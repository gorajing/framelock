import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_HEADER_BYTES = 22;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const MAX_END_SEARCH_BYTES = 65_535 + END_HEADER_BYTES;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x21;

export class CanonicalZipError extends Error {
  constructor() {
    super("INVALID_CANONICAL_ZIP");
    this.name = "CanonicalZipError";
  }
}

export type CanonicalZipFrame = Readonly<{
  archivePath: string;
  fileSha256: string;
}>;

export async function validateCanonicalStoredZip(input: {
  archivePath: string;
  frames: readonly CanonicalZipFrame[];
  totalUncompressedBytes: number;
}): Promise<void> {
  if (
    input.frames.length === 0 ||
    !Number.isSafeInteger(input.totalUncompressedBytes) ||
    input.totalUncompressedBytes <= 0 ||
    new Set(input.frames.map((frame) => frame.archivePath)).size !==
      input.frames.length
  ) {
    throw new CanonicalZipError();
  }
  const handle = await open(input.archivePath, "r");
  try {
    const facts = await handle.stat();
    if (
      !facts.isFile() ||
      !Number.isSafeInteger(facts.size) ||
      facts.size < END_HEADER_BYTES ||
      facts.size > MAX_ARCHIVE_BYTES
    ) {
      throw new CanonicalZipError();
    }
    const end = await readEndRecord(handle, facts.size);
    if (
      end.entryCount !== input.frames.length ||
      end.centralOffset + end.centralSize !== end.offset
    ) {
      throw new CanonicalZipError();
    }

    let centralPosition = end.centralOffset;
    let expectedLocalOffset = 0;
    let totalUncompressedBytes = 0;
    for (let index = 0; index < input.frames.length; index += 1) {
      const expected = input.frames[index];
      const central = await readCentralRecord(handle, centralPosition);
      if (
        central.name !== expected.archivePath ||
        central.localOffset !== expectedLocalOffset ||
        central.compression !== 0 ||
        central.flags !== 0 ||
        central.dosTime !== FIXED_DOS_TIME ||
        central.dosDate !== FIXED_DOS_DATE ||
        central.compressedSize !== central.uncompressedSize ||
        central.extraLength !== 0 ||
        central.commentLength !== 0 ||
        central.diskStart !== 0
      ) {
        throw new CanonicalZipError();
      }
      const local = await readLocalRecord(handle, central.localOffset);
      if (
        local.name !== central.name ||
        local.flags !== central.flags ||
        local.compression !== central.compression ||
        local.dosTime !== central.dosTime ||
        local.dosDate !== central.dosDate ||
        local.crc32 !== central.crc32 ||
        local.compressedSize !== central.compressedSize ||
        local.uncompressedSize !== central.uncompressedSize ||
        local.extraLength !== 0 ||
        local.dataOffset + local.compressedSize > end.centralOffset
      ) {
        throw new CanonicalZipError();
      }
      const observed = await hashStoredEntry(
        handle,
        local.dataOffset,
        local.uncompressedSize,
      );
      if (
        observed.sha256 !== expected.fileSha256 ||
        observed.crc32 !== central.crc32
      ) {
        throw new CanonicalZipError();
      }
      expectedLocalOffset = local.dataOffset + local.compressedSize;
      centralPosition += central.recordSize;
      totalUncompressedBytes += local.uncompressedSize;
    }
    if (
      expectedLocalOffset !== end.centralOffset ||
      centralPosition !== end.centralOffset + end.centralSize ||
      totalUncompressedBytes !== input.totalUncompressedBytes
    ) {
      throw new CanonicalZipError();
    }
  } catch (error) {
    if (error instanceof CanonicalZipError) throw error;
    throw new CanonicalZipError();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readEndRecord(handle: FileHandle, size: number) {
  const searchSize = Math.min(size, MAX_END_SEARCH_BYTES);
  const searchOffset = size - searchSize;
  const tail = await readExactly(handle, searchOffset, searchSize);
  let relativeOffset = -1;
  for (let index = tail.length - END_HEADER_BYTES; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === END_SIGNATURE) {
      relativeOffset = index;
      break;
    }
  }
  if (relativeOffset < 0) throw new CanonicalZipError();
  const offset = searchOffset + relativeOffset;
  const commentLength = tail.readUInt16LE(relativeOffset + 20);
  const disk = tail.readUInt16LE(relativeOffset + 4);
  const centralDisk = tail.readUInt16LE(relativeOffset + 6);
  const diskEntries = tail.readUInt16LE(relativeOffset + 8);
  const entryCount = tail.readUInt16LE(relativeOffset + 10);
  if (
    offset + END_HEADER_BYTES + commentLength !== size ||
    commentLength !== 0 ||
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount
  ) {
    throw new CanonicalZipError();
  }
  return {
    offset,
    entryCount,
    centralSize: tail.readUInt32LE(relativeOffset + 12),
    centralOffset: tail.readUInt32LE(relativeOffset + 16),
  };
}

async function readCentralRecord(handle: FileHandle, position: number) {
  const header = await readExactly(handle, position, CENTRAL_HEADER_BYTES);
  if (header.readUInt32LE(0) !== CENTRAL_SIGNATURE) {
    throw new CanonicalZipError();
  }
  const nameLength = header.readUInt16LE(28);
  const extraLength = header.readUInt16LE(30);
  const commentLength = header.readUInt16LE(32);
  const name = decodeName(
    await readExactly(handle, position + CENTRAL_HEADER_BYTES, nameLength),
  );
  return {
    name,
    flags: header.readUInt16LE(8),
    compression: header.readUInt16LE(10),
    dosTime: header.readUInt16LE(12),
    dosDate: header.readUInt16LE(14),
    crc32: header.readUInt32LE(16),
    compressedSize: header.readUInt32LE(20),
    uncompressedSize: header.readUInt32LE(24),
    extraLength,
    commentLength,
    diskStart: header.readUInt16LE(34),
    localOffset: header.readUInt32LE(42),
    recordSize:
      CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength,
  };
}

async function readLocalRecord(handle: FileHandle, position: number) {
  const header = await readExactly(handle, position, LOCAL_HEADER_BYTES);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new CanonicalZipError();
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const name = decodeName(
    await readExactly(handle, position + LOCAL_HEADER_BYTES, nameLength),
  );
  return {
    name,
    flags: header.readUInt16LE(6),
    compression: header.readUInt16LE(8),
    dosTime: header.readUInt16LE(10),
    dosDate: header.readUInt16LE(12),
    crc32: header.readUInt32LE(14),
    compressedSize: header.readUInt32LE(18),
    uncompressedSize: header.readUInt32LE(22),
    extraLength,
    dataOffset: position + LOCAL_HEADER_BYTES + nameLength + extraLength,
  };
}

async function hashStoredEntry(
  handle: FileHandle,
  position: number,
  size: number,
): Promise<{ sha256: string; crc32: number }> {
  const hash = createHash("sha256");
  let crc = 0xffffffff;
  let consumed = 0;
  while (consumed < size) {
    const bytes = await readExactly(
      handle,
      position + consumed,
      Math.min(HASH_CHUNK_BYTES, size - consumed),
    );
    hash.update(bytes);
    for (const byte of bytes) {
      crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    consumed += bytes.length;
  }
  return { sha256: hash.digest("hex"), crc32: (crc ^ 0xffffffff) >>> 0 };
}

async function readExactly(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || position < 0 || length < 0) {
    throw new CanonicalZipError();
  }
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesRead <= 0) throw new CanonicalZipError();
    offset += bytesRead;
  }
  return buffer;
}

function decodeName(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CanonicalZipError();
  }
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});
