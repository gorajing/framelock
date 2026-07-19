import { describe, expect, it } from "vitest";

import type { LocalJobRecord } from "./local-job-store";
import { buildRealJobView } from "./real-job-view";

const SHA = "a".repeat(64);
const SOURCE_PROVENANCE = {
  fileSha256: "b".repeat(64),
  manifest: {
    schemaVersion: 1 as const,
    provenanceLabel: "ai_generated_source" as const,
    originalImageSha256: "c".repeat(64),
    sourceBundleManifestSha256: "d".repeat(64),
    normalizedPlateSha256: "e".repeat(64),
    canonicalSourceMp4Sha256: SHA,
    foregroundMaskSha256: SHA,
    contactSheetSha256: "f".repeat(64),
    approval: {
      recordSha256: "1".repeat(64),
      approvedAt: "2026-07-18T01:02:03.000Z",
      reviewer: "FrameLock executor",
      note: "FRM-01 passed the frozen visual criteria.",
    },
  },
} as const;

function record(overrides: Partial<LocalJobRecord> = {}): LocalJobRecord {
  return {
    id: "real_hero_001",
    state: "validated",
    createdAt: "2026-07-17T20:00:00.000Z",
    updatedAt: "2026-07-17T20:00:00.000Z",
    generation: {
      sourceSha256: SHA,
      editMaskSha256: SHA,
      prompt: "Moonlit gallery",
      endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit",
      parameters: { keep_audio: false, shot_type: "customize" },
      digest: SHA,
    },
    ...overrides,
  };
}

describe("real job public view", () => {
  it("returns the validated digest and prompt without internal artifact paths", () => {
    expect(buildRealJobView(record())).toEqual({
      id: "real_hero_001",
      state: "validated",
      endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit",
      generationDigest: SHA,
      prompt: "Moonlit gallery",
      sourceSha256: SHA,
      editMaskSha256: SHA,
      createdAt: "2026-07-17T20:00:00.000Z",
      updatedAt: "2026-07-17T20:00:00.000Z",
    });
  });

  it("projects the safe AI-source lineage without any filesystem path", () => {
    const view = buildRealJobView(
      record({
        recordVersion: 3,
        sourceProvenance: SOURCE_PROVENANCE,
      }),
    );

    expect(view).toMatchObject({
      sourceProvenance: {
        fileSha256: SOURCE_PROVENANCE.fileSha256,
        ...SOURCE_PROVENANCE.manifest,
      },
    });
    expect(JSON.stringify(view)).not.toContain("/tmp/");
  });

  it("exposes stable failure codes but not provider errors or upload URLs", () => {
    const view = buildRealJobView(
      record({
        state: "failed",
        fal: {
          generationDigest: SHA,
          endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit",
          requestId: "request-1",
          sourceUploadUrl: "https://fal.media/private-source.mp4",
        },
        failure: {
          source: "fal_completion",
          error: "sensitive provider detail",
          errorType: "INTERNAL",
        },
      }),
    );

    expect(view).toMatchObject({
      state: "failed",
      requestId: "request-1",
      failureCode: "GENERATION_FAILED",
    });
    expect(JSON.stringify(view)).not.toContain("fal.media");
    expect(JSON.stringify(view)).not.toContain("sensitive provider detail");
  });

  it("exposes only the allowlisted canonical failure detail", () => {
    const view = buildRealJobView(
      record({
        state: "failed",
        failure: {
          source: "canonical_verification",
          code: "CANONICAL_EVIDENCE_INVALID",
          detail:
            "Committed canonical evidence failed integrity validation; no proof was promoted.",
        },
      }),
    );

    expect(view).toMatchObject({
      state: "failed",
      failureCode: "CANONICAL_EVIDENCE_INVALID",
      failureDetail:
        "Committed canonical evidence failed integrity validation; no proof was promoted.",
    });
  });
});
