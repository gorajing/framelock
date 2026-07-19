import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadFalMedia } from "./fal-media-download";

describe("fal media download policy", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-fal-download-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("streams an allowed fal HTTPS response into an exclusive local artifact", async () => {
    const payload = new TextEncoder().encode("model-output");
    const fetchImpl = vi.fn(async () => new Response(payload, { status: 200 }));
    const destination = join(root, "result.mp4");

    const result = await downloadFalMedia({
      url: "https://v3b.fal.media/files/result.mp4",
      destination,
      fetchImpl,
      maxBytes: 1_000,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://v3b.fal.media/files/result.mp4",
      { redirect: "error" },
    );
    expect(await readFile(destination)).toEqual(Buffer.from(payload));
    expect(result).toEqual({
      path: destination,
      bytes: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
  });

  it("reuses a complete persisted artifact after a crash before job-state persistence", async () => {
    const payload = Buffer.from("already-downloaded");
    const destination = join(root, "result.mp4");
    await writeFile(destination, payload, { mode: 0o600 });
    const fetchImpl = vi.fn();

    const result = await downloadFalMedia({
      url: "https://v3b.fal.media/files/result.mp4",
      destination,
      fetchImpl,
      maxBytes: 1_000,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      path: destination,
      bytes: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
  });

  it("rejects non-fal hosts before making a request", async () => {
    const fetchImpl = vi.fn();

    await expect(
      downloadFalMedia({
        url: "https://example.com/result.mp4",
        destination: join(root, "result.mp4"),
        fetchImpl,
      }),
    ).rejects.toThrow("allowed HTTPS hosts");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects declared and streamed bodies above the byte cap without debris", async () => {
    const declaredDestination = join(root, "declared.mp4");
    await expect(
      downloadFalMedia({
        url: "https://fal.media/declared.mp4",
        destination: declaredDestination,
        maxBytes: 4,
        fetchImpl: async () =>
          new Response(new Uint8Array([1]), {
            status: 200,
            headers: { "content-length": "5" },
          }),
      }),
    ).rejects.toThrow("exceeds the 4 byte download limit");

    const streamedDestination = join(root, "streamed.mp4");
    await expect(
      downloadFalMedia({
        url: "https://fal.media/streamed.mp4",
        destination: streamedDestination,
        maxBytes: 4,
        fetchImpl: async () =>
          new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 }),
      }),
    ).rejects.toThrow("exceeds the 4 byte download limit");

    await expect(readFile(declaredDestination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(streamedDestination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
