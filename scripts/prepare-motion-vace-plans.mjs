#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";

import {
  buildMotionWanVaceCandidateDrafts,
  prepareMotionWanVaceSubmission,
  resolveMotionWanVaceMaskUrl,
} from "../src/lib/fal/motion-wan-vace-plan.ts";

const MASK_TRANSPORT_PATH_JSON_POINTER = "/transport/path";
const MASK_TRANSPORT_SHA256_JSON_POINTER = "/transport/sha256";
const MAX_JSON_BYTES = 1024 * 1024;
const EXPECTED_PRICING = Object.freeze({
  unitPriceUsd: "0.08",
  estimatedUnits: "7.5625",
  estimatedCostUsd: "0.605",
});
const REQUIRED_ARGUMENTS = Object.freeze([
  "--mask-upload-receipt",
  "--mask-transport-receipt",
  "--pricing",
  "--output-dir",
]);

class PrepareVacePlansError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PrepareVacePlansError";
    this.code = code;
  }
}

function usage() {
  return [
    "Usage:",
    "  node --experimental-transform-types scripts/prepare-motion-vace-plans.mjs \\",
    "    --mask-upload-receipt <motion-v1-fal-upload.json> \\",
    "    --mask-transport-receipt <mask-transport-receipt.json> \\",
    "    --pricing <current-pricing-observation.json> \\",
    "    --output-dir <new-exclusive-directory>",
    "",
    "Offline only: verifies evidence and writes three immutable request plans.",
  ].join("\n");
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    if (argv.length !== 1) {
      throw new PrepareVacePlansError(
        "INVALID_ARGUMENTS",
        "--help cannot be combined with plan arguments",
      );
    }
    return { help: true };
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!REQUIRED_ARGUMENTS.includes(flag) || !value || value.startsWith("--")) {
      throw new PrepareVacePlansError(
        "INVALID_ARGUMENTS",
        `Invalid or incomplete argument: ${flag ?? "<missing>"}`,
      );
    }
    if (values.has(flag)) {
      throw new PrepareVacePlansError(
        "INVALID_ARGUMENTS",
        `Duplicate argument: ${flag}`,
      );
    }
    values.set(flag, value);
  }
  if (values.size !== REQUIRED_ARGUMENTS.length) {
    throw new PrepareVacePlansError(
      "INVALID_ARGUMENTS",
      "Every required plan argument must be supplied exactly once",
    );
  }
  return {
    help: false,
    maskUploadReceipt: values.get("--mask-upload-receipt"),
    maskTransportReceipt: values.get("--mask-transport-receipt"),
    pricing: values.get("--pricing"),
    outputDirectory: values.get("--output-dir"),
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, role) {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    throw new PrepareVacePlansError(
      "INVALID_EVIDENCE",
      `${role} schema is invalid`,
    );
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireSha256(value, role) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new PrepareVacePlansError(
      "INVALID_EVIDENCE",
      `${role} SHA-256 is malformed`,
    );
  }
  return value;
}

function withinRoot(path, root) {
  const pathRelativeToRoot = relative(root, path);
  return (
    pathRelativeToRoot === "" ||
    (!pathRelativeToRoot.startsWith(`..${sep}`) &&
      pathRelativeToRoot !== ".." &&
      !isAbsolute(pathRelativeToRoot))
  );
}

function requireUnderRoot(path, root, role, allowRoot = false) {
  if (!withinRoot(path, root) || (!allowRoot && path === root)) {
    throw new PrepareVacePlansError(
      "PATH_OUTSIDE_PROJECT",
      `${role} must remain under the project root`,
    );
  }
  return path;
}

function resolveFromRoot(value, root, role) {
  if (typeof value !== "string" || !value) {
    throw new PrepareVacePlansError(
      "INVALID_EVIDENCE",
      `${role} path is malformed`,
    );
  }
  return resolve(root, value);
}

async function readRegularFile(pathValue, root, role) {
  const candidate = resolveFromRoot(pathValue, root, role);
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch {
    throw new PrepareVacePlansError(
      "INVALID_EVIDENCE",
      `${role} is missing`,
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new PrepareVacePlansError(
      "INVALID_EVIDENCE",
      `${role} must be a regular non-symlink file`,
    );
  }
  const canonicalPath = await realpath(candidate);
  requireUnderRoot(canonicalPath, root, role);
  return {
    bytes: await readFile(canonicalPath),
    metadata,
    path: canonicalPath,
  };
}

async function readJsonEvidence(pathValue, root, role) {
  const file = await readRegularFile(pathValue, root, role);
  if (file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_JSON_BYTES) {
    throw new PrepareVacePlansError(
      "INVALID_EVIDENCE",
      `${role} is empty or exceeds the JSON size limit`,
    );
  }
  let payload;
  try {
    payload = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    throw new PrepareVacePlansError(
      "INVALID_EVIDENCE",
      `${role} is not valid JSON`,
    );
  }
  if (!isObject(payload)) {
    throw new PrepareVacePlansError(
      "INVALID_EVIDENCE",
      `${role} must contain a JSON object`,
    );
  }
  return { ...file, payload, sha256: sha256(file.bytes) };
}

function jsonPointerGet(document, pointer, role) {
  let current = document;
  for (const encodedToken of pointer.slice(1).split("/")) {
    const token = encodedToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current) || !(token in current)) {
      throw new PrepareVacePlansError(
        "INVALID_EVIDENCE",
        `${role} JSON pointer ${pointer} is missing`,
      );
    }
    current = current[token];
  }
  return current;
}

function projectPath(path, root) {
  return relative(root, path).split(sep).join("/");
}

async function verifyTransportReceipt(pathValue, root) {
  const receipt = await readJsonEvidence(
    pathValue,
    root,
    "mask transport evidence receipt",
  );
  const payload = receipt.payload;
  assertExactKeys(
    payload,
    [
      "digest_sha256",
      "kind",
      "roundtrip",
      "schema_version",
      "temporal_matte",
      "transport",
    ],
    "mask transport evidence receipt",
  );
  if (
    payload.schema_version !== 1 ||
    payload.kind !== "framelock_vace_mask_transport_evidence"
  ) {
    throw new PrepareVacePlansError(
      "INVALID_EVIDENCE",
      "mask transport evidence identity differs",
    );
  }
  const declaredDigest = requireSha256(
    payload.digest_sha256,
    "mask transport receipt",
  );
  const unsigned = { ...payload };
  delete unsigned.digest_sha256;
  if (sha256(canonicalBytes(unsigned)) !== declaredDigest) {
    throw new PrepareVacePlansError(
      "MASK_EVIDENCE_MISMATCH",
      "mask transport receipt self-digest differs",
    );
  }
  assertExactKeys(
    payload.transport,
    ["bytes", "media_facts", "path", "sha256"],
    "mask transport record",
  );
  assertExactKeys(
    payload.roundtrip,
    [
      "authoritative_ordered_pixels_sha256",
      "decoded_ordered_pixels_sha256",
      "decoder",
      "exact_equality",
      "frame_count",
      "validator",
    ],
    "mask transport roundtrip record",
  );
  const transportPathValue = jsonPointerGet(
    payload,
    MASK_TRANSPORT_PATH_JSON_POINTER,
    "mask transport receipt",
  );
  const transportSha256 = requireSha256(
    jsonPointerGet(
      payload,
      MASK_TRANSPORT_SHA256_JSON_POINTER,
      "mask transport receipt",
    ),
    "mask transport",
  );
  const transport = await readRegularFile(
    transportPathValue,
    root,
    "sealed mask transport",
  );
  if (
    transport.metadata.size !== payload.transport.bytes ||
    sha256(transport.bytes) !== transportSha256 ||
    payload.roundtrip.exact_equality !== true ||
    payload.roundtrip.frame_count !== 121 ||
    payload.roundtrip.authoritative_ordered_pixels_sha256 !==
      payload.roundtrip.decoded_ordered_pixels_sha256 ||
    payload.transport.media_facts?.frame_count !== 121 ||
    payload.transport.media_facts?.frame_rate?.numerator !== 24 ||
    payload.transport.media_facts?.frame_rate?.denominator !== 1
  ) {
    throw new PrepareVacePlansError(
      "MASK_EVIDENCE_MISMATCH",
      "sealed mask transport differs from its admitted evidence",
    );
  }
  return {
    receiptPath: receipt.path,
    receiptFileSha256: receipt.sha256,
    receiptDigestSha256: declaredDigest,
    transportPath: transport.path,
    transportSha256,
    transportBytes: transport.metadata.size,
  };
}

async function verifyUploadReceipt(pathValue, root, transport) {
  const receipt = await readJsonEvidence(
    pathValue,
    root,
    "mask fal upload receipt",
  );
  const payload = receipt.payload;
  assertExactKeys(
    payload,
    ["schemaVersion", "kind", "uploadedAt", "localFile", "falUrl"],
    "mask fal upload receipt",
  );
  assertExactKeys(
    payload.localFile,
    ["path", "name", "mime", "bytes", "sha256"],
    "mask fal upload local file",
  );
  const uploadedAt = Date.parse(payload.uploadedAt);
  const localFile = await readRegularFile(
    payload.localFile.path,
    root,
    "uploaded mask transport source",
  );
  if (
    payload.schemaVersion !== 1 ||
    payload.kind !== "motion-v1-fal-upload" ||
    !Number.isFinite(uploadedAt) ||
    payload.localFile.mime !== "video/mp4" ||
    payload.localFile.name !== basename(localFile.path) ||
    localFile.path !== transport.transportPath ||
    payload.localFile.sha256 !== transport.transportSha256 ||
    payload.localFile.bytes !== transport.transportBytes ||
    sha256(localFile.bytes) !== transport.transportSha256
  ) {
    throw new PrepareVacePlansError(
      "MASK_EVIDENCE_MISMATCH",
      "fal upload receipt does not bind the sealed mask transport",
    );
  }
  return {
    receiptPath: receipt.path,
    receiptFileSha256: receipt.sha256,
    falUrl: payload.falUrl,
  };
}

function parseDecimal(raw) {
  if (typeof raw !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw)) {
    throw new PrepareVacePlansError(
      "PRICING_MISMATCH",
      "pricing decimals must be fixed-point strings",
    );
  }
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

async function verifyPricing(pathValue, root, now) {
  const receipt = await readJsonEvidence(pathValue, root, "pricing observation");
  const pricing = receipt.payload;
  assertExactKeys(
    pricing,
    [
      "unitPriceUsd",
      "billingUnit",
      "estimatedUnits",
      "estimatedCostUsd",
      "pricingSource",
      "priceObservedAt",
      "priceValidUntil",
    ],
    "pricing observation",
  );
  const observedAt = Date.parse(pricing.priceObservedAt);
  const validUntil = Date.parse(pricing.priceValidUntil);
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(validUntil) ||
    observedAt > now.getTime() ||
    validUntil <= now.getTime() ||
    validUntil <= observedAt
  ) {
    throw new PrepareVacePlansError(
      "PRICING_NOT_CURRENT",
      "Wan VACE pricing observation is not current",
    );
  }
  if (
    pricing.unitPriceUsd !== EXPECTED_PRICING.unitPriceUsd ||
    pricing.estimatedUnits !== EXPECTED_PRICING.estimatedUnits ||
    pricing.estimatedCostUsd !== EXPECTED_PRICING.estimatedCostUsd ||
    typeof pricing.billingUnit !== "string" ||
    !pricing.billingUnit.trim() ||
    typeof pricing.pricingSource !== "string" ||
    !pricing.pricingSource.trim() ||
    parseDecimal(pricing.unitPriceUsd) * parseDecimal(pricing.estimatedUnits) !==
      parseDecimal(pricing.estimatedCostUsd) * 1_000_000n
  ) {
    throw new PrepareVacePlansError(
      "PRICING_MISMATCH",
      "Wan VACE pricing must bind exactly $0.08 x 7.5625 = $0.605",
    );
  }
  return {
    pricing,
    receiptPath: receipt.path,
    receiptFileSha256: receipt.sha256,
  };
}

function makePlans(drafts, upload, transport, pricing, root) {
  const seedOnlySetDigestSha256 = sha256(canonicalBytes(drafts));
  return drafts.map((draft) => {
    const ready = resolveMotionWanVaceMaskUrl(draft, upload.falUrl);
    const submission = prepareMotionWanVaceSubmission(ready);
    const plan = {
      schemaVersion: 1,
      state: "approved_for_submission",
      stage: "moving_environment_reshoot",
      candidateId: draft.candidateId,
      endpoint: submission.endpoint,
      falInput: submission.falInput,
      pricing: pricing.pricing,
      estimatedCostUsd: submission.estimatedCostUsd,
      sourceApproval: draft.source.approvalPath,
      sourceUploadReceipt:
        "artifacts/motion-v1/uploads/canonical-source-upload-02.json",
      sourceCanonicalSha256: draft.source.sha256,
      sourceConstructionManifestDigestSha256:
        "5473fc3a821364eaaa034e89e2b4e4a7f50f641f030dd40df369ff310c49979d",
      environmentSelection:
        draft.environmentReference.selectionPath,
      maskTransportEvidence: {
        transportReceiptPath: projectPath(transport.receiptPath, root),
        transportReceiptFileSha256: transport.receiptFileSha256,
        transportReceiptDigestSha256: transport.receiptDigestSha256,
        transportPathJsonPointer: MASK_TRANSPORT_PATH_JSON_POINTER,
        transportSha256JsonPointer: MASK_TRANSPORT_SHA256_JSON_POINTER,
        transportPath: projectPath(transport.transportPath, root),
        transportSha256: transport.transportSha256,
        transportBytes: transport.transportBytes,
        uploadReceiptPath: projectPath(upload.receiptPath, root),
        uploadReceiptFileSha256: upload.receiptFileSha256,
        falUrl: upload.falUrl,
      },
      pricingEvidence: {
        path: projectPath(pricing.receiptPath, root),
        fileSha256: pricing.receiptFileSha256,
      },
      candidateEvidence: {
        candidateIndex: draft.candidateIndex,
        planVersion: draft.planVersion,
        seed: draft.falInputTemplate.seed,
        source: draft.source,
        environmentReference: draft.environmentReference,
        draftDigestSha256: sha256(canonicalBytes(draft)),
        seedOnlySetDigestSha256,
      },
    };
    return {
      ...plan,
      digestSha256: sha256(canonicalBytes(plan)),
    };
  });
}

async function outputExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writePlansExclusive(outputValue, plans, root) {
  let target = requireUnderRoot(
    resolveFromRoot(outputValue, root, "VACE output directory"),
    root,
    "VACE output directory",
  );
  if (await outputExists(target)) {
    throw new PrepareVacePlansError(
      "OUTPUT_EXISTS",
      "VACE output directory already exists and will not be overwritten",
    );
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(dirname(target));
  requireUnderRoot(canonicalParent, root, "VACE output parent", true);
  target = resolve(canonicalParent, basename(target));
  if (await outputExists(target)) {
    throw new PrepareVacePlansError(
      "OUTPUT_EXISTS",
      "VACE output directory already exists and will not be overwritten",
    );
  }
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new PrepareVacePlansError(
        "OUTPUT_EXISTS",
        "VACE output directory already exists and will not be overwritten",
      );
    }
    throw error;
  }
  let complete = false;
  try {
    const outputs = [];
    for (const plan of plans) {
      const path = resolve(target, `${plan.candidateId}.json`);
      const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
      const handle = await open(path, "wx", 0o400);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(path, 0o400);
      outputs.push({
        path: projectPath(path, root),
        sha256: sha256(bytes),
        candidateId: plan.candidateId,
      });
    }
    const directoryHandle = await open(target, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    complete = true;
    return outputs;
  } finally {
    if (!complete) {
      await rm(target, { recursive: true, force: true });
    }
  }
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.help) {
    console.log(usage());
    return;
  }
  const root = await realpath(process.cwd());
  const drafts = buildMotionWanVaceCandidateDrafts();
  const transport = await verifyTransportReceipt(
    arguments_.maskTransportReceipt,
    root,
  );
  const upload = await verifyUploadReceipt(
    arguments_.maskUploadReceipt,
    root,
    transport,
  );
  const pricing = await verifyPricing(arguments_.pricing, root, new Date());
  const plans = makePlans(drafts, upload, transport, pricing, root);
  const outputs = await writePlansExclusive(
    arguments_.outputDirectory,
    plans,
    root,
  );
  console.log(
    JSON.stringify(
      {
        kind: "motion-v1-wan-vace-plan-set",
        estimatedTotalCostUsd: "1.815",
        falCallsMade: 0,
        outputs,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "VACE_PLAN_PREPARATION_FAILED";
  const message = error instanceof Error ? error.message : "VACE plan preparation failed";
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
});
