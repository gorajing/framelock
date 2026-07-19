import { describe, expect, it, vi } from "vitest";

import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "../fal/kling-contract";
import { createRealJobService } from "./create-real-job";

const SOURCE_SHA = "a".repeat(64);
const MASK_SHA = "b".repeat(64);
const DIGEST = "c".repeat(64);
const PROVENANCE_FILE_SHA = "d".repeat(64);

const SOURCE_PROVENANCE = {
  schemaVersion: 1 as const,
  provenanceLabel: "ai_generated_source" as const,
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
};

function provenanceFile() {
  return new File(
    [new TextEncoder().encode(JSON.stringify(SOURCE_PROVENANCE))],
    "source-provenance.json",
    { type: "application/json" },
  );
}

function intake() {
  return {
    source: new File([new Uint8Array([1])], "source.mp4", {
      type: "video/mp4",
    }),
    foregroundMask: new File([new Uint8Array([2])], "foreground.png", {
      type: "image/png",
    }),
    sourceProvenance: provenanceFile(),
    prompt: "Place the product in a moonlit gallery.",
  };
}

function evidence() {
  return {
    state: "validated" as const,
    claim: null,
    next_step: "generation" as const,
    run_directory: "/tmp/runs/real_hero_001",
    source: "/tmp/runs/real_hero_001/inputs/source.mp4",
    source_sha256: SOURCE_SHA,
    foreground_mask: "/tmp/runs/real_hero_001/inputs/foreground.png",
    foreground_mask_sha256: MASK_SHA,
    protected_core_pixels_per_frame: 100,
    proof_manifest: "/tmp/runs/real_hero_001/proof/proof_manifest.json",
    proof_manifest_sha256: SOURCE_SHA,
    summary: "/tmp/runs/real_hero_001/source_preparation.json",
    source_provenance: {
      path: "/tmp/runs/real_hero_001/inputs/source-provenance.json",
      file_sha256: PROVENANCE_FILE_SHA,
      size_bytes: 512,
      manifest: SOURCE_PROVENANCE,
    },
  };
}

function activeJobPort(spy = vi.fn()) {
  return {
    async runWithClaim<T>(
      input: { jobId: string },
      action: () => Promise<T>,
    ): Promise<T> {
      spy(input, action);
      return action();
    },
  };
}

describe("real job creation service", () => {
  it("prepares and persists only while holding the one-active intake slot", async () => {
    const prepare = vi.fn(async () => evidence());
    const createValidatedJob = vi.fn(async (input) => ({
      id: input.id,
      state: "validated" as const,
      generation: { ...input.generation, digest: DIGEST },
    }));
    const runWithClaim = vi.fn();
    const service = createRealJobService({
      createId: () => "real_hero_001",
      artifacts: { prepare },
      jobs: { createValidatedJob },
      activeJobs: activeJobPort(runWithClaim),
    });

    const result = await service.create(intake());

    expect(prepare).toHaveBeenCalledWith({
      jobId: "real_hero_001",
      source: expect.any(File),
      foregroundMask: expect.any(File),
      sourceProvenance: expect.any(File),
    });
    expect(createValidatedJob).toHaveBeenCalledWith({
      id: "real_hero_001",
      generation: {
        sourceSha256: SOURCE_SHA,
        editMaskSha256: MASK_SHA,
        prompt: "Place the product in a moonlit gallery.",
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        parameters: {
          keep_audio: false,
          shot_type: "customize",
        },
      },
      sourceProvenance: {
        fileSha256: PROVENANCE_FILE_SHA,
        manifest: SOURCE_PROVENANCE,
      },
    });
    expect(runWithClaim).toHaveBeenCalledWith(
      { jobId: "real_hero_001" },
      expect.any(Function),
    );
    expect(result).toEqual({
      id: "real_hero_001",
      state: "validated",
      claim: null,
      nextStep: "confirm_generation",
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      generationDigest: DIGEST,
      prompt: "Place the product in a moonlit gallery.",
      sourceSha256: SOURCE_SHA,
      editMaskSha256: MASK_SHA,
      protectedCorePixelsPerFrame: 100,
      sourceProvenance: {
        fileSha256: PROVENANCE_FILE_SHA,
        ...SOURCE_PROVENANCE,
      },
    });
  });

  it("rejects an unsafe generated ID before writing uploads", async () => {
    const prepare = vi.fn();
    const service = createRealJobService({
      createId: () => "../escape",
      artifacts: { prepare },
      jobs: { createValidatedJob: vi.fn() },
      activeJobs: activeJobPort(),
    });

    await expect(service.create(intake())).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not publish a claim when preparation or persistence fails", async () => {
    const runWithClaim = vi.fn();
    const preparationFailure = createRealJobService({
      createId: () => "real_hero_001",
      artifacts: {
        async prepare() {
          throw new Error("invalid media");
        },
      },
      jobs: { createValidatedJob: vi.fn() },
      activeJobs: activeJobPort(runWithClaim),
    });
    await expect(preparationFailure.create(intake())).rejects.toThrow();
    expect(runWithClaim).toHaveBeenCalledTimes(1);

    const persistenceFailure = createRealJobService({
      createId: () => "real_hero_002",
      artifacts: { async prepare() { return evidence(); } },
      jobs: {
        async createValidatedJob() {
          throw new Error("persistence failed");
        },
      },
      activeJobs: activeJobPort(runWithClaim),
    });
    await expect(persistenceFailure.create(intake())).rejects.toThrow();
    expect(runWithClaim).toHaveBeenCalledTimes(2);
  });
});
