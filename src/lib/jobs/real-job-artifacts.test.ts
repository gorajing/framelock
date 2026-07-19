import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRealJobArtifactsPort } from "./real-job-artifacts";

const SOURCE_BYTES = new Uint8Array([1, 2, 3]);
const MASK_BYTES = new Uint8Array([4, 5]);
const SOURCE_SHA = sha256(SOURCE_BYTES);
const MASK_SHA = sha256(MASK_BYTES);
const PROOF_SHA = "a".repeat(64);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function provenanceManifest(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    schemaVersion: 1,
    provenanceLabel: "ai_generated_source",
    originalImageSha256: "10".repeat(32),
    sourceBundleManifestSha256: "20".repeat(32),
    normalizedPlateSha256: "30".repeat(32),
    canonicalSourceMp4Sha256: SOURCE_SHA,
    foregroundMaskSha256: MASK_SHA,
    contactSheetSha256: "40".repeat(32),
    approval: {
      recordSha256: "50".repeat(32),
      approvedAt: "2026-07-18T01:02:03.000Z",
      reviewer: "FrameLock executor",
      note: "FRM-01 passed the frozen visual criteria.",
    },
    ...overrides,
  };
}

function provenanceFile(
  overrides: Partial<Record<string, unknown>> = {},
): File {
  return new File(
    [new TextEncoder().encode(JSON.stringify(provenanceManifest(overrides)))],
    "source-provenance.json",
    { type: "application/json" },
  );
}

async function preparedEvidence(
  outputDirectory: string,
  overrides: { sourceSha256?: string; maskSha256?: string } = {},
) {
  const inputs = join(outputDirectory, "inputs");
  await mkdir(inputs, { recursive: true });
  return {
    state: "validated" as const,
    claim: null,
    next_step: "generation" as const,
    run_directory: outputDirectory,
    source: join(inputs, "source.mp4"),
    source_sha256: overrides.sourceSha256 ?? SOURCE_SHA,
    foreground_mask: join(inputs, "foreground.png"),
    foreground_mask_sha256: overrides.maskSha256 ?? MASK_SHA,
    protected_core_pixels_per_frame: 100,
    proof_manifest: join(outputDirectory, "proof", "proof_manifest.json"),
    proof_manifest_sha256: PROOF_SHA,
    summary: join(outputDirectory, "source_preparation.json"),
  };
}

describe("real job intake artifacts", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-real-intake-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes private staging files, invokes the fixed CLI bridge and cleans staging", async () => {
    const prepareSource = vi.fn(
      async ({ sourcePath, foregroundMaskPath, outputDirectory }) => {
        expect(await readFile(sourcePath)).toEqual(Buffer.from(SOURCE_BYTES));
        expect(await readFile(foregroundMaskPath)).toEqual(Buffer.from(MASK_BYTES));
        expect((await stat(sourcePath)).mode & 0o777).toBe(0o600);
        expect((await stat(foregroundMaskPath)).mode & 0o777).toBe(0o600);
        return preparedEvidence(outputDirectory);
      },
    );
    const port = createRealJobArtifactsPort({
      stagingRoot: join(root, "staging"),
      runsRoot: join(root, "runs"),
      createToken: () => "fixed-token",
      cli: { prepareSource },
    });

    const sourceProvenance = provenanceFile();
    const provenanceBytes = new Uint8Array(
      await sourceProvenance.arrayBuffer(),
    );
    const result = await port.prepare({
      jobId: "real_hero_001",
      source: new File([SOURCE_BYTES], "source.mp4"),
      foregroundMask: new File([MASK_BYTES], "mask.png"),
      sourceProvenance,
    });

    expect(result.run_directory).toBe(join(root, "runs", "real_hero_001"));
    expect(result.source_provenance).toEqual({
      path: join(
        root,
        "runs",
        "real_hero_001",
        "inputs",
        "source-provenance.json",
      ),
      file_sha256: sha256(provenanceBytes),
      size_bytes: provenanceBytes.byteLength,
      manifest: provenanceManifest(),
    });
    expect(await readFile(result.source_provenance.path)).toEqual(
      Buffer.from(provenanceBytes),
    );
    expect((await stat(result.source_provenance.path)).mode & 0o777).toBe(0o600);
    expect(prepareSource).toHaveBeenCalledOnce();
    expect(await readdir(join(root, "staging"))).toEqual([]);
  });

  it("refuses to overwrite provenance already persisted beside prepared inputs", async () => {
    const port = createRealJobArtifactsPort({
      stagingRoot: join(root, "staging"),
      runsRoot: join(root, "runs"),
      createToken: () => "fixed-token",
      cli: {
        async prepareSource({ outputDirectory }) {
          const evidence = await preparedEvidence(outputDirectory);
          await writeFile(
            join(outputDirectory, "inputs", "source-provenance.json"),
            "existing immutable provenance",
            { flag: "wx", mode: 0o600 },
          );
          return evidence;
        },
      },
    });

    await expect(
      port.prepare({
        jobId: "real_hero_001",
        source: new File([SOURCE_BYTES], "source.mp4"),
        foregroundMask: new File([MASK_BYTES], "mask.png"),
        sourceProvenance: provenanceFile(),
      }),
    ).rejects.toMatchObject({ code: "PROVENANCE_ALREADY_EXISTS" });
    await expect(
      readFile(
        join(
          root,
          "runs",
          "real_hero_001",
          "inputs",
          "source-provenance.json",
        ),
        "utf8",
      ),
    ).resolves.toBe("existing immutable provenance");
  });

  it("rejects source and mask disagreement before invoking the media bridge", async () => {
    const prepareSource = vi.fn();
    const port = createRealJobArtifactsPort({
      stagingRoot: join(root, "staging"),
      runsRoot: join(root, "runs"),
      createToken: () => "fixed-token",
      cli: { prepareSource },
    });

    await expect(
      port.prepare({
        jobId: "real_hero_001",
        source: new File([SOURCE_BYTES], "source.mp4"),
        foregroundMask: new File([MASK_BYTES], "mask.png"),
        sourceProvenance: provenanceFile({
          canonicalSourceMp4Sha256: "f0".repeat(32),
        }),
      }),
    ).rejects.toMatchObject({ code: "PROVENANCE_SOURCE_MISMATCH" });
    expect(prepareSource).not.toHaveBeenCalled();
  });

  it("rejects a media bridge that reports different prepared input hashes", async () => {
    const port = createRealJobArtifactsPort({
      stagingRoot: join(root, "staging"),
      runsRoot: join(root, "runs"),
      createToken: () => "fixed-token",
      cli: {
        async prepareSource({ outputDirectory }) {
          return preparedEvidence(outputDirectory, {
            maskSha256: "f1".repeat(32),
          });
        },
      },
    });

    await expect(
      port.prepare({
        jobId: "real_hero_001",
        source: new File([SOURCE_BYTES], "source.mp4"),
        foregroundMask: new File([MASK_BYTES], "mask.png"),
        sourceProvenance: provenanceFile(),
      }),
    ).rejects.toMatchObject({ code: "PROVENANCE_MASK_MISMATCH" });
    await expect(
      stat(
        join(
          root,
          "runs",
          "real_hero_001",
          "inputs",
          "source-provenance.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans private staging after CLI rejection", async () => {
    const port = createRealJobArtifactsPort({
      stagingRoot: join(root, "staging"),
      runsRoot: join(root, "runs"),
      createToken: () => "fixed-token",
      cli: {
        async prepareSource() {
          throw new Error("invalid media");
        },
      },
    });

    await expect(
      port.prepare({
        jobId: "real_hero_001",
        source: new File([SOURCE_BYTES], "source.mp4"),
        foregroundMask: new File([MASK_BYTES], "mask.png"),
        sourceProvenance: provenanceFile(),
      }),
    ).rejects.toThrow("invalid media");

    expect(await readdir(join(root, "staging"))).toEqual([]);
  });

  it("rejects path-like job IDs before creating staging files", async () => {
    const prepareSource = vi.fn();
    const port = createRealJobArtifactsPort({
      stagingRoot: join(root, "staging"),
      runsRoot: join(root, "runs"),
      cli: { prepareSource },
    });

    await expect(
      port.prepare({
        jobId: "../escape",
        source: new File([SOURCE_BYTES], "source.mp4"),
        foregroundMask: new File([MASK_BYTES], "mask.png"),
        sourceProvenance: provenanceFile(),
      }),
    ).rejects.toThrow();
    expect(prepareSource).not.toHaveBeenCalled();
  });
});
