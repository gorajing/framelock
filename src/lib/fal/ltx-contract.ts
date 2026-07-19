import { z } from "zod";

export const LTX_ENDPOINT = "fal-ai/ltx-2.3-quality/inpaint" as const;

const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    },
    { message: "Artifact URL must use HTTP or HTTPS" },
  );

const buildInputSchema = z.object({
  prompt: z.string().trim().min(1).max(2_000),
  sourceUrl: httpUrlSchema,
  maskUrl: httpUrlSchema,
  seed: z.number().int().nonnegative().optional(),
});

export type BuildLtxInput = z.input<typeof buildInputSchema>;

export const LTX_FIXED_PARAMETERS = {
  video_strength: 1,
  num_frames: 121,
  frames_per_second: 24,
  num_inference_steps: 15,
  guidance_scale: 1,
  generate_audio: false,
  enable_prompt_expansion: false,
  enable_safety_checker: true,
  video_quality: "high",
  video_write_mode: "balanced",
} as const;

export function buildLtxGenerationParameters(seed?: number) {
  return {
    ...LTX_FIXED_PARAMETERS,
    ...(seed === undefined ? {} : { seed }),
  } as const;
}

export function buildLtxInput(values: BuildLtxInput) {
  const parsed = buildInputSchema.parse(values);

  return {
    prompt: parsed.prompt,
    video_url: parsed.sourceUrl,
    mask_video_url: parsed.maskUrl,
    ...buildLtxGenerationParameters(parsed.seed),
  } as const;
}

export const ltxOutputSchema = z.object({
  video: z.object({
    url: httpUrlSchema,
    content_type: z.string().min(1).optional(),
    file_name: z.string().min(1).optional(),
    file_size: z.number().int().nonnegative().optional(),
  }),
  seed: z.number().int().nonnegative(),
  prompt: z.string().min(1),
});

export type LtxOutput = z.infer<typeof ltxOutputSchema>;
