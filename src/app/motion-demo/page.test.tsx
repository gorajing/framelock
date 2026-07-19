import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readMotionDemoEvidence: vi.fn(),
}));

vi.mock("@/lib/demo/motion-demo-evidence.server", () => ({
  readMotionDemoEvidence: mocks.readMotionDemoEvidence,
}));

import MotionDemoPage from "./page";

const projection = {
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
} as const;

describe("Motion demo evidence boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the admitted hero only after the evidence reader projects it", async () => {
    mocks.readMotionDemoEvidence.mockResolvedValue(projection);

    const markup = renderToStaticMarkup(await MotionDemoPage());

    expect(markup).toContain("AI reshot the world");
    expect(markup).toContain("Generated world");
    expect(markup).toContain("121 / 121");
    expect(markup).toContain("0</dd>");
    expect(markup).toContain("Reveal caught corruption");
    expect(markup).toContain('/demo/motion/verified.mp4');
  });

  it("fails closed to the pending shell when evidence cannot be reopened", async () => {
    mocks.readMotionDemoEvidence.mockResolvedValue(null);

    const markup = renderToStaticMarkup(await MotionDemoPage());

    expect(markup).toContain("PROOF PENDING");
    expect(markup).not.toContain("AI reshot the world");
    expect(markup).not.toContain("121 / 121");
    expect(markup).not.toContain('/demo/motion/verified.mp4');
  });
});
