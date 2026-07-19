import { z } from "zod";

export const P0_MEDIA_CONTRACT = {
  width: 1280,
  height: 720,
  frameCount: 121,
  fpsNumerator: 24,
  fpsDenominator: 1,
  maxTimestampResidualMs: 1,
  maxBytes: 50 * 1024 * 1024,
} as const;

export const jobStateSchema = z.enum([
  "created",
  "validated",
  "submitting",
  "submission_unknown",
  "submitted",
  "queued",
  "generating",
  "generated",
  "not_comparable",
  "composited",
  "verified",
  "failed",
]);

export type JobState = z.infer<typeof jobStateSchema>;

const transitions: Readonly<Record<JobState, readonly JobState[]>> = {
  created: ["validated", "failed"],
  validated: ["submitting", "failed"],
  submitting: ["submitted", "submission_unknown", "failed"],
  submission_unknown: [],
  submitted: ["queued", "generating", "generated", "failed"],
  queued: ["generating", "generated", "failed"],
  generating: ["generated", "failed"],
  generated: ["not_comparable", "composited", "failed"],
  not_comparable: [],
  composited: ["verified", "failed"],
  verified: [],
  failed: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return transitions[from].includes(to);
}

const passingAuditSchema = z.object({
  framesAudited: z.literal(P0_MEDIA_CONTRACT.frameCount),
  framesWithNonEmptyCore: z.literal(P0_MEDIA_CONTRACT.frameCount),
  totalCorePixels: z.number().int().positive(),
  changedCoreSamples: z.literal(0),
  worstMaxChannelDelta: z.literal(0),
  coreHashMatchCount: z.literal(P0_MEDIA_CONTRACT.frameCount),
  comparabilityPassed: z.literal(true),
  stage: z.literal("canonical_pre_encode"),
});

export const verifiedJobSchema = z.object({
  id: z.string().min(1),
  state: z.literal("verified"),
  sourceArtifactId: z.string().min(1),
  coreMaskArtifactId: z.string().min(1),
  editMaskArtifactId: z.string().min(1),
  requestId: z.string().min(1),
  audit: passingAuditSchema,
});

export type VerifiedJob = z.infer<typeof verifiedJobSchema>;
