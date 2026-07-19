import { describe, expect, it } from "vitest";

import {
  REAL_KLING_PAID_CONFIRMATION,
  realKlingSubmitSchema,
} from "./real-kling-request";
const PRICING_DIGEST = "b".repeat(64);

describe("real Kling paid request", () => {
  it("binds a literal spend authorization to the exact generation digest", () => {
    const digest = "a".repeat(64);
    expect(
      realKlingSubmitSchema.parse({
        confirmation: REAL_KLING_PAID_CONFIRMATION,
        generationDigest: digest,
        pricingObservationDigest: PRICING_DIGEST,
      }),
    ).toEqual({
      confirmation: REAL_KLING_PAID_CONFIRMATION,
      generationDigest: digest,
      pricingObservationDigest: PRICING_DIGEST,
    });
    expect(() =>
      realKlingSubmitSchema.parse({
        confirmation: "run it",
        generationDigest: digest,
        pricingObservationDigest: PRICING_DIGEST,
      }),
    ).toThrow();
    expect(() =>
      realKlingSubmitSchema.parse({
        confirmation: REAL_KLING_PAID_CONFIRMATION,
        generationDigest: "latest",
        pricingObservationDigest: PRICING_DIGEST,
      }),
    ).toThrow();
    expect(() =>
      realKlingSubmitSchema.parse({
        confirmation: REAL_KLING_PAID_CONFIRMATION,
        generationDigest: digest,
      }),
    ).toThrow();
    expect(
      realKlingSubmitSchema.parse({
        confirmation: REAL_KLING_PAID_CONFIRMATION,
        generationDigest: digest,
        pricingObservationDigest: "f".repeat(64),
      }).pricingObservationDigest,
    ).toBe("f".repeat(64));
  });
});
