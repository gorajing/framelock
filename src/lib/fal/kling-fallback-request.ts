import { z } from "zod";

export const KLING_FALLBACK_JOB_ID = "synthetic-hero-kling-o3-001" as const;
export const KLING_FALLBACK_CONFIRMATION =
  "RUN KLING O3 FALLBACK 1" as const;
export const KLING_FALLBACK_PROMPT =
  "Transform @Video1 into a cinematic locked-off product commercial in a rain-soaked neon laboratory at night. Animate cyan and magenta light sweeps, drifting mist and rain around the centered package. Keep the camera fixed. Preserve the package silhouette, position, scale and front-facing orientation. Do not crop, letterbox, stretch, zoom or change aspect ratio." as const;

export const klingFallbackSubmitSchema = z
  .object({
    confirmation: z.literal(KLING_FALLBACK_CONFIRMATION),
  })
  .strict();

export type KlingFallbackSubmit = z.infer<typeof klingFallbackSubmitSchema>;
