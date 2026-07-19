import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "./kling-contract";
import {
  KlingPricingObservationError,
  observeKlingO3StandardEditPricing,
} from "./kling-pricing.server";

const API_ENV = { FAL_KEY: "api-scope-key" };
const OBSERVED_AT = "2026-07-18T20:00:00.000Z";

function pricingResponse(
  overrides: Record<string, unknown> = {},
): Response {
  return Response.json({
    prices: [
      {
        endpoint_id: KLING_O3_STANDARD_EDIT_ENDPOINT,
        unit_price: 0.14,
        unit: "second",
        currency: "USD",
      },
    ],
    next_cursor: null,
    has_more: false,
    ...overrides,
  });
}

describe("authenticated Kling pricing observation", () => {
  it("performs one fixed-host GET with FAL_KEY and no body, redirect, cache or retry", async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return pricingResponse();
      },
    );

    const observation = await observeKlingO3StandardEditPricing({
      env: API_ENV,
      fetchImpl,
      now: () => new Date(OBSERVED_AT),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = fetchImpl.mock.calls[0];
    const url = new URL(String(rawUrl));
    expect(url.origin).toBe("https://api.fal.ai");
    expect(url.pathname).toBe("/v1/models/pricing");
    expect([...url.searchParams]).toEqual([
      ["endpoint_id", KLING_O3_STANDARD_EDIT_ENDPOINT],
    ]);
    expect(init).toMatchObject({
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Key api-scope-key",
      },
      redirect: "error",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
    expect(init).not.toHaveProperty("body");
    expect(String(rawUrl)).not.toContain("queue.fal.run");
    expect(String(rawUrl)).not.toContain("storage");
    expect(observation).toEqual({
      unitPriceUsd: "0.14",
      billingUnit: "seconds",
      estimatedUnits: "5.041666667",
      estimatedCostUsd: "0.7058333334",
      pricingSource:
        "authenticated_fal_platform_pricing_api_v1_models_pricing",
      priceObservedAt: OBSERVED_AT,
    });
  });

  it("accepts the plural per-second unit and a zero price", async () => {
    const fetchImpl = vi.fn(async () =>
      pricingResponse({
        prices: [
          {
            endpoint_id: KLING_O3_STANDARD_EDIT_ENDPOINT,
            unit_price: 0,
            unit: "seconds",
            currency: "USD",
          },
        ],
      }),
    );

    await expect(
      observeKlingO3StandardEditPricing({
        env: API_ENV,
        fetchImpl,
        now: () => new Date(OBSERVED_AT),
      }),
    ).resolves.toMatchObject({
      unitPriceUsd: "0",
      billingUnit: "seconds",
      estimatedCostUsd: "0",
    });
  });

  it("normalizes a finite exponential price before decimal estimation", async () => {
    const fetchImpl = vi.fn(async () =>
      pricingResponse({
        prices: [
          {
            endpoint_id: KLING_O3_STANDARD_EDIT_ENDPOINT,
            unit_price: 1e-7,
            unit: "second",
            currency: "USD",
          },
        ],
      }),
    );

    await expect(
      observeKlingO3StandardEditPricing({
        env: API_ENV,
        fetchImpl,
        now: () => new Date(OBSERVED_AT),
      }),
    ).resolves.toMatchObject({
      unitPriceUsd: "0.0000001",
      estimatedCostUsd: "0.0000005042",
    });
  });

  it("never falls back to FAL_ADMIN_KEY", async () => {
    const fetchImpl = vi.fn(async () => pricingResponse());

    await expect(
      observeKlingO3StandardEditPricing({
        env: { FAL_ADMIN_KEY: "admin-must-not-be-used" },
        fetchImpl,
        now: () => new Date(OBSERVED_AT),
      }),
    ).rejects.toMatchObject({ code: "FAL_KEY_MISSING" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["empty prices", { prices: [] }],
    [
      "duplicate prices",
      {
        prices: [
          {
            endpoint_id: KLING_O3_STANDARD_EDIT_ENDPOINT,
            unit_price: 0.14,
            unit: "second",
            currency: "USD",
          },
          {
            endpoint_id: KLING_O3_STANDARD_EDIT_ENDPOINT,
            unit_price: 0.14,
            unit: "second",
            currency: "USD",
          },
        ],
      },
    ],
    [
      "wrong endpoint",
      {
        prices: [
          {
            endpoint_id: "fal-ai/kling-video/latest",
            unit_price: 0.14,
            unit: "second",
            currency: "USD",
          },
        ],
      },
    ],
    [
      "wrong currency",
      {
        prices: [
          {
            endpoint_id: KLING_O3_STANDARD_EDIT_ENDPOINT,
            unit_price: 0.14,
            unit: "second",
            currency: "EUR",
          },
        ],
      },
    ],
    [
      "unsupported unit",
      {
        prices: [
          {
            endpoint_id: KLING_O3_STANDARD_EDIT_ENDPOINT,
            unit_price: 0.14,
            unit: "video",
            currency: "USD",
          },
        ],
      },
    ],
    ["pagination flag", { has_more: true }],
    ["pagination cursor", { next_cursor: "next-page" }],
    [
      "negative price",
      {
        prices: [
          {
            endpoint_id: KLING_O3_STANDARD_EDIT_ENDPOINT,
            unit_price: -0.14,
            unit: "second",
            currency: "USD",
          },
        ],
      },
    ],
    [
      "nonfinite price",
      {
        prices: [
          {
            endpoint_id: KLING_O3_STANDARD_EDIT_ENDPOINT,
            unit_price: Number.POSITIVE_INFINITY,
            unit: "second",
            currency: "USD",
          },
        ],
      },
    ],
    ["malformed envelope", { prices: "not-an-array" }],
  ])("rejects %s without retrying", async (_label, overrides) => {
    const fetchImpl = vi.fn(async () => pricingResponse(overrides));

    await expect(
      observeKlingO3StandardEditPricing({
        env: API_ENV,
        fetchImpl,
        now: () => new Date(OBSERVED_AT),
      }),
    ).rejects.toMatchObject({ code: "FAL_PRICING_RESPONSE_INVALID" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 429, 500, 503])(
    "sanitizes HTTP %s without retrying or reflecting the response",
    async (status) => {
      const fetchImpl = vi.fn(async () =>
        Response.json(
          { error: "upstream-secret-detail" },
          { status, statusText: "upstream-secret-detail" },
        ),
      );

      let caught: unknown;
      try {
        await observeKlingO3StandardEditPricing({
          env: API_ENV,
          fetchImpl,
          now: () => new Date(OBSERVED_AT),
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(KlingPricingObservationError);
      expect(String(caught)).not.toContain("api-scope-key");
      expect(String(caught)).not.toContain("upstream-secret-detail");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("sanitizes network and invalid-JSON failures without retrying", async () => {
    const networkFetch = vi.fn(async () => {
      throw new Error("network detail api-scope-key");
    });
    const invalidJsonFetch = vi.fn(async () =>
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      observeKlingO3StandardEditPricing({
        env: API_ENV,
        fetchImpl: networkFetch,
        now: () => new Date(OBSERVED_AT),
      }),
    ).rejects.toMatchObject({ code: "FAL_PRICING_UNAVAILABLE" });
    await expect(
      observeKlingO3StandardEditPricing({
        env: API_ENV,
        fetchImpl: invalidJsonFetch,
        now: () => new Date(OBSERVED_AT),
      }),
    ).rejects.toMatchObject({ code: "FAL_PRICING_RESPONSE_INVALID" });
    expect(networkFetch).toHaveBeenCalledTimes(1);
    expect(invalidJsonFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid server observation time", async () => {
    const fetchImpl = vi.fn(async () => pricingResponse());

    await expect(
      observeKlingO3StandardEditPricing({
        env: API_ENV,
        fetchImpl,
        now: () => new Date(Number.NaN),
      }),
    ).rejects.toMatchObject({ code: "FAL_PRICING_RESPONSE_INVALID" });
  });

  it("sanitizes a non-Date observation clock result", async () => {
    const fetchImpl = vi.fn(async () => pricingResponse());

    await expect(
      observeKlingO3StandardEditPricing({
        env: API_ENV,
        fetchImpl,
        now: () => "invalid-clock-secret" as unknown as Date,
      }),
    ).rejects.toMatchObject({
      name: "KlingPricingObservationError",
      code: "FAL_PRICING_RESPONSE_INVALID",
    });
  });

  it("sanitizes a provider number that cannot fit the observation contract", async () => {
    const fetchImpl = vi.fn(async () =>
      pricingResponse({
        prices: [
          {
            endpoint_id: KLING_O3_STANDARD_EDIT_ENDPOINT,
            unit_price: 1e-200,
            unit: "second",
            currency: "USD",
          },
        ],
      }),
    );

    await expect(
      observeKlingO3StandardEditPricing({
        env: API_ENV,
        fetchImpl,
        now: () => new Date(OBSERVED_AT),
      }),
    ).rejects.toMatchObject({
      name: "KlingPricingObservationError",
      code: "FAL_PRICING_RESPONSE_INVALID",
    });
  });
});
