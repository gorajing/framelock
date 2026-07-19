import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DemoSummary } from "@/lib/demo/demo-summary";

import { DemoComparison } from "./demo-comparison";

const summary = {
  projectionLabel: "Legacy synthetic proof — read-only projection",
  fixture: "Synthetic diagnostic fixture",
  claim: "Protected core verified — canonical pre-encode frame sequence.",
  previewLabel: "Preview derived from verified canonical frames",
  proof: {
    framesAudited: 121,
    maximumChannelDelta: 0,
    coreHashMatches: 121,
    framesWithProtectedCore: 121,
    totalProtectedCorePixels: 1,
    changedCorePixels: 0,
    changedCoreChannelSamples: 0,
  },
  selectedGenerator: {
    attempt: 2,
    name: "Kling O3 Standard",
    endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit",
    requestId: "request-id",
    estimatedCostUsd: "0.70",
    media: {
      width: 1280,
      height: 720,
      frameCount: 121,
      frameRate: "24/1",
    },
  },
  rejectedAttempt: {
    attempt: 1,
    name: "LTX 2.3 Quality",
    endpoint: "fal-ai/ltx-2.3-quality/inpaint",
    failedCheck: "display_aspect_ratio",
    actual: "5/3",
    required: "16/9",
    estimatedCostUsd: "0.27",
    reason: "The output was not comparable.",
  },
} as unknown as DemoSummary;

describe("demo comparison claim boundary", () => {
  it("does not present the encoded H.264 preview as a verified sequence", () => {
    const markup = renderToStaticMarkup(<DemoComparison summary={summary} />);

    expect(markup).toContain("Canonical result preview");
    expect(markup).toContain("Legacy synthetic proof — read-only projection");
    expect(markup).toContain("Preview derived from verified canonical frames");
    expect(markup).not.toContain("Verified sequence");
  });

  it("does not mix legacy authenticated prices into the current Home pricing boundary", () => {
    const markup = renderToStaticMarkup(<DemoComparison summary={summary} />);

    expect(markup).not.toContain("Authenticated estimate");
    expect(markup).not.toContain("Authenticated cost");
    expect(markup).not.toContain("$0.70");
    expect(markup).not.toContain("$0.27");
  });
});
