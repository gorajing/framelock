import { describe, expect, it } from "vitest";

import {
  P0_MEDIA_CONTRACT,
  canTransition,
  verifiedJobSchema,
} from "./job";

describe("P0 media contract", () => {
  it("freezes the canonical source envelope", () => {
    expect(P0_MEDIA_CONTRACT).toEqual({
      width: 1280,
      height: 720,
      frameCount: 121,
      fpsNumerator: 24,
      fpsDenominator: 1,
      maxTimestampResidualMs: 1,
      maxBytes: 50 * 1024 * 1024,
    });
  });
});

describe("job state transitions", () => {
  it("does not allow generation to skip composition and audit", () => {
    expect(canTransition("generated", "verified")).toBe(false);
    expect(canTransition("generated", "composited")).toBe(true);
    expect(canTransition("composited", "verified")).toBe(true);
  });

  it("does not allow a verified job to transition again", () => {
    expect(canTransition("verified", "failed")).toBe(false);
  });
});

describe("verified job schema", () => {
  const validJob = {
    id: "job_hero",
    state: "verified" as const,
    sourceArtifactId: "source_sha256",
    coreMaskArtifactId: "mask_sha256",
    editMaskArtifactId: "edit_sha256",
    requestId: "fal_request_id",
    audit: {
      framesAudited: 121,
      framesWithNonEmptyCore: 121,
      totalCorePixels: 12_100,
      changedCoreSamples: 0,
      worstMaxChannelDelta: 0,
      coreHashMatchCount: 121,
      comparabilityPassed: true,
      stage: "canonical_pre_encode" as const,
    },
  };

  it("accepts a complete passing canonical audit", () => {
    expect(verifiedJobSchema.parse(validJob)).toEqual(validJob);
  });

  it("rejects an empty protected core", () => {
    expect(() =>
      verifiedJobSchema.parse({
        ...validJob,
        audit: {
          ...validJob.audit,
          framesWithNonEmptyCore: 0,
          totalCorePixels: 0,
          coreHashMatchCount: 0,
        },
      }),
    ).toThrow();
  });

  it("rejects a changed protected sample", () => {
    expect(() =>
      verifiedJobSchema.parse({
        ...validJob,
        audit: {
          ...validJob.audit,
          changedCoreSamples: 1,
          worstMaxChannelDelta: 1,
          coreHashMatchCount: 120,
        },
      }),
    ).toThrow();
  });
});
