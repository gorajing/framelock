import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./client.server", () => ({ fal: {} }));

describe("legacy synthetic Kling server boundary", () => {
  it("does not export any paid submission capability", async () => {
    const legacyKling = await import("./synthetic-kling-job.server");

    expect(legacyKling).not.toHaveProperty("submitKlingFallback");
  });
});
