import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalZipError,
  validateCanonicalStoredZip,
} from "./canonical-zip";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("canonical stored ZIP validator", () => {
  it("accepts the exact 121-frame archive emitted by the Python exporter", async () => {
    const root = await mkdtemp(join(tmpdir(), "framelock-python-zip-"));
    roots.push(root);
    const python = join(process.cwd(), ".venv", "bin", "python");
    const helper = join(
      process.cwd(),
      "tests",
      "helpers",
      "export_canonical_zip_fixture.py",
    );
    const result = spawnSync(python, [helper, root], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        PYTHONPATH: join(process.cwd(), "src"),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const fixture = JSON.parse(
      await readFile(join(root, "fixture.json"), "utf8"),
    ) as {
      archivePath: string;
      frames: Array<{ archivePath: string; fileSha256: string }>;
      totalUncompressedBytes: number;
    };

    await expect(
      validateCanonicalStoredZip({
        archivePath: fixture.archivePath,
        frames: fixture.frames,
        totalUncompressedBytes: fixture.totalUncompressedBytes,
      }),
    ).resolves.toBeUndefined();
    expect(fixture.frames).toHaveLength(121);
  });

  it("accepts one exact ordered stored sequence", async () => {
    const fixture = await zipFixture([
      ["canonical_frames/frame_000000.png", Buffer.from("frame-zero")],
      ["canonical_frames/frame_000001.png", Buffer.from("frame-one")],
    ]);

    await expect(
      validateCanonicalStoredZip({
        archivePath: fixture.path,
        frames: fixture.frames,
        totalUncompressedBytes: fixture.total,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["plain bytes", async (fixture: Awaited<ReturnType<typeof zipFixture>>) => {
      await writeFile(fixture.path, "not a zip");
    }],
    ["tampered frame bytes", async (fixture: Awaited<ReturnType<typeof zipFixture>>) => {
      const bytes = Buffer.from(await import("node:fs/promises").then((fs) => fs.readFile(fixture.path)));
      bytes[fixture.firstDataOffset] ^= 1;
      await writeFile(fixture.path, bytes);
    }],
    ["unmanifested extra entry", async (fixture: Awaited<ReturnType<typeof zipFixture>>) => {
      await writeFile(
        fixture.path,
        buildStoredZip([
          ["canonical_frames/frame_000000.png", Buffer.from("frame-zero")],
          ["canonical_frames/frame_000001.png", Buffer.from("frame-one")],
          ["canonical_frames/hidden.png", Buffer.from("hidden")],
        ]).bytes,
      );
    }],
  ])("rejects %s", async (_label, mutate) => {
    const fixture = await zipFixture([
      ["canonical_frames/frame_000000.png", Buffer.from("frame-zero")],
      ["canonical_frames/frame_000001.png", Buffer.from("frame-one")],
    ]);
    await mutate(fixture);

    await expect(
      validateCanonicalStoredZip({
        archivePath: fixture.path,
        frames: fixture.frames,
        totalUncompressedBytes: fixture.total,
      }),
    ).rejects.toBeInstanceOf(CanonicalZipError);
  });
});

async function zipFixture(entries: readonly (readonly [string, Buffer])[]) {
  const root = await mkdtemp(join(tmpdir(), "framelock-canonical-zip-"));
  roots.push(root);
  const path = join(root, "canonical_frames.zip");
  const archive = buildStoredZip(entries);
  await writeFile(path, archive.bytes);
  return {
    path,
    firstDataOffset: archive.firstDataOffset,
    frames: entries.map(([archivePath, bytes]) => ({
      archivePath,
      fileSha256: sha256(bytes),
    })),
    total: entries.reduce((total, [, bytes]) => total + bytes.length, 0),
  };
}

function buildStoredZip(entries: readonly (readonly [string, Buffer])[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  let firstDataOffset = 0;
  entries.forEach(([name, data], index) => {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    if (index === 0) firstDataOffset = localOffset + 30 + nameBytes.length;
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  });
  const centralOffset = localOffset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return { bytes: Buffer.concat([...localParts, ...centralParts, end]), firstDataOffset };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});
