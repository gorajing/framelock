import { describe, expect, it, vi } from "vitest";

import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "./kling-contract";
import {
  FAL_PAID_SUBMISSION_TIMEOUT_MS,
  submitFalQueueOnce,
} from "./fal-queue-single-submit";

const INPUT = {
  prompt: "Replace the set with a rain-soaked neon night market",
  video_url: "https://fal.media/source.mp4",
  keep_audio: false,
  shot_type: "customize",
} as const;

describe("single-attempt paid fal queue submission", () => {
  it("posts once with the fixed endpoint and both no-retry controls", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ request_id: "request-123", status: "IN_QUEUE" }),
    );

    const result = await submitFalQueueOnce({
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      input: INPUT,
      credentials: "secret-key",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://queue.fal.run/${KLING_O3_STANDARD_EDIT_ENDPOINT}`,
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Key secret-key",
          "Content-Type": "application/json",
          "X-Fal-No-Retry": "1",
          "X-Fal-Object-Lifecycle-Preference":
            '{"expiration_duration_seconds":3600}',
          "x-app-fal-disable-fallback": "true",
        },
        body: JSON.stringify(INPUT),
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual({
      requestId: "request-123",
      remoteStatus: "IN_QUEUE",
    });
  });

  it("terminalizes a paid POST that exceeds the fixed network deadline without retrying", async () => {
    const abort = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(abort.signal);
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const submission = submitFalQueueOnce({
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      input: INPUT,
      credentials: "secret-key",
      fetchImpl,
    });
    abort.abort();

    await expect(submission).rejects.toMatchObject({
      code: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
    });
    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(FAL_PAID_SUBMISSION_TIMEOUT_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never retries an ambiguous 503 response", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { detail: "upstream unavailable" },
        { status: 503, statusText: "Service Unavailable" },
      ),
    );

    await expect(
      submitFalQueueOnce({
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        input: INPUT,
        credentials: "secret-key",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a proxy timeout response as outcome-unknown and never retries", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { detail: "request timeout" },
        { status: 408, statusText: "Request Timeout" },
      ),
    );

    await expect(
      submitFalQueueOnce({
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        input: INPUT,
        credentials: "secret-key",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed success responses without exposing credentials", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: "IN_QUEUE" }));

    await expect(
      submitFalQueueOnce({
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        input: INPUT,
        credentials: "secret-key",
        fetchImpl,
      }),
    ).rejects.not.toThrow(/secret-key/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
