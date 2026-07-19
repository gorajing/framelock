import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  LocalJobStore,
  type LocalJobRecord,
} from "../jobs/local-job-store";
import { embeddedCanonicalJsonSha256 } from "./canonical-json";
import {
  resolveDemoMediaAsset,
  type DemoMediaId,
} from "./demo-media";
import { validateDemoArtifacts } from "./demo-summary";

export type { ValidatedDemoEvidence } from "./demo-summary";

export const DEFAULT_STATIC_DEMO_EVIDENCE_ROOT =
  "demo-evidence/static/root" as const;

type StaticDemoReadOptions = Readonly<{ evidenceRoot?: string }>;

function resolvedEvidenceRoot(options: StaticDemoReadOptions): string {
  return options.evidenceRoot === undefined
    ? join(process.cwd(), DEFAULT_STATIC_DEMO_EVIDENCE_ROOT)
    : resolve(/*turbopackIgnore: true*/ options.evidenceRoot);
}
const FRAME_IDS = {
  source: ["source-frame-0", "source-frame-60", "source-frame-120"],
  raw: ["raw-frame-0", "raw-frame-60", "raw-frame-120"],
  composite: ["composite-frame-0", "composite-frame-60", "composite-frame-120"],
  overlay: ["overlay-frame-0", "overlay-frame-60", "overlay-frame-120"],
} as const satisfies Record<string, readonly DemoMediaId[]>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJsonWithHash(path: string) {
  const bytes = await readFile(path);
  return { hash: sha256(bytes), json: JSON.parse(bytes.toString("utf8")) as unknown };
}

async function readMediaBytes(root: string, id: DemoMediaId) {
  const asset = resolveDemoMediaAsset(id);
  if (!asset) throw new Error(`Unknown fixed demo media: ${id}`);
  const bytes = await readFile(join(root, asset.relativePath));
  if (bytes.length <= 0 || bytes.length > asset.maxBytes) {
    throw new Error(`Fixed demo media violates its byte contract: ${id}`);
  }
  return { asset, bytes, hash: sha256(bytes) };
}

async function readValidatedDemoEvidence(
  options: StaticDemoReadOptions = {},
) {
  const root = resolvedEvidenceRoot(options);
  const jobsRoot = join(root, "artifacts", "jobs");
  const klingRoot = join(
    jobsRoot,
    "synthetic-hero-kling-o3-001",
  );
  const canonicalRoot = join(klingRoot, "canonical");
  const ltxRoot = join(jobsRoot, "synthetic-hero-ltx-001");
  const sourceProofManifest = join(
    root,
    "artifacts",
    "runs",
    "synthetic-hero-offline-hardening-v2",
    "proof",
    "proof_manifest.json",
  );
  const mediaIds = [
    "source-video",
    "raw-video",
    "canonical-preview",
    ...FRAME_IDS.source,
    ...FRAME_IDS.raw,
    ...FRAME_IDS.composite,
    ...FRAME_IDS.overlay,
  ] as const satisfies readonly DemoMediaId[];
  const [kling, ltx, audit, proofManifest, reviewManifest, runManifest, sourceProofHash, media] =
    await Promise.all([
      readJsonWithHash(join(klingRoot, "assessment", "comparability.json")),
      readJsonWithHash(join(ltxRoot, "assessment", "comparability.json")),
      readJsonWithHash(join(canonicalRoot, "audit.json")),
      readJsonWithHash(join(canonicalRoot, "proof_manifest.json")),
      readJsonWithHash(join(canonicalRoot, "review_manifest.json")),
      readJsonWithHash(join(canonicalRoot, "run_manifest.json")),
      readFile(sourceProofManifest).then(sha256),
      Promise.all(mediaIds.map((id) => readMediaBytes(root, id))),
    ]);
  const mediaById = new Map(mediaIds.map((id, index) => [id, media[index]]));
  const hashes = (ids: readonly DemoMediaId[]) =>
    ids.map((id) => mediaById.get(id)!.hash) as [string, string, string];
  const validated = validateDemoArtifacts({
    klingAssessment: kling.json,
    ltxAssessment: ltx.json,
    proofManifest: proofManifest.json,
    reviewManifest: reviewManifest.json,
    audit: audit.json,
    runManifest: runManifest.json,
    integrity: {
      klingAssessmentSha256: kling.hash,
      ltxAssessmentSha256: ltx.hash,
      auditSha256: audit.hash,
      proofManifestSha256: proofManifest.hash,
      reviewManifestSha256: reviewManifest.hash,
      reviewManifestCanonicalDigestSha256: embeddedCanonicalJsonSha256(reviewManifest.json),
      runManifestSha256: runManifest.hash,
      runManifestCanonicalDigestSha256: embeddedCanonicalJsonSha256(runManifest.json),
      sourceProofManifestSha256: sourceProofHash,
      sourceVideoSha256: mediaById.get("source-video")!.hash,
      rawVideoSha256: mediaById.get("raw-video")!.hash,
      previewVideoSha256: mediaById.get("canonical-preview")!.hash,
      servedFrames: {
        source: hashes(FRAME_IDS.source),
        raw: hashes(FRAME_IDS.raw),
        composite: hashes(FRAME_IDS.composite),
        overlay: hashes(FRAME_IDS.overlay),
      },
    },
  });
  return { ...validated, jobsRoot, mediaById };
}

type ValidatedDemo = Awaited<ReturnType<typeof readValidatedDemoEvidence>>;

function generationMatches(
  record: LocalJobRecord,
  evidence:
    | ValidatedDemo["evidence"]["kling"]
    | ValidatedDemo["evidence"]["ltx"],
): boolean {
  return (
    record.id === evidence.jobId &&
    record.generation.digest === evidence.generationDigest &&
    record.generation.endpoint === evidence.endpoint &&
    record.fal?.requestId === evidence.requestId &&
    record.fal.generationDigest === evidence.generationDigest &&
    record.fal.endpoint === evidence.endpoint &&
    record.fal.modelOutput?.sha256 === evidence.modelOutputSha256
  );
}

function terminalRecordsMatch(
  kling: LocalJobRecord,
  ltx: LocalJobRecord,
  validated: ValidatedDemo,
): boolean {
  const { evidence } = validated;
  const verification = kling.verification;
  return (
    generationMatches(kling, evidence.kling) &&
    kling.state === "verified" &&
    kling.assessment?.verdict === "comparable" &&
    kling.assessment.sha256 === evidence.kling.assessmentSha256 &&
    kling.composition?.proofManifestSha256 ===
      evidence.proof.manifestSha256 &&
    verification?.auditSha256 === evidence.proof.auditSha256 &&
    verification.runManifestSha256 === evidence.proof.runSha256 &&
    verification.previewSha256 === evidence.proof.previewSha256 &&
    verification.framesAudited === evidence.audit.framesAudited &&
    verification.framesWithNonEmptyCore ===
      evidence.audit.framesWithProtectedCore &&
    verification.totalCorePixels ===
      evidence.audit.totalProtectedCorePixels &&
    verification.changedCoreChannelSamples ===
      evidence.audit.changedCoreChannelSamples &&
    verification.worstMaxChannelDelta ===
      evidence.audit.maximumChannelDelta &&
    verification.coreHashMatchCount === evidence.audit.coreHashMatches &&
    generationMatches(ltx, evidence.ltx) &&
    ltx.state === "not_comparable" &&
    ltx.assessment?.verdict === "not_comparable" &&
    ltx.assessment.sha256 === evidence.ltx.assessmentSha256
  );
}

async function readOptionalVerifiedDemoEvidence(
  options: StaticDemoReadOptions = {},
): Promise<ValidatedDemo | null> {
  try {
    const validated = await readValidatedDemoEvidence(options);
    const store = new LocalJobStore(validated.jobsRoot);
    const [kling, ltx] = await Promise.all([
      store.readJob(validated.evidence.kling.jobId),
      store.readJob(validated.evidence.ltx.jobId),
    ]);
    return terminalRecordsMatch(kling, ltx, validated) ? validated : null;
  } catch {
    return null;
  }
}

export async function readDemoSummary(
  options: StaticDemoReadOptions = {},
) {
  const validated = await readOptionalVerifiedDemoEvidence(options);
  return validated?.summary ?? null;
}

export async function readVerifiedDemoMediaAsset(
  id: DemoMediaId,
  options: StaticDemoReadOptions = {},
) {
  const validated = await readOptionalVerifiedDemoEvidence(options);
  return validated?.mediaById.get(id) ?? null;
}
