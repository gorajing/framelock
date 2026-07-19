import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { embeddedCanonicalJsonSha256 } from "../demo/canonical-json";
import type { LocalJobRecord } from "./local-job-store";
import {
  type HashBoundAsset,
  readHashBoundJson,
  RealJobMediaError,
} from "./real-job-media-stream";

export { parseSingleByteRange, RealJobMediaError } from "./real-job-media-stream";

const MIB = 1024 * 1024;
const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePathSchema = z.string().min(1).refine(isAbsolute);
const assetSchema = z.enum([
  "source",
  "mask",
  "generated",
  "source-60",
  "generated-60",
  "overlay-0",
  "overlay-60",
  "overlay-120",
  "composite-60",
  "protected-core-60",
  "boundary-ring-60",
  "difference-heatmap-60",
  "preview",
  "proof-manifest",
  "audit",
  "run-manifest",
  "canonical-frames",
  "canonical-export-manifest",
  "corruption-manifest",
  "corruption-audit",
  "corruption-summary",
]);

type AssetName = z.infer<typeof assetSchema>;

type AssetPolicy = Readonly<{
  domain: "jobs" | "runs";
  relativePath: readonly string[];
  contentType: string;
  disposition: HashBoundAsset["disposition"];
  maxBytes: number;
  states: ReadonlySet<LocalJobRecord["state"]>;
}>;

const everyState = new Set<LocalJobRecord["state"]>([
  "validated",
  "submitting",
  "submission_unknown",
  "submitted",
  "generated",
  "not_comparable",
  "composited",
  "verified",
  "failed",
]);
const generatedStates = new Set<LocalJobRecord["state"]>([
  "generated",
  "not_comparable",
  "composited",
  "verified",
]);
const overlayStates = new Set<LocalJobRecord["state"]>([
  "generated",
  "composited",
  "verified",
]);
const verifiedState = new Set<LocalJobRecord["state"]>(["verified"]);

const policies: Record<AssetName, AssetPolicy> = {
  source: mediaPolicy("runs", ["inputs", "source.mp4"], "video/mp4", 50 * MIB, everyState),
  mask: mediaPolicy("runs", ["inputs", "foreground.png"], "image/png", 10 * MIB, everyState),
  generated: mediaPolicy("jobs", ["model-output.mp4"], "video/mp4", 256 * MIB, generatedStates),
  "source-60": mediaPolicy("runs", ["proof", "source_frames", "frame_000060.png"], "image/png", 16 * MIB, verifiedState),
  "generated-60": mediaPolicy("jobs", ["canonical", "generated_frames", "frame_000060.png"], "image/png", 16 * MIB, verifiedState),
  "overlay-0": mediaPolicy("jobs", ["canonical", "geometry_overlays", "overlay_000000.png"], "image/png", 32 * MIB, overlayStates),
  "overlay-60": mediaPolicy("jobs", ["canonical", "geometry_overlays", "overlay_000060.png"], "image/png", 32 * MIB, overlayStates),
  "overlay-120": mediaPolicy("jobs", ["canonical", "geometry_overlays", "overlay_000120.png"], "image/png", 32 * MIB, overlayStates),
  "composite-60": mediaPolicy("jobs", ["canonical", "composite_frames", "composite_000060.png"], "image/png", 16 * MIB, verifiedState),
  "protected-core-60": mediaPolicy("runs", ["proof", "masks", "protected_core.png"], "image/png", 16 * MIB, verifiedState),
  "boundary-ring-60": mediaPolicy("runs", ["proof", "masks", "feather_boundary.png"], "image/png", 16 * MIB, verifiedState),
  "difference-heatmap-60": mediaPolicy("jobs", ["canonical", "difference_heatmap_000060.png"], "image/png", 16 * MIB, verifiedState),
  preview: mediaPolicy("jobs", ["canonical", "preview.mp4"], "video/mp4", 256 * MIB, verifiedState),
  "proof-manifest": downloadPolicy("jobs", ["canonical", "proof_manifest.json"], "application/json; charset=utf-8", "proof_manifest.json", 16 * MIB, verifiedState),
  audit: downloadPolicy("jobs", ["canonical", "audit.json"], "application/json; charset=utf-8", "audit.json", 32 * MIB, verifiedState),
  "run-manifest": downloadPolicy("jobs", ["canonical", "run_manifest.json"], "application/json; charset=utf-8", "run_manifest.json", 4 * MIB, verifiedState),
  "canonical-frames": downloadPolicy("jobs", ["canonical", "canonical_frames.zip"], "application/zip", "canonical_frames.zip", 512 * MIB, verifiedState),
  "canonical-export-manifest": downloadPolicy("jobs", ["canonical", "canonical_frames_manifest.json"], "application/json; charset=utf-8", "canonical_frames_manifest.json", 4 * MIB, verifiedState),
  "corruption-manifest": downloadPolicy("jobs", ["canonical", "corruption_fixture", "corruption_manifest.json"], "application/json; charset=utf-8", "corruption_manifest.json", 16 * MIB, verifiedState),
  "corruption-audit": downloadPolicy("jobs", ["canonical", "corruption_fixture", "corruption_audit.json"], "application/json; charset=utf-8", "corruption_audit.json", 32 * MIB, verifiedState),
  "corruption-summary": downloadPolicy("jobs", ["canonical", "corruption_fixture", "corruption_summary.json"], "application/json; charset=utf-8", "corruption_summary.json", 64 * 1024, verifiedState),
};

const overlayEntry = (index: 0 | 60 | 120) =>
  z.object({
    source_index: z.literal(index),
    path: absolutePathSchema,
    sha256: sha256Schema,
  }).passthrough();

const jobBindingSchema = z.object({
  id: jobIdSchema,
  endpoint: z.string().min(1),
  request_id: z.string().min(1),
  generation_digest: sha256Schema,
  source_sha256: sha256Schema,
  restoration_mask_sha256: sha256Schema,
  model_output_sha256: sha256Schema,
}).passthrough();

const reviewManifestSchema = z.object({
  schema_version: z.union([z.literal(1), z.literal(2)]),
  job: jobBindingSchema,
  prepared_foreground_mask: z.object({
    path: absolutePathSchema,
    sha256: sha256Schema,
  }).passthrough(),
  generated_decode_provenance: z.object({
    source_media_path: absolutePathSchema,
    source_file_sha256: sha256Schema,
  }).passthrough(),
  geometry_overlays: z.tuple([
    overlayEntry(0),
    overlayEntry(60),
    overlayEntry(120),
  ]),
  digest_sha256: sha256Schema,
}).passthrough();

const proofFrameSchema = z.object({
  index: z.number().int().min(0).max(120),
  source_path: absolutePathSchema,
  generated_path: absolutePathSchema,
  composite_path: absolutePathSchema,
  core_mask_path: absolutePathSchema,
  source_file_sha256: sha256Schema,
  generated_file_sha256: sha256Schema,
  composite_file_sha256: sha256Schema,
  core_mask_file_sha256: sha256Schema,
}).passthrough();

const proofManifestSchema = z.object({
  schema_version: z.literal(2),
  generation_binding: z.object({
    prepared_foreground_mask_path: absolutePathSchema,
    prepared_foreground_mask_file_sha256: sha256Schema,
    generated_media_provenance: z.object({
      source_media_path: absolutePathSchema,
      source_file_sha256: sha256Schema,
    }).passthrough(),
  }).passthrough(),
  frames: z.array(proofFrameSchema).length(121),
}).passthrough();

const sourceAudioBindingSchema = z
  .object({
    manifest_path: absolutePathSchema,
    manifest_sha256: sha256Schema,
    source_audio_present: z.boolean(),
    normalized_audio_path: absolutePathSchema.nullable(),
    normalized_audio_sha256: sha256Schema.nullable(),
    normalization_operation: z.enum([
      "absent_source_no_track",
      "resample_stereo_then_pad_and_trim_to_242000_samples",
    ]),
    target_sample_count: z.literal(242_000),
    preview_audio_policy: z.enum([
      "silent_no_source_audio",
      "normalized_source_pcm_delivery_encode",
    ]),
    claim_scope: z.literal("outside_pixel_verification_claim"),
  })
  .strict()
  .superRefine((audio, context) => {
    const present = audio.source_audio_present;
    if (
      present !== (audio.normalized_audio_path !== null) ||
      present !== (audio.normalized_audio_sha256 !== null) ||
      audio.normalization_operation !==
        (present
          ? "resample_stereo_then_pad_and_trim_to_242000_samples"
          : "absent_source_no_track") ||
      audio.preview_audio_policy !==
        (present
          ? "normalized_source_pcm_delivery_encode"
          : "silent_no_source_audio")
    ) {
      context.addIssue({
        code: "custom",
        message: "source-audio binding has inconsistent presence semantics",
      });
    }
  });

const runManifestSchema = z
  .object({
    schema_version: z.union([z.literal(5), z.literal(6)]),
    job: jobBindingSchema,
    visual_geometry_approval: z
      .object({
        reviewed_source_indices: z.tuple([
          z.literal(0),
          z.literal(60),
          z.literal(120),
        ]),
        reviewed_overlay_sha256s: z.tuple([
          sha256Schema,
          sha256Schema,
          sha256Schema,
        ]),
      })
      .passthrough(),
    proof: z
      .object({
        manifest_path: absolutePathSchema,
        manifest_sha256: sha256Schema,
        audit_path: absolutePathSchema,
        audit_sha256: sha256Schema,
      })
      .passthrough(),
    preview: z
      .object({ path: absolutePathSchema, sha256: sha256Schema })
      .passthrough(),
    exports: z
      .object({
        canonical_frames: z
          .object({
            archive_path: absolutePathSchema,
            archive_sha256: sha256Schema,
            manifest_path: absolutePathSchema,
            manifest_sha256: sha256Schema,
          })
          .passthrough(),
      })
      .passthrough(),
    visualizations: z
      .object({
        protected_core_frame_60: z
          .object({
            path: absolutePathSchema,
            sha256: sha256Schema,
            claim_scope: z.literal("exactness_contract_mask"),
          })
          .strict(),
        boundary_ring_frame_60: z
          .object({
            path: absolutePathSchema,
            sha256: sha256Schema,
            claim_scope: z.literal("visual_only_not_exactness_contract"),
          })
          .strict(),
        difference_heatmap_frame_60: z
          .object({
            path: absolutePathSchema,
            sha256: sha256Schema,
            source_file_sha256: sha256Schema,
            composite_file_sha256: sha256Schema,
            claim_scope: z.literal("visual_only_not_verifier_output"),
          })
          .strict(),
      })
      .strict(),
    negative_test: z
      .object({
        manifest_path: absolutePathSchema,
        manifest_sha256: sha256Schema,
        audit_path: absolutePathSchema,
        audit_sha256: sha256Schema,
        summary_path: absolutePathSchema,
        summary_sha256: sha256Schema,
      })
      .passthrough(),
    audio: sourceAudioBindingSchema.optional(),
    digest_sha256: sha256Schema,
  })
  .passthrough()
  .superRefine((manifest, context) => {
    if (manifest.schema_version === 6 && !manifest.audio) {
      context.addIssue({
        code: "custom",
        path: ["audio"],
        message: "run schema v6 requires its source-audio binding",
      });
    }
    if (manifest.schema_version === 5 && manifest.audio) {
      context.addIssue({
        code: "custom",
        path: ["audio"],
        message: "run schema v5 forbids an unversioned source-audio binding",
      });
    }
  });

export function parseRealJobMediaJobId(raw: string): string {
  const parsed = jobIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RealJobMediaError("INVALID_JOB_ID");
  }
  return parsed.data;
}

export async function resolveRealJobAsset(input: {
  jobsRoot: string;
  runsRoot: string;
  record: LocalJobRecord;
  asset: string;
}): Promise<HashBoundAsset> {
  const parsedAsset = assetSchema.safeParse(input.asset);
  if (!parsedAsset.success) {
    throw new RealJobMediaError("UNKNOWN_ASSET");
  }
  const jobId = parseRealJobMediaJobId(input.record.id);
  const name = parsedAsset.data;
  const policy = policies[name];
  if (!policy.states.has(input.record.state)) {
    throw new RealJobMediaError("ASSET_NOT_AVAILABLE");
  }
  const paths = fixedPaths(input.jobsRoot, input.runsRoot, jobId);
  const expectedSha256 = await expectedAssetSha256(
    name,
    input.record,
    paths,
  );
  const root = policy.domain === "jobs" ? paths.jobRoot : paths.runRoot;
  return {
    path: resolve(root, ...policy.relativePath),
    root,
    expectedSha256,
    maxBytes: policy.maxBytes,
    contentType: policy.contentType,
    disposition: policy.disposition,
  };
}

async function expectedAssetSha256(
  asset: AssetName,
  record: LocalJobRecord,
  paths: ReturnType<typeof fixedPaths>,
): Promise<string> {
  switch (asset) {
    case "source":
      return record.generation.sourceSha256;
    case "mask":
      return record.generation.editMaskSha256;
    case "generated":
      return modelOutputSha256(record);
    case "proof-manifest":
      return verifiedEvidence(record).proofManifestSha256;
    case "audit":
      return verifiedEvidence(record).auditSha256;
    case "run-manifest":
      return verifiedEvidence(record).runManifestSha256;
    case "preview":
      return verifiedEvidence(record).previewSha256;
    case "overlay-0":
    case "overlay-60":
    case "overlay-120": {
      const tupleIndex = asset === "overlay-0" ? 0 : asset === "overlay-60" ? 1 : 2;
      if (record.state === "verified") {
        return (await loadAnchoredRun(record, paths)).visual_geometry_approval
          .reviewed_overlay_sha256s[tupleIndex];
      }
      return (await loadSelfDigestedReview(record, paths)).geometry_overlays[
        tupleIndex
      ].sha256;
    }
    case "source-60":
      return (await loadAnchoredProof(record, paths)).frames[60].source_file_sha256;
    case "generated-60":
      return (await loadAnchoredProof(record, paths)).frames[60]
        .generated_file_sha256;
    case "composite-60":
      return (await loadAnchoredProof(record, paths)).frames[60]
        .composite_file_sha256;
    case "protected-core-60":
      return (await loadAnchoredRun(record, paths)).visualizations
        .protected_core_frame_60.sha256;
    case "boundary-ring-60":
      return (await loadAnchoredRun(record, paths)).visualizations
        .boundary_ring_frame_60.sha256;
    case "difference-heatmap-60":
      return (await loadAnchoredRun(record, paths)).visualizations
        .difference_heatmap_frame_60.sha256;
    case "canonical-frames":
      return (await loadAnchoredRun(record, paths)).exports.canonical_frames
        .archive_sha256;
    case "canonical-export-manifest":
      return (await loadAnchoredRun(record, paths)).exports.canonical_frames
        .manifest_sha256;
    case "corruption-manifest":
      return (await loadAnchoredRun(record, paths)).negative_test
        .manifest_sha256;
    case "corruption-audit":
      return (await loadAnchoredRun(record, paths)).negative_test.audit_sha256;
    case "corruption-summary":
      return (await loadAnchoredRun(record, paths)).negative_test
        .summary_sha256;
  }
}

async function loadSelfDigestedReview(
  record: LocalJobRecord,
  paths: ReturnType<typeof fixedPaths>,
) {
  const loaded = await readHashBoundJson({
    path: paths.reviewManifest,
    root: paths.jobRoot,
    maxBytes: 16 * MIB,
  });
  const review = parseEvidence(reviewManifestSchema, loaded.json);
  assertJobBinding(review.job, record);
  assertExactPath(review.prepared_foreground_mask.path, paths.mask);
  assertExactPath(
    review.generated_decode_provenance.source_media_path,
    paths.generated,
  );
  if (
    review.prepared_foreground_mask.sha256 !==
      record.generation.editMaskSha256 ||
    review.generated_decode_provenance.source_file_sha256 !==
      modelOutputSha256(record) ||
    embeddedCanonicalJsonSha256(review) !== review.digest_sha256
  ) {
    throw new RealJobMediaError("ASSET_INTEGRITY_FAILED");
  }
  review.geometry_overlays.forEach((overlay, index) => {
    const sourceIndex = [0, 60, 120][index];
    assertExactPath(
      overlay.path,
      join(
        paths.canonicalRoot,
        "geometry_overlays",
        `overlay_${String(sourceIndex).padStart(6, "0")}.png`,
      ),
    );
  });
  return review;
}

async function loadAnchoredProof(
  record: LocalJobRecord,
  paths: ReturnType<typeof fixedPaths>,
) {
  const expected = verifiedEvidence(record);
  const loaded = await readHashBoundJson({
    path: paths.proofManifest,
    root: paths.jobRoot,
    maxBytes: policies["proof-manifest"].maxBytes,
    expectedSha256: expected.proofManifestSha256,
  });
  const proof = parseEvidence(proofManifestSchema, loaded.json);
  assertExactPath(
    proof.generation_binding.prepared_foreground_mask_path,
    paths.mask,
  );
  assertExactPath(
    proof.generation_binding.generated_media_provenance.source_media_path,
    paths.generated,
  );
  if (
    proof.generation_binding.prepared_foreground_mask_file_sha256 !==
      record.generation.editMaskSha256 ||
    proof.generation_binding.generated_media_provenance.source_file_sha256 !==
      modelOutputSha256(record)
  ) {
    throw new RealJobMediaError("ASSET_INTEGRITY_FAILED");
  }
  const frame = proof.frames[60];
  if (frame.index !== 60) {
    throw new RealJobMediaError("ASSET_INTEGRITY_FAILED");
  }
  assertExactPath(frame.source_path, paths.sourceFrame60);
  assertExactPath(frame.generated_path, paths.generatedFrame60);
  assertExactPath(frame.composite_path, paths.compositeFrame60);
  assertExactPath(frame.core_mask_path, paths.coreMaskFrame60);
  return proof;
}

async function loadAnchoredRun(
  record: LocalJobRecord,
  paths: ReturnType<typeof fixedPaths>,
) {
  const expected = verifiedEvidence(record);
  const loaded = await readHashBoundJson({
    path: paths.runManifest,
    root: paths.jobRoot,
    maxBytes: policies["run-manifest"].maxBytes,
    expectedSha256: expected.runManifestSha256,
  });
  const run = parseEvidence(runManifestSchema, loaded.json);
  assertJobBinding(run.job, record);
  assertExactPath(run.proof.manifest_path, paths.proofManifest);
  assertExactPath(run.proof.audit_path, paths.audit);
  assertExactPath(run.preview.path, paths.preview);
  assertExactPath(
    run.exports.canonical_frames.archive_path,
    paths.canonicalArchive,
  );
  assertExactPath(
    run.exports.canonical_frames.manifest_path,
    paths.canonicalExportManifest,
  );
  assertExactPath(run.negative_test.manifest_path, paths.corruptionManifest);
  assertExactPath(run.negative_test.audit_path, paths.corruptionAudit);
  assertExactPath(run.negative_test.summary_path, paths.corruptionSummary);
  assertExactPath(
    run.visualizations.protected_core_frame_60.path,
    paths.protectedCore,
  );
  assertExactPath(
    run.visualizations.boundary_ring_frame_60.path,
    paths.boundaryRing,
  );
  assertExactPath(
    run.visualizations.difference_heatmap_frame_60.path,
    paths.differenceHeatmap,
  );
  const proof = await loadAnchoredProof(record, paths);
  const frame = proof.frames[60];
  if (
    run.proof.manifest_sha256 !== expected.proofManifestSha256 ||
    run.proof.audit_sha256 !== expected.auditSha256 ||
    run.preview.sha256 !== expected.previewSha256 ||
    embeddedCanonicalJsonSha256(run) !== run.digest_sha256 ||
    run.visualizations.protected_core_frame_60.sha256 !==
      frame.core_mask_file_sha256 ||
    run.visualizations.difference_heatmap_frame_60.source_file_sha256 !==
      frame.source_file_sha256 ||
    run.visualizations.difference_heatmap_frame_60.composite_file_sha256 !==
      frame.composite_file_sha256
  ) {
    throw new RealJobMediaError("ASSET_INTEGRITY_FAILED");
  }
  return run;
}

function fixedPaths(jobsRoot: string, runsRoot: string, jobId: string) {
  const jobRoot = resolve(jobsRoot, jobId);
  const runRoot = resolve(runsRoot, jobId);
  const canonicalRoot = join(jobRoot, "canonical");
  return {
    jobRoot,
    runRoot,
    canonicalRoot,
    source: join(runRoot, "inputs", "source.mp4"),
    mask: join(runRoot, "inputs", "foreground.png"),
    generated: join(jobRoot, "model-output.mp4"),
    reviewManifest: join(canonicalRoot, "review_manifest.json"),
    proofManifest: join(canonicalRoot, "proof_manifest.json"),
    audit: join(canonicalRoot, "audit.json"),
    preview: join(canonicalRoot, "preview.mp4"),
    runManifest: join(canonicalRoot, "run_manifest.json"),
    sourceFrame60: join(
      runRoot,
      "proof",
      "source_frames",
      "frame_000060.png",
    ),
    generatedFrame60: join(
      canonicalRoot,
      "generated_frames",
      "frame_000060.png",
    ),
    compositeFrame60: join(
      canonicalRoot,
      "composite_frames",
      "composite_000060.png",
    ),
    coreMaskFrame60: join(
      runRoot,
      "proof",
      "core_masks",
      "core_000060.png",
    ),
    protectedCore: join(runRoot, "proof", "masks", "protected_core.png"),
    boundaryRing: join(runRoot, "proof", "masks", "feather_boundary.png"),
    differenceHeatmap: join(
      canonicalRoot,
      "difference_heatmap_000060.png",
    ),
    canonicalArchive: join(canonicalRoot, "canonical_frames.zip"),
    canonicalExportManifest: join(
      canonicalRoot,
      "canonical_frames_manifest.json",
    ),
    corruptionManifest: join(
      canonicalRoot,
      "corruption_fixture",
      "corruption_manifest.json",
    ),
    corruptionAudit: join(
      canonicalRoot,
      "corruption_fixture",
      "corruption_audit.json",
    ),
    corruptionSummary: join(
      canonicalRoot,
      "corruption_fixture",
      "corruption_summary.json",
    ),
  };
}

function assertJobBinding(
  binding: z.infer<typeof jobBindingSchema>,
  record: LocalJobRecord,
): void {
  const outputSha256 = modelOutputSha256(record);
  if (
    binding.id !== record.id ||
    binding.endpoint !== record.generation.endpoint ||
    binding.request_id !== record.fal?.requestId ||
    binding.generation_digest !== record.generation.digest ||
    binding.source_sha256 !== record.generation.sourceSha256 ||
    binding.restoration_mask_sha256 !== record.generation.editMaskSha256 ||
    binding.model_output_sha256 !== outputSha256
  ) {
    throw new RealJobMediaError("ASSET_INTEGRITY_FAILED");
  }
}

function modelOutputSha256(record: LocalJobRecord): string {
  const fal = record.fal;
  if (
    !fal?.modelOutput ||
    fal.generationDigest !== record.generation.digest ||
    fal.endpoint !== record.generation.endpoint
  ) {
    throw new RealJobMediaError("ASSET_NOT_AVAILABLE");
  }
  return fal.modelOutput.sha256;
}

function verifiedEvidence(record: LocalJobRecord): {
  proofManifestSha256: string;
  auditSha256: string;
  runManifestSha256: string;
  previewSha256: string;
} {
  if (
    record.state !== "verified" ||
    !record.composition ||
    !record.verification
  ) {
    throw new RealJobMediaError("ASSET_NOT_AVAILABLE");
  }
  return {
    proofManifestSha256: record.composition.proofManifestSha256,
    auditSha256: record.verification.auditSha256,
    runManifestSha256: record.verification.runManifestSha256,
    previewSha256: record.verification.previewSha256,
  };
}

function parseEvidence<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RealJobMediaError("ASSET_INTEGRITY_FAILED");
  }
  return result.data;
}

function assertExactPath(candidate: string, expected: string): void {
  if (resolve(candidate) !== resolve(expected)) {
    throw new RealJobMediaError("ASSET_INTEGRITY_FAILED");
  }
}

function mediaPolicy(
  domain: AssetPolicy["domain"],
  relativePath: readonly string[],
  contentType: string,
  maxBytes: number,
  states: AssetPolicy["states"],
): AssetPolicy {
  return {
    domain,
    relativePath,
    contentType,
    disposition: "inline",
    maxBytes,
    states,
  };
}

function downloadPolicy(
  domain: AssetPolicy["domain"],
  relativePath: readonly string[],
  contentType: string,
  filename: string,
  maxBytes: number,
  states: AssetPolicy["states"],
): AssetPolicy {
  return {
    domain,
    relativePath,
    contentType,
    disposition: `attachment; filename="${filename}"`,
    maxBytes,
    states,
  };
}
