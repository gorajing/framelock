import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MOTION_FAL_REQUEST_TIMEOUT_MS,
  MOTION_V1_SPEND_CEILING_USD,
  createMotionPaidAttemptController,
  digestMotionFalInput,
  type MotionPaidAttemptController,
  type MotionPricingObservation,
} from "./motion-paid-attempt";

const ENDPOINT = "fal-ai/sam-3-1/video-rle";
const SECOND_ENDPOINT = "fal-ai/kling-video/o3/standard/video-to-video/edit";
const NOW = new Date("2026-07-18T20:00:00.000Z");
const INPUT = {
  prompt: "the character in the red coat",
  video_url: "https://example.test/owned-character.mp4",
};
const PRICING: MotionPricingObservation = {
  unitPriceUsd: "0.005",
  billingUnit: "frames",
  estimatedUnits: "121",
  estimatedCostUsd: "0.605",
  pricingSource: "fal model API pricing observed for the motion-v1 run",
  priceObservedAt: "2026-07-18T19:50:00.000Z",
  priceValidUntil: "2026-07-18T21:00:00.000Z",
};

describe("Motion v1 paid fal attempt controller", () => {
  let root: string;
  let ledgerPath: string;
  let attemptIndex: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-motion-spend-"));
    ledgerPath = join(root, "artifacts", "motion-v1", "spend-ledger.json");
    attemptIndex = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function controller(input?: {
    fetchImpl?: typeof fetch;
    allowedEndpoints?: readonly string[];
  }): MotionPaidAttemptController {
    return createMotionPaidAttemptController({
      ledgerPath,
      allowedEndpoints: input?.allowedEndpoints ?? [ENDPOINT, SECOND_ENDPOINT],
      now: () => new Date(NOW),
      createAttemptId: () => `motion-attempt-${++attemptIndex}`,
      ...(input?.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
  }

  it("durably reserves exact endpoint, canonical input digest and current pricing before the one paid POST", async () => {
    const credentials = "fal-secret-that-must-not-be-persisted";
    const fetchImpl = vi.fn(async () => {
      const persistedAtNetworkBoundary = JSON.parse(
        await readFile(ledgerPath, "utf8"),
      );
      expect(persistedAtNetworkBoundary.attempts).toEqual([
        expect.objectContaining({
          attemptId: "motion-attempt-1",
          state: "reserved",
          endpoint: ENDPOINT,
          inputDigest: digestMotionFalInput(INPUT),
          pricing: PRICING,
        }),
      ]);
      return Response.json({ request_id: "fal-request-123", status: "IN_QUEUE" });
    });

    const result = await controller({ fetchImpl }).submit({
      endpoint: ENDPOINT,
      falInput: INPUT,
      credentials,
      pricing: PRICING,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://queue.fal.run/${ENDPOINT}`,
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Key ${credentials}`,
          "Content-Type": "application/json",
          "X-Fal-No-Retry": "1",
          "x-app-fal-disable-fallback": "true",
        },
        body: JSON.stringify(INPUT),
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toMatchObject({
      state: "submitted",
      requestId: "fal-request-123",
      remoteStatus: "IN_QUEUE",
    });

    const ledgerText = await readFile(ledgerPath, "utf8");
    expect(ledgerText).not.toContain(credentials);
    expect(JSON.parse(ledgerText)).toMatchObject({
      schemaVersion: 1,
      ceilingUsd: MOTION_V1_SPEND_CEILING_USD,
      attempts: [
        {
          attemptId: "motion-attempt-1",
          reservedAt: NOW.toISOString(),
          state: "submitted",
          endpoint: ENDPOINT,
          inputDigest: digestMotionFalInput(INPUT),
          pricing: PRICING,
          completedAt: NOW.toISOString(),
          httpStatus: 200,
          requestId: "fal-request-123",
          remoteStatus: "IN_QUEUE",
        },
      ],
    });
  });

  it("hashes logically identical JSON inputs identically regardless of object key order", () => {
    const expected = createHash("sha256")
      .update(
        '{"prompt":"the character in the red coat","video_url":"https://example.test/owned-character.mp4"}',
      )
      .digest("hex");

    expect(digestMotionFalInput(INPUT)).toBe(expected);
    expect(
      digestMotionFalInput({
        video_url: INPUT.video_url,
        prompt: INPUT.prompt,
      }),
    ).toBe(expected);
  });

  it("rejects endpoints outside the explicit controller allowlist before reserving or fetching", async () => {
    const fetchImpl = vi.fn();

    await expect(
      controller({ fetchImpl, allowedEndpoints: [ENDPOINT] }).submit({
        endpoint: SECOND_ENDPOINT,
        falInput: INPUT,
        credentials: "secret-key",
        pricing: PRICING,
      }),
    ).rejects.toMatchObject({ code: "ENDPOINT_NOT_ALLOWED" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readFile(ledgerPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects stale or internally inconsistent pricing before reserving or fetching", async () => {
    const fetchImpl = vi.fn();
    const stalePricing = {
      ...PRICING,
      priceValidUntil: "2026-07-18T19:59:59.000Z",
    };

    await expect(
      controller({ fetchImpl }).submit({
        endpoint: ENDPOINT,
        falInput: INPUT,
        credentials: "secret-key",
        pricing: stalePricing,
      }),
    ).rejects.toMatchObject({ code: "PRICING_NOT_CURRENT" });
    await expect(
      controller({ fetchImpl }).submit({
        endpoint: ENDPOINT,
        falInput: INPUT,
        credentials: "secret-key",
        pricing: { ...PRICING, estimatedCostUsd: "0.604" },
      }),
    ).rejects.toMatchObject({ code: "PRICING_MATH_MISMATCH" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readFile(ledgerPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("atomically prevents concurrent reservations from exceeding the cumulative $100 ceiling", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ request_id: "one-authorized-request" }),
    );
    const sixtyDollars: MotionPricingObservation = {
      ...PRICING,
      unitPriceUsd: "60",
      estimatedUnits: "1",
      estimatedCostUsd: "60",
    };
    const motion = controller({ fetchImpl });

    const results = await Promise.allSettled([
      motion.submit({
        endpoint: ENDPOINT,
        falInput: { ...INPUT, prompt: "attempt one" },
        credentials: "secret-key",
        pricing: sixtyDollars,
      }),
      motion.submit({
        endpoint: ENDPOINT,
        falInput: { ...INPUT, prompt: "attempt two" },
        credentials: "secret-key",
        pricing: sixtyDollars,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "MOTION_SPEND_CEILING_EXCEEDED" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await motion.readLedger()).toMatchObject({
      ceilingUsd: "100",
      reservedCostUsd: "60",
      remainingCostUsd: "40",
      attempts: [expect.objectContaining({ pricing: sixtyDollars })],
    });
  });

  it.each([
    [422, "rejected"],
    [503, "submission_unknown"],
  ] as const)(
    "records HTTP %i as %s and does not retry",
    async (status, expectedState) => {
      const fetchImpl = vi.fn(async () =>
        Response.json({ detail: "remote response" }, { status }),
      );

      const attempt = await controller({ fetchImpl }).submit({
        endpoint: ENDPOINT,
        falInput: INPUT,
        credentials: "secret-key",
        pricing: PRICING,
      });

      expect(attempt).toMatchObject({
        state: expectedState,
        httpStatus: status,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("records thrown network errors as submission_unknown without retrying or exposing credentials", async () => {
    const credentials = "never-print-this-secret";
    const fetchImpl = vi.fn(async () => {
      throw new Error(`transport failed for ${credentials}`);
    });

    const attempt = await controller({ fetchImpl }).submit({
      endpoint: ENDPOINT,
      falInput: INPUT,
      credentials,
      pricing: PRICING,
    });

    expect(attempt).toMatchObject({ state: "submission_unknown" });
    expect(JSON.stringify(attempt)).not.toContain(credentials);
    expect(await readFile(ledgerPath, "utf8")).not.toContain(credentials);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the fixed abort deadline for a paid POST", async () => {
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

    const submission = controller({ fetchImpl }).submit({
      endpoint: ENDPOINT,
      falInput: INPUT,
      credentials: "secret-key",
      pricing: PRICING,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    abort.abort();

    await expect(submission).resolves.toMatchObject({
      state: "submission_unknown",
    });
    expect(timeout).toHaveBeenCalledWith(MOTION_FAL_REQUEST_TIMEOUT_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("polls later status and result with GET only and never mutates the spend ledger", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ request_id: "request-read-only", status: "IN_QUEUE" }),
      )
      .mockResolvedValueOnce(Response.json({ status: "COMPLETED" }))
      .mockResolvedValueOnce(
        Response.json({ video: { url: "https://example.test/result.mp4" } }),
      );
    const motion = controller({ fetchImpl });
    const submitted = await motion.submit({
      endpoint: ENDPOINT,
      falInput: INPUT,
      credentials: "secret-key",
      pricing: PRICING,
    });
    const beforeReads = await readFile(ledgerPath, "utf8");

    await expect(
      motion.readStatus({
        attemptId: submitted.attemptId,
        credentials: "secret-key",
      }),
    ).resolves.toEqual({ status: "COMPLETED" });
    await expect(
      motion.readResult({
        attemptId: submitted.attemptId,
        credentials: "secret-key",
      }),
    ).resolves.toEqual({
      video: { url: "https://example.test/result.mp4" },
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `https://queue.fal.run/${ENDPOINT}/requests/request-read-only/status`,
      expect.objectContaining({ method: "GET", body: undefined }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      `https://queue.fal.run/${ENDPOINT}/requests/request-read-only`,
      expect.objectContaining({ method: "GET", body: undefined }),
    );
    expect(await readFile(ledgerPath, "utf8")).toBe(beforeReads);
  });

  it("persists fal's namespace-shortened queue URLs and uses those exact URLs for read-only GETs", async () => {
    const requestId = "request-o3-i2v";
    const statusUrl =
      `https://queue.fal.run/fal-ai/kling-video/requests/${requestId}/status`;
    const responseUrl =
      `https://queue.fal.run/fal-ai/kling-video/requests/${requestId}`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          request_id: requestId,
          status: "IN_QUEUE",
          status_url: statusUrl,
          response_url: responseUrl,
        }),
      )
      .mockResolvedValueOnce(Response.json({ status: "COMPLETED" }))
      .mockResolvedValueOnce(
        Response.json({ video: { url: "https://example.test/o3-result.mp4" } }),
      );
    const motion = controller({ fetchImpl });

    const submitted = await motion.submit({
      endpoint: SECOND_ENDPOINT,
      falInput: INPUT,
      credentials: "secret-key",
      pricing: PRICING,
    });

    expect(submitted).toMatchObject({
      state: "submitted",
      requestId,
      statusUrl,
      responseUrl,
    });
    expect(await motion.readAttempt(submitted.attemptId)).toMatchObject({
      statusUrl,
      responseUrl,
    });

    await motion.readStatus({
      attemptId: submitted.attemptId,
      credentials: "secret-key",
    });
    await motion.readResult({
      attemptId: submitted.attemptId,
      credentials: "secret-key",
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      statusUrl,
      expect.objectContaining({ method: "GET", body: undefined }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      responseUrl,
      expect.objectContaining({ method: "GET", body: undefined }),
    );
  });

  it.each([
    {
      label: "arbitrary status host",
      statusUrl:
        "https://attacker.example/steal/requests/request-secure/status",
      responseUrl:
        "https://queue.fal.run/fal-ai/model/requests/request-secure",
    },
    {
      label: "mismatched response request ID",
      statusUrl:
        "https://queue.fal.run/fal-ai/model/requests/request-secure/status",
      responseUrl:
        "https://queue.fal.run/fal-ai/model/requests/different-request",
    },
  ])("rejects $label before it can become a read target", async ({
    statusUrl,
    responseUrl,
  }) => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        request_id: "request-secure",
        status: "IN_QUEUE",
        status_url: statusUrl,
        response_url: responseUrl,
      }),
    );
    const motion = controller({ fetchImpl });

    const attempt = await motion.submit({
      endpoint: SECOND_ENDPOINT,
      falInput: INPUT,
      credentials: "secret-key",
      pricing: PRICING,
    });

    expect(attempt).toMatchObject({ state: "submission_unknown" });
    expect(JSON.stringify(attempt)).not.toContain("attacker.example");
    await expect(
      motion.readStatus({
        attemptId: attempt.attemptId,
        credentials: "secret-key",
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_NOT_SUBMITTED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
