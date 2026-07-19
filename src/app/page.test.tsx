import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readCorruptionEvidence: vi.fn(),
  readDemoSummary: vi.fn(),
  readActiveRealJob: vi.fn(),
  readVerifiedRealJobProof: vi.fn(),
  readWorkspaceRealJob: vi.fn(),
}));

vi.mock("@/lib/demo/demo-summary.server", () => ({
  readDemoSummary: mocks.readDemoSummary,
}));
vi.mock("@/lib/jobs/corruption-evidence.server", () => ({
  DEFAULT_CORRUPTION_JOB_ID: "synthetic-hero-kling-o3-001",
  readCorruptionEvidence: mocks.readCorruptionEvidence,
}));
vi.mock("@/lib/jobs/real-job-intake.server", () => ({
  readActiveRealJob: mocks.readActiveRealJob,
  readWorkspaceRealJob: mocks.readWorkspaceRealJob,
}));
vi.mock("@/lib/review/real-job-review.server", () => ({
  readVerifiedRealJobProof: mocks.readVerifiedRealJobProof,
}));

import Home from "./page";

describe("home page optional evidence boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readActiveRealJob.mockResolvedValue(null);
    mocks.readWorkspaceRealJob.mockResolvedValue(null);
  });

  it("renders the intake workspace when a fresh clone has no demo artifacts", async () => {
    mocks.readDemoSummary.mockRejectedValue(
      Object.assign(new Error("missing artifacts"), { code: "ENOENT" }),
    );

    const page = await Home({ searchParams: Promise.resolve({}) });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Create a verified reshoot.");
    expect(markup).not.toContain("Canonical verified");
    expect(markup).not.toContain("Protected core verified");
  });

  it("restores the active persisted job without invoking a mutating action", async () => {
    mocks.readDemoSummary.mockRejectedValue(new Error("no demo"));
    mocks.readActiveRealJob.mockResolvedValue({
      id: "ai_source_01",
      state: "submitted",
      endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit",
      generationDigest: "10".repeat(32),
      prompt: "Move the AI product into a moonlit gallery.",
      sourceSha256: "20".repeat(32),
      editMaskSha256: "30".repeat(32),
    });

    const page = await Home({ searchParams: Promise.resolve({}) });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("ai_source_01");
    expect(markup).toContain("Generation in progress.");
    expect(mocks.readActiveRealJob).toHaveBeenCalledOnce();
    expect(mocks.readWorkspaceRealJob).not.toHaveBeenCalled();
  });

  it("restores an interrupted composited job with an explicit no-fal recovery action", async () => {
    mocks.readDemoSummary.mockRejectedValue(new Error("no demo"));
    mocks.readActiveRealJob.mockResolvedValue({
      id: "ai_source_composited_01",
      state: "composited",
      endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit",
      generationDigest: "10".repeat(32),
      prompt: "Move the AI product into a moonlit gallery.",
      sourceSha256: "20".repeat(32),
      editMaskSha256: "30".repeat(32),
    });

    const page = await Home({ searchParams: Promise.resolve({}) });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Canonical finalization interrupted.");
    expect(markup).toContain("Resume canonical verification — no fal call");
    expect(markup).not.toContain("No result was promoted.");
  });

  it("reopens and validates the complete canonical proof for a directly requested verified job", async () => {
    mocks.readDemoSummary.mockRejectedValue(new Error("no demo"));
    mocks.readWorkspaceRealJob.mockResolvedValue({
      id: "ai_source_verified_01",
      state: "verified",
      endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit",
      generationDigest: "10".repeat(32),
      prompt: "Move the AI product into a moonlit gallery.",
      sourceSha256: "20".repeat(32),
      editMaskSha256: "30".repeat(32),
      verification: {
        claim: "Protected core verified — canonical pre-encode frame sequence.",
        framesAudited: 121,
        changedCoreChannelSamples: 0,
        worstMaxChannelDelta: 0,
        coreHashMatchCount: 121,
      },
    });
    mocks.readVerifiedRealJobProof.mockResolvedValue({
      claim: "Protected core verified — canonical pre-encode frame sequence.",
      framesAudited: 121,
      protectedCorePixels: 22_029_381,
      changedCoreChannelSamples: 0,
      worstMaxChannelDelta: 0,
      coreHashMatchCount: 121,
      proofManifestSha256: "40".repeat(32),
      auditSha256: "50".repeat(32),
      runManifestSha256: "60".repeat(32),
      previewSha256: "70".repeat(32),
    });

    const page = await Home({
      searchParams: Promise.resolve({ job: "ai_source_verified_01" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("ai_source_verified_01");
    expect(markup).toContain("data-verified-playback");
    expect(markup).toContain("40".repeat(32));
    expect(markup).toContain("Canonical frames ZIP — 121 authoritative PNGs");
    expect(markup).toContain(
      "/?proof=corrupt&amp;job=ai_source_verified_01",
    );
    expect(mocks.readWorkspaceRealJob).toHaveBeenCalledWith(
      "ai_source_verified_01",
    );
    expect(mocks.readVerifiedRealJobProof).toHaveBeenCalledWith(
      "ai_source_verified_01",
    );
    expect(mocks.readActiveRealJob).not.toHaveBeenCalled();
  });

  it("fails closed when a verified job's canonical bundle cannot be reopened", async () => {
    mocks.readDemoSummary.mockRejectedValue(new Error("no demo"));
    mocks.readWorkspaceRealJob.mockResolvedValue({
      id: "ai_source_verified_01",
      state: "verified",
      endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit",
      generationDigest: "10".repeat(32),
      prompt: "Move the AI product into a moonlit gallery.",
      sourceSha256: "20".repeat(32),
      editMaskSha256: "30".repeat(32),
      verification: {
        claim: "Protected core verified — canonical pre-encode frame sequence.",
        framesAudited: 121,
        changedCoreChannelSamples: 0,
        worstMaxChannelDelta: 0,
        coreHashMatchCount: 121,
      },
    });
    mocks.readVerifiedRealJobProof.mockRejectedValue(
      new Error("canonical archive hash mismatch"),
    );

    const page = await Home({
      searchParams: Promise.resolve({ job: "ai_source_verified_01" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Proof unavailable.");
    expect(markup).not.toContain("ai_source_verified_01");
    expect(markup).not.toContain(
      "Protected core verified — canonical pre-encode frame sequence.",
    );
    expect(markup).not.toContain("Create a verified reshoot.");
  });

  it("fails closed in corrupt-proof mode when negative evidence is unavailable", async () => {
    mocks.readCorruptionEvidence.mockRejectedValue(
      Object.assign(new Error("missing corruption evidence"), {
        code: "ENOENT",
      }),
    );

    const page = await Home({
      searchParams: Promise.resolve({ proof: "corrupt" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Proof unavailable.");
    expect(markup).toContain("Persisted evidence could not be reopened safely.");
    expect(markup).not.toContain("Create a verified reshoot.");
    expect(markup).not.toContain("Verification failed.");
    expect(markup).not.toContain("Canonical verified");
  });

  it("does not collapse an active-job read failure into a fresh intake", async () => {
    mocks.readDemoSummary.mockRejectedValue(new Error("no demo"));
    mocks.readActiveRealJob.mockRejectedValue(
      new Error("active pointer references invalid evidence"),
    );

    const page = await Home({ searchParams: Promise.resolve({}) });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Proof unavailable.");
    expect(markup).toContain("Persisted evidence could not be reopened safely.");
    expect(markup).not.toContain("Create a verified reshoot.");
  });

  it("does not collapse a requested-job read failure into a fresh intake", async () => {
    mocks.readDemoSummary.mockRejectedValue(new Error("no demo"));
    mocks.readWorkspaceRealJob.mockRejectedValue(new Error("job record invalid"));

    const page = await Home({
      searchParams: Promise.resolve({ job: "ai_source_invalid_01" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Proof unavailable.");
    expect(markup).toContain("Persisted evidence could not be reopened safely.");
    expect(markup).not.toContain("Create a verified reshoot.");
  });
});
