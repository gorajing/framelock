import { describe, expect, it } from "vitest";

import {
  KLING_O3_STANDARD_EDIT_ENDPOINT,
  buildKlingO3EditInput,
  klingO3EditOutputSchema,
} from "./kling-contract";

describe("Kling O3 Standard fallback request contract", () => {
  it("freezes the one allowed fallback endpoint and explicit audio/shot controls", () => {
    expect(KLING_O3_STANDARD_EDIT_ENDPOINT).toBe(
      "fal-ai/kling-video/o3/standard/video-to-video/edit",
    );
    expect(
      buildKlingO3EditInput({
        prompt: "Transform @Video1 into a rain-soaked neon laboratory",
        sourceUrl: "https://example.com/source.mp4",
      }),
    ).toEqual({
      prompt: "Transform @Video1 into a rain-soaked neon laboratory",
      video_url: "https://example.com/source.mp4",
      keep_audio: false,
      shot_type: "customize",
    });
  });

  it("rejects blank prompts, non-HTTPS source URLs and unknown controls", () => {
    expect(() =>
      buildKlingO3EditInput({
        prompt: "   ",
        sourceUrl: "file:///tmp/source.mp4",
      }),
    ).toThrow();
    expect(() =>
      buildKlingO3EditInput({
        prompt: "Transform @Video1",
        sourceUrl: "http://example.com/source.mp4",
      }),
    ).toThrow();
    expect(() =>
      buildKlingO3EditInput({
        prompt: "Transform @Video1",
        sourceUrl: "https://example.com/source.mp4",
        endpoint: "fal-ai/anything",
      } as never),
    ).toThrow();
  });
});

describe("Kling O3 Standard output contract", () => {
  it("accepts the documented response without inventing LTX-only fields", () => {
    const output = {
      video: {
        url: "https://fal.media/result.mp4",
        content_type: "video/mp4",
        file_name: "result.mp4",
        file_size: 12_345,
      },
    };

    expect(klingO3EditOutputSchema.parse(output)).toEqual(output);
  });

  it("accepts nullable optional File metadata from the live OpenAPI schema", () => {
    const output = {
      video: {
        url: "https://fal.media/result.mp4",
        content_type: null,
        file_name: null,
        file_size: null,
      },
    };

    expect(klingO3EditOutputSchema.parse(output)).toEqual(output);
  });

  it("rejects an output without a downloadable video URL", () => {
    expect(() => klingO3EditOutputSchema.parse({ video: {} })).toThrow();
  });
});
