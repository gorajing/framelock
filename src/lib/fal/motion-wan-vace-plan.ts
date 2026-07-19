import { z } from "zod";

export const MOTION_V1_WAN_VACE_ENDPOINT =
  "fal-ai/wan-vace-14b" as const;
export const MOTION_V1_WAN_VACE_PLAN_VERSION =
  "motion-v1-wan-vace.v1" as const;
export const MOTION_V1_TEMPORAL_MASK_URL_PLACEHOLDER =
  "__FRAMELOCK_TEMPORAL_MASK_FAL_URL_REQUIRED__" as const;

export const MOTION_V1_APPROVED_SOURCE_URL =
  "https://v3b.fal.media/files/b/0aa2cf8f/-NH9i_kO3kcbysv5Cgs7Z_source-canonical.mp4" as const;
export const MOTION_V1_SELECTED_ENVIRONMENT_URL =
  "https://v3b.fal.media/files/b/0aa2cbf0/V51CCE-ZsyCthytpMOO8P_8D6gmts2.png" as const;

export const WAN_VACE_CANDIDATE_SEEDS = [480_197, 731_029, 921_847] as const;

const POSITIVE_PROMPT =
  "locked eye-level camera, one continuous photorealistic live-action shot. Replace only the neutral gray studio outside the masked courier with a rain-lashed futuristic underground transit platform at midnight. Match the supplied environment reference: abstract cyan and magenta architectural light bars, a wet reflective concrete floor, subtle atmospheric mist and a distant train. The crimson-coated FRM-01 courier performs exactly the source lateral walk with identical timing, placement, pose and full-body silhouette. Keep the camera completely static, preserve coherent reflections and lighting across all 121 frames, and maintain strong temporal continuity with no text in the environment.";

const NEGATIVE_PROMPT =
  "camera movement, pan, tilt, zoom, dolly, orbit, handheld shake, cuts, transitions, time jump, frame interpolation, duplicated frames, missing frames, changed timing, subject drift, identity change, wardrobe change, altered crimson coat, altered FRM-01 badge, extra person, duplicate person, ghost limbs, extra limbs, malformed hands, malformed face, body deformation, occlusion crossing the courier, foreground obstacle, floor opening, text, letters, numbers, logos, signs, subtitles, captions, watermarks, flicker, strobing, temporal jitter, inconsistent lighting, warped geometry, low resolution, blur, compression artifacts, cartoon, illustration";

const PLAN_VERSION_PATTERN = /^motion-v1-wan-vace\.v[1-9]\d*$/;

export type WanVacePlanErrorCode =
  | "CANDIDATES_NOT_SEED_ONLY"
  | "INVALID_MASK_URL"
  | "INVALID_PLAN"
  | "MASK_UPLOAD_UNRESOLVED"
  | "PLAN_VERSION_REQUIRED";

export class WanVacePlanError extends Error {
  readonly code: WanVacePlanErrorCode;

  constructor(
    code: WanVacePlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WanVacePlanError";
    this.code = code;
  }
}

function isFalMediaUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
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
    return false;
  }
  const segments = url.pathname.split("/").slice(2);
  if (segments.length === 0 || segments.some((segment) => !segment)) {
    return false;
  }
  return segments.every((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    return (
      decoded !== "." &&
      decoded !== ".." &&
      !decoded.includes("/") &&
      !decoded.includes("\\") &&
      !decoded.includes("\0")
    );
  });
}

const falMediaUrlSchema = z
  .string()
  .max(2_048)
  .refine(isFalMediaUrl, "URL must be a clean fal CDN media URL");

const planVersionSchema = z.string().regex(PLAN_VERSION_PATTERN);

const falInputBaseSchema = z
  .object({
    prompt: z.string().min(1).max(4_000),
    negative_prompt: z.string().min(1).max(4_000),
    task: z.literal("inpainting"),
    video_url: z.literal(MOTION_V1_APPROVED_SOURCE_URL),
    ref_image_urls: z.tuple([z.literal(MOTION_V1_SELECTED_ENVIRONMENT_URL)]),
    match_input_num_frames: z.literal(true),
    num_frames: z.literal(121),
    match_input_frames_per_second: z.literal(true),
    frames_per_second: z.literal(24),
    resolution: z.literal("720p"),
    aspect_ratio: z.literal("16:9"),
    num_inference_steps: z.literal(30),
    guidance_scale: z.literal(5),
    sampler: z.literal("unipc"),
    shift: z.literal(5),
    enable_safety_checker: z.literal(true),
    enable_prompt_expansion: z.literal(false),
    preprocess: z.literal(false),
    acceleration: z.literal("none"),
    video_quality: z.literal("maximum"),
    video_write_mode: z.literal("balanced"),
    num_interpolated_frames: z.literal(0),
    temporal_downsample_factor: z.literal(0),
    enable_auto_downsample: z.literal(false),
    sync_mode: z.literal(false),
    return_frames_zip: z.literal(true),
    seed: z.number().int().nonnegative(),
  })
  .strict();

const draftFalInputSchema = falInputBaseSchema
  .extend({
    mask_video_url: z.literal(MOTION_V1_TEMPORAL_MASK_URL_PLACEHOLDER),
  })
  .strict();

const readyFalInputSchema = falInputBaseSchema
  .extend({ mask_video_url: falMediaUrlSchema })
  .strict();

const sourceSchema = z
  .object({
    approvalPath: z.literal(
      "artifacts/motion-v1/source/source-approval.json",
    ),
    falUrl: z.literal(MOTION_V1_APPROVED_SOURCE_URL),
    sha256: z.literal(
      "9882dceb76ad0b8954c92f8c8e8b9f00ea4e7812ea96a4f0307c1fa916611dc6",
    ),
    width: z.literal(1280),
    height: z.literal(720),
    frameCount: z.literal(121),
    frameRate: z.literal("24/1"),
  })
  .strict();

const environmentReferenceSchema = z
  .object({
    selectionPath: z.literal(
      "artifacts/motion-v1/environment-selection-final.json",
    ),
    falUrl: z.literal(MOTION_V1_SELECTED_ENVIRONMENT_URL),
    sha256: z.literal(
      "751b002574e41e0b6f1b7c52bc0f9d7e7b9be6360180932235c87ab53b59a98a",
    ),
    environmentSentence: z.literal(
      "A rain-lashed neon transit platform at midnight, with abstract cyan-magenta light bars, a wet reflective floor and a distant train, while the locked eye-level camera remains unchanged.",
    ),
  })
  .strict();

const pricingEstimateSchema = z
  .object({
    unitPriceUsd: z.literal("0.08"),
    billingUnit: z.literal("video-second at 16 frames per second"),
    estimatedUnits: z.literal("7.5625"),
    estimatedCostUsd: z.literal("0.605"),
    pricingSource: z.literal(
      "fal public Wan VACE 14B 720p price observed 2026-07-18",
    ),
  })
  .strict();

const candidateBaseShape = {
  schemaVersion: z.literal(1),
  planVersion: planVersionSchema,
  candidateId: z.string().regex(/^motion-wan-vace-candidate-0[1-3]$/),
  candidateIndex: z.number().int().min(1).max(3),
  endpoint: z.literal(MOTION_V1_WAN_VACE_ENDPOINT),
  source: sourceSchema,
  environmentReference: environmentReferenceSchema,
  pricingEstimate: pricingEstimateSchema,
} as const;

export const motionWanVaceCandidateDraftSchema = z
  .object({
    ...candidateBaseShape,
    state: z.literal("awaiting_temporal_mask_upload"),
    falInputTemplate: draftFalInputSchema,
  })
  .strict();

export const motionWanVaceReadyCandidateSchema = z
  .object({
    ...candidateBaseShape,
    state: z.literal("ready_for_submission"),
    falInput: readyFalInputSchema,
  })
  .strict();

export type MotionWanVaceCandidateDraft = z.infer<
  typeof motionWanVaceCandidateDraftSchema
>;
export type MotionWanVaceReadyCandidate = z.infer<
  typeof motionWanVaceReadyCandidateSchema
>;

function commonCandidateEvidence() {
  return {
    schemaVersion: 1 as const,
    planVersion: MOTION_V1_WAN_VACE_PLAN_VERSION as string,
    endpoint: MOTION_V1_WAN_VACE_ENDPOINT,
    source: {
      approvalPath: "artifacts/motion-v1/source/source-approval.json" as const,
      falUrl: MOTION_V1_APPROVED_SOURCE_URL,
      sha256:
        "9882dceb76ad0b8954c92f8c8e8b9f00ea4e7812ea96a4f0307c1fa916611dc6" as const,
      width: 1280 as const,
      height: 720 as const,
      frameCount: 121 as const,
      frameRate: "24/1" as const,
    },
    environmentReference: {
      selectionPath:
        "artifacts/motion-v1/environment-selection-final.json" as const,
      falUrl: MOTION_V1_SELECTED_ENVIRONMENT_URL,
      sha256:
        "751b002574e41e0b6f1b7c52bc0f9d7e7b9be6360180932235c87ab53b59a98a" as const,
      environmentSentence:
        "A rain-lashed neon transit platform at midnight, with abstract cyan-magenta light bars, a wet reflective floor and a distant train, while the locked eye-level camera remains unchanged." as const,
    },
    pricingEstimate: {
      unitPriceUsd: "0.08" as const,
      billingUnit: "video-second at 16 frames per second" as const,
      estimatedUnits: "7.5625" as const,
      estimatedCostUsd: "0.605" as const,
      pricingSource:
        "fal public Wan VACE 14B 720p price observed 2026-07-18" as const,
    },
  };
}

function falInputTemplate(seed: number) {
  return {
    prompt: POSITIVE_PROMPT,
    negative_prompt: NEGATIVE_PROMPT,
    task: "inpainting" as const,
    video_url: MOTION_V1_APPROVED_SOURCE_URL,
    mask_video_url: MOTION_V1_TEMPORAL_MASK_URL_PLACEHOLDER,
    ref_image_urls: [MOTION_V1_SELECTED_ENVIRONMENT_URL] as [
      typeof MOTION_V1_SELECTED_ENVIRONMENT_URL,
    ],
    match_input_num_frames: true as const,
    num_frames: 121 as const,
    match_input_frames_per_second: true as const,
    frames_per_second: 24 as const,
    resolution: "720p" as const,
    aspect_ratio: "16:9" as const,
    num_inference_steps: 30 as const,
    guidance_scale: 5 as const,
    sampler: "unipc" as const,
    shift: 5 as const,
    enable_safety_checker: true as const,
    enable_prompt_expansion: false as const,
    preprocess: false as const,
    acceleration: "none" as const,
    video_quality: "maximum" as const,
    video_write_mode: "balanced" as const,
    num_interpolated_frames: 0 as const,
    temporal_downsample_factor: 0 as const,
    enable_auto_downsample: false as const,
    sync_mode: false as const,
    return_frames_zip: true as const,
    seed,
  };
}

export function buildMotionWanVaceCandidateDrafts(): MotionWanVaceCandidateDraft[] {
  const drafts = WAN_VACE_CANDIDATE_SEEDS.map((seed, offset) => {
    const candidateIndex = offset + 1;
    return {
      ...commonCandidateEvidence(),
      state: "awaiting_temporal_mask_upload" as const,
      candidateId: `motion-wan-vace-candidate-0${candidateIndex}`,
      candidateIndex,
      falInputTemplate: falInputTemplate(seed),
    };
  });
  return validateMotionWanVaceCandidateSet(drafts);
}

function exceptKeys(value: object, excluded: readonly string[]) {
  const excludedSet = new Set(excluded);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !excludedSet.has(key)),
  );
}

function comparableCandidate(plan: MotionWanVaceCandidateDraft): string {
  const rest = exceptKeys(plan, ["candidateId", "candidateIndex"]);
  const falInputWithoutSeed = exceptKeys(plan.falInputTemplate, ["seed"]);
  return JSON.stringify({ ...rest, falInputTemplate: falInputWithoutSeed });
}

export function validateMotionWanVaceCandidateSet(
  raw: unknown,
): MotionWanVaceCandidateDraft[] {
  let plans: MotionWanVaceCandidateDraft[];
  try {
    plans = z.array(motionWanVaceCandidateDraftSchema).length(3).parse(raw);
  } catch {
    throw new WanVacePlanError(
      "INVALID_PLAN",
      "Motion v1 Wan VACE candidate drafts failed strict validation",
    );
  }

  const comparable = comparableCandidate(plans[0]);
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    if (
      plan.candidateIndex !== index + 1 ||
      plan.candidateId !== `motion-wan-vace-candidate-0${index + 1}` ||
      plan.falInputTemplate.seed !== WAN_VACE_CANDIDATE_SEEDS[index] ||
      comparableCandidate(plan) !== comparable
    ) {
      throw new WanVacePlanError(
        "CANDIDATES_NOT_SEED_ONLY",
        "Motion v1 Wan VACE candidates must differ only by their fixed seed",
      );
    }
  }
  return plans;
}

export function assertWanVacePlanEvolution(
  previousRaw: unknown,
  currentRaw: unknown,
): void {
  let previous: MotionWanVaceCandidateDraft;
  let current: MotionWanVaceCandidateDraft;
  try {
    previous = motionWanVaceCandidateDraftSchema.parse(previousRaw);
    current = motionWanVaceCandidateDraftSchema.parse(currentRaw);
  } catch {
    throw new WanVacePlanError(
      "INVALID_PLAN",
      "Motion v1 Wan VACE plan evolution failed strict validation",
    );
  }
  const previousInput = exceptKeys(previous.falInputTemplate, ["seed"]);
  const currentInput = exceptKeys(current.falInputTemplate, ["seed"]);
  if (
    JSON.stringify(previousInput) !== JSON.stringify(currentInput) &&
    previous.planVersion === current.planVersion
  ) {
    throw new WanVacePlanError(
      "PLAN_VERSION_REQUIRED",
      "A non-seed Wan VACE input change requires an explicit plan version",
    );
  }
}

export function resolveMotionWanVaceMaskUrl(
  draftRaw: unknown,
  maskUrl: string,
): MotionWanVaceReadyCandidate {
  let draft: MotionWanVaceCandidateDraft;
  try {
    draft = motionWanVaceCandidateDraftSchema.parse(draftRaw);
  } catch {
    throw new WanVacePlanError(
      "INVALID_PLAN",
      "Motion v1 Wan VACE draft failed strict validation",
    );
  }
  const parsedMaskUrl = falMediaUrlSchema.safeParse(maskUrl);
  if (!parsedMaskUrl.success) {
    throw new WanVacePlanError(
      "INVALID_MASK_URL",
      "Motion v1 Wan VACE mask must resolve to a clean fal CDN media URL",
    );
  }
  const evidence = exceptKeys(draft, ["state", "falInputTemplate"]);
  return motionWanVaceReadyCandidateSchema.parse({
    ...evidence,
    state: "ready_for_submission",
    falInput: {
      ...draft.falInputTemplate,
      mask_video_url: parsedMaskUrl.data,
    },
  });
}

export function prepareMotionWanVaceSubmission(raw: unknown): {
  endpoint: typeof MOTION_V1_WAN_VACE_ENDPOINT;
  falInput: z.infer<typeof readyFalInputSchema>;
  estimatedCostUsd: "0.605";
} {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "state" in raw &&
    raw.state === "awaiting_temporal_mask_upload"
  ) {
    throw new WanVacePlanError(
      "MASK_UPLOAD_UNRESOLVED",
      "Motion v1 Wan VACE submission requires the temporal-mask fal URL",
    );
  }
  const parsed = motionWanVaceReadyCandidateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WanVacePlanError(
      "INVALID_PLAN",
      "Motion v1 Wan VACE submission plan failed strict validation",
    );
  }
  return {
    endpoint: parsed.data.endpoint,
    falInput: parsed.data.falInput,
    estimatedCostUsd: parsed.data.pricingEstimate.estimatedCostUsd,
  };
}
