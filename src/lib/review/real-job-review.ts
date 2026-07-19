import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type {
  CommittedFinalizationEvidence,
  FinalizationEvidence,
  FinalizationSuccessEvidence,
  GenerationAssessmentEvidence,
  GenerationReviewEvidence,
} from "../media/framelock-cli-core";
import { FrameLockCliError } from "../media/framelock-cli-core";
import type { ActiveJobPointer } from "../jobs/active-job-registry";
import {
  type CanonicalVerificationFailureCode,
  type LocalJobRecord,
  LocalJobStore,
} from "../jobs/local-job-store";
import { buildRealJobView } from "../jobs/real-job-view";
import {
  CanonicalZipError,
  validateCanonicalStoredZip,
} from "./canonical-zip";

const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const decimalTextSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const absolutePathSchema = z.string().min(1).refine(isAbsolute);
const REVIEW_INDICES = [0, 60, 120] as const;
const FRAME_COUNT = 121;
const VERIFIED_CLAIM =
  "Protected core verified — canonical pre-encode frame sequence." as const;

export const APPROVE_REVIEW_PHRASE = "APPROVE 0 60 120" as const;

export const realJobApprovalSchema = z
  .object({
    approval: z.literal(APPROVE_REVIEW_PHRASE),
    reviewManifestSha256: sha256Schema,
    overlaySha256s: z.tuple([sha256Schema, sha256Schema, sha256Schema]),
    reviewer: z.string().trim().min(1).max(200),
    visualNote: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type RealJobApproval = z.infer<typeof realJobApprovalSchema>;

const assessmentSchema = z
  .object({
    schema_version: z.literal(1),
    rule_version: z.literal("framelock-comparability-p0-v1"),
    verdict: z.enum([
      "not_comparable",
      "comparable_pending_visual_approval",
    ]),
    attempt: z
      .object({
        cap: z.literal(3),
        index: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      })
      .strict(),
    pricing: z
      .object({
        unit_price_usd: decimalTextSchema,
        billing_unit: z.string().trim().min(1).max(64),
        estimated_units: decimalTextSchema,
        estimated_cost_usd: decimalTextSchema,
        source: z.string().trim().min(1).max(256),
        price_observed_at: z.string().datetime(),
        snapshot_captured_at: z.string().datetime(),
        snapshot_digest_sha256: sha256Schema,
      })
      .strict(),
    model_output: z
      .object({
        bytes: z.number().int().positive(),
        path: absolutePathSchema,
        sha256: sha256Schema,
      })
      .strict(),
    job_provenance: z
      .object({
        id: jobIdSchema,
        state: z.literal("generated"),
        generation: z
          .object({
            digest: sha256Schema,
            sourceSha256: sha256Schema,
            editMaskSha256: sha256Schema,
            endpoint: z.string().min(1),
          })
          .passthrough(),
        fal: z
          .object({
            generationDigest: sha256Schema,
            endpoint: z.string().min(1),
            requestId: z.string().min(1),
            modelOutput: z
              .object({ sha256: sha256Schema })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
    probe: z
      .object({
        path: absolutePathSchema,
        raw_json_sha256: sha256Schema,
      })
      .passthrough(),
    normalization_applied: z.literal(false),
    visual_geometry_approval: z.enum([
      "not_reached_automatic_gate_failed",
      "pending_human_review",
    ]),
  })
  .passthrough();

const reviewManifestSchema = z
  .object({
    schema_version: z.union([z.literal(1), z.literal(2)]),
    prepared_at: z.string().datetime({ offset: true }),
    review_state: z.literal("awaiting_visual_geometry_approval"),
    reviewed_source_indices: z.tuple([
      z.literal(0),
      z.literal(60),
      z.literal(120),
    ]),
    job: z
      .object({
        id: jobIdSchema,
        endpoint: z.string().min(1),
        request_id: z.string().min(1),
        generation_digest: sha256Schema,
        source_sha256: sha256Schema,
        restoration_mask_sha256: sha256Schema,
        model_output_sha256: sha256Schema,
      })
      .strict(),
    generation_assessment: z
      .object({
        path: absolutePathSchema,
        sha256: sha256Schema,
        rule_version: z.literal("framelock-comparability-p0-v1"),
        automatic_checks_passed: z.literal(true),
      })
      .strict(),
    source_proof: z
      .object({
        directory: absolutePathSchema,
        proof_manifest_sha256: sha256Schema,
        ingest_digest_sha256: sha256Schema,
      })
      .strict(),
    prepared_foreground_mask: z
      .object({ path: absolutePathSchema, sha256: sha256Schema })
      .strict(),
    generated_decode_provenance: z
      .object({
        decoded_frame_count: z.literal(FRAME_COUNT),
        width: z.literal(1280),
        height: z.literal(720),
        frame_rate_numerator: z.literal(24),
        frame_rate_denominator: z.literal(1),
        source_file_sha256: sha256Schema,
        source_media_path: absolutePathSchema,
      })
      .passthrough(),
    generated_frames: z
      .array(
        z
          .object({
            source_index: z.number().int().min(0).max(120),
            path: absolutePathSchema,
            file_sha256: sha256Schema,
            rgb_sha256: sha256Schema,
          })
          .strict(),
      )
      .length(FRAME_COUNT),
    geometry_overlays: z
      .array(
        z
          .object({
            source_index: z.union([
              z.literal(0),
              z.literal(60),
              z.literal(120),
            ]),
            path: absolutePathSchema,
            sha256: sha256Schema,
          })
          .strict(),
      )
      .length(3),
    digest_sha256: sha256Schema,
  })
  .passthrough();

const proofManifestSchema = z
  .object({
    schema_version: z.literal(2),
    expected_width: z.literal(1280),
    expected_height: z.literal(720),
    expected_frame_count: z.literal(FRAME_COUNT),
    digest_sha256: sha256Schema,
    generation_binding: z
      .object({
        prepared_foreground_mask_path: absolutePathSchema,
        prepared_foreground_mask_file_sha256: sha256Schema,
        generated_media_provenance: z
          .object({
            source_media_path: absolutePathSchema,
            source_file_sha256: sha256Schema,
            decoded_frame_count: z.literal(FRAME_COUNT),
            width: z.literal(1280),
            height: z.literal(720),
            frame_rate_numerator: z.literal(24),
            frame_rate_denominator: z.literal(1),
          })
          .passthrough(),
      })
      .strict(),
    frames: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(120),
            source_path: absolutePathSchema,
            core_mask_path: absolutePathSchema,
            composite_path: absolutePathSchema,
            generated_path: absolutePathSchema,
            source_file_sha256: sha256Schema,
            source_rgb_sha256: sha256Schema,
            core_mask_file_sha256: sha256Schema,
            composite_file_sha256: sha256Schema,
            generated_file_sha256: sha256Schema,
            generated_rgb_sha256: sha256Schema,
          })
          .strict(),
      )
      .length(FRAME_COUNT),
  })
  .passthrough();

const auditSchema = z
  .object({
    schema_version: z.literal(1),
    claim: z.literal(VERIFIED_CLAIM),
    audit: z
      .object({
        passed: z.literal(true),
        canonical_contract_passed: z.literal(true),
        core_passed: z.literal(true),
        artifact_integrity_passed: z.literal(true),
        frames_audited: z.literal(FRAME_COUNT),
        frames_with_nonempty_core: z.literal(FRAME_COUNT),
        total_core_pixels: z.number().int().positive(),
        total_changed_core_pixels: z.literal(0),
        total_changed_core_channel_samples: z.literal(0),
        worst_maximum_absolute_channel_delta: z.literal(0),
        core_hash_match_count: z.literal(FRAME_COUNT),
        manifest_digest_sha256: sha256Schema,
        deterministic_composition_checked: z.literal(true),
        deterministic_composition_passed: z.literal(true),
        stage: z.literal("canonical_pre_encode"),
        frame_audits: z.array(z.unknown()).length(FRAME_COUNT),
      })
      .passthrough(),
    manifest: z
      .object({
        digest_sha256: sha256Schema,
        frames: z.array(z.unknown()).length(FRAME_COUNT),
      })
      .passthrough(),
  })
  .strict();

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

const finalizationCommitOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      path: z.string().min(1),
      kind: z.literal("file"),
      sha256: sha256Schema,
      size_bytes: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      path: z.string().min(1),
      kind: z.literal("directory"),
      file_count: z.number().int().positive(),
      tree_digest_sha256: sha256Schema,
    })
    .strict(),
]);

const finalizationCommitSchema = z
  .object({
    schema_version: z.literal(1),
    attempt_id: z.string().uuid(),
    review_manifest_sha256: sha256Schema,
    outputs: z.array(finalizationCommitOutputSchema).length(9),
    digest_sha256: sha256Schema,
  })
  .strict();

const runManifestSchema = z
  .object({
    schema_version: z.union([z.literal(5), z.literal(6)]),
    claim: z.literal(VERIFIED_CLAIM),
    job: z
      .object({
        id: jobIdSchema,
        endpoint: z.string().min(1),
        request_id: z.string().min(1),
        generation_digest: sha256Schema,
        source_sha256: sha256Schema,
        restoration_mask_sha256: sha256Schema,
        model_output_sha256: sha256Schema,
      })
      .strict(),
    generation_assessment: z
      .object({
        path: absolutePathSchema,
        sha256: sha256Schema,
        rule_version: z.literal("framelock-comparability-p0-v1"),
        automatic_checks_passed: z.literal(true),
      })
      .strict(),
    visual_geometry_approval: z
      .object({
        passed: z.literal(true),
        reviewer: z.string().min(1).max(200),
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
        review_manifest_sha256: sha256Schema,
        note: z.string().min(1).max(2_000),
      })
      .strict(),
    review_evidence: z
      .object({
        manifest_path: absolutePathSchema,
        manifest_sha256: sha256Schema,
        manifest_digest_sha256: sha256Schema,
        prepared_before_approval: z.literal(true),
      })
      .passthrough(),
    proof: z
      .object({
        manifest_path: absolutePathSchema,
        manifest_sha256: sha256Schema,
        manifest_digest_sha256: sha256Schema,
        audit_path: absolutePathSchema,
        audit_sha256: sha256Schema,
        frames_audited: z.literal(FRAME_COUNT),
        changed_core_channel_samples: z.literal(0),
        deterministic_composition_checked: z.literal(true),
        deterministic_composition_passed: z.literal(true),
      })
      .strict(),
    preview: z
      .object({
        path: absolutePathSchema,
        sha256: sha256Schema,
        label: z.literal("Preview derived from verified canonical frames"),
      })
      .strict(),
    exports: z
      .object({
        canonical_frames: z
          .object({
            archive_path: absolutePathSchema,
            archive_sha256: sha256Schema,
            manifest_path: absolutePathSchema,
            manifest_sha256: sha256Schema,
            frame_count: z.literal(FRAME_COUNT),
            total_uncompressed_bytes: z.number().int().positive(),
            label: z.literal(
              "Proof-bound canonical pre-encode RGB24 PNG sequence",
            ),
          })
          .strict(),
      })
      .strict(),
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
        fixture: z.literal(
          "one_channel_one_pixel_protected_core_corruption",
        ),
        verifier: z.literal("verify_persisted_sequence"),
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
      .strict(),
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

const canonicalExportManifestSchema = z
  .object({
    schema_version: z.literal(1),
    artifact: z.literal("canonical_rgb24_png_sequence"),
    claim_scope: z.literal(
      "Packaging of proof-bound canonical pre-encode RGB24 PNG frames; the proof manifest remains authoritative.",
    ),
    frame_count: z.literal(FRAME_COUNT),
    proof_manifest_digest_sha256: sha256Schema,
    total_uncompressed_bytes: z.number().int().positive(),
    archive: z
      .object({
        format: z.literal("zip"),
        compression: z.literal("stored"),
        sha256: sha256Schema,
      })
      .strict(),
    frames: z
      .array(
        z
          .object({
            source_index: z.number().int().min(0).max(120),
            archive_path: z.string().regex(
              /^canonical_frames\/frame_\d{6}\.png$/,
            ),
            file_sha256: sha256Schema,
          })
          .strict(),
      )
      .length(FRAME_COUNT),
  })
  .strict();

const corruptionManifestSchema = z
  .object({
    digest_sha256: sha256Schema,
    frames: z.array(z.unknown()).length(FRAME_COUNT),
  })
  .passthrough();

const corruptionAuditSchema = z
  .object({
    schema_version: z.literal(1),
    claim: z.null(),
    audit: z
      .object({
        passed: z.literal(false),
        canonical_contract_passed: z.literal(true),
        total_changed_core_pixels: z.literal(1),
        total_changed_core_channel_samples: z.literal(1),
        worst_maximum_absolute_channel_delta: z.literal(1),
        frames_audited: z.literal(FRAME_COUNT),
      })
      .passthrough(),
  })
  .passthrough();

const corruptionSummarySchema = z
  .object({
    fixture: z.literal("one_channel_one_pixel_protected_core_corruption"),
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
  })
  .strict();

type ReviewCliPort = Readonly<{
  assessGeneration(input: {
    mediaPath: string;
    outputDirectory: string;
    jobRecordPath: string;
    paidAttemptIndex: number;
    paidAttemptCap: number;
    unitPriceUsd: string;
    billingUnit: string;
    estimatedUnits: string;
    estimatedCostUsd: string;
    pricingSource: string;
    priceObservedAt: string;
    snapshotCapturedAt: string;
    snapshotDigestSha256: string;
  }): Promise<GenerationAssessmentEvidence>;
  prepareGenerationReview(input: {
    sourceProofDirectory: string;
    foregroundMaskPath: string;
    generatedMediaPath: string;
    generationAssessmentPath: string;
    jobRecordPath: string;
    outputDirectory: string;
  }): Promise<GenerationReviewEvidence>;
  finalizeGenerationProof(input: {
    preparedReviewDirectory: string;
    reviewManifestSha256: string;
    overlaySha256s: readonly [string, string, string];
    reviewer: string;
    visualNote: string;
  }): Promise<FinalizationEvidence>;
  validateFinalizationCommit(input: {
    preparedReviewDirectory: string;
    reviewManifestSha256: string;
  }): Promise<CommittedFinalizationEvidence>;
}>;

type ActiveJobPort = Readonly<{
  read(): Promise<ActiveJobPointer | { jobId: string } | null>;
}>;

type ServiceOptions = Readonly<{
  jobs: LocalJobStore;
  activeJobs: ActiveJobPort;
  cli: ReviewCliPort;
  jobsRoot: string;
  runsRoot: string;
}>;

type LoadedAssessment = Readonly<{
  path: string;
  rawProbePath: string;
  sha256: string;
  verdict: "not_comparable" | "comparable_pending_visual_approval";
}>;

type ReviewView = Readonly<{
  state: "awaiting_visual_geometry_approval";
  reviewManifestSha256: string;
  reviewManifestDigestSha256: string;
  overlaySha256s: readonly [string, string, string];
  overlays: readonly [
    { frame: 0; url: string; sha256: string },
    { frame: 60; url: string; sha256: string },
    { frame: 120; url: string; sha256: string },
  ];
}>;

type LoadedReview = Readonly<{
  assessmentSha256: string;
  manifestPath: string;
  manifestSha256: string;
  manifestDigestSha256: string;
  sourceAudio?: z.infer<typeof sourceAudioBindingSchema>;
  overlayPaths: readonly [string, string, string];
  overlaySha256s: readonly [string, string, string];
  view: ReviewView;
}>;

type FinalProof = Readonly<{
  claim: typeof VERIFIED_CLAIM;
  framesAudited: 121;
  protectedCorePixels: number;
  changedCoreChannelSamples: 0;
  worstMaxChannelDelta: 0;
  coreHashMatchCount: 121;
  proofManifestSha256: string;
  auditSha256: string;
  runManifestSha256: string;
  previewSha256: string;
  exports: Readonly<{
    canonicalFrames: string;
    canonicalExportManifest: string;
    proofManifest: string;
    audit: string;
    runManifest: string;
    preview: string;
  }>;
}>;

type LoadedFinalEvidence = Readonly<{
  assessmentSha256: string;
  proofManifestSha256: string;
  auditSha256: string;
  runManifestSha256: string;
  previewSha256: string;
  framesAudited: 121;
  framesWithNonEmptyCore: 121;
  totalCorePixels: number;
  changedCoreChannelSamples: 0;
  worstMaxChannelDelta: 0;
  coreHashMatchCount: 121;
  proof: FinalProof;
}>;

export class RealJobReviewError extends Error {
  constructor(
    readonly code:
      | "ACTIVE_JOB_MISMATCH"
      | "INVALID_JOB_STATE"
      | "EVIDENCE_INCOMPLETE"
      | "EVIDENCE_INVALID"
      | "STALE_REVIEW_HASHES",
  ) {
    super(code);
    this.name = "RealJobReviewError";
  }
}

export function createRealJobReviewService(options: ServiceOptions) {
  const jobsRoot = resolve(options.jobsRoot);
  const runsRoot = resolve(options.runsRoot);

  return {
    async readVerified(rawJobId: string) {
      const jobId = jobIdSchema.parse(rawJobId);
      const record = await options.jobs.readJob(jobId);
      assertState(record, ["verified"]);
      const paths = jobPaths(jobsRoot, runsRoot, jobId);
      await assertModelOutput(record, paths);
      const assessment = await loadAssessment(record, paths);
      if (assessment.verdict !== "comparable_pending_visual_approval") {
        throw new RealJobReviewError("EVIDENCE_INVALID");
      }
      const review = await loadReview(record, paths, assessment);
      const approval = await loadCommittedApproval(paths, review);
      const evidence = await loadFinalEvidence(
        record,
        paths,
        assessment,
        review,
        approval,
        jobId,
      );
      assertVerifiedEvidenceMatchesRecord(record, evidence);
      return { job: buildRealJobView(record), proof: evidence.proof };
    },

    async review(rawJobId: string) {
      const jobId = jobIdSchema.parse(rawJobId);
      return options.jobs.withEvidenceWorkflowLock(jobId, async () => {
        await assertActiveJob(options.activeJobs, jobId);
        const record = await options.jobs.readJob(jobId);
        assertState(record, ["generated"]);
        const paidAttempt = paidAttemptEvidence(record);
        const paths = jobPaths(jobsRoot, runsRoot, jobId);
        await assertModelOutput(record, paths);

        let assessment: LoadedAssessment;
        if (await pathExists(paths.assessmentDirectory)) {
          assessment = await loadAssessment(record, paths);
        } else {
          const cliEvidence = await options.cli.assessGeneration({
            mediaPath: paths.modelOutput,
            outputDirectory: paths.assessmentDirectory,
            jobRecordPath: paths.jobRecord,
            paidAttemptIndex: paidAttempt.attemptIndex,
            paidAttemptCap: paidAttempt.attemptCap,
            unitPriceUsd: paidAttempt.unitPriceUsd,
            billingUnit: paidAttempt.billingUnit,
            estimatedUnits: paidAttempt.estimatedUnits,
            estimatedCostUsd: paidAttempt.estimatedCostUsd,
            pricingSource: paidAttempt.pricingSource,
            priceObservedAt: paidAttempt.priceObservedAt,
            snapshotCapturedAt: paidAttempt.capturedAt,
            snapshotDigestSha256: paidAttempt.digestSha256,
          });
          assessment = await loadAssessment(record, paths);
          assertAssessmentCliEvidence(cliEvidence, assessment, paths);
        }

        if (assessment.verdict === "not_comparable") {
          const terminal = await options.jobs.persistNotComparable({
            ...generatedIdentity(record),
            jobId,
            assessmentSha256: assessment.sha256,
          });
          return { job: buildRealJobView(terminal) };
        }

        let review: LoadedReview;
        if (await pathExists(paths.reviewDirectory)) {
          review = await loadReview(record, paths, assessment);
        } else {
          const cliEvidence = await options.cli.prepareGenerationReview({
            sourceProofDirectory: paths.sourceProofDirectory,
            foregroundMaskPath: paths.foregroundMask,
            generatedMediaPath: paths.modelOutput,
            generationAssessmentPath: paths.assessment,
            jobRecordPath: paths.jobRecord,
            outputDirectory: paths.reviewDirectory,
          });
          review = await loadReview(record, paths, assessment);
          assertReviewCliEvidence(cliEvidence, review, paths);
        }

        return { job: buildRealJobView(record), review: review.view };
      });
    },

    async approve(rawJobId: string, rawApproval: unknown) {
      const jobId = jobIdSchema.parse(rawJobId);
      const approval = realJobApprovalSchema.parse(rawApproval);
      return options.jobs.withEvidenceWorkflowLock(jobId, async () => {
        await assertActiveJob(options.activeJobs, jobId);
        let record = await options.jobs.readJob(jobId);
        assertState(record, ["generated", "composited", "verified"]);
        const paths = jobPaths(jobsRoot, runsRoot, jobId);
        await assertModelOutput(record, paths);
        const assessment = await loadAssessment(record, paths);
        if (assessment.verdict !== "comparable_pending_visual_approval") {
          throw new RealJobReviewError("INVALID_JOB_STATE");
        }
        const review = await loadReview(record, paths, assessment);
        assertApprovalMatchesReview(approval, review);

        let committed: CommittedFinalizationEvidence;
        try {
          committed = await options.cli.validateFinalizationCommit({
            preparedReviewDirectory: paths.reviewDirectory,
            reviewManifestSha256: approval.reviewManifestSha256,
          });
        } catch (error) {
          if (
            record.state !== "generated" ||
            !(error instanceof FrameLockCliError) ||
            error.code !== "CLI_EXECUTION_FAILED"
          ) {
            throw error;
          }
          const cliEvidence = await options.cli.finalizeGenerationProof({
            preparedReviewDirectory: paths.reviewDirectory,
            reviewManifestSha256: approval.reviewManifestSha256,
            overlaySha256s: approval.overlaySha256s,
            reviewer: approval.reviewer,
            visualNote: approval.visualNote,
          });
          if ("state" in cliEvidence) {
            return persistCanonicalFailure(
              options.jobs,
              record,
              cliEvidence.code,
            );
          }
          try {
            assertFinalCliPaths(cliEvidence, paths);
          } catch (error) {
            const code = canonicalEvidenceFailureCode(error);
            if (!code) throw error;
            return persistCanonicalFailure(options.jobs, record, code);
          }
          committed = await options.cli.validateFinalizationCommit({
            preparedReviewDirectory: paths.reviewDirectory,
            reviewManifestSha256: approval.reviewManifestSha256,
          });
        }
        try {
          await assertCommittedCliEvidence(committed, paths, review);

          const evidence = await loadFinalEvidence(
            record,
            paths,
            assessment,
            review,
            approval,
            jobId,
          );
          record = await reconcileVerifiedEvidence(options.jobs, record, evidence);
          return { job: buildRealJobView(record), proof: evidence.proof };
        } catch (error) {
          const code = canonicalEvidenceFailureCode(error);
          if (!code || record.state === "verified") throw error;
          return persistCanonicalFailure(options.jobs, record, code);
        }
      });
    },

    async resumeVerification(rawJobId: string) {
      const jobId = jobIdSchema.parse(rawJobId);
      return options.jobs.withEvidenceWorkflowLock(jobId, async () => {
        await assertActiveJob(options.activeJobs, jobId);
        let record = await options.jobs.readJob(jobId);
        assertState(record, ["composited", "verified"]);
        const paths = jobPaths(jobsRoot, runsRoot, jobId);
        await assertModelOutput(record, paths);
        const assessment = await loadAssessment(record, paths);
        if (assessment.verdict !== "comparable_pending_visual_approval") {
          throw new RealJobReviewError("INVALID_JOB_STATE");
        }
        const review = await loadReview(record, paths, assessment);
        const approval = await loadCommittedApproval(paths, review);
        const committed = await options.cli.validateFinalizationCommit({
          preparedReviewDirectory: paths.reviewDirectory,
          reviewManifestSha256: review.manifestSha256,
        });
        try {
          await assertCommittedCliEvidence(committed, paths, review);
          const evidence = await loadFinalEvidence(
            record,
            paths,
            assessment,
            review,
            approval,
            jobId,
          );
          record = await reconcileVerifiedEvidence(options.jobs, record, evidence);
          return { job: buildRealJobView(record), proof: evidence.proof };
        } catch (error) {
          const code = canonicalEvidenceFailureCode(error);
          if (!code || record.state === "verified") throw error;
          return persistCanonicalFailure(options.jobs, record, code);
        }
      });
    },
  };
}

function jobPaths(jobsRoot: string, runsRoot: string, jobId: string) {
  const jobDirectory = join(jobsRoot, jobId);
  const runDirectory = join(runsRoot, jobId);
  const assessmentDirectory = join(jobDirectory, "assessment");
  const reviewDirectory = join(jobDirectory, "canonical");
  return {
    jobsRoot,
    runsRoot,
    jobDirectory,
    runDirectory,
    jobRecord: join(jobDirectory, "job.json"),
    modelOutput: join(jobDirectory, "model-output.mp4"),
    assessmentDirectory,
    assessment: join(assessmentDirectory, "comparability.json"),
    rawProbe: join(assessmentDirectory, "ffprobe.raw.json"),
    reviewDirectory,
    reviewManifest: join(reviewDirectory, "review_manifest.json"),
    sourceProofDirectory: join(runDirectory, "proof"),
    sourceProofManifest: join(runDirectory, "proof", "proof_manifest.json"),
    protectedCore: join(
      runDirectory,
      "proof",
      "masks",
      "protected_core.png",
    ),
    boundaryRing: join(
      runDirectory,
      "proof",
      "masks",
      "feather_boundary.png",
    ),
    foregroundMask: join(runDirectory, "inputs", "foreground.png"),
    proofManifest: join(reviewDirectory, "proof_manifest.json"),
    audit: join(reviewDirectory, "audit.json"),
    preview: join(reviewDirectory, "preview.mp4"),
    runManifest: join(reviewDirectory, "run_manifest.json"),
    composites: join(reviewDirectory, "composite_frames"),
    canonicalArchive: join(reviewDirectory, "canonical_frames.zip"),
    canonicalExportManifest: join(
      reviewDirectory,
      "canonical_frames_manifest.json",
    ),
    differenceHeatmap: join(
      reviewDirectory,
      "difference_heatmap_000060.png",
    ),
    corruptionDirectory: join(reviewDirectory, "corruption_fixture"),
    corruptedFrame: join(
      reviewDirectory,
      "corruption_fixture",
      "corrupted_composite_000060.png",
    ),
    corruptionManifest: join(
      reviewDirectory,
      "corruption_fixture",
      "corruption_manifest.json",
    ),
    corruptionAudit: join(
      reviewDirectory,
      "corruption_fixture",
      "corruption_audit.json",
    ),
    corruptionSummary: join(
      reviewDirectory,
      "corruption_fixture",
      "corruption_summary.json",
    ),
    finalizationCommit: join(
      reviewDirectory,
      ".finalization-committed.json",
    ),
    finalizationJournal: join(
      reviewDirectory,
      ".finalization-transaction.json",
    ),
  };
}

async function assertActiveJob(
  activeJobs: ActiveJobPort,
  jobId: string,
): Promise<void> {
  if ((await activeJobs.read())?.jobId !== jobId) {
    throw new RealJobReviewError("ACTIVE_JOB_MISMATCH");
  }
}

function assertState(
  record: LocalJobRecord,
  allowed: readonly LocalJobRecord["state"][],
): void {
  if (!allowed.includes(record.state)) {
    throw new RealJobReviewError("INVALID_JOB_STATE");
  }
}

function generatedIdentity(record: LocalJobRecord) {
  const fal = record.fal;
  if (!fal?.modelOutput) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  return {
    generationDigest: record.generation.digest,
    endpoint: record.generation.endpoint,
    requestId: fal.requestId,
    modelOutputSha256: fal.modelOutput.sha256,
  };
}

function canonicalEvidenceFailureCode(
  error: unknown,
): CanonicalVerificationFailureCode | undefined {
  if (!(error instanceof RealJobReviewError)) return undefined;
  if (error.code === "EVIDENCE_INVALID") {
    return "CANONICAL_EVIDENCE_INVALID";
  }
  if (error.code === "EVIDENCE_INCOMPLETE") {
    return "CANONICAL_EVIDENCE_INCOMPLETE";
  }
  return undefined;
}

async function persistCanonicalFailure(
  store: LocalJobStore,
  record: LocalJobRecord,
  code: CanonicalVerificationFailureCode,
) {
  const failed = await store.persistCanonicalVerificationFailure({
    ...generatedIdentity(record),
    jobId: record.id,
    code,
  });
  return { job: buildRealJobView(failed) };
}

function paidAttemptEvidence(record: LocalJobRecord) {
  const paidAttempt = record.paidAttempt;
  if (!paidAttempt || paidAttempt.attemptCap !== 3) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  return paidAttempt;
}

async function assertModelOutput(
  record: LocalJobRecord,
  paths: ReturnType<typeof jobPaths>,
): Promise<void> {
  const identity = generatedIdentity(record);
  await assertExactRegularFile(paths.jobDirectory, paths.modelOutput);
  if ((await sha256File(paths.modelOutput)) !== identity.modelOutputSha256) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
}

async function loadAssessment(
  record: LocalJobRecord,
  paths: ReturnType<typeof jobPaths>,
): Promise<LoadedAssessment> {
  await Promise.all([
    assertExactRegularFile(paths.assessmentDirectory, paths.assessment),
    assertExactRegularFile(paths.assessmentDirectory, paths.rawProbe),
  ]);
  const payload = await readEvidenceJson(paths.assessment, assessmentSchema);
  const identity = generatedIdentity(record);
  const paidAttempt = paidAttemptEvidence(record);
  assertExactPath(payload.model_output.path, paths.modelOutput);
  assertExactPath(payload.probe.path, paths.rawProbe);
  if (
    payload.model_output.sha256 !== identity.modelOutputSha256 ||
    payload.job_provenance.id !== record.id ||
    payload.job_provenance.generation.digest !== record.generation.digest ||
    payload.job_provenance.generation.sourceSha256 !==
      record.generation.sourceSha256 ||
    payload.job_provenance.generation.editMaskSha256 !==
      record.generation.editMaskSha256 ||
    payload.job_provenance.generation.endpoint !== record.generation.endpoint ||
    payload.job_provenance.fal.generationDigest !== record.generation.digest ||
    payload.job_provenance.fal.endpoint !== record.generation.endpoint ||
    payload.job_provenance.fal.requestId !== identity.requestId ||
    payload.job_provenance.fal.modelOutput.sha256 !==
      identity.modelOutputSha256 ||
    payload.attempt.index !== paidAttempt.attemptIndex ||
    payload.attempt.cap !== paidAttempt.attemptCap ||
    payload.pricing.unit_price_usd !== paidAttempt.unitPriceUsd ||
    payload.pricing.billing_unit !== paidAttempt.billingUnit ||
    payload.pricing.estimated_units !== paidAttempt.estimatedUnits ||
    payload.pricing.estimated_cost_usd !== paidAttempt.estimatedCostUsd ||
    payload.pricing.source !== paidAttempt.pricingSource ||
    payload.pricing.price_observed_at !== paidAttempt.priceObservedAt ||
    payload.pricing.snapshot_captured_at !== paidAttempt.capturedAt ||
    payload.pricing.snapshot_digest_sha256 !== paidAttempt.digestSha256 ||
    (await sha256File(paths.rawProbe)) !== payload.probe.raw_json_sha256
  ) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  const expectedApproval =
    payload.verdict === "not_comparable"
      ? "not_reached_automatic_gate_failed"
      : "pending_human_review";
  if (payload.visual_geometry_approval !== expectedApproval) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  return {
    path: paths.assessment,
    rawProbePath: paths.rawProbe,
    sha256: await sha256File(paths.assessment),
    verdict: payload.verdict,
  };
}

function assertAssessmentCliEvidence(
  cli: GenerationAssessmentEvidence,
  assessment: LoadedAssessment,
  paths: ReturnType<typeof jobPaths>,
): void {
  if (
    resolve(cli.assessment) !== resolve(assessment.path) ||
    resolve(cli.raw_probe) !== resolve(assessment.rawProbePath) ||
    resolve(cli.assessment) !== resolve(paths.assessment) ||
    cli.verdict !== assessment.verdict
  ) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
}

async function loadReview(
  record: LocalJobRecord,
  paths: ReturnType<typeof jobPaths>,
  assessment: LoadedAssessment,
): Promise<LoadedReview> {
  await assertExactRegularFile(paths.reviewDirectory, paths.reviewManifest);
  const payload = await readEvidenceJson(paths.reviewManifest, reviewManifestSchema);
  const identity = generatedIdentity(record);
  const sourceAudio = await loadReviewSourceAudio(payload, paths);
  const proofSha256 = await sha256File(paths.sourceProofManifest);
  const maskSha256 = await sha256File(paths.foregroundMask);
  assertExactPath(
    payload.generation_assessment.path,
    paths.assessment,
  );
  assertExactPath(payload.source_proof.directory, paths.sourceProofDirectory);
  assertExactPath(payload.prepared_foreground_mask.path, paths.foregroundMask);
  assertExactPath(
    payload.generated_decode_provenance.source_media_path,
    paths.modelOutput,
  );
  if (
    payload.job.id !== record.id ||
    payload.job.endpoint !== record.generation.endpoint ||
    payload.job.request_id !== identity.requestId ||
    payload.job.generation_digest !== record.generation.digest ||
    payload.job.source_sha256 !== record.generation.sourceSha256 ||
    payload.job.restoration_mask_sha256 !== record.generation.editMaskSha256 ||
    payload.job.model_output_sha256 !== identity.modelOutputSha256 ||
    payload.generation_assessment.sha256 !== assessment.sha256 ||
    payload.source_proof.proof_manifest_sha256 !== proofSha256 ||
    payload.prepared_foreground_mask.sha256 !== maskSha256 ||
    payload.generated_decode_provenance.source_file_sha256 !==
      identity.modelOutputSha256
  ) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  const unsigned = withoutDigest(payload);
  if (sha256(canonicalJson(unsigned)) !== payload.digest_sha256) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  await Promise.all(
    payload.generated_frames.map(async (frame, index) => {
      const expected = join(
        paths.reviewDirectory,
        "generated_frames",
        `frame_${String(index).padStart(6, "0")}.png`,
      );
      if (frame.source_index !== index) {
        throw new RealJobReviewError("EVIDENCE_INVALID");
      }
      assertExactPath(frame.path, expected);
      await assertExactRegularFile(paths.reviewDirectory, expected);
      if ((await sha256File(expected)) !== frame.file_sha256) {
        throw new RealJobReviewError("EVIDENCE_INVALID");
      }
    }),
  );
  const overlayPaths = payload.geometry_overlays.map((overlay, index) => {
    const sourceIndex = REVIEW_INDICES[index];
    const expected = join(
      paths.reviewDirectory,
      "geometry_overlays",
      `overlay_${String(sourceIndex).padStart(6, "0")}.png`,
    );
    if (overlay.source_index !== sourceIndex) {
      throw new RealJobReviewError("EVIDENCE_INVALID");
    }
    assertExactPath(overlay.path, expected);
    return expected;
  }) as [string, string, string];
  const overlaySha256s = payload.geometry_overlays.map(
    (overlay) => overlay.sha256,
  ) as [string, string, string];
  await Promise.all(
    overlayPaths.map(async (path, index) => {
      await assertExactRegularFile(paths.reviewDirectory, path);
      if ((await sha256File(path)) !== overlaySha256s[index]) {
        throw new RealJobReviewError("EVIDENCE_INVALID");
      }
    }),
  );
  const manifestSha256 = await sha256File(paths.reviewManifest);
  return {
    assessmentSha256: assessment.sha256,
    manifestPath: paths.reviewManifest,
    manifestSha256,
    manifestDigestSha256: payload.digest_sha256,
    ...(sourceAudio ? { sourceAudio } : {}),
    overlayPaths,
    overlaySha256s,
    view: {
      state: "awaiting_visual_geometry_approval",
      reviewManifestSha256: manifestSha256,
      reviewManifestDigestSha256: payload.digest_sha256,
      overlaySha256s,
      overlays: [
        {
          frame: 0,
          url: mediaUrl(record.id, "overlay-0"),
          sha256: overlaySha256s[0],
        },
        {
          frame: 60,
          url: mediaUrl(record.id, "overlay-60"),
          sha256: overlaySha256s[1],
        },
        {
          frame: 120,
          url: mediaUrl(record.id, "overlay-120"),
          sha256: overlaySha256s[2],
        },
      ],
    },
  };
}

async function loadReviewSourceAudio(
  payload: z.infer<typeof reviewManifestSchema>,
  paths: ReturnType<typeof jobPaths>,
): Promise<z.infer<typeof sourceAudioBindingSchema> | undefined> {
  const raw = payload.source_audio;
  if (payload.schema_version === 1) {
    if (raw !== undefined) {
      throw new RealJobReviewError("EVIDENCE_INVALID");
    }
    return undefined;
  }
  const parsed = sourceAudioBindingSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  const audio = parsed.data;
  const manifestPath = join(paths.sourceProofDirectory, "source_audio.json");
  assertExactPath(audio.manifest_path, manifestPath);
  await assertExactRegularFile(paths.sourceProofDirectory, manifestPath);
  if ((await sha256File(manifestPath)) !== audio.manifest_sha256) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  if (audio.source_audio_present) {
    if (!audio.normalized_audio_path || !audio.normalized_audio_sha256) {
      throw new RealJobReviewError("EVIDENCE_INVALID");
    }
    const normalizedPath = join(paths.sourceProofDirectory, "source_audio.wav");
    assertExactPath(audio.normalized_audio_path, normalizedPath);
    await assertExactRegularFile(paths.sourceProofDirectory, normalizedPath);
    if ((await sha256File(normalizedPath)) !== audio.normalized_audio_sha256) {
      throw new RealJobReviewError("EVIDENCE_INVALID");
    }
  }
  return audio;
}

function assertReviewCliEvidence(
  cli: GenerationReviewEvidence,
  review: LoadedReview,
  paths: ReturnType<typeof jobPaths>,
): void {
  if (
    cli.generated_frames !== FRAME_COUNT ||
    cli.review_state !== "awaiting_visual_geometry_approval" ||
    resolve(cli.review_manifest) !== resolve(paths.reviewManifest) ||
    cli.review_manifest_sha256 !== review.manifestSha256 ||
    cli.review_manifest_digest_sha256 !== review.manifestDigestSha256 ||
    !sameTuple(cli.geometry_overlays, review.overlayPaths) ||
    !sameTuple(cli.geometry_overlay_sha256s, review.overlaySha256s)
  ) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
}

function assertApprovalMatchesReview(
  approval: RealJobApproval,
  review: LoadedReview,
): void {
  if (
    approval.reviewManifestSha256 !== review.manifestSha256 ||
    !sameTuple(approval.overlaySha256s, review.overlaySha256s)
  ) {
    throw new RealJobReviewError("STALE_REVIEW_HASHES");
  }
}

function assertFinalCliPaths(
  evidence: FinalizationSuccessEvidence,
  paths: ReturnType<typeof jobPaths>,
): void {
  if (
    evidence.claim !== VERIFIED_CLAIM ||
    evidence.canonical_contract_passed !== true ||
    evidence.changed_core_channel_samples !== 0 ||
    resolve(evidence.manifest) !== resolve(paths.proofManifest) ||
    resolve(evidence.audit) !== resolve(paths.audit) ||
    resolve(evidence.preview) !== resolve(paths.preview) ||
    resolve(evidence.run_manifest) !== resolve(paths.runManifest)
  ) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
}

async function assertCommittedCliEvidence(
  evidence: CommittedFinalizationEvidence,
  paths: ReturnType<typeof jobPaths>,
  review: LoadedReview,
): Promise<void> {
  if (
    evidence.state !== "committed" ||
    evidence.schema_version !== 1 ||
    evidence.output_count !== 9 ||
    evidence.review_manifest_sha256 !== review.manifestSha256 ||
    resolve(evidence.marker) !== resolve(paths.finalizationCommit)
  ) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  await assertExactRegularFile(paths.reviewDirectory, paths.finalizationCommit);
  if ((await sha256File(paths.finalizationCommit)) !== evidence.marker_sha256) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  if (await pathExists(paths.finalizationJournal)) {
    throw new RealJobReviewError("EVIDENCE_INCOMPLETE");
  }
}

async function loadFinalEvidence(
  record: LocalJobRecord,
  paths: ReturnType<typeof jobPaths>,
  assessment: LoadedAssessment,
  review: LoadedReview,
  approval: RealJobApproval,
  jobId: string,
): Promise<LoadedFinalEvidence> {
  await Promise.all(
    [
      paths.proofManifest,
      paths.audit,
      paths.preview,
      paths.runManifest,
      paths.canonicalArchive,
      paths.canonicalExportManifest,
      paths.differenceHeatmap,
      paths.corruptedFrame,
      paths.corruptionManifest,
      paths.corruptionAudit,
      paths.corruptionSummary,
      paths.finalizationCommit,
    ].map((path) => assertExactRegularFile(paths.reviewDirectory, path)),
  );
  await Promise.all([
    assertExactRegularFile(paths.sourceProofDirectory, paths.protectedCore),
    assertExactRegularFile(paths.sourceProofDirectory, paths.boundaryRing),
  ]);
  const [
    proofManifest,
    audit,
    runManifest,
    exportManifest,
    corruptionManifest,
    corruptionAudit,
    corruptionSummary,
    finalizationCommit,
  ] = await Promise.all([
    readEvidenceJson(paths.proofManifest, proofManifestSchema),
    readEvidenceJson(paths.audit, auditSchema),
    readEvidenceJson(paths.runManifest, runManifestSchema),
    readEvidenceJson(
      paths.canonicalExportManifest,
      canonicalExportManifestSchema,
    ),
    readEvidenceJson(paths.corruptionManifest, corruptionManifestSchema),
    readEvidenceJson(paths.corruptionAudit, corruptionAuditSchema),
    readEvidenceJson(paths.corruptionSummary, corruptionSummarySchema),
    readEvidenceJson(paths.finalizationCommit, finalizationCommitSchema),
  ]);
  const identity = generatedIdentity(record);
  const [
    proofManifestSha256,
    auditSha256,
    previewSha256,
    runManifestSha256,
    canonicalArchiveSha256,
    canonicalExportManifestSha256,
    corruptionManifestSha256,
    corruptionAuditSha256,
    corruptionSummarySha256,
    corruptedFrameSha256,
    protectedCoreSha256,
    boundaryRingSha256,
    differenceHeatmapSha256,
  ] = await Promise.all([
      sha256File(paths.proofManifest),
      sha256File(paths.audit),
      sha256File(paths.preview),
      sha256File(paths.runManifest),
      sha256File(paths.canonicalArchive),
      sha256File(paths.canonicalExportManifest),
      sha256File(paths.corruptionManifest),
      sha256File(paths.corruptionAudit),
      sha256File(paths.corruptionSummary),
      sha256File(paths.corruptedFrame),
      sha256File(paths.protectedCore),
      sha256File(paths.boundaryRing),
      sha256File(paths.differenceHeatmap),
    ]);
  assertExactPath(
    proofManifest.generation_binding.prepared_foreground_mask_path,
    paths.foregroundMask,
  );
  assertExactPath(
    proofManifest.generation_binding.generated_media_provenance
      .source_media_path,
    paths.modelOutput,
  );
  if (
    proofManifest.generation_binding.prepared_foreground_mask_file_sha256 !==
      record.generation.editMaskSha256 ||
    proofManifest.generation_binding.generated_media_provenance
      .source_file_sha256 !== identity.modelOutputSha256
  ) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  await Promise.all(
    proofManifest.frames.map(async (frame, index) => {
      const suffix = String(index).padStart(6, "0");
      const sourcePath = join(
        paths.sourceProofDirectory,
        "source_frames",
        `frame_${suffix}.png`,
      );
      const coreMaskPath = join(
        paths.sourceProofDirectory,
        "core_masks",
        `core_${suffix}.png`,
      );
      const generatedPath = join(
        paths.reviewDirectory,
        "generated_frames",
        `frame_${suffix}.png`,
      );
      const compositePath = join(
        paths.composites,
        `composite_${suffix}.png`,
      );
      if (frame.index !== index) {
        throw new RealJobReviewError("EVIDENCE_INVALID");
      }
      assertExactPath(frame.source_path, sourcePath);
      assertExactPath(frame.core_mask_path, coreMaskPath);
      assertExactPath(frame.generated_path, generatedPath);
      assertExactPath(frame.composite_path, compositePath);
      await Promise.all([
        assertExactRegularFile(paths.sourceProofDirectory, sourcePath),
        assertExactRegularFile(paths.sourceProofDirectory, coreMaskPath),
        assertExactRegularFile(paths.reviewDirectory, generatedPath),
        assertExactRegularFile(paths.reviewDirectory, compositePath),
      ]);
      const [sourceSha256, coreMaskSha256, generatedSha256, compositeSha256] =
        await Promise.all([
          sha256File(sourcePath),
          sha256File(coreMaskPath),
          sha256File(generatedPath),
          sha256File(compositePath),
        ]);
      if (
        frame.source_file_sha256 !== sourceSha256 ||
        frame.core_mask_file_sha256 !== coreMaskSha256 ||
        frame.generated_file_sha256 !== generatedSha256 ||
        frame.composite_file_sha256 !== compositeSha256
      ) {
        throw new RealJobReviewError("EVIDENCE_INVALID");
      }
    }),
  );
  assertExactPath(runManifest.generation_assessment.path, paths.assessment);
  assertExactPath(runManifest.review_evidence.manifest_path, paths.reviewManifest);
  assertExactPath(runManifest.proof.manifest_path, paths.proofManifest);
  assertExactPath(runManifest.proof.audit_path, paths.audit);
  assertExactPath(runManifest.preview.path, paths.preview);
  assertExactPath(
    runManifest.exports.canonical_frames.archive_path,
    paths.canonicalArchive,
  );
  assertExactPath(
    runManifest.exports.canonical_frames.manifest_path,
    paths.canonicalExportManifest,
  );
  assertExactPath(runManifest.negative_test.manifest_path, paths.corruptionManifest);
  assertExactPath(runManifest.negative_test.audit_path, paths.corruptionAudit);
  assertExactPath(runManifest.negative_test.summary_path, paths.corruptionSummary);
  assertExactPath(
    runManifest.visualizations.protected_core_frame_60.path,
    paths.protectedCore,
  );
  assertExactPath(
    runManifest.visualizations.boundary_ring_frame_60.path,
    paths.boundaryRing,
  );
  assertExactPath(
    runManifest.visualizations.difference_heatmap_frame_60.path,
    paths.differenceHeatmap,
  );
  assertExactPath(corruptionSummary.manifest_path, paths.corruptionManifest);
  assertExactPath(corruptionSummary.audit_path, paths.corruptionAudit);
  if (
    proofManifest.digest_sha256 !== audit.audit.manifest_digest_sha256 ||
    proofManifest.digest_sha256 !== audit.manifest.digest_sha256 ||
    proofManifest.digest_sha256 !== runManifest.proof.manifest_digest_sha256 ||
    runManifest.job.id !== record.id ||
    runManifest.job.endpoint !== record.generation.endpoint ||
    runManifest.job.request_id !== identity.requestId ||
    runManifest.job.generation_digest !== record.generation.digest ||
    runManifest.job.source_sha256 !== record.generation.sourceSha256 ||
    runManifest.job.restoration_mask_sha256 !==
      record.generation.editMaskSha256 ||
    runManifest.job.model_output_sha256 !== identity.modelOutputSha256 ||
    runManifest.generation_assessment.sha256 !== assessment.sha256 ||
    runManifest.review_evidence.manifest_sha256 !== review.manifestSha256 ||
    runManifest.review_evidence.manifest_digest_sha256 !==
      review.manifestDigestSha256 ||
    runManifest.visual_geometry_approval.reviewer !== approval.reviewer ||
    runManifest.visual_geometry_approval.note !== approval.visualNote ||
    runManifest.visual_geometry_approval.review_manifest_sha256 !==
      approval.reviewManifestSha256 ||
    !sameTuple(
      runManifest.visual_geometry_approval.reviewed_overlay_sha256s,
      approval.overlaySha256s,
    ) ||
    runManifest.proof.manifest_sha256 !== proofManifestSha256 ||
    runManifest.proof.audit_sha256 !== auditSha256 ||
    runManifest.preview.sha256 !== previewSha256 ||
    runManifest.exports.canonical_frames.archive_sha256 !==
      canonicalArchiveSha256 ||
    runManifest.exports.canonical_frames.manifest_sha256 !==
      canonicalExportManifestSha256 ||
    runManifest.visualizations.protected_core_frame_60.sha256 !==
      protectedCoreSha256 ||
    protectedCoreSha256 !== proofManifest.frames[60].core_mask_file_sha256 ||
    runManifest.visualizations.boundary_ring_frame_60.sha256 !==
      boundaryRingSha256 ||
    runManifest.visualizations.difference_heatmap_frame_60.sha256 !==
      differenceHeatmapSha256 ||
    runManifest.visualizations.difference_heatmap_frame_60
      .source_file_sha256 !== proofManifest.frames[60].source_file_sha256 ||
    runManifest.visualizations.difference_heatmap_frame_60
      .composite_file_sha256 !==
      proofManifest.frames[60].composite_file_sha256 ||
    runManifest.exports.canonical_frames.total_uncompressed_bytes !==
      exportManifest.total_uncompressed_bytes ||
    exportManifest.proof_manifest_digest_sha256 !==
      proofManifest.digest_sha256 ||
    exportManifest.archive.sha256 !== canonicalArchiveSha256 ||
    exportManifest.frames.some(
      (frame, index) =>
        frame.source_index !== index ||
        frame.file_sha256 !==
          proofManifest.frames[index].composite_file_sha256,
    ) ||
    runManifest.negative_test.manifest_sha256 !== corruptionManifestSha256 ||
    runManifest.negative_test.audit_sha256 !== corruptionAuditSha256 ||
    runManifest.negative_test.summary_sha256 !== corruptionSummarySha256 ||
    corruptionSummary.manifest_sha256 !== corruptionManifestSha256 ||
    corruptionSummary.audit_sha256 !== corruptionAuditSha256 ||
    corruptionManifest.digest_sha256 !==
      corruptionAudit.audit.manifest_digest_sha256 ||
    (runManifest.schema_version === 6) !== Boolean(review.sourceAudio) ||
    (runManifest.schema_version === 6 &&
      canonicalJson(runManifest.audio) !== canonicalJson(review.sourceAudio))
  ) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  const unsignedRun = withoutDigest(runManifest);
  if (sha256(canonicalJson(unsignedRun)) !== runManifest.digest_sha256) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  await assertFinalizationCommit({
    marker: finalizationCommit,
    paths,
    reviewManifestSha256: review.manifestSha256,
    proofManifest,
    hashes: {
      proofManifestSha256,
      auditSha256,
      previewSha256,
      runManifestSha256,
      canonicalArchiveSha256,
      canonicalExportManifestSha256,
      corruptedFrameSha256,
      corruptionManifestSha256,
      corruptionAuditSha256,
      corruptionSummarySha256,
      differenceHeatmapSha256,
    },
  });
  try {
    await validateCanonicalStoredZip({
      archivePath: paths.canonicalArchive,
      frames: exportManifest.frames.map((frame) => ({
        archivePath: frame.archive_path,
        fileSha256: frame.file_sha256,
      })),
      totalUncompressedBytes: exportManifest.total_uncompressed_bytes,
    });
  } catch (error) {
    if (error instanceof CanonicalZipError) {
      throw new RealJobReviewError("EVIDENCE_INVALID");
    }
    throw error;
  }
  return {
    assessmentSha256: assessment.sha256,
    proofManifestSha256,
    auditSha256,
    runManifestSha256,
    previewSha256,
    framesAudited: 121,
    framesWithNonEmptyCore: 121,
    totalCorePixels: audit.audit.total_core_pixels,
    changedCoreChannelSamples: 0,
    worstMaxChannelDelta: 0,
    coreHashMatchCount: 121,
    proof: {
      claim: VERIFIED_CLAIM,
      framesAudited: 121,
      protectedCorePixels: audit.audit.total_core_pixels,
      changedCoreChannelSamples: 0,
      worstMaxChannelDelta: 0,
      coreHashMatchCount: 121,
      proofManifestSha256,
      auditSha256,
      runManifestSha256,
      previewSha256,
      exports: {
        canonicalFrames: mediaUrl(jobId, "canonical-frames"),
        canonicalExportManifest: mediaUrl(
          jobId,
          "canonical-export-manifest",
        ),
        proofManifest: mediaUrl(jobId, "proof-manifest"),
        audit: mediaUrl(jobId, "audit"),
        runManifest: mediaUrl(jobId, "run-manifest"),
        preview: mediaUrl(jobId, "preview"),
      },
    },
  };
}

async function loadCommittedApproval(
  paths: ReturnType<typeof jobPaths>,
  review: LoadedReview,
): Promise<RealJobApproval> {
  await assertExactRegularFile(paths.reviewDirectory, paths.runManifest);
  const runManifest = await readEvidenceJson(
    paths.runManifest,
    runManifestSchema,
  );
  const persisted = runManifest.visual_geometry_approval;
  const approval: RealJobApproval = {
    approval: APPROVE_REVIEW_PHRASE,
    reviewManifestSha256: persisted.review_manifest_sha256,
    overlaySha256s: persisted.reviewed_overlay_sha256s,
    reviewer: persisted.reviewer,
    visualNote: persisted.note,
  };
  try {
    assertApprovalMatchesReview(approval, review);
  } catch {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  return approval;
}

async function assertFinalizationCommit(input: {
  marker: z.infer<typeof finalizationCommitSchema>;
  paths: ReturnType<typeof jobPaths>;
  reviewManifestSha256: string;
  proofManifest: z.infer<typeof proofManifestSchema>;
  hashes: Readonly<{
    proofManifestSha256: string;
    auditSha256: string;
    previewSha256: string;
    runManifestSha256: string;
    canonicalArchiveSha256: string;
    canonicalExportManifestSha256: string;
    corruptedFrameSha256: string;
    corruptionManifestSha256: string;
    corruptionAuditSha256: string;
    corruptionSummarySha256: string;
    differenceHeatmapSha256: string;
  }>;
}): Promise<void> {
  const { marker, paths, hashes } = input;
  const unsigned = withoutDigest(marker);
  if (
    marker.review_manifest_sha256 !== input.reviewManifestSha256 ||
    sha256(canonicalJson(unsigned)) !== marker.digest_sha256
  ) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  const fileRecords = await Promise.all(
    [
      ["proof_manifest.json", paths.proofManifest, hashes.proofManifestSha256],
      ["audit.json", paths.audit, hashes.auditSha256],
      ["preview.mp4", paths.preview, hashes.previewSha256],
      ["run_manifest.json", paths.runManifest, hashes.runManifestSha256],
      [
        "canonical_frames.zip",
        paths.canonicalArchive,
        hashes.canonicalArchiveSha256,
      ],
      [
        "canonical_frames_manifest.json",
        paths.canonicalExportManifest,
        hashes.canonicalExportManifestSha256,
      ],
      [
        "difference_heatmap_000060.png",
        paths.differenceHeatmap,
        hashes.differenceHeatmapSha256,
      ],
    ].map(async ([path, absolutePath, digest]) => ({
      path,
      kind: "file" as const,
      sha256: digest,
      size_bytes: await exactFileSize(absolutePath),
    })),
  );
  const compositeFiles = input.proofManifest.frames.map((frame, index) => ({
    path: `composite_${String(index).padStart(6, "0")}.png`,
    sha256: frame.composite_file_sha256,
  }));
  const corruptionFiles = [
    {
      path: "corrupted_composite_000060.png",
      sha256: hashes.corruptedFrameSha256,
    },
    { path: "corruption_audit.json", sha256: hashes.corruptionAuditSha256 },
    {
      path: "corruption_manifest.json",
      sha256: hashes.corruptionManifestSha256,
    },
    {
      path: "corruption_summary.json",
      sha256: hashes.corruptionSummarySha256,
    },
  ];
  const expected = [
    {
      path: "composite_frames",
      kind: "directory" as const,
      file_count: compositeFiles.length,
      tree_digest_sha256: sha256(canonicalJson(compositeFiles)),
    },
    ...fileRecords,
    {
      path: "corruption_fixture",
      kind: "directory" as const,
      file_count: corruptionFiles.length,
      tree_digest_sha256: sha256(canonicalJson(corruptionFiles)),
    },
  ];
  if (canonicalJson(marker.outputs) !== canonicalJson(expected)) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
}

async function exactFileSize(path: string): Promise<number> {
  const facts = await lstat(path);
  if (!facts.isFile() || facts.isSymbolicLink() || facts.size <= 0) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
  return facts.size;
}

async function reconcileVerifiedEvidence(
  store: LocalJobStore,
  initial: LocalJobRecord,
  evidence: LoadedFinalEvidence,
): Promise<LocalJobRecord> {
  let record = initial;
  const identity = generatedIdentity(record);
  if (record.state === "generated") {
    record = await store.persistComposition({
      ...identity,
      jobId: record.id,
      assessmentSha256: evidence.assessmentSha256,
      proofManifestSha256: evidence.proofManifestSha256,
    });
  }
  if (record.state === "composited") {
    if (
      record.assessment?.verdict !== "comparable" ||
      record.assessment.sha256 !== evidence.assessmentSha256 ||
      record.composition?.proofManifestSha256 !==
        evidence.proofManifestSha256
    ) {
      throw new RealJobReviewError("EVIDENCE_INVALID");
    }
    record = await store.persistVerification({
      ...identity,
      jobId: record.id,
      proofManifestSha256: evidence.proofManifestSha256,
      auditSha256: evidence.auditSha256,
      runManifestSha256: evidence.runManifestSha256,
      previewSha256: evidence.previewSha256,
      framesAudited: evidence.framesAudited,
      framesWithNonEmptyCore: evidence.framesWithNonEmptyCore,
      totalCorePixels: evidence.totalCorePixels,
      changedCoreChannelSamples: evidence.changedCoreChannelSamples,
      worstMaxChannelDelta: evidence.worstMaxChannelDelta,
      coreHashMatchCount: evidence.coreHashMatchCount,
    });
  }
  assertVerifiedEvidenceMatchesRecord(record, evidence);
  return record;
}

function assertVerifiedEvidenceMatchesRecord(
  record: LocalJobRecord,
  evidence: LoadedFinalEvidence,
): void {
  if (record.state !== "verified") {
    throw new RealJobReviewError("INVALID_JOB_STATE");
  }
  const verification = record.verification;
  if (
    record.assessment?.sha256 !== evidence.assessmentSha256 ||
    record.composition?.proofManifestSha256 !==
      evidence.proofManifestSha256 ||
    !verification ||
    verification.claim !== VERIFIED_CLAIM ||
    verification.auditSha256 !== evidence.auditSha256 ||
    verification.runManifestSha256 !== evidence.runManifestSha256 ||
    verification.previewSha256 !== evidence.previewSha256 ||
    verification.framesAudited !== evidence.framesAudited ||
    verification.framesWithNonEmptyCore !== evidence.framesWithNonEmptyCore ||
    verification.totalCorePixels !== evidence.totalCorePixels ||
    verification.changedCoreChannelSamples !==
      evidence.changedCoreChannelSamples ||
    verification.worstMaxChannelDelta !== evidence.worstMaxChannelDelta ||
    verification.coreHashMatchCount !== evidence.coreHashMatchCount
  ) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
}

async function readEvidenceJson<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof RealJobReviewError) throw error;
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
}

async function assertExactRegularFile(root: string, path: string): Promise<void> {
  try {
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(path);
    const traversal = relative(resolvedRoot, resolvedPath);
    if (
      traversal === "" ||
      traversal === ".." ||
      traversal.startsWith(`..${sep}`) ||
      isAbsolute(traversal)
    ) {
      throw new RealJobReviewError("EVIDENCE_INVALID");
    }
    const rootInfo = await lstat(resolvedRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new RealJobReviewError("EVIDENCE_INVALID");
    }
    const parts = traversal.split(sep);
    let current = resolvedRoot;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const info = await lstat(current);
      const final = index === parts.length - 1;
      if (
        info.isSymbolicLink() ||
        (final ? !info.isFile() : !info.isDirectory())
      ) {
        throw new RealJobReviewError("EVIDENCE_INVALID");
      }
    }
  } catch (error) {
    if (error instanceof RealJobReviewError) throw error;
    throw new RealJobReviewError("EVIDENCE_INCOMPLETE");
  }
}

function assertExactPath(candidate: string, expected: string): void {
  if (resolve(candidate) !== resolve(expected)) {
    throw new RealJobReviewError("EVIDENCE_INVALID");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(([key, item]) => `${asciiJsonString(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return asciiJsonString(value);
  return JSON.stringify(value);
}

function withoutDigest(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "digest_sha256"),
  );
}

function asciiJsonString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function sameTuple(
  left: readonly [string, string, string],
  right: readonly [string, string, string],
): boolean {
  return left.every(
    (value, index) =>
      resolveHashOrPath(value) === resolveHashOrPath(right[index]),
  );
}

function resolveHashOrPath(value: string): string {
  return isAbsolute(value) ? resolve(value) : value;
}

function mediaUrl(jobId: string, asset: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/media/${asset}`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
