import { describe, expect, it } from "vitest";

import {
  KLING_FALLBACK_CONFIRMATION,
  KLING_FALLBACK_JOB_ID,
  KLING_FALLBACK_PROMPT,
  klingFallbackSubmitSchema,
} from "./kling-fallback-request";

describe("one-shot Kling fallback request", () => {
  it("freezes the job, prompt and paid confirmation server-side", () => {
    expect(KLING_FALLBACK_JOB_ID).toBe("synthetic-hero-kling-o3-001");
    expect(KLING_FALLBACK_CONFIRMATION).toBe("RUN KLING O3 FALLBACK 1");
    expect(KLING_FALLBACK_PROMPT).toContain("@Video1");
    expect(
      klingFallbackSubmitSchema.parse({
        confirmation: KLING_FALLBACK_CONFIRMATION,
      }),
    ).toEqual({ confirmation: KLING_FALLBACK_CONFIRMATION });
  });

  it.each(["endpoint", "attempt", "requestId", "sourceUrl", "maskUrl", "prompt"])(
    "rejects browser control of %s",
    (field) => {
      expect(() =>
        klingFallbackSubmitSchema.parse({
          confirmation: KLING_FALLBACK_CONFIRMATION,
          [field]: "browser-controlled",
        }),
      ).toThrow();
    },
  );

  it("rejects any confirmation other than the exact one-shot phrase", () => {
    expect(() =>
      klingFallbackSubmitSchema.parse({ confirmation: "RUN KLING" }),
    ).toThrow();
  });
});
