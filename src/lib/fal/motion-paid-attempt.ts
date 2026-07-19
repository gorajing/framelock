import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

import { z } from "zod";

export const MOTION_V1_SPEND_CEILING_USD = "100" as const;
export const MOTION_V1_SPEND_LEDGER_PATH = resolve(
  process.cwd(),
  "artifacts",
  "motion-v1",
  "spend-ledger.json",
);
export const MOTION_FAL_REQUEST_TIMEOUT_MS = 30_000;

const ZERO = BigInt(0);
const USD_SCALE = BigInt(1_000_000);
const SPEND_CEILING_MICRO_USD = BigInt(100) * USD_SCALE;
const LEDGER_SCHEMA_VERSION = 1 as const;
const LOCK_LEASE_MS = 120_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const DEFINITIVE_REJECTION_STATUSES = new Set([
  400, 401, 403, 404, 405, 413, 415, 422,
]);

const decimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const endpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/)
  .refine(
    (endpoint) =>
      !endpoint.endsWith("/") &&
      !endpoint.includes("//") &&
      !endpoint.split("/").includes(".."),
  );
const attemptIdSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const requestIdSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/);
const falQueueUrlSchema = z.string().min(1).max(2_048);
const isoDateSchema = z.string().datetime({ offset: true });

export const motionPricingObservationSchema = z
  .object({
    unitPriceUsd: decimalSchema,
    billingUnit: z.string().trim().min(1).max(128),
    estimatedUnits: decimalSchema,
    estimatedCostUsd: decimalSchema,
    pricingSource: z.string().trim().min(1).max(1_000),
    priceObservedAt: isoDateSchema,
    priceValidUntil: isoDateSchema,
  })
  .strict();

export type MotionPricingObservation = z.infer<
  typeof motionPricingObservationSchema
>;

const attemptBaseSchema = z.object({
  attemptId: attemptIdSchema,
  reservedAt: isoDateSchema,
  endpoint: endpointSchema,
  inputDigest: sha256Schema,
  pricing: motionPricingObservationSchema,
});

const reservedAttemptSchema = attemptBaseSchema
  .extend({ state: z.literal("reserved") })
  .strict();
const submittedAttemptSchema = attemptBaseSchema
  .extend({
    state: z.literal("submitted"),
    completedAt: isoDateSchema,
    httpStatus: z.number().int().min(200).max(299),
    requestId: requestIdSchema,
    remoteStatus: z.string().trim().min(1).max(256).optional(),
    statusUrl: falQueueUrlSchema.optional(),
    responseUrl: falQueueUrlSchema.optional(),
  })
  .strict();
const rejectedAttemptSchema = attemptBaseSchema
  .extend({
    state: z.literal("rejected"),
    completedAt: isoDateSchema,
    httpStatus: z.number().int().refine((status) =>
      DEFINITIVE_REJECTION_STATUSES.has(status),
    ),
  })
  .strict();
const unknownAttemptSchema = attemptBaseSchema
  .extend({
    state: z.literal("submission_unknown"),
    completedAt: isoDateSchema,
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();

export const motionPaidAttemptSchema = z.discriminatedUnion("state", [
  reservedAttemptSchema,
  submittedAttemptSchema,
  rejectedAttemptSchema,
  unknownAttemptSchema,
]);
export type MotionPaidAttempt = z.infer<typeof motionPaidAttemptSchema>;

const motionSpendLedgerSchema = z
  .object({
    schemaVersion: z.literal(LEDGER_SCHEMA_VERSION),
    ceilingUsd: z.literal(MOTION_V1_SPEND_CEILING_USD),
    attempts: z.array(motionPaidAttemptSchema),
  })
  .strict()
  .superRefine((ledger, context) => {
    const ids = new Set<string>();
    let total = ZERO;
    for (const attempt of ledger.attempts) {
      if (ids.has(attempt.attemptId)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate Motion v1 attempt ID",
        });
      }
      ids.add(attempt.attemptId);
      try {
        assertPricingMath(attempt.pricing);
        total += parseDecimal(attempt.pricing.estimatedCostUsd);
      } catch {
        context.addIssue({
          code: "custom",
          message: "Invalid Motion v1 pricing evidence",
        });
      }
      if (
        attempt.state === "submitted" &&
        ((attempt.statusUrl === undefined) !==
          (attempt.responseUrl === undefined) ||
          (attempt.statusUrl !== undefined &&
            attempt.responseUrl !== undefined &&
            (!validateFalQueueReadUrl(
              attempt.statusUrl,
              attempt.requestId,
              "status",
            ) ||
              !validateFalQueueReadUrl(
                attempt.responseUrl,
                attempt.requestId,
                "result",
              ))))
      ) {
        context.addIssue({
          code: "custom",
          message: "Invalid Motion v1 fal queue URL evidence",
        });
      }
    }
    if (total > SPEND_CEILING_MICRO_USD) {
      context.addIssue({
        code: "custom",
        message: "Motion v1 ledger exceeds its spend ceiling",
      });
    }
  });

type MotionSpendLedger = z.infer<typeof motionSpendLedgerSchema>;

export type MotionSpendLedgerView = Readonly<{
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  ceilingUsd: typeof MOTION_V1_SPEND_CEILING_USD;
  reservedCostUsd: string;
  remainingCostUsd: string;
  attempts: readonly MotionPaidAttempt[];
}>;

export type MotionPaidAttemptErrorCode =
  | "ENDPOINT_NOT_ALLOWED"
  | "INVALID_CONFIGURATION"
  | "INVALID_CREDENTIALS"
  | "INVALID_FAL_INPUT"
  | "INVALID_PRICING"
  | "PRICING_MATH_MISMATCH"
  | "PRICING_NOT_CURRENT"
  | "MOTION_SPEND_CEILING_EXCEEDED"
  | "LEDGER_INVALID"
  | "LEDGER_LOCK_TIMEOUT"
  | "LEDGER_WRITE_FAILED"
  | "ATTEMPT_NOT_FOUND"
  | "ATTEMPT_NOT_SUBMITTED"
  | "SUBMISSION_PERSISTENCE_UNRESOLVED"
  | "FAL_READ_FAILED";

export class MotionPaidAttemptError extends Error {
  constructor(
    readonly code: MotionPaidAttemptErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MotionPaidAttemptError";
  }
}

export type MotionPaidAttemptControllerConfig = Readonly<{
  allowedEndpoints: readonly string[];
  ledgerPath?: string;
  now?: () => Date;
  createAttemptId?: () => string;
  fetchImpl?: typeof fetch;
}>;

export type SubmitMotionPaidAttemptInput = Readonly<{
  endpoint: string;
  falInput: unknown;
  credentials: string;
  pricing: MotionPricingObservation;
}>;

export type MotionPaidAttemptController = Readonly<{
  submit(input: SubmitMotionPaidAttemptInput): Promise<MotionPaidAttempt>;
  readLedger(): Promise<MotionSpendLedgerView>;
  readAttempt(attemptId: string): Promise<MotionPaidAttempt>;
  readStatus(input: {
    attemptId: string;
    credentials: string;
  }): Promise<unknown>;
  readResult(input: {
    attemptId: string;
    credentials: string;
  }): Promise<unknown>;
}>;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type LockOwner = Readonly<{
  schemaVersion: 1;
  ownerPid: number;
  ownerHost: string;
  ownerToken: string;
  acquiredAt: string;
  leaseExpiresAt: string;
}>;

const lockOwnerSchema = z
  .object({
    schemaVersion: z.literal(1),
    ownerPid: z.number().int().positive(),
    ownerHost: z.string().min(1),
    ownerToken: z.string().uuid(),
    acquiredAt: isoDateSchema,
    leaseExpiresAt: isoDateSchema,
  })
  .strict();

function parseDecimal(raw: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw)) {
    throw new TypeError("Invalid fixed-point decimal");
  }
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole) * USD_SCALE + BigInt(fraction.padEnd(6, "0"));
}

function formatDecimal(value: bigint): string {
  const whole = value / USD_SCALE;
  const fraction = (value % USD_SCALE).toString().padStart(6, "0");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole.toString();
}

function assertPricingMath(pricing: MotionPricingObservation): void {
  const unitPrice = parseDecimal(pricing.unitPriceUsd);
  const units = parseDecimal(pricing.estimatedUnits);
  const estimatedCost = parseDecimal(pricing.estimatedCostUsd);
  if (
    unitPrice <= ZERO ||
    units <= ZERO ||
    estimatedCost <= ZERO ||
    unitPrice * units !== estimatedCost * USD_SCALE
  ) {
    throw new MotionPaidAttemptError(
      "PRICING_MATH_MISMATCH",
      "Estimated Motion v1 cost does not exactly equal unit price times units",
    );
  }
}

function parsePricing(raw: unknown): MotionPricingObservation {
  const parsed = motionPricingObservationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MotionPaidAttemptError(
      "INVALID_PRICING",
      "Motion v1 pricing evidence is invalid",
    );
  }
  assertPricingMath(parsed.data);
  return parsed.data;
}

function validNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new MotionPaidAttemptError(
      "INVALID_CONFIGURATION",
      "Motion v1 controller clock returned an invalid date",
    );
  }
  return value;
}

function assertPricingCurrent(
  pricing: MotionPricingObservation,
  now: Date,
): void {
  const observedAt = Date.parse(pricing.priceObservedAt);
  const validUntil = Date.parse(pricing.priceValidUntil);
  if (
    observedAt > now.getTime() ||
    validUntil < now.getTime() ||
    validUntil <= observedAt
  ) {
    throw new MotionPaidAttemptError(
      "PRICING_NOT_CURRENT",
      "Motion v1 pricing evidence is not current at reservation time",
    );
  }
}

function normalizeJson(value: unknown, seen: Set<object>): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Non-finite numbers are not valid fal JSON input");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new TypeError("fal input must contain only JSON values");
  }
  if (seen.has(value)) {
    throw new TypeError("fal input must not contain cycles");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeJson(entry, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("fal input must use plain JSON objects");
    }
    const record = value as Record<string, unknown>;
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      normalized[key] = normalizeJson(record[key], seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function canonicalFalInput(raw: unknown): {
  value: { [key: string]: JsonValue };
  json: string;
} {
  let normalized: JsonValue;
  try {
    normalized = normalizeJson(raw, new Set());
  } catch {
    throw new MotionPaidAttemptError(
      "INVALID_FAL_INPUT",
      "Motion v1 fal input must be a plain JSON object",
    );
  }
  if (
    normalized === null ||
    Array.isArray(normalized) ||
    typeof normalized !== "object"
  ) {
    throw new MotionPaidAttemptError(
      "INVALID_FAL_INPUT",
      "Motion v1 fal input must be a JSON object",
    );
  }
  return { value: normalized, json: JSON.stringify(normalized) };
}

export function digestMotionFalInput(input: unknown): string {
  return createHash("sha256").update(canonicalFalInput(input).json).digest("hex");
}

function parseCredentials(raw: string): string {
  const credentials = typeof raw === "string" ? raw.trim() : "";
  if (!credentials) {
    throw new MotionPaidAttemptError(
      "INVALID_CREDENTIALS",
      "fal credentials are required",
    );
  }
  return credentials;
}

function emptyLedger(): MotionSpendLedger {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    ceilingUsd: MOTION_V1_SPEND_CEILING_USD,
    attempts: [],
  };
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readLedgerFile(path: string): Promise<MotionSpendLedger> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return emptyLedger();
    }
    throw new MotionPaidAttemptError(
      "LEDGER_INVALID",
      "Motion v1 spend ledger could not be read",
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new MotionPaidAttemptError(
      "LEDGER_INVALID",
      "Motion v1 spend ledger is not valid JSON",
    );
  }
  const parsed = motionSpendLedgerSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new MotionPaidAttemptError(
      "LEDGER_INVALID",
      "Motion v1 spend ledger failed its evidence contract",
    );
  }
  return parsed.data;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeLedgerAtomic(
  path: string,
  ledger: MotionSpendLedger,
): Promise<void> {
  const parsed = motionSpendLedgerSchema.parse(ledger);
  const directoryPath = dirname(path);
  await mkdir(directoryPath, { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await syncDirectory(directoryPath);
  } catch (error) {
    if (error instanceof MotionPaidAttemptError) {
      throw error;
    }
    throw new MotionPaidAttemptError(
      "LEDGER_WRITE_FAILED",
      "Motion v1 spend ledger could not be durably persisted",
    );
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function createLockOwner(): LockOwner {
  const now = new Date();
  return {
    schemaVersion: 1,
    ownerPid: process.pid,
    ownerHost: hostname(),
    ownerToken: randomUUID(),
    acquiredAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + LOCK_LEASE_MS).toISOString(),
  };
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
  try {
    return lockOwnerSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

function ownerProcessIsDead(owner: LockOwner): boolean {
  if (
    owner.ownerHost !== hostname() ||
    Date.parse(owner.leaseExpiresAt) > Date.now()
  ) {
    return false;
  }
  try {
    process.kill(owner.ownerPid, 0);
    return false;
  } catch (error) {
    return isNodeError(error, "ESRCH");
  }
}

async function reclaimStaleLock(path: string): Promise<boolean> {
  const owner = await readLockOwner(path);
  if (!owner || !ownerProcessIsDead(owner)) {
    return false;
  }
  const confirmed = await readLockOwner(path);
  if (
    !confirmed ||
    confirmed.ownerToken !== owner.ownerToken ||
    !ownerProcessIsDead(confirmed)
  ) {
    return false;
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function withLedgerLock<T>(
  ledgerPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const directoryPath = dirname(ledgerPath);
  const lockPath = `${ledgerPath}.lock`;
  await mkdir(directoryPath, { recursive: true });
  const owner = createLockOwner();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw new MotionPaidAttemptError(
          "LEDGER_WRITE_FAILED",
          "Motion v1 spend lock could not be created",
        );
      }
      if (await reclaimStaleLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new MotionPaidAttemptError(
          "LEDGER_LOCK_TIMEOUT",
          "Motion v1 spend ledger is being updated",
        );
      }
      await wait(LOCK_RETRY_MS);
    }
  }

  try {
    return await action();
  } finally {
    const current = await readLockOwner(lockPath);
    if (current?.ownerToken === owner.ownerToken) {
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

function totalReservedMicroUsd(ledger: MotionSpendLedger): bigint {
  return ledger.attempts.reduce(
    (total, attempt) =>
      total + parseDecimal(attempt.pricing.estimatedCostUsd),
    ZERO,
  );
}

function ledgerView(ledger: MotionSpendLedger): MotionSpendLedgerView {
  const reserved = totalReservedMicroUsd(ledger);
  return {
    schemaVersion: ledger.schemaVersion,
    ceilingUsd: ledger.ceilingUsd,
    reservedCostUsd: formatDecimal(reserved),
    remainingCostUsd: formatDecimal(SPEND_CEILING_MICRO_USD - reserved),
    attempts: ledger.attempts.map((attempt) => ({ ...attempt })),
  };
}

function parseRemoteSubmission(payload: unknown): {
  requestId: string;
  remoteStatus?: string;
  statusUrl?: string;
  responseUrl?: string;
} | undefined {
  const parsed = z
    .object({
      request_id: requestIdSchema,
      status: z.string().trim().min(1).max(256).optional(),
      status_url: falQueueUrlSchema.optional(),
      response_url: falQueueUrlSchema.optional(),
    })
    .passthrough()
    .safeParse(payload);
  if (!parsed.success) {
    return undefined;
  }
  const hasStatusUrl = parsed.data.status_url !== undefined;
  const hasResponseUrl = parsed.data.response_url !== undefined;
  if (hasStatusUrl !== hasResponseUrl) {
    return undefined;
  }
  let statusUrl: string | undefined;
  let responseUrl: string | undefined;
  if (parsed.data.status_url && parsed.data.response_url) {
    statusUrl = validateFalQueueReadUrl(
      parsed.data.status_url,
      parsed.data.request_id,
      "status",
    );
    responseUrl = validateFalQueueReadUrl(
      parsed.data.response_url,
      parsed.data.request_id,
      "result",
    );
    if (!statusUrl || !responseUrl) {
      return undefined;
    }
  }
  return {
    requestId: parsed.data.request_id,
    ...(parsed.data.status ? { remoteStatus: parsed.data.status } : {}),
    ...(statusUrl ? { statusUrl } : {}),
    ...(responseUrl ? { responseUrl } : {}),
  };
}

function validateFalQueueReadUrl(
  rawUrl: string,
  requestId: string,
  kind: "status" | "result",
): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "queue.fal.run" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  const suffix =
    kind === "status"
      ? `/requests/${requestId}/status`
      : `/requests/${requestId}`;
  if (!url.pathname.endsWith(suffix)) {
    return undefined;
  }
  return url.toString();
}

export function createMotionPaidAttemptController(
  config: MotionPaidAttemptControllerConfig,
): MotionPaidAttemptController {
  if (!Array.isArray(config.allowedEndpoints) || config.allowedEndpoints.length === 0) {
    throw new MotionPaidAttemptError(
      "INVALID_CONFIGURATION",
      "Motion v1 requires an explicit non-empty endpoint allowlist",
    );
  }
  const allowedEndpoints = new Set<string>();
  for (const rawEndpoint of config.allowedEndpoints) {
    const parsed = endpointSchema.safeParse(rawEndpoint);
    if (!parsed.success) {
      throw new MotionPaidAttemptError(
        "INVALID_CONFIGURATION",
        "Motion v1 endpoint allowlist contains an invalid endpoint",
      );
    }
    allowedEndpoints.add(parsed.data);
  }
  const ledgerPath = config.ledgerPath ?? MOTION_V1_SPEND_LEDGER_PATH;
  if (!ledgerPath.trim()) {
    throw new MotionPaidAttemptError(
      "INVALID_CONFIGURATION",
      "Motion v1 ledger path is required",
    );
  }
  const now = config.now ?? (() => new Date());
  const createAttemptId = config.createAttemptId ?? (() => randomUUID());
  const fetchImpl = config.fetchImpl ?? fetch;

  function assertAllowedEndpoint(rawEndpoint: string): string {
    const endpoint = endpointSchema.safeParse(rawEndpoint);
    if (!endpoint.success || !allowedEndpoints.has(endpoint.data)) {
      throw new MotionPaidAttemptError(
        "ENDPOINT_NOT_ALLOWED",
        "Requested fal endpoint is outside the Motion v1 allowlist",
      );
    }
    return endpoint.data;
  }

  async function readLedger(): Promise<MotionSpendLedgerView> {
    return ledgerView(await readLedgerFile(ledgerPath));
  }

  async function readAttempt(attemptIdRaw: string): Promise<MotionPaidAttempt> {
    const attemptId = attemptIdSchema.safeParse(attemptIdRaw);
    if (!attemptId.success) {
      throw new MotionPaidAttemptError(
        "ATTEMPT_NOT_FOUND",
        "Motion v1 paid attempt does not exist",
      );
    }
    const ledger = await readLedgerFile(ledgerPath);
    const attempt = ledger.attempts.find(
      (candidate) => candidate.attemptId === attemptId.data,
    );
    if (!attempt) {
      throw new MotionPaidAttemptError(
        "ATTEMPT_NOT_FOUND",
        "Motion v1 paid attempt does not exist",
      );
    }
    return { ...attempt };
  }

  async function reserve(input: {
    endpoint: string;
    inputDigest: string;
    pricing: MotionPricingObservation;
  }): Promise<MotionPaidAttempt> {
    return withLedgerLock(ledgerPath, async () => {
      const ledger = await readLedgerFile(ledgerPath);
      const reservationTime = validNow(now);
      assertPricingCurrent(input.pricing, reservationTime);
      const nextCost = parseDecimal(input.pricing.estimatedCostUsd);
      const reserved = totalReservedMicroUsd(ledger);
      if (reserved + nextCost > SPEND_CEILING_MICRO_USD) {
        throw new MotionPaidAttemptError(
          "MOTION_SPEND_CEILING_EXCEEDED",
          `Motion v1 reservation would exceed the $${MOTION_V1_SPEND_CEILING_USD} ceiling`,
        );
      }
      const attemptId = attemptIdSchema.safeParse(createAttemptId());
      if (!attemptId.success) {
        throw new MotionPaidAttemptError(
          "INVALID_CONFIGURATION",
          "Motion v1 attempt ID generator returned an invalid ID",
        );
      }
      if (
        ledger.attempts.some(
          (attempt) => attempt.attemptId === attemptId.data,
        )
      ) {
        throw new MotionPaidAttemptError(
          "INVALID_CONFIGURATION",
          "Motion v1 attempt ID generator returned a duplicate ID",
        );
      }
      const attempt = reservedAttemptSchema.parse({
        attemptId: attemptId.data,
        reservedAt: reservationTime.toISOString(),
        state: "reserved",
        endpoint: input.endpoint,
        inputDigest: input.inputDigest,
        pricing: input.pricing,
      });
      await writeLedgerAtomic(ledgerPath, {
        ...ledger,
        attempts: [...ledger.attempts, attempt],
      });
      return attempt;
    });
  }

  async function completeAttempt(
    reserved: MotionPaidAttempt,
    outcome:
      | {
          state: "submitted";
          httpStatus: number;
          requestId: string;
          remoteStatus?: string;
          statusUrl?: string;
          responseUrl?: string;
        }
      | { state: "rejected"; httpStatus: number }
      | { state: "submission_unknown"; httpStatus?: number },
  ): Promise<MotionPaidAttempt> {
    try {
      return await withLedgerLock(ledgerPath, async () => {
        const ledger = await readLedgerFile(ledgerPath);
        const index = ledger.attempts.findIndex(
          (attempt) => attempt.attemptId === reserved.attemptId,
        );
        if (index === -1 || ledger.attempts[index]?.state !== "reserved") {
          throw new MotionPaidAttemptError(
            "LEDGER_INVALID",
            "Motion v1 reservation is missing or already terminal",
          );
        }
        const completed = motionPaidAttemptSchema.parse({
          ...reserved,
          ...outcome,
          completedAt: validNow(now).toISOString(),
        });
        const attempts = [...ledger.attempts];
        attempts[index] = completed;
        await writeLedgerAtomic(ledgerPath, { ...ledger, attempts });
        return completed;
      });
    } catch {
      throw new MotionPaidAttemptError(
        "SUBMISSION_PERSISTENCE_UNRESOLVED",
        "fal submission finished but its Motion v1 outcome could not be persisted; do not retry",
      );
    }
  }

  async function submit(
    rawInput: SubmitMotionPaidAttemptInput,
  ): Promise<MotionPaidAttempt> {
    const endpoint = assertAllowedEndpoint(rawInput.endpoint);
    const credentials = parseCredentials(rawInput.credentials);
    const pricing = parsePricing(rawInput.pricing);
    const falInput = canonicalFalInput(rawInput.falInput);
    const inputDigest = createHash("sha256").update(falInput.json).digest("hex");
    const reserved = await reserve({ endpoint, inputDigest, pricing });

    let response: Response;
    try {
      response = await fetchImpl(`https://queue.fal.run/${endpoint}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Key ${credentials}`,
          "Content-Type": "application/json",
          "X-Fal-No-Retry": "1",
          "x-app-fal-disable-fallback": "true",
        },
        body: falInput.json,
        redirect: "error",
        signal: AbortSignal.timeout(MOTION_FAL_REQUEST_TIMEOUT_MS),
      });
    } catch {
      return completeAttempt(reserved, { state: "submission_unknown" });
    }

    if (!response.ok) {
      if (DEFINITIVE_REJECTION_STATUSES.has(response.status)) {
        return completeAttempt(reserved, {
          state: "rejected",
          httpStatus: response.status,
        });
      }
      return completeAttempt(reserved, {
        state: "submission_unknown",
        httpStatus: response.status,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return completeAttempt(reserved, {
        state: "submission_unknown",
        httpStatus: response.status,
      });
    }
    const submission = parseRemoteSubmission(payload);
    if (!submission) {
      return completeAttempt(reserved, {
        state: "submission_unknown",
        httpStatus: response.status,
      });
    }
    return completeAttempt(reserved, {
      state: "submitted",
      httpStatus: response.status,
      requestId: submission.requestId,
      ...(submission.remoteStatus
        ? { remoteStatus: submission.remoteStatus }
        : {}),
      ...(submission.statusUrl ? { statusUrl: submission.statusUrl } : {}),
      ...(submission.responseUrl
        ? { responseUrl: submission.responseUrl }
        : {}),
    });
  }

  async function readRemote(
    kind: "status" | "result",
    input: { attemptId: string; credentials: string },
  ): Promise<unknown> {
    const credentials = parseCredentials(input.credentials);
    const attempt = await readAttempt(input.attemptId);
    if (attempt.state !== "submitted") {
      throw new MotionPaidAttemptError(
        "ATTEMPT_NOT_SUBMITTED",
        "Only a submitted Motion v1 attempt can be read from fal",
      );
    }
    const suffix = kind === "status" ? "/status" : "";
    const requestUrl =
      kind === "status"
        ? (attempt.statusUrl ??
          `https://queue.fal.run/${attempt.endpoint}/requests/${attempt.requestId}${suffix}`)
        : (attempt.responseUrl ??
          `https://queue.fal.run/${attempt.endpoint}/requests/${attempt.requestId}`);
    let response: Response;
    try {
      response = await fetchImpl(
        requestUrl,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Key ${credentials}`,
            "X-Fal-No-Retry": "1",
            "x-app-fal-disable-fallback": "true",
          },
          body: undefined,
          redirect: "error",
          signal: AbortSignal.timeout(MOTION_FAL_REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      throw new MotionPaidAttemptError(
        "FAL_READ_FAILED",
        `Motion v1 fal ${kind} read failed`,
      );
    }
    if (!response.ok) {
      throw new MotionPaidAttemptError(
        "FAL_READ_FAILED",
        `Motion v1 fal ${kind} read failed`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new MotionPaidAttemptError(
        "FAL_READ_FAILED",
        `Motion v1 fal ${kind} returned invalid JSON`,
      );
    }
  }

  return {
    submit,
    readLedger,
    readAttempt,
    readStatus: (input) => readRemote("status", input),
    readResult: (input) => readRemote("result", input),
  };
}
