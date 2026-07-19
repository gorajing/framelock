import { z } from "zod";

export const VERIFIED_CLAIM =
  "Protected core verified — canonical pre-encode frame sequence." as const;

const KLING_ENDPOINT =
  "fal-ai/kling-video/o3/standard/video-to-video/edit" as const;
const LTX_ENDPOINT = "fal-ai/ltx-2.3-quality/inpaint" as const;
const RULE_VERSION = "framelock-comparability-p0-v1" as const;
const REVIEW_INDICES = [0, 60, 120] as const;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const decimalSchema = z.string().regex(/^\d+(?:\.\d+)?$/);
const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const shaTupleSchema = z.tuple([sha256Schema, sha256Schema, sha256Schema]);

const generatedProvenanceSchema = z.object({
  source_file_sha256: sha256Schema,
  presentation_timestamps_sha256: sha256Schema,
  decoded_frame_count: z.literal(121),
  frame_rate_numerator: z.literal(24),
  frame_rate_denominator: z.literal(1),
  width: z.literal(1280),
  height: z.literal(720),
  max_pts_residual_microseconds: z.number().int().nonnegative().max(1_000),
});

const proofFrameSchema = z.object({
  index: z.number().int().min(0).max(120),
  source_file_sha256: sha256Schema,
  source_rgb_sha256: sha256Schema,
  core_mask_file_sha256: sha256Schema,
  generated_file_sha256: sha256Schema,
  generated_rgb_sha256: sha256Schema,
  composite_file_sha256: sha256Schema,
});

const proofFramesSchema = z
  .array(proofFrameSchema)
  .length(121)
  .superRefine((frames, context) => {
    frames.forEach((frame, index) => {
      if (frame.index !== index) {
        context.addIssue({
          code: "custom",
          path: [index, "index"],
          message: "Proof frame indices must be consecutive from zero",
        });
      }
    });
  });

const proofManifestSchema = z.object({
  schema_version: z.literal(2),
  ingest_schema_version: z.literal(1),
  digest_sha256: sha256Schema,
  ingest_digest_sha256: sha256Schema,
  expected_frame_count: z.literal(121),
  expected_height: z.literal(720),
  expected_width: z.literal(1280),
  generation_binding: z.object({
    prepared_foreground_mask_file_sha256: sha256Schema,
    generated_media_provenance: generatedProvenanceSchema,
  }),
  frames: proofFramesSchema,
});

const overlayTupleSchema = z.tuple([
  z.object({ source_index: z.literal(0), sha256: sha256Schema }),
  z.object({ source_index: z.literal(60), sha256: sha256Schema }),
  z.object({ source_index: z.literal(120), sha256: sha256Schema }),
]);

const reviewGeneratedFramesSchema = z
  .array(
    z.object({
      source_index: z.number().int().min(0).max(120),
      file_sha256: sha256Schema,
      rgb_sha256: sha256Schema,
    }),
  )
  .length(121)
  .superRefine((frames, context) => {
    frames.forEach((frame, index) => {
      if (frame.source_index !== index) {
        context.addIssue({
          code: "custom",
          path: [index, "source_index"],
          message: "Review frame indices must be consecutive from zero",
        });
      }
    });
  });

const generationIdentitySchema = z.object({
  digest: sha256Schema,
  sourceSha256: sha256Schema,
  editMaskSha256: sha256Schema,
  endpoint: z.literal(KLING_ENDPOINT),
});

const klingAssessmentSchema = z.object({
  schema_version: z.literal(1),
  rule_version: z.literal(RULE_VERSION),
  automatic_checks_passed: z.literal(true),
  failed_checks: z.array(z.string()).length(0),
  verdict: z.literal("comparable_pending_visual_approval"),
  attempt: z.object({ index: z.literal(2), cap: z.literal(3) }),
  media: z.object({
    width: z.literal(1280),
    height: z.literal(720),
    frame_count: z.literal(121),
    frame_rate: z.literal("24/1"),
    display_aspect_ratio: z.literal("16/9"),
    max_timestamp_residual_microseconds: z.number().int().nonnegative().max(1_000),
  }),
  pricing: z.object({
    billing_unit: z.literal("seconds"),
    estimated_cost_usd: decimalSchema,
    estimated_units: decimalSchema,
    source: z.literal("authenticated_fal_pricing_and_estimate"),
    unit_price_usd: decimalSchema,
  }),
  job_provenance: z.object({
    id: z.literal("synthetic-hero-kling-o3-001"),
    generation: generationIdentitySchema,
    fal: z.object({
      endpoint: z.literal(KLING_ENDPOINT),
      requestId: requestIdSchema,
      generationDigest: sha256Schema,
      modelOutput: z.object({ sha256: sha256Schema }),
    }),
  }),
});

const failedCheckSchema = z.object({
  name: z.literal("display_aspect_ratio"),
  actual: z.literal("5/3"),
  expected: z.literal("16/9"),
  passed: z.literal(false),
});

const ltxAssessmentSchema = z.object({
  schema_version: z.literal(1),
  rule_version: z.literal(RULE_VERSION),
  automatic_checks_passed: z.literal(false),
  failed_checks: z.tuple([z.literal("display_aspect_ratio")]),
  verdict: z.literal("not_comparable"),
  normalization_applied: z.literal(false),
  normalization_plan: z.literal("not_permitted"),
  visual_geometry_note: z.literal(
    "Cropping and aspect-distorting scaling are outside the frozen contract.",
  ),
  attempt: z.object({ index: z.literal(1), cap: z.literal(3) }),
  checks: z.array(z.unknown()).min(1),
  pricing: z.object({
    billing_unit: z.literal("megapixels"),
    estimated_cost_usd: decimalSchema,
    estimated_units: decimalSchema,
    source: z.literal("authenticated_fal_pricing"),
    unit_price_usd: decimalSchema,
  }),
  job_provenance: z.object({
    id: z.literal("synthetic-hero-ltx-001"),
    generation: z.object({ digest: sha256Schema }),
    fal: z.object({
      endpoint: z.literal(LTX_ENDPOINT),
      requestId: requestIdSchema,
      generationDigest: sha256Schema,
      modelOutput: z.object({ sha256: sha256Schema }),
    }),
  }),
});

const reviewManifestSchema = z.object({
  schema_version: z.literal(1),
  digest_sha256: sha256Schema,
  review_state: z.literal("awaiting_visual_geometry_approval"),
  reviewed_source_indices: z.tuple([
    z.literal(0),
    z.literal(60),
    z.literal(120),
  ]),
  job: z.object({
    endpoint: z.literal(KLING_ENDPOINT),
    id: z.literal("synthetic-hero-kling-o3-001"),
    generation_digest: sha256Schema,
    model_output_sha256: sha256Schema,
    request_id: requestIdSchema,
    restoration_mask_sha256: sha256Schema,
    source_sha256: sha256Schema,
  }),
  generation_assessment: z.object({
    automatic_checks_passed: z.literal(true),
    rule_version: z.literal(RULE_VERSION),
    sha256: sha256Schema,
  }),
  source_proof: z.object({
    ingest_digest_sha256: sha256Schema,
    proof_manifest_sha256: sha256Schema,
  }),
  prepared_foreground_mask: z.object({ sha256: sha256Schema }),
  generated_decode_provenance: generatedProvenanceSchema,
  generated_frames: reviewGeneratedFramesSchema,
  geometry_overlays: overlayTupleSchema,
});

const auditSchema = z.object({
  schema_version: z.literal(1),
  claim: z.literal(VERIFIED_CLAIM),
  audit: z.object({
    artifact_integrity_passed: z.literal(true),
    canonical_contract_passed: z.literal(true),
    core_hash_match_count: z.literal(121),
    core_passed: z.literal(true),
    deterministic_composition_checked: z.literal(true),
    deterministic_composition_passed: z.literal(true),
    frames_audited: z.literal(121),
    frames_with_nonempty_core: z.literal(121),
    manifest_digest_sha256: sha256Schema,
    passed: z.literal(true),
    stage: z.literal("canonical_pre_encode"),
    total_changed_core_channel_samples: z.literal(0),
    total_changed_core_pixels: z.literal(0),
    total_core_pixels: z.number().int().positive(),
    worst_maximum_absolute_channel_delta: z.literal(0),
  }),
  manifest: proofManifestSchema,
});

const runManifestSchema = z.object({
  schema_version: z.literal(2),
  claim: z.literal(VERIFIED_CLAIM),
  digest_sha256: sha256Schema,
  generation_assessment: z.object({
    automatic_checks_passed: z.literal(true),
    rule_version: z.literal(RULE_VERSION),
    sha256: sha256Schema,
  }),
  job: reviewManifestSchema.shape.job,
  source_proof: reviewManifestSchema.shape.source_proof,
  generated_decode_provenance: generatedProvenanceSchema,
  review_evidence: z.object({
    manifest_digest_sha256: sha256Schema,
    manifest_sha256: sha256Schema,
    prepared_before_approval: z.literal(true),
    geometry_overlays: overlayTupleSchema,
  }),
  proof: z.object({
    audit_sha256: sha256Schema,
    changed_core_channel_samples: z.literal(0),
    deterministic_composition_checked: z.literal(true),
    deterministic_composition_passed: z.literal(true),
    frames_audited: z.literal(121),
    manifest_digest_sha256: sha256Schema,
    manifest_sha256: sha256Schema,
  }),
  preview: z.object({
    label: z.literal("Preview derived from verified canonical frames"),
    sha256: sha256Schema,
  }),
  visual_geometry_approval: z.object({
    note: z.string().trim().min(1).max(1_000),
    passed: z.literal(true),
    review_manifest_sha256: sha256Schema,
    reviewed_overlay_sha256s: shaTupleSchema,
    reviewed_source_indices: z.tuple([
      z.literal(0),
      z.literal(60),
      z.literal(120),
    ]),
    reviewer: z.string().trim().min(1).max(200),
  }),
});

const integritySchema = z.object({
  klingAssessmentSha256: sha256Schema,
  ltxAssessmentSha256: sha256Schema,
  auditSha256: sha256Schema,
  proofManifestSha256: sha256Schema,
  reviewManifestSha256: sha256Schema,
  reviewManifestCanonicalDigestSha256: sha256Schema,
  runManifestSha256: sha256Schema,
  runManifestCanonicalDigestSha256: sha256Schema,
  sourceProofManifestSha256: sha256Schema,
  sourceVideoSha256: sha256Schema,
  rawVideoSha256: sha256Schema,
  previewVideoSha256: sha256Schema,
  servedFrames: z.object({
    source: shaTupleSchema,
    raw: shaTupleSchema,
    composite: shaTupleSchema,
    overlay: shaTupleSchema,
  }),
});

const demoSummaryArtifactsSchema = z.object({
  klingAssessment: z.unknown(),
  ltxAssessment: z.unknown(),
  proofManifest: z.unknown(),
  reviewManifest: z.unknown(),
  audit: z.unknown(),
  runManifest: z.unknown(),
  integrity: integritySchema,
});

function requireMatch(actual: string, expected: string, description: string) {
  if (actual !== expected) throw new Error(`${description} does not match`);
}

function requireJsonMatch(actual: unknown, expected: unknown, description: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${description} does not match`);
  }
}

function overlayHashes(overlays: z.infer<typeof overlayTupleSchema>) {
  return overlays.map((overlay) => overlay.sha256) as [string, string, string];
}

function selectedProofFrames(frames: z.infer<typeof proofFramesSchema>) {
  return REVIEW_INDICES.map((index) => frames[index]);
}

export function validateDemoArtifacts(input: unknown) {
  const bundle = demoSummaryArtifactsSchema.parse(input);
  const kling = klingAssessmentSchema.parse(bundle.klingAssessment);
  const ltx = ltxAssessmentSchema.parse(bundle.ltxAssessment);
  const proofManifest = proofManifestSchema.parse(bundle.proofManifest);
  const review = reviewManifestSchema.parse(bundle.reviewManifest);
  const audit = auditSchema.parse(bundle.audit);
  const run = runManifestSchema.parse(bundle.runManifest);
  const ltxDisplayAspectCheck = ltx.checks
    .map((check) => failedCheckSchema.safeParse(check))
    .find((result) => result.success);
  if (!ltxDisplayAspectCheck?.success) {
    throw new Error("LTX rejection is missing its display-aspect evidence");
  }

  requireJsonMatch(audit.manifest, proofManifest, "Audit proof manifest");
  requireMatch(audit.audit.manifest_digest_sha256, proofManifest.digest_sha256, "Audit manifest digest");
  requireMatch(run.proof.manifest_digest_sha256, proofManifest.digest_sha256, "Run proof manifest digest");
  requireMatch(bundle.integrity.proofManifestSha256, run.proof.manifest_sha256, "Proof manifest hash");
  requireMatch(bundle.integrity.auditSha256, run.proof.audit_sha256, "Canonical audit hash");
  requireMatch(bundle.integrity.runManifestCanonicalDigestSha256, run.digest_sha256, "Run manifest digest");
  requireMatch(bundle.integrity.reviewManifestSha256, run.review_evidence.manifest_sha256, "Review manifest hash");
  requireMatch(bundle.integrity.reviewManifestSha256, run.visual_geometry_approval.review_manifest_sha256, "Approval review manifest hash");
  requireMatch(bundle.integrity.reviewManifestCanonicalDigestSha256, review.digest_sha256, "Review manifest digest");
  requireMatch(review.digest_sha256, run.review_evidence.manifest_digest_sha256, "Run review manifest digest");
  requireMatch(bundle.integrity.sourceProofManifestSha256, run.source_proof.proof_manifest_sha256, "Source proof manifest hash");
  requireMatch(review.source_proof.proof_manifest_sha256, run.source_proof.proof_manifest_sha256, "Review source proof hash");
  requireMatch(review.source_proof.ingest_digest_sha256, proofManifest.ingest_digest_sha256, "Review ingest digest");
  requireMatch(run.source_proof.ingest_digest_sha256, proofManifest.ingest_digest_sha256, "Run ingest digest");

  const klingGeneration = kling.job_provenance.generation;
  requireMatch(kling.job_provenance.fal.requestId, run.job.request_id, "Kling request ID");
  requireMatch(kling.job_provenance.fal.generationDigest, klingGeneration.digest, "Kling assessment generation digest");
  requireMatch(klingGeneration.digest, run.job.generation_digest, "Kling run generation digest");
  requireMatch(klingGeneration.sourceSha256, run.job.source_sha256, "Kling source hash");
  requireMatch(klingGeneration.editMaskSha256, run.job.restoration_mask_sha256, "Kling restoration mask hash");
  requireMatch(kling.job_provenance.fal.modelOutput.sha256, run.job.model_output_sha256, "Kling model output hash");
  requireMatch(bundle.integrity.klingAssessmentSha256, run.generation_assessment.sha256, "Kling assessment hash");
  requireMatch(review.generation_assessment.sha256, run.generation_assessment.sha256, "Review assessment hash");
  requireJsonMatch(review.job, run.job, "Review job provenance");

  requireMatch(review.prepared_foreground_mask.sha256, run.job.restoration_mask_sha256, "Review restoration mask hash");
  requireMatch(proofManifest.generation_binding.prepared_foreground_mask_file_sha256, run.job.restoration_mask_sha256, "Proof restoration mask hash");
  requireJsonMatch(review.generated_decode_provenance, run.generated_decode_provenance, "Run generated decode provenance");
  requireJsonMatch(proofManifest.generation_binding.generated_media_provenance, run.generated_decode_provenance, "Proof generated decode provenance");
  requireMatch(run.generated_decode_provenance.source_file_sha256, run.job.model_output_sha256, "Generated media binding");
  review.generated_frames.forEach((frame, index) => {
    requireMatch(frame.file_sha256, proofManifest.frames[index].generated_file_sha256, `Review generated frame ${index} file hash`);
    requireMatch(frame.rgb_sha256, proofManifest.frames[index].generated_rgb_sha256, `Review generated frame ${index} RGB hash`);
  });

  const reviewOverlayHashes = overlayHashes(review.geometry_overlays);
  const runOverlayHashes = overlayHashes(run.review_evidence.geometry_overlays);
  requireJsonMatch(runOverlayHashes, reviewOverlayHashes, "Run review overlay hashes");
  requireJsonMatch(run.visual_geometry_approval.reviewed_overlay_sha256s, reviewOverlayHashes, "Approval overlay hashes");
  requireJsonMatch(bundle.integrity.servedFrames.overlay, reviewOverlayHashes, "Served overlay frame hashes");

  selectedProofFrames(proofManifest.frames).forEach((frame, index) => {
    requireMatch(bundle.integrity.servedFrames.source[index], frame.source_file_sha256, `Served source frame ${REVIEW_INDICES[index]} hash`);
    requireMatch(bundle.integrity.servedFrames.raw[index], frame.generated_file_sha256, `Served raw frame ${REVIEW_INDICES[index]} hash`);
    requireMatch(bundle.integrity.servedFrames.composite[index], frame.composite_file_sha256, `Served composite frame ${REVIEW_INDICES[index]} hash`);
  });

  requireMatch(bundle.integrity.sourceVideoSha256, run.job.source_sha256, "Source video hash");
  requireMatch(bundle.integrity.rawVideoSha256, run.job.model_output_sha256, "Raw model video hash");
  requireMatch(bundle.integrity.previewVideoSha256, run.preview.sha256, "Preview video hash");
  requireMatch(ltx.job_provenance.fal.generationDigest, ltx.job_provenance.generation.digest, "LTX generation digest");

  const summary = {
    schemaVersion: 2 as const,
    status: "verified" as const,
    projectionLabel: "Legacy synthetic proof — read-only projection" as const,
    fixture: "Synthetic diagnostic fixture" as const,
    claim: VERIFIED_CLAIM,
    selectedGenerator: {
      name: "Kling O3 Standard Edit" as const,
      endpoint: KLING_ENDPOINT,
      attempt: kling.attempt.index,
      requestId: run.job.request_id,
      estimatedCostUsd: kling.pricing.estimated_cost_usd,
      media: {
        width: kling.media.width,
        height: kling.media.height,
        frameCount: kling.media.frame_count,
        frameRate: kling.media.frame_rate,
        displayAspectRatio: kling.media.display_aspect_ratio,
      },
    },
    proof: {
      framesAudited: audit.audit.frames_audited,
      framesWithProtectedCore: audit.audit.frames_with_nonempty_core,
      totalProtectedCorePixels: audit.audit.total_core_pixels,
      changedCorePixels: audit.audit.total_changed_core_pixels,
      changedCoreChannelSamples: audit.audit.total_changed_core_channel_samples,
      maximumChannelDelta: audit.audit.worst_maximum_absolute_channel_delta,
      coreHashMatches: audit.audit.core_hash_match_count,
      deterministicCompositionChecked: audit.audit.deterministic_composition_checked,
      deterministicCompositionPassed: audit.audit.deterministic_composition_passed,
      stage: audit.audit.stage,
    },
    rejectedAttempt: {
      name: "LTX 2.3 Quality Inpaint" as const,
      endpoint: LTX_ENDPOINT,
      attempt: ltx.attempt.index,
      estimatedCostUsd: ltx.pricing.estimated_cost_usd,
      failedCheck: ltxDisplayAspectCheck.data.name,
      actual: ltxDisplayAspectCheck.data.actual,
      required: ltxDisplayAspectCheck.data.expected,
      reason: ltx.visual_geometry_note,
    },
    previewLabel: "H.264 preview — not lossless proof" as const,
  };

  const evidence = {
    kling: {
      jobId: kling.job_provenance.id,
      endpoint: KLING_ENDPOINT,
      requestId: run.job.request_id,
      generationDigest: run.job.generation_digest,
      modelOutputSha256: run.job.model_output_sha256,
      assessmentSha256: bundle.integrity.klingAssessmentSha256,
    },
    ltx: {
      jobId: ltx.job_provenance.id,
      endpoint: LTX_ENDPOINT,
      requestId: ltx.job_provenance.fal.requestId,
      generationDigest: ltx.job_provenance.generation.digest,
      modelOutputSha256: ltx.job_provenance.fal.modelOutput.sha256,
      assessmentSha256: bundle.integrity.ltxAssessmentSha256,
    },
    proof: {
      manifestSha256: bundle.integrity.proofManifestSha256,
      manifestDigestSha256: proofManifest.digest_sha256,
      auditSha256: bundle.integrity.auditSha256,
      runSha256: bundle.integrity.runManifestSha256,
      runDigestSha256: run.digest_sha256,
      reviewSha256: bundle.integrity.reviewManifestSha256,
      reviewDigestSha256: review.digest_sha256,
      previewSha256: bundle.integrity.previewVideoSha256,
    },
    audit: summary.proof,
  };

  return { evidence, summary };
}

export function buildDemoSummary(input: unknown) {
  return validateDemoArtifacts(input).summary;
}

export type DemoSummary = ReturnType<typeof buildDemoSummary>;
export type ValidatedDemoEvidence = ReturnType<typeof validateDemoArtifacts>["evidence"];
