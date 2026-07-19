import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pollKlingFallback: vi.fn(),
}));

vi.mock("@/lib/fal/synthetic-kling-job.server", () => ({
  pollKlingFallback: mocks.pollKlingFallback,
}));
vi.mock("@/lib/fal/kling-fallback-request", () => ({
  klingFallbackSubmitSchema: { parse: (value: unknown) => value },
}));
vi.mock("@/lib/jobs/local-job-store", () => ({
  JobStoreError: class JobStoreError extends Error {
    code = "JOB_NOT_FOUND";
  },
}));

import { GET, POST } from "./route";

describe("legacy synthetic Kling route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails paid POST closed", async () => {
    const response = await POST();

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual({
      error: "LEGACY_SYNTHETIC_SUBMISSION_CLOSED",
      reason:
        "Paid generation is available only through the hash-bound real-job run action.",
    });
  });

  it("keeps the historical GET as a read-only compatibility projection", async () => {
    const historical = {
      id: "synthetic-hero-kling-o3-001",
      state: "verified",
    };
    mocks.pollKlingFallback.mockResolvedValue(historical);

    const response = await GET(
      new Request("http://localhost/api/jobs/synthetic/kling"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(historical);
    expect(mocks.pollKlingFallback).toHaveBeenCalledTimes(1);
  });
});
