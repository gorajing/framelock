import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type {
  MotionPaidAttempt,
  MotionPaidAttemptController,
} from "./motion-paid-attempt";

const MP4_MIME = "video/mp4" as const;
const JSON_MIME = "application/json" as const;
const DEFAULT_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;
const MAX_LOCAL_UPLOAD_BYTES = 1024 * 1024 * 1024;
const READ_TIMEOUT_MS = 60_000;
const RESERVED_CAPTURE_NAMES = new Set([
  "capture-receipt.json",
  "remote-result.json",
  "remote-status.json",
]);
const ENDPOINT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const FILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MIME_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

type JsonFileEvidence = Readonly<{
  fileName: string;
  mime: typeof JSON_MIME;
  bytes: number;
  sha256: string;
}>;

export type MotionFalUploadReceipt = Readonly<{
  schemaVersion: 1;
  kind: "motion-v1-fal-upload";
  uploadedAt: string;
  localFile: Readonly<{
    path: string;
    name: string;
    mime: typeof MP4_MIME;
    bytes: number;
    sha256: string;
  }>;
  falUrl: string;
}>;

export type MotionFalDownloadDeclaration = Readonly<{
  jsonPointer: string;
  fileName: string;
  expectedMime: string;
  maxBytes?: number;
}>;

export type MotionFalDownloadEvidence = Readonly<{
  jsonPointer: string;
  falUrl: string;
  fileName: string;
  mime: string;
  bytes: number;
  sha256: string;
}>;

export type MotionFalReadCapture = Readonly<{
  schemaVersion: 1;
  kind: "motion-v1-fal-read-capture";
  capturedAt: string;
  attempt: Readonly<{
    attemptId: string;
    endpoint: string;
    requestId: string;
    inputDigest: string;
    statusUrl?: string;
    responseUrl?: string;
  }>;
  status: JsonFileEvidence;
  result: JsonFileEvidence;
  downloads: readonly MotionFalDownloadEvidence[];
}>;

export type MotionFalReadPort = Pick<
  MotionPaidAttemptController,
  "readAttempt" | "readResult" | "readStatus"
>;

export type MotionFalIoErrorCode =
  | "ATTEMPT_ENDPOINT_NOT_ALLOWED"
  | "ATTEMPT_NOT_SUBMITTED"
  | "CREDENTIAL_ECHO_REFUSED"
  | "DOWNLOAD_EMPTY"
  | "DOWNLOAD_FAILED"
  | "DOWNLOAD_LIMIT_EXCEEDED"
  | "DOWNLOAD_MIME_MISMATCH"
  | "EVIDENCE_EXISTS"
  | "EVIDENCE_WRITE_FAILED"
  | "INVALID_CONFIGURATION"
  | "INVALID_CREDENTIALS"
  | "INVALID_DOWNLOAD_DECLARATION"
  | "INVALID_FAL_MEDIA_URL"
  | "INVALID_LOCAL_MP4"
  | "INVALID_REMOTE_JSON"
  | "UPLOAD_FAILED";

export class MotionFalIoError extends Error {
  constructor(
    readonly code: MotionFalIoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MotionFalIoError";
  }
}

type PreparedDownload = Readonly<{
  jsonPointer: string;
  fileName: string;
  expectedMime: string;
  maxBytes: number;
}>;

type ResolvedDownload = PreparedDownload & Readonly<{ falUrl: string }>;

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function validDate(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new MotionFalIoError(
      "INVALID_CONFIGURATION",
      "Motion v1 fal I/O clock returned an invalid date",
    );
  }
  return value;
}

function parseCredentials(raw: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new MotionFalIoError(
      "INVALID_CREDENTIALS",
      "FAL_KEY is required for Motion v1 fal reads",
    );
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function withEvidenceGuard<T>(
  targetPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const parent = dirname(targetPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await pathExists(targetPath)) {
    throw new MotionFalIoError(
      "EVIDENCE_EXISTS",
      "Motion v1 fal evidence already exists and will not be overwritten",
    );
  }
  const guardPath = `${targetPath}.lock`;
  let guard;
  try {
    guard = await open(guardPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new MotionFalIoError(
        "EVIDENCE_EXISTS",
        "Motion v1 fal evidence is already being created",
      );
    }
    throw error;
  }
  try {
    await guard.writeFile(`${process.pid}\n`, "utf8");
    await guard.sync();
    if (await pathExists(targetPath)) {
      throw new MotionFalIoError(
        "EVIDENCE_EXISTS",
        "Motion v1 fal evidence already exists and will not be overwritten",
      );
    }
    return await action();
  } finally {
    await guard.close().catch(() => undefined);
    await unlink(guardPath).catch(() => undefined);
  }
}

async function writeImmutableBytes(
  destination: string,
  bytes: Uint8Array,
): Promise<void> {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, destination);
    await syncDirectory(parent);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new MotionFalIoError(
        "EVIDENCE_EXISTS",
        "Motion v1 fal evidence already exists and will not be overwritten",
      );
    }
    if (error instanceof MotionFalIoError) {
      throw error;
    }
    throw new MotionFalIoError(
      "EVIDENCE_WRITE_FAILED",
      "Motion v1 fal evidence could not be atomically persisted",
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function encodeJsonEvidence(
  value: unknown,
  label: "status" | "result" | "receipt",
): Uint8Array {
  try {
    const encoded = JSON.stringify(value, null, 2);
    if (encoded === undefined) {
      throw new TypeError("undefined JSON");
    }
    return Buffer.from(`${encoded}\n`, "utf8");
  } catch {
    throw new MotionFalIoError(
      "INVALID_REMOTE_JSON",
      `Motion v1 fal ${label} is not persistable JSON`,
    );
  }
}

function jsonFileEvidence(
  fileName: string,
  bytes: Uint8Array,
): JsonFileEvidence {
  return {
    fileName,
    mime: JSON_MIME,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function validateEndpoint(raw: string): string | undefined {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > 256 ||
    !ENDPOINT_PATTERN.test(raw) ||
    raw.endsWith("/") ||
    raw.includes("//") ||
    raw.split("/").includes("..")
  ) {
    return undefined;
  }
  return raw;
}

function allowedEndpointSet(raw: readonly string[]): Set<string> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new MotionFalIoError(
      "INVALID_CONFIGURATION",
      "Motion v1 fal capture requires an explicit endpoint allowlist",
    );
  }
  const endpoints = new Set<string>();
  for (const candidate of raw) {
    const endpoint = validateEndpoint(candidate);
    if (!endpoint) {
      throw new MotionFalIoError(
        "INVALID_CONFIGURATION",
        "Motion v1 fal capture endpoint allowlist is invalid",
      );
    }
    endpoints.add(endpoint);
  }
  return endpoints;
}

function validateFalMediaUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MotionFalIoError(
      "INVALID_FAL_MEDIA_URL",
      "Motion v1 media URL is invalid",
    );
  }
  const isFalMediaHost =
    url.hostname === "fal.media" || url.hostname.endsWith(".fal.media");
  if (
    url.protocol !== "https:" ||
    !isFalMediaHost ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith("/files/")
  ) {
    throw new MotionFalIoError(
      "INVALID_FAL_MEDIA_URL",
      "Motion v1 media URL is outside the allowed fal CDN boundary",
    );
  }
  const segments = url.pathname.split("/").slice(2);
  if (segments.length === 0 || segments.some((segment) => !segment)) {
    throw new MotionFalIoError(
      "INVALID_FAL_MEDIA_URL",
      "Motion v1 media URL has an invalid fal CDN path",
    );
  }
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new MotionFalIoError(
        "INVALID_FAL_MEDIA_URL",
        "Motion v1 media URL has an invalid fal CDN path",
      );
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      throw new MotionFalIoError(
        "INVALID_FAL_MEDIA_URL",
        "Motion v1 media URL has an invalid fal CDN path",
      );
    }
  }
  return url.toString();
}

function assertMp4Bytes(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 12 ||
    Buffer.from(bytes.subarray(4, 8)).toString("ascii") !== "ftyp"
  ) {
    throw new MotionFalIoError(
      "INVALID_LOCAL_MP4",
      "Motion v1 upload source is not an ISO base media MP4",
    );
  }
}

async function readLocalMp4(path: string): Promise<{
  bytes: Uint8Array;
  resolvedPath: string;
  name: string;
}> {
  const resolvedPath = resolve(path);
  const name = basename(resolvedPath);
  if (!name.toLowerCase().endsWith(".mp4")) {
    throw new MotionFalIoError(
      "INVALID_LOCAL_MP4",
      "Motion v1 upload source must have an .mp4 filename",
    );
  }
  let handle;
  try {
    handle = await open(resolvedPath, "r");
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_LOCAL_UPLOAD_BYTES
    ) {
      throw new MotionFalIoError(
        "INVALID_LOCAL_MP4",
        "Motion v1 upload source must be a non-empty regular MP4 within the size limit",
      );
    }
    const bytes = new Uint8Array(await handle.readFile());
    if (bytes.byteLength !== metadata.size) {
      throw new MotionFalIoError(
        "INVALID_LOCAL_MP4",
        "Motion v1 upload source changed while it was being read",
      );
    }
    assertMp4Bytes(bytes);
    return { bytes, resolvedPath, name };
  } catch (error) {
    if (error instanceof MotionFalIoError) {
      throw error;
    }
    throw new MotionFalIoError(
      "INVALID_LOCAL_MP4",
      "Motion v1 upload source could not be read",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function uploadMotionCanonicalMp4(input: {
  sourcePath: string;
  receiptPath: string;
  upload(file: File): Promise<string>;
  now?: () => Date;
}): Promise<MotionFalUploadReceipt> {
  const receiptPath = resolve(input.receiptPath);
  const now = input.now ?? (() => new Date());
  return withEvidenceGuard(receiptPath, async () => {
    const local = await readLocalMp4(input.sourcePath);
    const uploadedAt = validDate(now).toISOString();
    const uploadBytes = new Uint8Array(local.bytes.byteLength);
    uploadBytes.set(local.bytes);
    let rawUrl: string;
    try {
      rawUrl = await input.upload(
        new File([uploadBytes.buffer], local.name, { type: MP4_MIME }),
      );
    } catch {
      throw new MotionFalIoError(
        "UPLOAD_FAILED",
        "Motion v1 MP4 upload to fal storage failed",
      );
    }
    const falUrl = validateFalMediaUrl(rawUrl);
    const receipt: MotionFalUploadReceipt = {
      schemaVersion: 1,
      kind: "motion-v1-fal-upload",
      uploadedAt,
      localFile: {
        path: local.resolvedPath,
        name: local.name,
        mime: MP4_MIME,
        bytes: local.bytes.byteLength,
        sha256: sha256(local.bytes),
      },
      falUrl,
    };
    await writeImmutableBytes(
      receiptPath,
      encodeJsonEvidence(receipt, "receipt"),
    );
    return receipt;
  });
}

function prepareDownloadDeclarations(
  raw: readonly MotionFalDownloadDeclaration[],
): PreparedDownload[] {
  if (!Array.isArray(raw)) {
    throw new MotionFalIoError(
      "INVALID_DOWNLOAD_DECLARATION",
      "Motion v1 download declarations must be an array",
    );
  }
  const pointers = new Set<string>();
  const names = new Set<string>();
  return raw.map((declaration) => {
    if (
      !declaration ||
      typeof declaration !== "object" ||
      typeof declaration.jsonPointer !== "string" ||
      declaration.jsonPointer.length < 2 ||
      declaration.jsonPointer.length > 512 ||
      !declaration.jsonPointer.startsWith("/") ||
      /~(?![01])/u.test(declaration.jsonPointer) ||
      typeof declaration.fileName !== "string" ||
      !FILE_NAME_PATTERN.test(declaration.fileName) ||
      declaration.fileName === "." ||
      declaration.fileName === ".." ||
      RESERVED_CAPTURE_NAMES.has(declaration.fileName) ||
      typeof declaration.expectedMime !== "string"
    ) {
      throw new MotionFalIoError(
        "INVALID_DOWNLOAD_DECLARATION",
        "Motion v1 download declaration is invalid",
      );
    }
    const expectedMime = declaration.expectedMime.trim().toLowerCase();
    const maxBytes = declaration.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
    if (
      !MIME_PATTERN.test(expectedMime) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > MAX_LOCAL_UPLOAD_BYTES ||
      pointers.has(declaration.jsonPointer) ||
      names.has(declaration.fileName)
    ) {
      throw new MotionFalIoError(
        "INVALID_DOWNLOAD_DECLARATION",
        "Motion v1 download declaration is invalid or duplicated",
      );
    }
    pointers.add(declaration.jsonPointer);
    names.add(declaration.fileName);
    return {
      jsonPointer: declaration.jsonPointer,
      fileName: declaration.fileName,
      expectedMime,
      maxBytes,
    };
  });
}

function resolveJsonPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) {
        throw new MotionFalIoError(
          "INVALID_DOWNLOAD_DECLARATION",
          "Motion v1 result JSON pointer does not resolve to a file URL",
        );
      }
      current = current[Number(token)];
    } else if (
      current !== null &&
      typeof current === "object" &&
      Object.prototype.hasOwnProperty.call(current, token)
    ) {
      current = (current as Record<string, unknown>)[token];
    } else {
      throw new MotionFalIoError(
        "INVALID_DOWNLOAD_DECLARATION",
        "Motion v1 result JSON pointer does not resolve to a file URL",
      );
    }
  }
  return current;
}

function resolveDownloads(
  result: unknown,
  declarations: readonly PreparedDownload[],
): ResolvedDownload[] {
  return declarations.map((declaration) => {
    const value = resolveJsonPointer(result, declaration.jsonPointer);
    if (typeof value !== "string") {
      throw new MotionFalIoError(
        "INVALID_DOWNLOAD_DECLARATION",
        "Motion v1 result JSON pointer does not resolve to a file URL",
      );
    }
    return { ...declaration, falUrl: validateFalMediaUrl(value) };
  });
}

function normalizedResponseMime(response: Response): string | undefined {
  const header = response.headers.get("content-type");
  if (!header) {
    return undefined;
  }
  const mime = header.split(";", 1)[0]?.trim().toLowerCase();
  return mime && MIME_PATTERN.test(mime) ? mime : undefined;
}

async function downloadResolvedFalFile(input: {
  declaration: ResolvedDownload;
  outputDirectory: string;
  fetchImpl: typeof fetch;
}): Promise<MotionFalDownloadEvidence> {
  const destination = resolve(input.outputDirectory, input.declaration.fileName);
  if (dirname(destination) !== resolve(input.outputDirectory)) {
    throw new MotionFalIoError(
      "INVALID_DOWNLOAD_DECLARATION",
      "Motion v1 download destination escapes the evidence directory",
    );
  }
  if (await pathExists(destination)) {
    throw new MotionFalIoError(
      "EVIDENCE_EXISTS",
      "Motion v1 download destination already exists",
    );
  }
  let response: Response;
  try {
    response = await input.fetchImpl(input.declaration.falUrl, {
      method: "GET",
      headers: { Accept: input.declaration.expectedMime },
      redirect: "error",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    throw new MotionFalIoError(
      "DOWNLOAD_FAILED",
      "Motion v1 fal media download failed",
    );
  }
  if (!response.ok || !response.body) {
    throw new MotionFalIoError(
      "DOWNLOAD_FAILED",
      "Motion v1 fal media download returned an unsuccessful response",
    );
  }
  const responseMime = normalizedResponseMime(response);
  if (responseMime !== input.declaration.expectedMime) {
    throw new MotionFalIoError(
      "DOWNLOAD_MIME_MISMATCH",
      "Motion v1 fal media response MIME does not match its declaration",
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const declaredBytes = Number(declaredLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > input.declaration.maxBytes
    ) {
      throw new MotionFalIoError(
        "DOWNLOAD_LIMIT_EXCEEDED",
        "Motion v1 fal media exceeds its declared byte limit",
      );
    }
  }

  const temporary = `${destination}.${process.pid}.${randomUUID()}.download`;
  let handle;
  let handleClosed = false;
  const digest = createHash("sha256");
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    handle = await open(temporary, "wx", 0o600);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > input.declaration.maxBytes) {
        throw new MotionFalIoError(
          "DOWNLOAD_LIMIT_EXCEEDED",
          "Motion v1 fal media exceeds its declared byte limit",
        );
      }
      digest.update(chunk.value);
      await handle.write(chunk.value);
    }
    if (bytes === 0) {
      throw new MotionFalIoError(
        "DOWNLOAD_EMPTY",
        "Motion v1 fal media download was empty",
      );
    }
    await handle.sync();
    await handle.close();
    handleClosed = true;
    await link(temporary, destination);
    await syncDirectory(input.outputDirectory);
    return {
      jsonPointer: input.declaration.jsonPointer,
      falUrl: input.declaration.falUrl,
      fileName: input.declaration.fileName,
      mime: input.declaration.expectedMime,
      bytes,
      sha256: digest.digest("hex"),
    };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (isNodeError(error, "EEXIST")) {
      throw new MotionFalIoError(
        "EVIDENCE_EXISTS",
        "Motion v1 download destination already exists",
      );
    }
    if (error instanceof MotionFalIoError) {
      throw error;
    }
    throw new MotionFalIoError(
      "DOWNLOAD_FAILED",
      "Motion v1 fal media download could not be persisted",
    );
  } finally {
    if (!handleClosed) {
      await handle?.close().catch(() => undefined);
    }
    await unlink(temporary).catch(() => undefined);
  }
}

function submittedAttemptSummary(attempt: MotionPaidAttempt) {
  if (attempt.state !== "submitted") {
    throw new MotionFalIoError(
      "ATTEMPT_NOT_SUBMITTED",
      "Motion v1 fal read capture requires a submitted paid attempt",
    );
  }
  return {
    attemptId: attempt.attemptId,
    endpoint: attempt.endpoint,
    requestId: attempt.requestId,
    inputDigest: attempt.inputDigest,
    ...(attempt.statusUrl ? { statusUrl: attempt.statusUrl } : {}),
    ...(attempt.responseUrl ? { responseUrl: attempt.responseUrl } : {}),
  };
}

export async function captureMotionFalReadEvidence(input: {
  controller: MotionFalReadPort;
  attemptId: string;
  credentials: string;
  allowedEndpoints: readonly string[];
  outputDirectory: string;
  downloads?: readonly MotionFalDownloadDeclaration[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<MotionFalReadCapture> {
  const outputDirectory = resolve(input.outputDirectory);
  const credentials = parseCredentials(input.credentials);
  const endpoints = allowedEndpointSet(input.allowedEndpoints);
  const declarations = prepareDownloadDeclarations(input.downloads ?? []);
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const capturedAt = validDate(now).toISOString();

  return withEvidenceGuard(outputDirectory, async () => {
    const attempt = await input.controller.readAttempt(input.attemptId);
    const attemptSummary = submittedAttemptSummary(attempt);
    if (attemptSummary.attemptId !== input.attemptId) {
      throw new MotionFalIoError(
        "ATTEMPT_NOT_SUBMITTED",
        "Motion v1 fal read controller returned a different paid attempt",
      );
    }
    if (!endpoints.has(attemptSummary.endpoint)) {
      throw new MotionFalIoError(
        "ATTEMPT_ENDPOINT_NOT_ALLOWED",
        "Submitted Motion v1 attempt is outside the capture endpoint allowlist",
      );
    }

    const status = await input.controller.readStatus({
      attemptId: attemptSummary.attemptId,
      credentials,
    });
    const result = await input.controller.readResult({
      attemptId: attemptSummary.attemptId,
      credentials,
    });
    const statusBytes = encodeJsonEvidence(status, "status");
    const resultBytes = encodeJsonEvidence(result, "result");
    if (
      Buffer.from(statusBytes).includes(Buffer.from(credentials)) ||
      Buffer.from(resultBytes).includes(Buffer.from(credentials))
    ) {
      throw new MotionFalIoError(
        "CREDENTIAL_ECHO_REFUSED",
        "Motion v1 fal response echoed credentials and was not persisted",
      );
    }
    const resolvedDownloads = resolveDownloads(result, declarations);

    await mkdir(outputDirectory, { mode: 0o700 });
    await writeImmutableBytes(
      resolve(outputDirectory, "remote-status.json"),
      statusBytes,
    );
    await writeImmutableBytes(
      resolve(outputDirectory, "remote-result.json"),
      resultBytes,
    );
    const downloads: MotionFalDownloadEvidence[] = [];
    for (const declaration of resolvedDownloads) {
      downloads.push(
        await downloadResolvedFalFile({
          declaration,
          outputDirectory,
          fetchImpl,
        }),
      );
    }
    const capture: MotionFalReadCapture = {
      schemaVersion: 1,
      kind: "motion-v1-fal-read-capture",
      capturedAt,
      attempt: attemptSummary,
      status: jsonFileEvidence("remote-status.json", statusBytes),
      result: jsonFileEvidence("remote-result.json", resultBytes),
      downloads,
    };
    const receiptBytes = encodeJsonEvidence(capture, "receipt");
    if (Buffer.from(receiptBytes).includes(Buffer.from(credentials))) {
      throw new MotionFalIoError(
        "CREDENTIAL_ECHO_REFUSED",
        "Motion v1 fal capture receipt contained credentials and was refused",
      );
    }
    await writeImmutableBytes(
      resolve(outputDirectory, "capture-receipt.json"),
      receiptBytes,
    );
    return capture;
  });
}
