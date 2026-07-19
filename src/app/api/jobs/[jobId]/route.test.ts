import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/local-job-store", () => ({
  JobStoreError: class JobStoreError extends Error {},
}));
vi.mock("@/lib/jobs/real-job-intake.server", () => ({
  cancelRealJob: vi.fn(),
  readRealJob: vi.fn(),
}));

describe("real job resource route", () => {
  it("does not expose cancellation in the frozen P0 surface", async () => {
    const route = await import("./route");

    expect(route).not.toHaveProperty("DELETE");
  });
});
