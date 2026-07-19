import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { embeddedCanonicalJsonSha256 } from "../demo/canonical-json";
import type { LocalJobRecord } from "./local-job-store";
import {
  parseSingleByteRange,
  resolveRealJobAsset,
} from "./real-job-media";
import {
  createHashBoundMediaResponse,
  RealJobMediaError,
} from "./real-job-media-stream";

const ENDPOINT = "fal-ai/kling-video/o3/standard/video-to-video/edit";
const DIGEST = "d".repeat(64);
const REQUEST_ID = "request-media-001";

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function put(path: string, body: string | Uint8Array): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return sha256(body);
}

async function putJson(path: string, payload: unknown): Promise<string> {
  return put(path, `${JSON.stringify(payload, null, 2)}\n`);
}

async function fixture(jobId = "real_media_001") {
  const root = await mkdtemp(join(tmpdir(), "framelock-media-route-"));
  const jobsRoot = join(root, "jobs");
  const runsRoot = join(root, "runs");
  const jobRoot = join(jobsRoot, jobId);
  const runRoot = join(runsRoot, jobId);
  const canonicalRoot = join(jobRoot, "canonical");
  const sourcePath = join(runRoot, "inputs", "source.mp4");
  const maskPath = join(runRoot, "inputs", "foreground.png");
  const generatedPath = join(jobRoot, "model-output.mp4");
  const sourceSha256 = await put(sourcePath, "source-video");
  const maskSha256 = await put(maskPath, "foreground-mask");
  const generatedSha256 = await put(generatedPath, "generated-video");

  const overlays = [0, 60, 120] as const;
  const overlayEntries = await Promise.all(
    overlays.map(async (index) => {
      const path = join(
        canonicalRoot,
        "geometry_overlays",
        `overlay_${String(index).padStart(6, "0")}.png`,
      );
      return {
        source_index: index,
        path,
        sha256: await put(path, `overlay-${index}`),
      };
    }),
  );

  const reviewManifestPath = join(canonicalRoot, "review_manifest.json");
  const reviewManifest = {
    schema_version: 2,
    job: {
      id: jobId,
      endpoint: ENDPOINT,
      request_id: REQUEST_ID,
      generation_digest: DIGEST,
      source_sha256: sourceSha256,
      restoration_mask_sha256: maskSha256,
      model_output_sha256: generatedSha256,
    },
    prepared_foreground_mask: { path: maskPath, sha256: maskSha256 },
    generated_decode_provenance: {
      source_media_path: generatedPath,
      source_file_sha256: generatedSha256,
    },
    geometry_overlays: overlayEntries,
    digest_sha256: "",
  };
  reviewManifest.digest_sha256 = embeddedCanonicalJsonSha256(reviewManifest);
  await putJson(reviewManifestPath, reviewManifest);

  const sourceFramePath = join(
    runRoot,
    "proof",
    "source_frames",
    "frame_000060.png",
  );
  const generatedFramePath = join(
    canonicalRoot,
    "generated_frames",
    "frame_000060.png",
  );
  const compositeFramePath = join(
    canonicalRoot,
    "composite_frames",
    "composite_000060.png",
  );
  const sourceFrameSha256 = await put(sourceFramePath, "source-frame-60");
  const generatedFrameSha256 = await put(
    generatedFramePath,
    "generated-frame-60",
  );
  const compositeFrameSha256 = await put(
    compositeFramePath,
    "composite-frame-60",
  );
  const protectedCorePath = join(
    runRoot,
    "proof",
    "masks",
    "protected_core.png",
  );
  const boundaryRingPath = join(
    runRoot,
    "proof",
    "masks",
    "feather_boundary.png",
  );
  const coreMaskFramePath = join(
    runRoot,
    "proof",
    "core_masks",
    "core_000060.png",
  );
  const differenceHeatmapPath = join(
    canonicalRoot,
    "difference_heatmap_000060.png",
  );
  const protectedCoreSha256 = await put(protectedCorePath, "protected-core-60");
  await put(coreMaskFramePath, "protected-core-60");
  const boundaryRingSha256 = await put(boundaryRingPath, "boundary-ring-60");
  const differenceHeatmapSha256 = await put(
    differenceHeatmapPath,
    "difference-heatmap-60",
  );
  const proofManifestPath = join(canonicalRoot, "proof_manifest.json");
  const proofManifest = {
    schema_version: 2,
    generation_binding: {
      prepared_foreground_mask_path: maskPath,
      prepared_foreground_mask_file_sha256: maskSha256,
      generated_media_provenance: {
        source_media_path: generatedPath,
        source_file_sha256: generatedSha256,
      },
    },
    frames: Array.from({ length: 121 }, (_, index) => {
      const suffix = String(index).padStart(6, "0");
      return {
        index,
        source_path: join(
          runRoot,
          "proof",
          "source_frames",
          `frame_${suffix}.png`,
        ),
        generated_path: join(
          canonicalRoot,
          "generated_frames",
          `frame_${suffix}.png`,
        ),
        composite_path: join(
          canonicalRoot,
          "composite_frames",
          `composite_${suffix}.png`,
        ),
        core_mask_path: join(
          runRoot,
          "proof",
          "core_masks",
          `core_${suffix}.png`,
        ),
        source_file_sha256:
          index === 60 ? sourceFrameSha256 : "1".repeat(64),
        generated_file_sha256:
          index === 60 ? generatedFrameSha256 : "2".repeat(64),
        composite_file_sha256:
          index === 60 ? compositeFrameSha256 : "3".repeat(64),
        core_mask_file_sha256:
          index === 60 ? protectedCoreSha256 : "4".repeat(64),
      };
    }),
  };
  const proofManifestSha256 = await putJson(proofManifestPath, proofManifest);

  const auditPath = join(canonicalRoot, "audit.json");
  const previewPath = join(canonicalRoot, "preview.mp4");
  const canonicalArchivePath = join(canonicalRoot, "canonical_frames.zip");
  const canonicalExportManifestPath = join(
    canonicalRoot,
    "canonical_frames_manifest.json",
  );
  const auditSha256 = await put(auditPath, "verified-audit");
  const previewSha256 = await put(previewPath, "verified-preview");
  const canonicalArchiveSha256 = await put(
    canonicalArchivePath,
    "canonical-zip",
  );
  const canonicalExportManifestSha256 = await put(
    canonicalExportManifestPath,
    "canonical-export-manifest",
  );

  const corruptionRoot = join(canonicalRoot, "corruption_fixture");
  const corruptedFramePath = join(
    corruptionRoot,
    "corrupted_composite_000060.png",
  );
  const corruptionManifestPath = join(
    corruptionRoot,
    "corruption_manifest.json",
  );
  const corruptionAuditPath = join(corruptionRoot, "corruption_audit.json");
  const corruptionSummaryPath = join(
    corruptionRoot,
    "corruption_summary.json",
  );
  const corruptedFrameSha256 = await put(
    corruptedFramePath,
    "corrupted-frame-60",
  );
  const corruptionManifestSha256 = await putJson(corruptionManifestPath, {
    frames: Array.from({ length: 121 }, (_, index) => ({
      index,
      composite_path:
        index === 60
          ? corruptedFramePath
          : join(
              canonicalRoot,
              "composite_frames",
              `composite_${String(index).padStart(6, "0")}.png`,
            ),
      composite_file_sha256:
        index === 60 ? corruptedFrameSha256 : "4".repeat(64),
    })),
  });
  const corruptionAuditSha256 = await put(
    corruptionAuditPath,
    "corruption-audit",
  );
  const corruptionSummarySha256 = await put(
    corruptionSummaryPath,
    "corruption-summary",
  );

  const runManifestPath = join(canonicalRoot, "run_manifest.json");
  const runManifest = {
    schema_version: 5,
    job: {
      id: jobId,
      endpoint: ENDPOINT,
      request_id: REQUEST_ID,
      generation_digest: DIGEST,
      source_sha256: sourceSha256,
      restoration_mask_sha256: maskSha256,
      model_output_sha256: generatedSha256,
    },
    visual_geometry_approval: {
      reviewed_source_indices: [0, 60, 120],
      reviewed_overlay_sha256s: overlayEntries.map((entry) => entry.sha256),
    },
    proof: {
      manifest_path: proofManifestPath,
      manifest_sha256: proofManifestSha256,
      audit_path: auditPath,
      audit_sha256: auditSha256,
    },
    preview: { path: previewPath, sha256: previewSha256 },
    exports: {
      canonical_frames: {
        archive_path: canonicalArchivePath,
        archive_sha256: canonicalArchiveSha256,
        manifest_path: canonicalExportManifestPath,
        manifest_sha256: canonicalExportManifestSha256,
      },
    },
    visualizations: {
      protected_core_frame_60: {
        path: protectedCorePath,
        sha256: protectedCoreSha256,
        claim_scope: "exactness_contract_mask",
      },
      boundary_ring_frame_60: {
        path: boundaryRingPath,
        sha256: boundaryRingSha256,
        claim_scope: "visual_only_not_exactness_contract",
      },
      difference_heatmap_frame_60: {
        path: differenceHeatmapPath,
        sha256: differenceHeatmapSha256,
        source_file_sha256: sourceFrameSha256,
        composite_file_sha256: compositeFrameSha256,
        claim_scope: "visual_only_not_verifier_output",
      },
    },
    negative_test: {
      manifest_path: corruptionManifestPath,
      manifest_sha256: corruptionManifestSha256,
      audit_path: corruptionAuditPath,
      audit_sha256: corruptionAuditSha256,
      summary_path: corruptionSummaryPath,
      summary_sha256: corruptionSummarySha256,
    },
    digest_sha256: "",
  };
  runManifest.digest_sha256 = embeddedCanonicalJsonSha256(runManifest);
  const runManifestSha256 = await putJson(runManifestPath, runManifest);

  const generatedRecord: LocalJobRecord = {
    id: jobId,
    state: "generated",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:01:00.000Z",
    generation: {
      sourceSha256,
      editMaskSha256: maskSha256,
      prompt: "Transform the exterior while preserving the protected core.",
      endpoint: ENDPOINT,
      parameters: {},
      digest: DIGEST,
    },
    fal: {
      generationDigest: DIGEST,
      endpoint: ENDPOINT,
      requestId: REQUEST_ID,
      modelOutput: {
        artifactId: `sha256:${generatedSha256}`,
        sha256: generatedSha256,
        url: "https://example.test/generated.mp4",
        contentType: "video/mp4",
      },
    },
  };
  const verifiedRecord: LocalJobRecord = {
    ...generatedRecord,
    state: "verified",
    assessment: { verdict: "comparable", sha256: "a".repeat(64) },
    composition: { proofManifestSha256 },
    verification: {
      claim: "Protected core verified — canonical pre-encode frame sequence.",
      auditSha256,
      runManifestSha256,
      previewSha256,
      framesAudited: 121,
      framesWithNonEmptyCore: 121,
      totalCorePixels: 1,
      changedCoreChannelSamples: 0,
      worstMaxChannelDelta: 0,
      coreHashMatchCount: 121,
      stage: "canonical_pre_encode",
    },
  };
  return {
    jobsRoot,
    runsRoot,
    jobId,
    jobRoot,
    canonicalRoot,
    generatedRecord,
    verifiedRecord,
    paths: {
      auditPath,
      proofManifestPath,
      runManifestPath,
      canonicalArchivePath,
      protectedCorePath,
      boundaryRingPath,
      differenceHeatmapPath,
    },
    hashes: {
      sourceSha256,
      overlay60Sha256: overlayEntries[1].sha256,
      sourceFrameSha256,
      generatedFrameSha256,
      compositeFrameSha256,
      canonicalArchiveSha256,
      corruptionManifestSha256,
      corruptedFrameSha256,
      protectedCoreSha256,
      boundaryRingSha256,
      differenceHeatmapSha256,
    },
  };
}

type MediaFixture = Awaited<ReturnType<typeof fixture>>;

type MutableRunManifest = Record<string, unknown> & {
  schema_version: number;
  digest_sha256: string;
  audio?: Record<string, unknown>;
};

function sourceAudioBinding(roots: MediaFixture) {
  return {
    manifest_path: join(
      roots.runsRoot,
      roots.jobId,
      "proof",
      "source_audio.json",
    ),
    manifest_sha256: "5".repeat(64),
    source_audio_present: true,
    normalized_audio_path: join(
      roots.runsRoot,
      roots.jobId,
      "proof",
      "source_audio.wav",
    ),
    normalized_audio_sha256: "6".repeat(64),
    normalization_operation:
      "resample_stereo_then_pad_and_trim_to_242000_samples",
    target_sample_count: 242_000,
    preview_audio_policy: "normalized_source_pcm_delivery_encode",
    claim_scope: "outside_pixel_verification_claim",
  };
}

async function reanchorRunManifest(
  roots: MediaFixture,
  mutate: (manifest: MutableRunManifest) => void,
): Promise<LocalJobRecord> {
  const manifest = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(roots.paths.runManifestPath, "utf8"),
    ),
  ) as MutableRunManifest;
  mutate(manifest);
  manifest.digest_sha256 = embeddedCanonicalJsonSha256(manifest);
  const runManifestSha256 = await putJson(
    roots.paths.runManifestPath,
    manifest,
  );
  return {
    ...roots.verifiedRecord,
    verification: {
      ...roots.verifiedRecord.verification!,
      runManifestSha256,
    },
  };
}

describe("real job media trust chain", () => {
  it("accepts run schema v5 only when no audio binding is present", async () => {
    const roots = await fixture();

    await expect(
      resolveRealJobAsset({
        ...roots,
        record: roots.verifiedRecord,
        asset: "canonical-frames",
      }),
    ).resolves.toMatchObject({
      expectedSha256: roots.hashes.canonicalArchiveSha256,
    });
  });

  it("accepts run schema v6 when its source-audio binding is present", async () => {
    const roots = await fixture();
    const record = await reanchorRunManifest(roots, (manifest) => {
      manifest.schema_version = 6;
      manifest.audio = sourceAudioBinding(roots);
    });

    await expect(
      resolveRealJobAsset({
        ...roots,
        record,
        asset: "canonical-frames",
      }),
    ).resolves.toMatchObject({
      expectedSha256: roots.hashes.canonicalArchiveSha256,
    });
  });

  it("rejects run schema v6 when its source-audio binding is missing", async () => {
    const roots = await fixture();
    const record = await reanchorRunManifest(roots, (manifest) => {
      manifest.schema_version = 6;
      delete manifest.audio;
    });

    await expect(
      resolveRealJobAsset({
        ...roots,
        record,
        asset: "canonical-frames",
      }),
    ).rejects.toMatchObject({ code: "ASSET_INTEGRITY_FAILED" });
  });

  it("rejects run schema v5 when an audio binding is present", async () => {
    const roots = await fixture();
    const record = await reanchorRunManifest(roots, (manifest) => {
      manifest.audio = sourceAudioBinding(roots);
    });

    await expect(
      resolveRealJobAsset({
        ...roots,
        record,
        asset: "canonical-frames",
      }),
    ).rejects.toMatchObject({ code: "ASSET_INTEGRITY_FAILED" });
  });

  it("binds direct source, generated and verified proof assets to the job record", async () => {
    const roots = await fixture();
    const source = await resolveRealJobAsset({
      ...roots,
      record: roots.generatedRecord,
      asset: "source",
    });
    const generated = await resolveRealJobAsset({
      ...roots,
      record: roots.generatedRecord,
      asset: "generated",
    });
    const audit = await resolveRealJobAsset({
      ...roots,
      record: roots.verifiedRecord,
      asset: "audit",
    });

    expect(source.expectedSha256).toBe(roots.hashes.sourceSha256);
    expect(generated.expectedSha256).toBe(
      roots.generatedRecord.fal?.modelOutput?.sha256,
    );
    expect(audit.expectedSha256).toBe(
      roots.verifiedRecord.verification?.auditSha256,
    );
  });

  it("allows only self-digested, record-bound overlays before verification", async () => {
    const roots = await fixture();
    const overlay = await resolveRealJobAsset({
      ...roots,
      record: roots.generatedRecord,
      asset: "overlay-60",
    });
    expect(overlay.expectedSha256).toBe(roots.hashes.overlay60Sha256);

    const reviewPath = join(roots.canonicalRoot, "review_manifest.json");
    const review = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(reviewPath, "utf8"))) as Record<string, unknown>;
    review.tampered = true;
    await putJson(reviewPath, review);
    await expect(
      resolveRealJobAsset({
        ...roots,
        record: roots.generatedRecord,
        asset: "overlay-60",
      }),
    ).rejects.toMatchObject({ code: "ASSET_INTEGRITY_FAILED" });
  });

  it("derives verified stills and overlays from record-anchored proof and run manifests", async () => {
    const roots = await fixture();
    const assets = await Promise.all(
      ["source-60", "generated-60", "composite-60", "overlay-60"].map(
        (asset) =>
          resolveRealJobAsset({
            ...roots,
            record: roots.verifiedRecord,
            asset,
          }),
      ),
    );
    expect(assets.map((asset) => asset.expectedSha256)).toEqual([
      roots.hashes.sourceFrameSha256,
      roots.hashes.generatedFrameSha256,
      roots.hashes.compositeFrameSha256,
      roots.hashes.overlay60Sha256,
    ]);
  });

  it("serves proof-bound core, boundary and deterministic heatmap assets only after verification", async () => {
    const roots = await fixture();
    const assets = await Promise.all(
      ["protected-core-60", "boundary-ring-60", "difference-heatmap-60"].map(
        (asset) =>
          resolveRealJobAsset({
            ...roots,
            record: roots.verifiedRecord,
            asset,
          }),
      ),
    );
    expect(assets.map((asset) => asset.path)).toEqual([
      roots.paths.protectedCorePath,
      roots.paths.boundaryRingPath,
      roots.paths.differenceHeatmapPath,
    ]);
    expect(assets.map((asset) => asset.expectedSha256)).toEqual([
      roots.hashes.protectedCoreSha256,
      roots.hashes.boundaryRingSha256,
      roots.hashes.differenceHeatmapSha256,
    ]);
    expect(
      await Promise.all(
        assets.map(async (asset) =>
          (await createHashBoundMediaResponse(asset, undefined)).text(),
        ),
      ),
    ).toEqual([
      "protected-core-60",
      "boundary-ring-60",
      "difference-heatmap-60",
    ]);

    await expect(
      resolveRealJobAsset({
        ...roots,
        record: roots.generatedRecord,
        asset: "protected-core-60",
      }),
    ).rejects.toMatchObject({ code: "ASSET_NOT_AVAILABLE" });
  });

  it("rejects a re-anchored run manifest that drifts a visualization into another job", async () => {
    const roots = await fixture("real_media_primary");
    const other = await fixture("real_media_other");
    const runManifest = JSON.parse(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(roots.paths.runManifestPath, "utf8"),
      ),
    ) as {
      visualizations: {
        protected_core_frame_60: { path: string };
      };
      digest_sha256: string;
    };
    runManifest.visualizations.protected_core_frame_60.path =
      other.paths.protectedCorePath;
    runManifest.digest_sha256 = embeddedCanonicalJsonSha256(runManifest);
    const runManifestSha256 = await putJson(
      roots.paths.runManifestPath,
      runManifest,
    );
    const reanchoredRecord: LocalJobRecord = {
      ...roots.verifiedRecord,
      verification: {
        ...roots.verifiedRecord.verification!,
        runManifestSha256,
      },
    };

    await expect(
      resolveRealJobAsset({
        ...roots,
        record: reanchoredRecord,
        asset: "protected-core-60",
      }),
    ).rejects.toMatchObject({ code: "ASSET_INTEGRITY_FAILED" });
  });

  it("binds canonical ZIP and corruption evidence through the anchored run manifest", async () => {
    const roots = await fixture();
    const archive = await resolveRealJobAsset({
      ...roots,
      record: roots.verifiedRecord,
      asset: "canonical-frames",
    });
    const negativeManifest = await resolveRealJobAsset({
      ...roots,
      record: roots.verifiedRecord,
      asset: "corruption-manifest",
    });
    expect(archive.expectedSha256).toBe(roots.hashes.canonicalArchiveSha256);
    expect(negativeManifest.expectedSha256).toBe(
      roots.hashes.corruptionManifestSha256,
    );
    expect(await (await createHashBoundMediaResponse(archive, undefined)).text()).toBe(
      "canonical-zip",
    );
  });

  it("fails closed when verified bytes or their anchoring manifests are tampered", async () => {
    const targetTamper = await fixture();
    const audit = await resolveRealJobAsset({
      ...targetTamper,
      record: targetTamper.verifiedRecord,
      asset: "audit",
    });
    await writeFile(targetTamper.paths.auditPath, "tampered-audit");
    await expect(
      createHashBoundMediaResponse(audit, undefined),
    ).rejects.toMatchObject({ code: "ASSET_INTEGRITY_FAILED" });

    const runTamper = await fixture();
    await writeFile(runTamper.paths.runManifestPath, "{}");
    await expect(
      resolveRealJobAsset({
        ...runTamper,
        record: runTamper.verifiedRecord,
        asset: "canonical-frames",
      }),
    ).rejects.toMatchObject({ code: "ASSET_INTEGRITY_FAILED" });

    const proofTamper = await fixture();
    await writeFile(proofTamper.paths.proofManifestPath, "{}");
    await expect(
      resolveRealJobAsset({
        ...proofTamper,
        record: proofTamper.verifiedRecord,
        asset: "source-60",
      }),
    ).rejects.toMatchObject({ code: "ASSET_INTEGRITY_FAILED" });
  });

  it("keeps derived proof behind verification and rejects symlinked assets", async () => {
    const roots = await fixture();
    await expect(
      resolveRealJobAsset({
        ...roots,
        record: roots.generatedRecord,
        asset: "source-60",
      }),
    ).rejects.toMatchObject({ code: "ASSET_NOT_AVAILABLE" });
    await expect(
      resolveRealJobAsset({
        ...roots,
        record: roots.generatedRecord,
        asset: "../../.env.local",
      }),
    ).rejects.toBeInstanceOf(RealJobMediaError);

    const source = await resolveRealJobAsset({
      ...roots,
      record: roots.generatedRecord,
      asset: "source",
    });
    await unlink(source.path);
    const outside = join(roots.jobRoot, "outside.mp4");
    await writeFile(outside, "source-video");
    await symlink(outside, source.path);
    await expect(
      createHashBoundMediaResponse(source, undefined),
    ).rejects.toMatchObject({ code: "UNSAFE_ASSET" });
  });
});

describe("single byte ranges", () => {
  it("accepts one bounded range and rejects ambiguous requests with the size", () => {
    expect(parseSingleByteRange(undefined, 100)).toBeUndefined();
    expect(parseSingleByteRange("bytes=10-19", 100)).toEqual({
      start: 10,
      end: 19,
    });
    expect(parseSingleByteRange("bytes=90-", 100)).toEqual({
      start: 90,
      end: 99,
    });
    expect(parseSingleByteRange("bytes=-10", 100)).toEqual({
      start: 90,
      end: 99,
    });
    for (const header of [
      "items=0-1",
      "bytes=0-1,4-5",
      "bytes=100-101",
      "bytes=20-10",
      "bytes=-0",
    ]) {
      try {
        parseSingleByteRange(header, 100);
        throw new Error("expected invalid range");
      } catch (error) {
        expect(error).toMatchObject({ code: "INVALID_RANGE", fileSize: 100 });
      }
    }
  });
});
