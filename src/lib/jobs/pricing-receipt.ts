import { createHash } from "node:crypto";

import { z } from "zod";

import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "../fal/kling-contract";
import { canonicalSha256Schema } from "./generation-digest";
import {
  paidAttemptPricingObservationSchema,
  pricingReceiptViewSchema,
  type PaidAttemptPricingObservation,
} from "./paid-attempt-pricing";

const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

const createPricingReceiptInputSchema = z
  .object({
    jobId: jobIdSchema,
    generationDigest: canonicalSha256Schema,
    sourceProvenanceFileSha256: canonicalSha256Schema,
    pricingObservation: paidAttemptPricingObservationSchema,
  })
  .strict();

const unsignedPricingReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: jobIdSchema,
    generationDigest: canonicalSha256Schema,
    sourceProvenanceFileSha256: canonicalSha256Schema,
    endpoint: z.literal(KLING_O3_STANDARD_EDIT_ENDPOINT),
    currency: z.literal("USD"),
    pricingObservation: paidAttemptPricingObservationSchema,
    pricingObservationDigest: canonicalSha256Schema,
  })
  .strict();

type UnsignedPricingReceipt = z.infer<typeof unsignedPricingReceiptSchema>;

export const pricingReceiptSchema = pricingReceiptViewSchema
  .superRefine((receipt, context) => {
    if (
      computePricingObservationDigest(receipt.pricingObservation) !==
      receipt.pricingObservationDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["pricingObservationDigest"],
        message: "pricing observation digest does not match its facts",
      });
    }
    if (computePricingReceiptDigest(receipt) !== receipt.receiptDigestSha256) {
      context.addIssue({
        code: "custom",
        path: ["receiptDigestSha256"],
        message: "pricing receipt digest does not match its provenance",
      });
    }
  });

export type PricingReceipt = z.infer<typeof pricingReceiptSchema>;

function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function canonicalPricingObservation(
  rawPricing: PaidAttemptPricingObservation,
) {
  const pricing = paidAttemptPricingObservationSchema.parse(rawPricing);
  return {
    schemaVersion: 1 as const,
    unitPriceUsd: pricing.unitPriceUsd,
    billingUnit: pricing.billingUnit,
    estimatedUnits: pricing.estimatedUnits,
    estimatedCostUsd: pricing.estimatedCostUsd,
    pricingSource: pricing.pricingSource,
    priceObservedAt: pricing.priceObservedAt,
  };
}

/** SHA-256 over exactly the immutable pricing facts displayed to the user. */
export function computePricingObservationDigest(
  rawPricing: PaidAttemptPricingObservation,
): string {
  return sha256Json(canonicalPricingObservation(rawPricing));
}

/**
 * SHA-256 over the server-issued receipt, including the exact job, generation
 * and fixed endpoint to prevent cross-job reuse of an otherwise valid price.
 */
export function computePricingReceiptDigest(
  rawReceipt: UnsignedPricingReceipt | PricingReceipt,
): string {
  const receipt = unsignedPricingReceiptSchema.parse({
    schemaVersion: rawReceipt.schemaVersion,
    jobId: rawReceipt.jobId,
    generationDigest: rawReceipt.generationDigest,
    sourceProvenanceFileSha256: rawReceipt.sourceProvenanceFileSha256,
    endpoint: rawReceipt.endpoint,
    currency: rawReceipt.currency,
    pricingObservation: rawReceipt.pricingObservation,
    pricingObservationDigest: rawReceipt.pricingObservationDigest,
  });
  return sha256Json({
    schemaVersion: receipt.schemaVersion,
    jobId: receipt.jobId,
    generationDigest: receipt.generationDigest,
    sourceProvenanceFileSha256: receipt.sourceProvenanceFileSha256,
    endpoint: receipt.endpoint,
    currency: receipt.currency,
    pricingObservation: canonicalPricingObservation(
      receipt.pricingObservation,
    ),
    pricingObservationDigest: receipt.pricingObservationDigest,
  });
}

export function createPricingReceipt(
  rawInput: z.input<typeof createPricingReceiptInputSchema>,
): PricingReceipt {
  const input = createPricingReceiptInputSchema.parse(rawInput);
  const unsigned = unsignedPricingReceiptSchema.parse({
    schemaVersion: 1,
    jobId: input.jobId,
    generationDigest: input.generationDigest,
    sourceProvenanceFileSha256: input.sourceProvenanceFileSha256,
    endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
    currency: "USD",
    pricingObservation: input.pricingObservation,
    pricingObservationDigest: computePricingObservationDigest(
      input.pricingObservation,
    ),
  });
  return pricingReceiptSchema.parse({
    ...unsigned,
    receiptDigestSha256: computePricingReceiptDigest(unsigned),
  });
}
