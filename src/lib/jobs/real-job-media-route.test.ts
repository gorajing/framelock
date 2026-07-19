import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { LocalJobRecord } from "./local-job-store";
import { createRealJobMediaHandler } from "./real-job-media-route";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "framelock-media-handler-"));
  const jobsRoot = join(root, "jobs");
  const runsRoot = join(root, "runs");
  const id = "real_route_001";
  const source = "0123456789";
  const sourcePath = join(runsRoot, id, "inputs", "source.mp4");
  await mkdir(join(runsRoot, id, "inputs"), { recursive: true });
  await writeFile(sourcePath, source);
  const record: LocalJobRecord = {
    id,
    state: "validated",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    generation: {
      sourceSha256: sha256(source),
      editMaskSha256: "e".repeat(64),
      prompt: "Replace the exterior.",
      endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit",
      parameters: {},
      digest: "d".repeat(64),
    },
  };
  const readJob = vi.fn(async () => record);
  return {
    id,
    sourcePath,
    readJob,
    GET: createRealJobMediaHandler({
      jobs: { readJob },
      jobsRoot,
      runsRoot,
    }),
  };
}

describe("real job media handler", () => {
  it("returns 404 for an invalid job ID without consulting the store", async () => {
    const test = await fixture();
    const response = await test.GET(
      new Request("http://localhost/api/jobs/bad/media/source"),
      { params: Promise.resolve({ jobId: "../bad", asset: "source" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(test.readJob).not.toHaveBeenCalled();
  });

  it("returns an RFC-style unsatisfied range with the actual size", async () => {
    const test = await fixture();
    const response = await test.GET(
      new Request("http://localhost/api/jobs/real_route_001/media/source", {
        headers: { Range: "bytes=10-20" },
      }),
      { params: Promise.resolve({ jobId: test.id, asset: "source" }) },
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("streams a valid range and fails closed after byte tampering", async () => {
    const test = await fixture();
    const ranged = await test.GET(
      new Request("http://localhost/api/jobs/real_route_001/media/source", {
        headers: { Range: "bytes=2-5" },
      }),
      { params: Promise.resolve({ jobId: test.id, asset: "source" }) },
    );
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("2345");

    await writeFile(test.sourcePath, "tampered!!");
    const tampered = await test.GET(
      new Request("http://localhost/api/jobs/real_route_001/media/source"),
      { params: Promise.resolve({ jobId: test.id, asset: "source" }) },
    );
    expect(tampered.status).toBe(409);
    expect(await tampered.json()).toEqual({
      error: "ASSET_INTEGRITY_FAILED",
    });
  });
});
