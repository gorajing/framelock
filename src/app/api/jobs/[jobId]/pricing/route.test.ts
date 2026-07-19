import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RealKlingRuntimeError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }

  class KlingPricingObservationError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }

  class JobStoreError extends Error {
    constructor(
      readonly code: string,
      message = code,
    ) {
      super(message);
    }
  }

  class PaidAttemptBudgetError extends Error {
    constructor(
      readonly code: string,
      readonly budget?: { used: number; next: number; cap: 3 },
    ) {
      super(code);
    }
  }

  return {
    refreshRealKlingPricing: vi.fn(),
    RealKlingRuntimeError,
    KlingPricingObservationError,
    JobStoreError,
    PaidAttemptBudgetError,
  };
});

vi.mock("@/lib/fal/real-kling-job.server", () => ({
  RealKlingRuntimeError: mocks.RealKlingRuntimeError,
  refreshRealKlingPricing: mocks.refreshRealKlingPricing,
}));
vi.mock("@/lib/fal/kling-pricing.server", () => ({
  KlingPricingObservationError: mocks.KlingPricingObservationError,
}));
vi.mock("@/lib/jobs/local-job-store", () => ({
  JobStoreError: mocks.JobStoreError,
}));
vi.mock("@/lib/jobs/paid-attempt-budget", () => ({
  PaidAttemptBudgetError: mocks.PaidAttemptBudgetError,
}));
vi.mock("@/lib/jobs/paid-attempt-pricing", async () =>
  import("../../../../../lib/jobs/paid-attempt-pricing"),
);

import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "../../../../../lib/fal/kling-contract";

import { POST } from "./route";

const JOB_ID = "ai_source_01";
const RECEIPT = {
  schemaVersion: 1 as const,
  jobId: JOB_ID,
  generationDigest: "a".repeat(64),
  sourceProvenanceFileSha256: "b".repeat(64),
  endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
  currency: "USD" as const,
  pricingObservation: {
    unitPriceUsd: "0.126",
    billingUnit: "seconds",
    estimatedUnits: "5.041666667",
    estimatedCostUsd: "0.6352500000",
    pricingSource:
      "authenticated_fal_platform_pricing_api_v1_models_pricing",
    priceObservedAt: "2026-07-18T20:00:00.000Z",
  },
  pricingObservationDigest: "c".repeat(64),
  receiptDigestSha256: "d".repeat(64),
};

function request(
  suffix = "",
  init: RequestInit = { method: "POST" },
): Request {
  return new Request(
    `http://localhost/api/jobs/${JOB_ID}/pricing${suffix}`,
    init,
  );
}

function context(jobId = JOB_ID) {
  return { params: Promise.resolve({ jobId }) };
}

describe("real Kling pricing route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshRealKlingPricing.mockResolvedValue(RECEIPT);
  });

  it("returns the direct strict client-safe receipt without starting generation", async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual(RECEIPT);
    expect(mocks.refreshRealKlingPricing).toHaveBeenCalledOnce();
    expect(mocks.refreshRealKlingPricing).toHaveBeenCalledWith(JOB_ID);
  });

  it("accepts the zero-byte POST body produced by the browser transport", async () => {
    const response = await POST(
      request("", { method: "POST", body: "" }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(RECEIPT);
    expect(mocks.refreshRealKlingPricing).toHaveBeenCalledOnce();
  });

  it.each([
    ["query parameters", request("?refresh=1")],
    [
      "a JSON body",
      request("", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: true }),
      }),
    ],
  ])("rejects %s before observing pricing", async (_label, input) => {
    const response = await POST(input, context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "INVALID_REQUEST",
    });
    expect(mocks.refreshRealKlingPricing).not.toHaveBeenCalled();
  });

  it("rejects an invalid job ID before observing pricing", async () => {
    const response = await POST(request(), context("../other-job"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "INVALID_REQUEST",
    });
    expect(mocks.refreshRealKlingPricing).not.toHaveBeenCalled();
  });

  it("fails closed if a runtime return contains fields outside the safe receipt schema", async () => {
    mocks.refreshRealKlingPricing.mockResolvedValue({
      ...RECEIPT,
      internalCredential: "must-never-cross-route-boundary",
    });

    const response = await POST(request(), context());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "SERVER_ERROR" });
  });

  it.each([
    ["ACTIVE_JOB_MISMATCH", 409],
    ["AI_SOURCE_EVIDENCE_MISMATCH", 409],
    ["PRICING_RECEIPT_REQUIRED", 409],
    ["FAL_KEY_MISSING", 503],
  ])("maps runtime %s to a stable %i response", async (code, status) => {
    mocks.refreshRealKlingPricing.mockRejectedValue(
      new mocks.RealKlingRuntimeError(code),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: code });
  });

  it.each([
    "FAL_KEY_MISSING",
    "FAL_PRICING_AUTHORIZATION_FAILED",
    "FAL_PRICING_RATE_LIMITED",
    "FAL_PRICING_UNAVAILABLE",
    "FAL_PRICING_RESPONSE_INVALID",
  ])("sanitizes pricing observation failure %s", async (code) => {
    mocks.refreshRealKlingPricing.mockRejectedValue(
      new mocks.KlingPricingObservationError(code),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: code });
  });

  it.each([
    ["JOB_NOT_FOUND", 404],
    ["JOB_ALREADY_ACTIVE", 409],
    ["INVALID_JOB_STATE", 409],
    ["PROVENANCE_MISMATCH", 500],
  ])("maps job store %s to a stable %i response", async (code, status) => {
    mocks.refreshRealKlingPricing.mockRejectedValue(
      new mocks.JobStoreError(code, "internal store path must stay private"),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: code });
  });

  it("returns safe budget facts when the fixed paid-attempt cap is reached", async () => {
    const budget = { used: 3, next: 4, cap: 3 as const };
    mocks.refreshRealKlingPricing.mockRejectedValue(
      new mocks.PaidAttemptBudgetError("PAID_ATTEMPT_CAP_REACHED", budget),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "PAID_ATTEMPT_CAP_REACHED",
      budget,
    });
  });
});
