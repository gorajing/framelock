import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, stat, unlink } from "node:fs/promises";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

export type FalMediaDownload = {
  path: string;
  sha256: string;
  bytes: number;
};

function assertFalMediaUrl(value: string): URL {
  const url = new URL(value);
  const isFalHost =
    url.hostname === "fal.media" ||
    url.hostname.endsWith(".fal.media") ||
    url.hostname === "fal.ai" ||
    url.hostname.endsWith(".fal.ai");
  if (url.protocol !== "https:" || !isFalHost) {
    throw new Error("fal result URL is outside the allowed HTTPS hosts");
  }
  return url;
}

function limitMessage(maxBytes: number): string {
  return `fal result exceeds the ${maxBytes} byte download limit`;
}

async function readExistingArtifact(
  destination: string,
  maxBytes: number,
): Promise<FalMediaDownload | undefined> {
  let metadata;
  try {
    metadata = await stat(destination);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  if (!metadata.isFile()) {
    throw new Error("persisted fal result destination is not a regular file");
  }
  if (metadata.size > maxBytes) {
    throw new Error(limitMessage(maxBytes));
  }
  const bytes = await readFile(destination);
  if (bytes.byteLength > maxBytes) {
    throw new Error(limitMessage(maxBytes));
  }
  return {
    path: destination,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

export async function downloadFalMedia(input: {
  url: string;
  destination: string;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}): Promise<FalMediaDownload> {
  const url = assertFalMediaUrl(input.url);
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("download byte limit must be a positive safe integer");
  }
  const existing = await readExistingArtifact(input.destination, maxBytes);
  if (existing) {
    return existing;
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(url.href, { redirect: "error" });
  if (!response.ok) {
    throw new Error(`fal result download failed with HTTP ${response.status}`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > maxBytes
    ) {
      throw new Error(limitMessage(maxBytes));
    }
  }
  if (!response.body) {
    throw new Error("fal result response has no body");
  }

  const temporary = `${input.destination}.${randomUUID()}.download`;
  const handle = await open(temporary, "wx", 0o600);
  const digest = createHash("sha256");
  let bytes = 0;
  const reader = response.body.getReader();
  let handleClosed = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        throw new Error(limitMessage(maxBytes));
      }
      digest.update(chunk.value);
      await handle.write(chunk.value);
    }
    await handle.sync();
    await handle.close();
    handleClosed = true;
    const downloaded = {
      path: input.destination,
      sha256: digest.digest("hex"),
      bytes,
    };
    try {
      await link(temporary, input.destination);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
      const winner = await readExistingArtifact(input.destination, maxBytes);
      if (!winner) {
        throw new Error("concurrent fal result persistence lost its destination");
      }
      return winner;
    }
    return downloaded;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (!handleClosed) {
      await handle.close().catch(() => undefined);
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
