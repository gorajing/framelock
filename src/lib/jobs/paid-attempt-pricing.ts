import { z } from "zod";

import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "../fal/kling-contract";

const canonicalSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

const decimalSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0;
  });

/**
 * Client-safe pricing facts displayed before a paid attempt is authorized.
 *
 * Every monetary and quantity value is a canonical decimal string so the
 * browser, server and persisted provenance hash the same bytes without
 * floating-point serialization drift.
 */
export const paidAttemptPricingObservationSchema = z
  .object({
    unitPriceUsd: decimalSchema,
    billingUnit: z.string().trim().min(1).max(64),
    estimatedUnits: decimalSchema,
    estimatedCostUsd: decimalSchema,
    pricingSource: z.string().trim().min(1).max(256),
    priceObservedAt: z.string().datetime(),
  })
  .strict();

export type PaidAttemptPricingObservation = z.infer<
  typeof paidAttemptPricingObservationSchema
>;

/**
 * Browser-safe view of the immutable server-issued pricing receipt. The
 * cryptographic constructors live in the server-side pricing-receipt module;
 * this schema contains no credentials or Node-only imports.
 */
export const pricingReceiptViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: jobIdSchema,
    generationDigest: canonicalSha256Schema,
    sourceProvenanceFileSha256: canonicalSha256Schema,
    endpoint: z.literal(KLING_O3_STANDARD_EDIT_ENDPOINT),
    currency: z.literal("USD"),
    pricingObservation: paidAttemptPricingObservationSchema,
    pricingObservationDigest: canonicalSha256Schema,
    receiptDigestSha256: canonicalSha256Schema,
  })
  .strict();

export type PricingReceiptView = z.infer<typeof pricingReceiptViewSchema>;
