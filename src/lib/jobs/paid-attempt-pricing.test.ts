import { describe, expect, it } from "vitest";

import {
  paidAttemptPricingObservationSchema,
  pricingReceiptViewSchema,
} from "./paid-attempt-pricing";

const observation = {
  unitPriceUsd: "0.14",
  billingUnit: "seconds",
  estimatedUnits: "5.041666667",
  estimatedCostUsd: "0.7058333334",
  pricingSource: "authenticated_fal_platform_pricing_api_v1_models_pricing",
  priceObservedAt: "2026-07-18T20:00:00.000Z",
} as const;

describe("client-safe paid pricing observation", () => {
  it("accepts and preserves the strict canonical observation shape", () => {
    expect(paidAttemptPricingObservationSchema.parse(observation)).toEqual(
      observation,
    );
  });

  it("rejects unknown fields and non-string decimal values", () => {
    expect(() =>
      paidAttemptPricingObservationSchema.parse({
        ...observation,
        credential: "must-not-cross-the-boundary",
      }),
    ).toThrow();
    expect(() =>
      paidAttemptPricingObservationSchema.parse({
        ...observation,
        unitPriceUsd: 0.14,
      }),
    ).toThrow();
  });

  it.each([
    ["negative", "-0.14"],
    ["exponential", "1.4e-1"],
    ["leading zero", "00.14"],
    ["trailing decimal point", "0."],
    ["not a number", "NaN"],
    ["infinity", "Infinity"],
    ["excessively long", "1".repeat(129)],
  ])("rejects a %s decimal", (_label, candidate) => {
    expect(() =>
      paidAttemptPricingObservationSchema.parse({
        ...observation,
        unitPriceUsd: candidate,
      }),
    ).toThrow();
  });

  it("normalizes bounded human-readable labels but rejects empty values", () => {
    expect(
      paidAttemptPricingObservationSchema.parse({
        ...observation,
        billingUnit: " seconds ",
        pricingSource: " authenticated_fal_platform_pricing_api ",
      }),
    ).toMatchObject({
      billingUnit: "seconds",
      pricingSource: "authenticated_fal_platform_pricing_api",
    });
    expect(() =>
      paidAttemptPricingObservationSchema.parse({
        ...observation,
        billingUnit: "   ",
      }),
    ).toThrow();
  });

  it("rejects timestamps that are not canonical ISO datetimes", () => {
    expect(() =>
      paidAttemptPricingObservationSchema.parse({
        ...observation,
        priceObservedAt: "July 18, 2026",
      }),
    ).toThrow();
  });

  it("parses the exact client-safe, provenance-bound pricing receipt", () => {
    const receipt = {
      schemaVersion: 1 as const,
      jobId: "ai_source_01",
      generationDigest: "1".repeat(64),
      sourceProvenanceFileSha256: "2".repeat(64),
      endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit" as const,
      currency: "USD" as const,
      pricingObservation: observation,
      pricingObservationDigest: "3".repeat(64),
      receiptDigestSha256: "4".repeat(64),
    };

    expect(pricingReceiptViewSchema.parse(receipt)).toEqual(receipt);
    expect(() =>
      pricingReceiptViewSchema.parse({ ...receipt, credential: "secret" }),
    ).toThrow();
  });
});
