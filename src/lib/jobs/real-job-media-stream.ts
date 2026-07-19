import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const STREAM_CHUNK_BYTES = 64 * 1024;

export type RealJobMediaErrorCode =
  | "INVALID_JOB_ID"
  | "UNKNOWN_ASSET"
  | "ASSET_NOT_AVAILABLE"
  | "UNSAFE_ASSET"
  | "ASSET_TOO_LARGE"
  | "ASSET_INTEGRITY_FAILED"
  | "ASSET_CHANGED"
  | "INVALID_RANGE";

export class RealJobMediaError extends Error {
  constructor(
    readonly code: RealJobMediaErrorCode,
    readonly fileSize?: number,
  ) {
    super(code);
    this.name = "RealJobMediaError";
  }
}

export type HashBoundAsset = Readonly<{
  path: string;
  root: string;
  expectedSha256: string;
  maxBytes: number;
  contentType: string;
  disposition: "inline" | `attachment; filename="${string}"`;
}>;

type PositionedReader = Readonly<{
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}>;

type FileFingerprint = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

export async function readExactPositioned(
  reader: PositionedReader,
  target: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < target.byteLength) {
    const { bytesRead } = await reader.read(
      target,
      offset,
      target.byteLength - offset,
      position + offset,
    );
    if (
      !Number.isSafeInteger(bytesRead) ||
      bytesRead <= 0 ||
      bytesRead > target.byteLength - offset
    ) {
      throw new RealJobMediaError("ASSET_CHANGED");
    }
    offset += bytesRead;
  }
}

export function parseSingleByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | undefined {
  if (header === undefined) return undefined;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RealJobMediaError("INVALID_RANGE", size);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) {
    throw new RealJobMediaError("INVALID_RANGE", size);
  }
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new RealJobMediaError("INVALID_RANGE", size);
    }
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start >= size ||
    requestedEnd < start
  ) {
    throw new RealJobMediaError("INVALID_RANGE", size);
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export async function createHashBoundMediaResponse(
  asset: HashBoundAsset,
  rangeHeader: string | undefined,
): Promise<Response> {
  const opened = await openVerifiedAsset(asset);
  let handedToStream = false;
  try {
    const range = parseSingleByteRange(rangeHeader, opened.size);
    const start = range?.start ?? 0;
    const end = range?.end ?? opened.size - 1;
    const contentLength = end - start + 1;
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Disposition": asset.disposition,
      "Content-Length": String(contentLength),
      "Content-Type": asset.contentType,
      "X-Content-Type-Options": "nosniff",
    });
    if (range) {
      headers.set(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${opened.size}`,
      );
    }
    const body = streamDescriptor(
      opened.handle,
      opened.fingerprint,
      start,
      end,
    );
    handedToStream = true;
    return new Response(body, { status: range ? 206 : 200, headers });
  } finally {
    if (!handedToStream) {
      await opened.handle.close().catch(() => undefined);
    }
  }
}

export async function readHashBoundJson(input: {
  path: string;
  root: string;
  maxBytes: number;
  expectedSha256?: string;
}): Promise<{ json: unknown; sha256: string; size: number }> {
  const opened = await openOwnedRegularFile(
    input.root,
    input.path,
    input.maxBytes,
  );
  try {
    const bytes = new Uint8Array(opened.size);
    await readExactPositioned(opened.handle, bytes, 0);
    const afterRead = await fingerprint(opened.handle);
    if (!sameFingerprint(opened.fingerprint, afterRead)) {
      throw new RealJobMediaError("ASSET_CHANGED");
    }
    const digest = sha256(bytes);
    if (input.expectedSha256 && digest !== input.expectedSha256) {
      throw new RealJobMediaError("ASSET_INTEGRITY_FAILED");
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new RealJobMediaError("ASSET_INTEGRITY_FAILED");
    }
    return { json, sha256: digest, size: opened.size };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function openVerifiedAsset(asset: HashBoundAsset): Promise<{
  handle: FileHandle;
  size: number;
  fingerprint: FileFingerprint;
}> {
  const opened = await openOwnedRegularFile(
    asset.root,
    asset.path,
    asset.maxBytes,
  );
  try {
    const digest = await hashDescriptor(opened.handle, opened.size);
    const afterHash = await fingerprint(opened.handle);
    if (!sameFingerprint(opened.fingerprint, afterHash)) {
      throw new RealJobMediaError("ASSET_CHANGED");
    }
    if (digest !== asset.expectedSha256) {
      throw new RealJobMediaError("ASSET_INTEGRITY_FAILED");
    }
    return opened;
  } catch (error) {
    await opened.handle.close().catch(() => undefined);
    throw error;
  }
}

async function openOwnedRegularFile(
  rawRoot: string,
  rawPath: string,
  maxBytes: number,
): Promise<{
  handle: FileHandle;
  size: number;
  fingerprint: FileFingerprint;
}> {
  const root = resolve(rawRoot);
  const path = resolve(rawPath);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RealJobMediaError("UNSAFE_ASSET");
  }
  await assertNoSymlinkComponents(root, path);
  let handle: FileHandle;
  try {
    const noFollow =
      typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new RealJobMediaError("ASSET_NOT_AVAILABLE");
    }
    if (isNodeError(error, "ELOOP")) {
      throw new RealJobMediaError("UNSAFE_ASSET");
    }
    throw error;
  }
  try {
    const observed = await fingerprint(handle);
    const pathFacts = await lstat(path, { bigint: true });
    if (
      !pathFacts.isFile() ||
      pathFacts.isSymbolicLink() ||
      pathFacts.dev !== observed.dev ||
      pathFacts.ino !== observed.ino
    ) {
      throw new RealJobMediaError("UNSAFE_ASSET");
    }
    const [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(root),
      realpath(path),
    ]);
    if (!isWithin(canonicalRoot, canonicalPath)) {
      throw new RealJobMediaError("UNSAFE_ASSET");
    }
    const size = Number(observed.size);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new RealJobMediaError("UNSAFE_ASSET");
    }
    if (size > maxBytes) {
      throw new RealJobMediaError("ASSET_TOO_LARGE");
    }
    return { handle, size, fingerprint: observed };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertNoSymlinkComponents(
  root: string,
  path: string,
): Promise<void> {
  const traversal = relative(root, path);
  if (
    traversal === "" ||
    traversal === ".." ||
    traversal.startsWith(`..${sep}`) ||
    isAbsolute(traversal)
  ) {
    throw new RealJobMediaError("UNSAFE_ASSET");
  }
  let current = root;
  try {
    const rootFacts = await lstat(root);
    if (!rootFacts.isDirectory() || rootFacts.isSymbolicLink()) {
      throw new RealJobMediaError("UNSAFE_ASSET");
    }
    for (const component of traversal.split(sep)) {
      current = resolve(current, component);
      const facts = await lstat(current);
      if (facts.isSymbolicLink()) {
        throw new RealJobMediaError("UNSAFE_ASSET");
      }
    }
  } catch (error) {
    if (error instanceof RealJobMediaError) throw error;
    if (isNodeError(error, "ENOENT")) {
      throw new RealJobMediaError("ASSET_NOT_AVAILABLE");
    }
    throw error;
  }
}

async function fingerprint(handle: FileHandle): Promise<FileFingerprint> {
  const facts = await handle.stat({ bigint: true });
  if (!facts.isFile()) {
    throw new RealJobMediaError("UNSAFE_ASSET");
  }
  return {
    dev: facts.dev,
    ino: facts.ino,
    size: facts.size,
    mtimeNs: facts.mtimeNs,
    ctimeNs: facts.ctimeNs,
  };
}

function sameFingerprint(
  left: FileFingerprint,
  right: FileFingerprint,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function hashDescriptor(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  let position = 0;
  while (position < size) {
    const chunk = new Uint8Array(Math.min(STREAM_CHUNK_BYTES, size - position));
    await readExactPositioned(handle, chunk, position);
    hash.update(chunk);
    position += chunk.byteLength;
  }
  return hash.digest("hex");
}

function streamDescriptor(
  handle: FileHandle,
  expectedFingerprint: FileFingerprint,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  let position = start;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (position > end) {
          const finalFingerprint = await fingerprint(handle);
          if (!sameFingerprint(expectedFingerprint, finalFingerprint)) {
            throw new RealJobMediaError("ASSET_CHANGED");
          }
          await close();
          controller.close();
          return;
        }
        const chunk = new Uint8Array(
          Math.min(STREAM_CHUNK_BYTES, end - position + 1),
        );
        await readExactPositioned(handle, chunk, position);
        position += chunk.byteLength;
        controller.enqueue(chunk);
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
    async cancel() {
      await close();
    },
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const traversal = relative(root, candidate);
  return (
    traversal === "" ||
    (!traversal.startsWith(`..${sep}`) &&
      traversal !== ".." &&
      !isAbsolute(traversal))
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
