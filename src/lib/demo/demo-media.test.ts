import { describe, expect, it } from "vitest";

import {
  DEMO_MEDIA_IDS,
  parseDemoByteRange,
  resolveDemoMediaAsset,
} from "./demo-media";

describe("FrameLock demo media allowlist", () => {
  it("contains only the three videos and fixed 0, 60 and 120 frame views", () => {
    expect(DEMO_MEDIA_IDS).toHaveLength(15);
    expect(DEMO_MEDIA_IDS).toEqual(
      expect.arrayContaining([
        "source-video",
        "raw-video",
        "canonical-preview",
        "source-frame-0",
        "raw-frame-60",
        "composite-frame-120",
        "overlay-frame-60",
      ]),
    );

    expect(resolveDemoMediaAsset("raw-frame-60")).toMatchObject({
      contentType: "image/png",
      relativePath:
        "artifacts/jobs/synthetic-hero-kling-o3-001/canonical/generated_frames/frame_000060.png",
    });
    expect(resolveDemoMediaAsset("source-video")).toMatchObject({
      relativePath:
        "artifacts/runs/synthetic-hero-offline-hardening-v2/inputs/framelock-hero.mp4",
    });
    expect(resolveDemoMediaAsset("source-frame-60")).toMatchObject({
      relativePath:
        "artifacts/runs/synthetic-hero-offline-hardening-v2/proof/source_frames/frame_000060.png",
    });
  });

  it.each([
    "../job.json",
    "source-frame-1",
    "raw-frame-121",
    "model-output.mp4",
    "/Users/example/private.mp4",
    "https://signed.example/output.mp4",
  ])("rejects non-allowlisted media ID %s", (value) => {
    expect(resolveDemoMediaAsset(value)).toBeNull();
  });
});

describe("demo video byte ranges", () => {
  it("accepts bounded and open-ended single ranges", () => {
    expect(parseDemoByteRange("bytes=10-19", 100)).toEqual({
      start: 10,
      end: 19,
    });
    expect(parseDemoByteRange("bytes=90-", 100)).toEqual({
      start: 90,
      end: 99,
    });
  });

  it.each(["bytes=100-", "bytes=20-10", "bytes=0-1,4-5", "items=0-1"])(
    "rejects invalid or multipart range %s",
    (value) => {
      expect(parseDemoByteRange(value, 100)).toBeNull();
    },
  );
});
