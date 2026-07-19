import { describe, expect, it } from "vitest";

import {
  createAiJobId,
  parseRealJobWorkspaceView,
  resumableRealJobWorkspaceView,
} from "./real-job-workspace-view";

const SHA = "a".repeat(64);

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: "ai_source_01",
    state: "validated",
    endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit",
    generationDigest: SHA,
    prompt: "Move the AI product into a moonlit gallery.",
    sourceSha256: SHA,
    editMaskSha256: SHA,
    ...overrides,
  };
}

describe("read-only real job workspace view", () => {
  it("formats generated IDs with the AI-source prefix", () => {
    expect(createAiJobId("123e4567-e89b-12d3-a456-426614174000")).toBe(
      "ai_123e4567e89b12d3a456426614174000",
    );
    expect(() => createAiJobId("../escape")).toThrow();
  });

  it("keeps only the allowlisted browser-safe fields", () => {
    expect(
      parseRealJobWorkspaceView(
        view({
          filesystemPath: "/private/artifacts/source.mp4",
          sourceUploadUrl: "https://private.example/source.mp4",
        }),
      ),
    ).toEqual(view());
  });

  it("requires the frozen endpoint and exact AI-source label", () => {
    expect(() =>
      parseRealJobWorkspaceView(view({ endpoint: "fal-ai/another-model" })),
    ).toThrow();
    expect(() =>
      parseRealJobWorkspaceView(
        view({
          sourceProvenance: {
            fileSha256: SHA,
            schemaVersion: 1,
            provenanceLabel: "camera_original",
            originalImageSha256: SHA,
            sourceBundleManifestSha256: SHA,
            normalizedPlateSha256: SHA,
            canonicalSourceMp4Sha256: SHA,
            foregroundMaskSha256: SHA,
            contactSheetSha256: SHA,
            approval: {
              recordSha256: SHA,
              approvedAt: "2026-07-18T01:02:03.000Z",
              reviewer: "FrameLock executor",
              note: "Approved AI-source package.",
            },
          },
        }),
      ),
    ).toThrow();
  });

  it.each([
    "validated",
    "submitting",
    "submitted",
    "generated",
    "composited",
    "verified",
  ])(
    "resumes persisted %s state",
    (state) => {
      expect(resumableRealJobWorkspaceView(view({ state }))?.state).toBe(state);
    },
  );

  it.each(["submission_unknown", "not_comparable", "failed"])(
    "does not auto-resume terminal or incomplete %s state",
    (state) => {
      expect(resumableRealJobWorkspaceView(view({ state }))).toBeNull();
    },
  );
});
