import { z } from "zod";

import { aiSourceProvenanceSchema } from "./ai-source-provenance";

export const PROTECTED_CORE_CLAIM =
  "Protected core verified — canonical pre-encode frame sequence." as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalFailureCodes = [
  "CANONICAL_FINALIZATION_REJECTED",
  "CANONICAL_EVIDENCE_INVALID",
  "CANONICAL_EVIDENCE_INCOMPLETE",
] as const;
const canonicalFailureDetailByCode = {
  CANONICAL_FINALIZATION_REJECTED:
    "Canonical finalization rejected the approved evidence; no proof was promoted.",
  CANONICAL_EVIDENCE_INVALID:
    "Committed canonical evidence failed integrity validation; no proof was promoted.",
  CANONICAL_EVIDENCE_INCOMPLETE:
    "Committed canonical evidence was incomplete; no proof was promoted.",
} as const;
const canonicalFailureDetails = [
  canonicalFailureDetailByCode.CANONICAL_FINALIZATION_REJECTED,
  canonicalFailureDetailByCode.CANONICAL_EVIDENCE_INVALID,
  canonicalFailureDetailByCode.CANONICAL_EVIDENCE_INCOMPLETE,
] as const;

const sourceProvenanceViewSchema = aiSourceProvenanceSchema
  .extend({ fileSha256: sha256Schema })
  .strict();

export const realJobWorkspaceViewSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    state: z.enum([
      "validated",
      "submitting",
      "submission_unknown",
      "submitted",
      "generated",
      "not_comparable",
      "composited",
      "verified",
      "failed",
    ]),
    endpoint: z.literal(
      "fal-ai/kling-video/o3/standard/video-to-video/edit",
    ),
    generationDigest: sha256Schema,
    prompt: z.string().min(1),
    sourceSha256: sha256Schema,
    editMaskSha256: sha256Schema,
    sourceProvenance: sourceProvenanceViewSchema.optional(),
    claim: z.null().optional(),
    nextStep: z.string().optional(),
    protectedCorePixelsPerFrame: z.number().int().positive().optional(),
    requestId: z.string().optional(),
    remoteStatus: z.string().optional(),
    failureCode: z.string().optional(),
    failureDetail: z.enum(canonicalFailureDetails).optional(),
    verification: z
      .object({
        claim: z.literal(PROTECTED_CORE_CLAIM),
        framesAudited: z.literal(121),
        changedCoreChannelSamples: z.literal(0),
        worstMaxChannelDelta: z.literal(0),
        coreHashMatchCount: z.literal(121),
      })
      .strict()
      .optional(),
  })
  .superRefine((job, context) => {
    const canonicalCode = canonicalFailureCodes.find(
      (code) => code === job.failureCode,
    );
    if (
      canonicalCode &&
      (job.state !== "failed" ||
        job.failureDetail !== canonicalFailureDetailByCode[canonicalCode])
    ) {
      context.addIssue({
        code: "custom",
        path: ["failureDetail"],
        message: "Canonical failure code and safe detail must match",
      });
    }
    if (job.failureDetail && !canonicalCode) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "Canonical failure detail requires its allowlisted code",
      });
    }
  });

export type RealJobWorkspaceView = z.infer<
  typeof realJobWorkspaceViewSchema
>;

export function createAiJobId(uuid: string): string {
  return `ai_${z.string().uuid().parse(uuid).replaceAll("-", "")}`;
}

export function parseRealJobWorkspaceView(value: unknown): RealJobWorkspaceView {
  return realJobWorkspaceViewSchema.parse(value);
}

const RESUMABLE_STATES: ReadonlySet<RealJobWorkspaceView["state"]> = new Set([
  "validated",
  "submitting",
  "submitted",
  "generated",
  "composited",
  "verified",
]);

export function resumableRealJobWorkspaceView(
  value: unknown,
): RealJobWorkspaceView | null {
  const view = parseRealJobWorkspaceView(value);
  return RESUMABLE_STATES.has(view.state) ? view : null;
}
