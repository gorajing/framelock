import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readRequiredMotionDemoEvidence } from "./motion-demo-evidence.server";

describe("packaged Motion release evidence", () => {
  it("reopens the portable v2 proof chain and public media fail-closed boundary", async () => {
    const projection = await readRequiredMotionDemoEvidence();

    expect(projection).toEqual({
      media: {
        source: "/demo/motion/source.mp4",
        raw: "/demo/motion/generated-world.mp4",
        mask: "/demo/motion/mask.mp4",
        verified: "/demo/motion/verified.mp4",
      },
      evidence: {
        admission: "admitted",
        audit: {
          claimScope: "canonical_pre_encode_frames",
          framesAudited: 121,
          framesExpected: 121,
          changedProtectedPixels: 0,
          temporalMasksBound: 121,
        },
        negativeControl: {
          status: "bound",
          frameIndex: 60,
          changedProtectedChannelSamples: 1,
          verifierRejected: true,
        },
      },
    });
  });
});
