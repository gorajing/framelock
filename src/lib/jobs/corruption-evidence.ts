import { z } from "zod";

import { canonicalJsonSha256 } from "../demo/canonical-json";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const absolutePathSchema = z.string().startsWith("/");
const fixtureSchema = z.literal(
  "one_channel_one_pixel_protected_core_corruption",
);

const frameSchema = z
  .object({
    index: z.number().int().min(0).max(120),
    source_path: absolutePathSchema,
    core_mask_path: absolutePathSchema,
    composite_path: absolutePathSchema,
    source_file_sha256: sha256Schema,
    source_rgb_sha256: sha256Schema,
    core_mask_file_sha256: sha256Schema,
    composite_file_sha256: sha256Schema,
  })
  .passthrough();

const manifestSchema = z
  .object({
    schema_version: z.union([z.literal(1), z.literal(2)]),
    expected_width: z.literal(1280),
    expected_height: z.literal(720),
    expected_frame_count: z.literal(121),
    ingest_schema_version: z.literal(1),
    ingest_digest_sha256: sha256Schema,
    mask_parameters: z
      .object({
        foreground_threshold: z.number().int(),
        erosion_radius: z.number().int(),
      })
      .strict(),
    media_provenance: z.union([
      z.record(z.string(), z.unknown()),
      z.null(),
    ]),
    generation_binding: z.union([
      z.record(z.string(), z.unknown()),
      z.null(),
    ]),
    digest_sha256: sha256Schema,
    frames: z.array(frameSchema).length(121),
  })
  .passthrough();

const auditSchema = z
  .object({
    schema_version: z.literal(1),
    claim: z.null(),
    manifest: manifestSchema,
    audit: z
      .object({
        passed: z.literal(false),
        canonical_contract_passed: z.literal(true),
        core_passed: z.literal(false),
        artifact_integrity_passed: z.literal(false),
        frames_audited: z.literal(121),
        frames_with_nonempty_core: z.literal(121),
        total_changed_core_pixels: z.literal(1),
        total_changed_core_channel_samples: z.literal(1),
        worst_maximum_absolute_channel_delta: z.literal(1),
        core_hash_match_count: z.literal(120),
        manifest_digest_sha256: sha256Schema,
        stage: z.literal("canonical_pre_encode"),
        frame_audits: z
          .array(
            z
              .object({
                index: z.number().int().min(0).max(120),
                output_core_sha256: sha256Schema,
              })
              .passthrough(),
          )
          .length(121),
      })
      .passthrough(),
  })
  .strict();

const summaryShape = {
  fixture: fixtureSchema,
  corrupted_frame_index: z.literal(60),
  corrupted_channel: z.literal(1),
  passed: z.literal(false),
  changed_core_pixels: z.literal(1),
  changed_core_channel_samples: z.literal(1),
  worst_maximum_absolute_channel_delta: z.literal(1),
  canonical_artifacts_mutated: z.literal(false),
  manifest_path: absolutePathSchema,
  manifest_sha256: sha256Schema,
  audit_path: absolutePathSchema,
  audit_sha256: sha256Schema,
} as const;

const legacySummarySchema = z.object(summaryShape).strict();

const artifactBoundSummarySchema = z
  .object({
    schema_version: z.literal(2),
    corrupted_frame_path: absolutePathSchema,
    corrupted_frame_file_sha256: sha256Schema,
    corrupted_frame_rgb_sha256: sha256Schema,
    corrupted_frame_output_core_sha256: sha256Schema,
    ...summaryShape,
  })
  .strict();

const summarySchema = z.union([
  artifactBoundSummarySchema,
  legacySummarySchema,
]);

const runBindingSchema = z
  .object({
    fixture: fixtureSchema,
    verifier: z.literal("verify_persisted_sequence").optional(),
    frame_index: z.literal(60),
    channel: z.literal(1),
    passed: z.literal(false),
    claim: z.null(),
    canonical_artifacts_mutated: z.literal(false),
    changed_core_pixels: z.literal(1),
    changed_core_channel_samples: z.literal(1),
    worst_maximum_absolute_channel_delta: z.literal(1),
    manifest_path: absolutePathSchema,
    manifest_sha256: sha256Schema,
    audit_path: absolutePathSchema,
    audit_sha256: sha256Schema,
    summary_path: absolutePathSchema,
    summary_sha256: sha256Schema,
  })
  .strict();

export type CorruptionEvidenceInput = {
  jobId: string;
  expected: {
    proofManifestPath: string;
    proofManifestSha256: string;
    corruptionManifestPath: string;
    corruptionAuditPath: string;
    corruptionSummaryPath: string;
    corruptedFramePath: string;
  };
  integrity: {
    proofManifestSha256: string;
    corruptionManifestSha256: string;
    corruptionAuditSha256: string;
    corruptionSummarySha256: string;
    corruptedFrameSha256: string;
  };
  proofManifest: z.input<typeof manifestSchema>;
  corruptionManifest: z.input<typeof manifestSchema>;
  audit: z.input<typeof auditSchema>;
  summary: z.input<typeof summarySchema>;
  runBinding?: z.input<typeof runBindingSchema>;
};

type ValidatedCorruptionEvidenceBase = {
  jobId: string;
  frameIndex: 60;
  channel: 1;
  changedCorePixels: 1;
  changedCoreChannelSamples: 1;
  worstMaximumAbsoluteChannelDelta: 1;
  coreHashMatchCount: 120;
  auditSha256: string;
  manifestSha256: string;
  summarySha256: string;
  runBound: boolean;
};

export type ValidatedCorruptionEvidence =
  ValidatedCorruptionEvidenceBase &
    (
      | {
          artifactBound: true;
          summarySchemaVersion: 2;
        }
      | {
          artifactBound: false;
          summarySchemaVersion: 1;
        }
    );

function fail(message: string): never {
  throw new Error(message);
}

export function calculateProofManifestDigest(
  input: z.input<typeof manifestSchema>,
): string {
  const manifest = manifestSchema.parse(input);
  return canonicalJsonSha256({
    contract: {
      expected_frame_count: manifest.expected_frame_count,
      expected_height: manifest.expected_height,
      expected_width: manifest.expected_width,
    },
    frames: manifest.frames,
    ingest_digest_sha256: manifest.ingest_digest_sha256,
    ingest_schema_version: manifest.ingest_schema_version,
    generation_binding: manifest.generation_binding,
    mask_parameters: manifest.mask_parameters,
    media_provenance: manifest.media_provenance,
    schema_version: manifest.schema_version,
  });
}

export function validateCorruptionEvidence(
  input: CorruptionEvidenceInput,
): ValidatedCorruptionEvidence {
  const jobId = jobIdSchema.parse(input.jobId);
  const expected = z
    .object({
      proofManifestPath: absolutePathSchema,
      proofManifestSha256: sha256Schema,
      corruptionManifestPath: absolutePathSchema,
      corruptionAuditPath: absolutePathSchema,
      corruptionSummaryPath: absolutePathSchema,
      corruptedFramePath: absolutePathSchema,
    })
    .strict()
    .parse(input.expected);
  const integrity = z
    .object({
      proofManifestSha256: sha256Schema,
      corruptionManifestSha256: sha256Schema,
      corruptionAuditSha256: sha256Schema,
      corruptionSummarySha256: sha256Schema,
      corruptedFrameSha256: sha256Schema,
    })
    .strict()
    .parse(input.integrity);
  const proof = manifestSchema.parse(input.proofManifest);
  const negative = manifestSchema.parse(input.corruptionManifest);
  const audit = auditSchema.parse(input.audit);
  const summary = summarySchema.parse(input.summary);
  const artifactBoundSummary =
    "schema_version" in summary ? summary : null;
  const runBinding = input.runBinding
    ? runBindingSchema.parse(input.runBinding)
    : undefined;

  if (
    integrity.proofManifestSha256 !== expected.proofManifestSha256 ||
    summary.manifest_sha256 !== integrity.corruptionManifestSha256 ||
    summary.audit_sha256 !== integrity.corruptionAuditSha256 ||
    summary.manifest_path !== expected.corruptionManifestPath ||
    summary.audit_path !== expected.corruptionAuditPath
  ) {
    fail("corruption evidence hash binding failed");
  }
  if (artifactBoundSummary) {
    if (
      artifactBoundSummary.corrupted_frame_path !==
        expected.corruptedFramePath ||
      artifactBoundSummary.corrupted_frame_file_sha256 !==
        integrity.corruptedFrameSha256
    ) {
      fail("corrupted frame identity failed");
    }
  }
  if (calculateProofManifestDigest(proof) !== proof.digest_sha256) {
    fail("verified proof manifest canonical digest failed");
  }
  if (calculateProofManifestDigest(negative) !== negative.digest_sha256) {
    fail("corruption manifest canonical digest failed");
  }
  if (audit.audit.manifest_digest_sha256 !== negative.digest_sha256) {
    fail("corruption audit names a different manifest digest");
  }
  if (canonicalJsonSha256(audit.manifest) !== canonicalJsonSha256(negative)) {
    fail("corruption audit embeds a different manifest");
  }
  if (artifactBoundSummary) {
    const corruptedAuditFrame = audit.audit.frame_audits[60];
    if (
      !corruptedAuditFrame ||
      corruptedAuditFrame.index !== 60 ||
      artifactBoundSummary.corrupted_frame_output_core_sha256 !==
        corruptedAuditFrame.output_core_sha256
    ) {
      fail("corrupted frame audit binding failed");
    }
  }
  const normalizedFrames = negative.frames.map((frame, index) => {
    const proofFrame = proof.frames[index];
    if (!proofFrame || frame.index !== index || proofFrame.index !== index) {
      fail("negative manifest frame sequence is invalid");
    }
    if (
      index === 60 &&
      frame.composite_path !== expected.corruptedFramePath
    ) {
      fail("negative manifest does not name the deliberate frame copy");
    }
    return index === 60
      ? { ...frame, composite_path: proofFrame.composite_path }
      : frame;
  });
  const normalizedNegative = {
    ...negative,
    frames: normalizedFrames,
    digest_sha256: proof.digest_sha256,
  };
  if (canonicalJsonSha256(normalizedNegative) !== canonicalJsonSha256(proof)) {
    fail("negative manifest differs beyond the deliberate frame");
  }
  if (runBinding) {
    if (
      runBinding.manifest_path !== expected.corruptionManifestPath ||
      runBinding.audit_path !== expected.corruptionAuditPath ||
      runBinding.summary_path !== expected.corruptionSummaryPath ||
      runBinding.manifest_sha256 !== integrity.corruptionManifestSha256 ||
      runBinding.audit_sha256 !== integrity.corruptionAuditSha256 ||
      runBinding.summary_sha256 !== integrity.corruptionSummarySha256
    ) {
      fail("run manifest negative-test binding failed");
    }
  }
  const validated: ValidatedCorruptionEvidenceBase = {
    jobId,
    frameIndex: 60,
    channel: 1,
    changedCorePixels: 1,
    changedCoreChannelSamples: 1,
    worstMaximumAbsoluteChannelDelta: 1,
    coreHashMatchCount: audit.audit.core_hash_match_count,
    auditSha256: integrity.corruptionAuditSha256,
    manifestSha256: integrity.corruptionManifestSha256,
    summarySha256: integrity.corruptionSummarySha256,
    runBound: runBinding !== undefined,
  };
  return artifactBoundSummary
    ? {
        ...validated,
        artifactBound: true,
        summarySchemaVersion: 2,
      }
    : {
        ...validated,
        artifactBound: false,
        summarySchemaVersion: 1,
      };
}
