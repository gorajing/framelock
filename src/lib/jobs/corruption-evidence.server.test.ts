import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(),
  readJob: vi.fn(),
  validateCorruptionEvidence: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("node:fs/promises", () => ({
  lstat: mocks.lstat,
  readFile: mocks.readFile,
  realpath: mocks.realpath,
}));
vi.mock("./local-job-store", () => ({
  LocalJobStore: class {
    readJob = mocks.readJob;
  },
}));
vi.mock("./corruption-evidence", () => ({
  validateCorruptionEvidence: mocks.validateCorruptionEvidence,
}));

import { readCorruptionEvidence } from "./corruption-evidence.server";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("corruption evidence server read boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const json = Buffer.from("{}");
    const corruptedFrame = Buffer.from("actual-corrupted-frame");
    mocks.lstat.mockImplementation(async (path: string) => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: path.endsWith(".png") ? corruptedFrame.length : json.length,
    }));
    mocks.realpath.mockImplementation(async (path: string) => path);
    mocks.readFile.mockImplementation(async (path: string) =>
      path.endsWith(".png") ? corruptedFrame : json,
    );
    mocks.readJob.mockResolvedValue({
      state: "verified",
      composition: { proofManifestSha256: sha256(json) },
      verification: { runManifestSha256: sha256(json) },
    });
    mocks.validateCorruptionEvidence.mockReturnValue({
      artifactBound: false,
      summarySchemaVersion: 1,
    });
  });

  it("reads and hashes the actual corrupted PNG before validation", async () => {
    await expect(readCorruptionEvidence("motion-proof")).resolves.toEqual({
      artifactBound: false,
      summarySchemaVersion: 1,
    });

    const corruptedRead = mocks.readFile.mock.calls.find(([path]) =>
      String(path).endsWith("corrupted_composite_000060.png"),
    );
    expect(corruptedRead).toBeDefined();
    expect(mocks.validateCorruptionEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        integrity: expect.objectContaining({
          corruptedFrameSha256: sha256(
            Buffer.from("actual-corrupted-frame"),
          ),
        }),
      }),
    );
  });
});
