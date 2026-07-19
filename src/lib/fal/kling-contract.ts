import { z } from "zod";

export const KLING_O3_STANDARD_EDIT_ENDPOINT =
  "fal-ai/kling-video/o3/standard/video-to-video/edit" as const;

const httpsUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => new URL(value).protocol === "https:",
    { message: "Artifact URL must use HTTPS" },
  );

const buildInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2_000),
    sourceUrl: httpsUrlSchema,
  })
  .strict();

export const KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS = {
  keep_audio: false,
  shot_type: "customize",
} as const;

export function buildKlingO3EditInput(
  values: z.input<typeof buildInputSchema>,
) {
  const parsed = buildInputSchema.parse(values);
  return {
    prompt: parsed.prompt,
    video_url: parsed.sourceUrl,
    ...KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
  } as const;
}

export const klingO3EditOutputSchema = z.object({
  video: z.object({
    url: httpsUrlSchema,
    content_type: z.string().min(1).nullable().optional(),
    file_name: z.string().min(1).nullable().optional(),
    file_size: z.number().int().nonnegative().nullable().optional(),
  }),
});

export type KlingO3EditOutput = z.infer<typeof klingO3EditOutputSchema>;
