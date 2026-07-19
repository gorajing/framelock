import { describe, expect, it } from "vitest";

import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "../fal/kling-contract";
import type { PaidAttemptPricingObservation } from "./paid-attempt-pricing";
import {
  computePricingObservationDigest,
  computePricingReceiptDigest,
  createPricingReceipt,
  pricingReceiptSchema,
} from "./pricing-receipt";

const JOB_ID = "real_ai_source_01";
const GENERATION_DIGEST = "10".repeat(32);
const SOURCE_PROVENANCE_SHA256 = "20".repeat(32);
const observation: PaidAttemptPricingObservation = {
  unitPriceUsd: "0.14",
  billingUnit: "seconds",
  estimatedUnits: "5.041666667",
  estimatedCostUsd: "0.7058333334",
  pricingSource: "authenticated_fal_pricing_and_estimate",
  priceObservedAt: "2026-07-17T18:47:33.000Z",
};

describe("immutable pricing authorization receipt", () => {
  it("retains the existing canonical observation digest", () => {
    expect(computePricingObservationDigest(observation)).toBe(
      "036a25b92d2ae159f8036287b242b0533508b4a2791753a6c1286ef81e426aa7",
    );
  });

  it.each([
    ["unit price", { unitPriceUsd: "0.15" }],
    ["billing unit", { billingUnit: "minutes" }],
    ["estimated units", { estimatedUnits: "5.1" }],
    ["estimated cost", { estimatedCostUsd: "0.71" }],
    ["pricing source", { pricingSource: "another_authenticated_source" }],
    ["observation time", { priceObservedAt: "2026-07-17T18:47:34.000Z" }],
  ])("binds the displayed %s", (_label, mutation) => {
    expect(
      computePricingObservationDigest({ ...observation, ...mutation }),
    ).not.toBe(computePricingObservationDigest(observation));
  });

  it("binds the exact job, generation and Kling endpoint", () => {
    const receipt = createPricingReceipt({
      jobId: JOB_ID,
      generationDigest: GENERATION_DIGEST,
      sourceProvenanceFileSha256: SOURCE_PROVENANCE_SHA256,
      pricingObservation: observation,
    });

    expect(receipt).toEqual({
      schemaVersion: 1,
      jobId: JOB_ID,
      generationDigest: GENERATION_DIGEST,
      sourceProvenanceFileSha256: SOURCE_PROVENANCE_SHA256,
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      currency: "USD",
      pricingObservation: observation,
      pricingObservationDigest:
        "036a25b92d2ae159f8036287b242b0533508b4a2791753a6c1286ef81e426aa7",
      receiptDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(computePricingReceiptDigest(receipt)).toBe(
      receipt.receiptDigestSha256,
    );
    expect(pricingReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it.each([
    ["job", { jobId: "another_job" }],
    ["generation", { generationDigest: "20".repeat(32) }],
    ["source provenance", { sourceProvenanceFileSha256: "30".repeat(32) }],
    [
      "observation",
      {
        pricingObservation: {
          ...observation,
          estimatedCostUsd: "0.7058333335",
        },
      },
    ],
  ])("changes the receipt digest when the %s changes", (_label, mutation) => {
    const baseline = createPricingReceipt({
      jobId: JOB_ID,
      generationDigest: GENERATION_DIGEST,
      sourceProvenanceFileSha256: SOURCE_PROVENANCE_SHA256,
      pricingObservation: observation,
    });
    const changed = createPricingReceipt({
      jobId:
        "jobId" in mutation && typeof mutation.jobId === "string"
          ? mutation.jobId
          : JOB_ID,
      generationDigest:
        "generationDigest" in mutation &&
        typeof mutation.generationDigest === "string"
          ? mutation.generationDigest
          : GENERATION_DIGEST,
      sourceProvenanceFileSha256:
        "sourceProvenanceFileSha256" in mutation &&
        typeof mutation.sourceProvenanceFileSha256 === "string"
          ? mutation.sourceProvenanceFileSha256
          : SOURCE_PROVENANCE_SHA256,
      pricingObservation:
        "pricingObservation" in mutation && mutation.pricingObservation
          ? mutation.pricingObservation
          : observation,
    });

    expect(changed.receiptDigestSha256).not.toBe(
      baseline.receiptDigestSha256,
    );
  });

  it("rejects tampering with either digest", () => {
    const receipt = createPricingReceipt({
      jobId: JOB_ID,
      generationDigest: GENERATION_DIGEST,
      sourceProvenanceFileSha256: SOURCE_PROVENANCE_SHA256,
      pricingObservation: observation,
    });

    expect(() =>
      pricingReceiptSchema.parse({
        ...receipt,
        pricingObservationDigest: "f".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      pricingReceiptSchema.parse({
        ...receipt,
        receiptDigestSha256: "f".repeat(64),
      }),
    ).toThrow();
  });

  it("rejects a different endpoint, unknown fields and unsafe identifiers", () => {
    const receipt = createPricingReceipt({
      jobId: JOB_ID,
      generationDigest: GENERATION_DIGEST,
      sourceProvenanceFileSha256: SOURCE_PROVENANCE_SHA256,
      pricingObservation: observation,
    });

    expect(() =>
      pricingReceiptSchema.parse({
        ...receipt,
        endpoint: "fal-ai/kling-video/latest",
      }),
    ).toThrow();
    expect(() =>
      pricingReceiptSchema.parse({ ...receipt, credential: "secret" }),
    ).toThrow();
    expect(() =>
      createPricingReceipt({
        jobId: "../outside",
        generationDigest: GENERATION_DIGEST,
        sourceProvenanceFileSha256: SOURCE_PROVENANCE_SHA256,
        pricingObservation: observation,
      }),
    ).toThrow();
  });
});
