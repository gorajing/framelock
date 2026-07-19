import { describe, expect, it } from "vitest";

import { LTX_ENDPOINT } from "../fal/ltx-contract";
import { computeGenerationDigest } from "./generation-digest";

const SOURCE_SHA256 = "11".repeat(32);
const EDIT_MASK_SHA256 = "22".repeat(32);

const normalizedParameters = {
  video_strength: 1,
  num_frames: 121,
  frames_per_second: 24,
  num_inference_steps: 15,
  guidance_scale: 1,
  generate_audio: false,
  seed: 42,
  enable_prompt_expansion: false,
  enable_safety_checker: true,
  video_quality: "high",
  video_write_mode: "balanced",
} as const;

const generationIdentity = {
  sourceSha256: SOURCE_SHA256,
  editMaskSha256: EDIT_MASK_SHA256,
  prompt: "Transform the exterior into a stormy neon market",
  endpoint: LTX_ENDPOINT,
  parameters: normalizedParameters,
} as const;

describe("generation input digest", () => {
  it("is a deterministic SHA-256 over canonical inputs and normalized parameters", () => {
    const reorderedParameters = {
      video_write_mode: "balanced",
      video_quality: "high",
      enable_safety_checker: true,
      enable_prompt_expansion: false,
      seed: 42,
      generate_audio: false,
      guidance_scale: 1,
      num_inference_steps: 15,
      frames_per_second: 24,
      num_frames: 121,
      video_strength: 1,
    } as const;

    const first = computeGenerationDigest(generationIdentity);
    const second = computeGenerationDigest({
      ...generationIdentity,
      parameters: reorderedParameters,
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it.each([
    ["source hash", { sourceSha256: "33".repeat(32) }],
    ["edit-mask hash", { editMaskSha256: "44".repeat(32) }],
    ["prompt", { prompt: "Transform the exterior into a snowy studio" }],
    ["endpoint", { endpoint: "fal-ai/kling-video/o3/standard/video-to-video" }],
  ])("binds the %s", (_label, mutation) => {
    const baseline = computeGenerationDigest(generationIdentity);
    const changed = computeGenerationDigest({
      ...generationIdentity,
      ...mutation,
    });

    expect(changed).not.toBe(baseline);
  });

  it("binds every normalized model parameter", () => {
    const baseline = computeGenerationDigest(generationIdentity);
    const changed = computeGenerationDigest({
      ...generationIdentity,
      parameters: {
        ...normalizedParameters,
        guidance_scale: 1.5,
      },
    });

    expect(changed).not.toBe(baseline);
  });

  it("rejects artifact identifiers that are not canonical SHA-256 values", () => {
    expect(() =>
      computeGenerationDigest({
        ...generationIdentity,
        sourceSha256: "source-latest",
      }),
    ).toThrow();
  });
});
