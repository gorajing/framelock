import { z } from "zod";

import { canonicalSha256Schema } from "../jobs/generation-digest";

export const REAL_KLING_PAID_CONFIRMATION =
  "I authorize one paid Kling O3 generation for this exact digest." as const;

export const realKlingSubmitSchema = z
  .object({
    confirmation: z.literal(REAL_KLING_PAID_CONFIRMATION),
    generationDigest: canonicalSha256Schema,
    pricingObservationDigest: canonicalSha256Schema,
  })
  .strict();

export type RealKlingSubmitRequest = z.infer<typeof realKlingSubmitSchema>;
