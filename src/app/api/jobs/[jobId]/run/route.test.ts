import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submitRealKlingJob: vi.fn(),
  RealKlingJobError: class RealKlingJobError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/lib/fal/real-kling-job.server", () => ({
  RealKlingRuntimeError: class RealKlingRuntimeError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  submitRealKlingJob: mocks.submitRealKlingJob,
}));
vi.mock("@/lib/fal/real-kling-job-core", () => ({
  RealKlingJobError: mocks.RealKlingJobError,
}));
vi.mock("@/lib/fal/real-kling-request", () => ({
  realKlingSubmitSchema: { parse: (value: unknown) => value },
}));
vi.mock("@/lib/jobs/local-job-store", () => ({
  JobStoreError: class JobStoreError extends Error {
    code = "JOB_NOT_FOUND";
  },
}));
vi.mock("@/lib/jobs/paid-attempt-budget", () => ({
  PaidAttemptBudgetError: class PaidAttemptBudgetError extends Error {
    code = "PAID_ATTEMPT_CAP_REACHED";
  },
}));

import { POST } from "./route";

const JOB_ID = "real-hero-kling-o3-007";
const GENERATION_DIGEST = "a".repeat(64);

describe("real Kling run route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the stable safe code when pricing evidence is not current", async () => {
    mocks.submitRealKlingJob.mockRejectedValue(
      new mocks.RealKlingJobError(
        "PRICING_OBSERVATION_NOT_CURRENT",
        "internal freshness detail must not cross the route boundary",
      ),
    );

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmation:
            "I authorize one paid Kling O3 generation for this exact digest.",
          generationDigest: GENERATION_DIGEST,
          pricingObservationDigest: "b".repeat(64),
        }),
      }),
      { params: Promise.resolve({ jobId: JOB_ID }) },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual({
      error: "PRICING_OBSERVATION_NOT_CURRENT",
    });
  });

  it.each([
    ["ACTIVE_JOB_MISMATCH", 409],
    ["AI_SOURCE_EVIDENCE_MISMATCH", 409],
    ["PRICING_RECEIPT_REQUIRED", 409],
    ["FAL_KEY_MISSING", 503],
  ])("maps runtime %s to a stable %i response", async (code, status) => {
    const { RealKlingRuntimeError } = await import(
      "@/lib/fal/real-kling-job.server"
    );
    mocks.submitRealKlingJob.mockRejectedValue(
      new RealKlingRuntimeError(code as never),
    );

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmation:
            "I authorize one paid Kling O3 generation for this exact digest.",
          generationDigest: GENERATION_DIGEST,
          pricingObservationDigest: "b".repeat(64),
        }),
      }),
      { params: Promise.resolve({ jobId: JOB_ID }) },
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual({ error: code });
  });
});
