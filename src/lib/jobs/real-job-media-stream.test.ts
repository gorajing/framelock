import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createHashBoundMediaResponse,
  readExactPositioned,
} from "./real-job-media-stream";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("hash-bound media streaming", () => {
  it("streams bounded chunks from the same validated descriptor", async () => {
    const root = await mkdtemp(join(tmpdir(), "framelock-media-stream-"));
    const path = join(root, "large.bin");
    const bytes = new Uint8Array(200_000).map((_, index) => index % 251);
    await writeFile(path, bytes);

    const response = await createHashBoundMediaResponse(
      {
        path,
        root,
        expectedSha256: sha256(bytes),
        maxBytes: 250_000,
        contentType: "application/octet-stream",
        disposition: "inline",
      },
      undefined,
    );

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader!.read();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBeGreaterThan(0);
    expect(first.value?.byteLength).toBeLessThan(bytes.byteLength);
    await reader!.cancel();
  });

  it("serves a single range without buffering the whole asset", async () => {
    const root = await mkdtemp(join(tmpdir(), "framelock-media-range-"));
    const path = join(root, "video.mp4");
    const bytes = new TextEncoder().encode("0123456789abcdef");
    await writeFile(path, bytes);

    const response = await createHashBoundMediaResponse(
      {
        path,
        root,
        expectedSha256: sha256(bytes),
        maxBytes: 1_024,
        contentType: "video/mp4",
        disposition: "inline",
      },
      "bytes=3-7",
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 3-7/16");
    expect(response.headers.get("content-length")).toBe("5");
    expect(await response.text()).toBe("34567");
  });

  it("loops across short positioned reads", async () => {
    const source = new TextEncoder().encode("short-read");
    const reader = {
      async read(
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) {
        const bytesRead = Math.min(2, length, source.byteLength - position);
        if (bytesRead > 0) {
          buffer.set(source.subarray(position, position + bytesRead), offset);
        }
        return { bytesRead };
      },
    };
    const target = new Uint8Array(source.byteLength);

    await readExactPositioned(reader, target, 0);

    expect(new TextDecoder().decode(target)).toBe("short-read");
  });
});
