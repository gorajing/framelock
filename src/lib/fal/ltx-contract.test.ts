import { describe, expect, it } from "vitest";

import {
  LTX_ENDPOINT,
  buildLtxInput,
  ltxOutputSchema,
} from "./ltx-contract";

describe("LTX P0 request contract", () => {
  it("freezes the selected endpoint and canonical generation controls", () => {
    expect(LTX_ENDPOINT).toBe("fal-ai/ltx-2.3-quality/inpaint");
    expect(
      buildLtxInput({
        prompt: "A stormy neon market at night",
        sourceUrl: "https://example.com/source.mp4",
        maskUrl: "https://example.com/edit-mask.mp4",
        seed: 42,
      }),
    ).toEqual({
      prompt: "A stormy neon market at night",
      video_url: "https://example.com/source.mp4",
      mask_video_url: "https://example.com/edit-mask.mp4",
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
    });
  });

  it("rejects blank prompts and non-HTTP artifact URLs", () => {
    expect(() =>
      buildLtxInput({
        prompt: "   ",
        sourceUrl: "file:///tmp/source.mp4",
        maskUrl: "https://example.com/mask.mp4",
      }),
    ).toThrow();
  });
});

describe("LTX output contract", () => {
  it("accepts the documented live-schema response", () => {
    const output = {
      video: {
        url: "https://fal.media/result.mp4",
        content_type: "video/mp4",
        file_name: "result.mp4",
        file_size: 12_345,
      },
      seed: 42,
      prompt: "A stormy neon market at night",
    };

    expect(ltxOutputSchema.parse(output)).toEqual(output);
  });

  it("rejects an output without a downloadable video URL", () => {
    expect(() =>
      ltxOutputSchema.parse({ seed: 42, prompt: "A prompt", video: {} }),
    ).toThrow();
  });
});
