import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jobRoots: [] as string[],
  readFile: vi.fn(),
  readJob: vi.fn(),
  reconcilePersistedEvidence: vi.fn(),
  validateDemoArtifacts: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("../jobs/local-job-store", () => ({
  LocalJobStore: class {
    constructor(root: string) {
      mocks.jobRoots.push(root);
    }

    readJob = mocks.readJob;
  },
}));
vi.mock("../jobs/reconcile-evidence", () => ({
  reconcilePersistedEvidence: mocks.reconcilePersistedEvidence,
}));
vi.mock("./canonical-json", () => ({
  embeddedCanonicalJsonSha256: () => "01".repeat(32),
}));
vi.mock("./demo-media", () => ({
  resolveDemoMediaAsset: (id: string) => ({
    contentType: id.includes("video") ? "video/mp4" : "image/png",
    maxBytes: 1024,
    relativePath: `artifacts/${id}`,
  }),
}));
vi.mock("./demo-summary", () => ({
  validateDemoArtifacts: mocks.validateDemoArtifacts,
}));

import {
  readDemoSummary,
  readVerifiedDemoMediaAsset,
} from "./demo-summary.server";

const klingEvidence = {
  jobId: "synthetic-hero-kling-o3-001",
  endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit",
  requestId: "kling-request",
  generationDigest: "10".repeat(32),
  modelOutputSha256: "11".repeat(32),
  assessmentSha256: "12".repeat(32),
};

const ltxEvidence = {
  jobId: "synthetic-hero-ltx-001",
  endpoint: "fal-ai/ltx-2.3-quality/inpaint",
  requestId: "ltx-request",
  generationDigest: "20".repeat(32),
  modelOutputSha256: "21".repeat(32),
  assessmentSha256: "22".repeat(32),
};

const validated = {
  evidence: {
    kling: klingEvidence,
    ltx: ltxEvidence,
    proof: {
      manifestSha256: "30".repeat(32),
      auditSha256: "31".repeat(32),
      runSha256: "32".repeat(32),
      previewSha256: "33".repeat(32),
    },
    audit: {
      framesAudited: 121,
      framesWithProtectedCore: 121,
      totalProtectedCorePixels: 123,
      changedCoreChannelSamples: 0,
      maximumChannelDelta: 0,
      coreHashMatches: 121,
    },
  },
  summary: {
    status: "verified",
    projectionLabel: "Legacy synthetic proof — read-only projection",
  },
};

function generatedRecord(evidence: typeof klingEvidence | typeof ltxEvidence) {
  return {
    id: evidence.jobId,
    state: "generated",
    generation: {
      digest: evidence.generationDigest,
      endpoint: evidence.endpoint,
    },
    fal: {
      requestId: evidence.requestId,
      generationDigest: evidence.generationDigest,
      endpoint: evidence.endpoint,
      modelOutput: { sha256: evidence.modelOutputSha256 },
    },
  };
}

function verifiedKlingRecord() {
  return {
    ...generatedRecord(klingEvidence),
    state: "verified",
    assessment: {
      verdict: "comparable",
      sha256: klingEvidence.assessmentSha256,
    },
    composition: {
      proofManifestSha256: validated.evidence.proof.manifestSha256,
    },
    verification: {
      auditSha256: validated.evidence.proof.auditSha256,
      runManifestSha256: validated.evidence.proof.runSha256,
      previewSha256: validated.evidence.proof.previewSha256,
      framesAudited: 121,
      framesWithNonEmptyCore: 121,
      totalCorePixels: 123,
      changedCoreChannelSamples: 0,
      worstMaxChannelDelta: 0,
      coreHashMatchCount: 121,
    },
  };
}

function rejectedLtxRecord() {
  return {
    ...generatedRecord(ltxEvidence),
    state: "not_comparable",
    assessment: {
      verdict: "not_comparable",
      sha256: ltxEvidence.assessmentSha256,
    },
  };
}

describe("legacy demo summary read boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobRoots.length = 0;
    mocks.readFile.mockResolvedValue(Buffer.from("{}"));
    mocks.validateDemoArtifacts.mockReturnValue(validated);
  });

  it("does not promote generated jobs while loading the home summary", async () => {
    mocks.readJob.mockImplementation(async (id: string) =>
      id === klingEvidence.jobId
        ? generatedRecord(klingEvidence)
        : rejectedLtxRecord(),
    );

    await expect(readDemoSummary()).resolves.toBeNull();
    await expect(
      readVerifiedDemoMediaAsset("source-video"),
    ).resolves.toBeNull();
    expect(mocks.reconcilePersistedEvidence).not.toHaveBeenCalled();
  });

  it("projects legacy evidence only when persisted terminal states match", async () => {
    mocks.readJob.mockImplementation(async (id: string) =>
      id === klingEvidence.jobId
        ? verifiedKlingRecord()
        : rejectedLtxRecord(),
    );

    await expect(readDemoSummary()).resolves.toBe(validated.summary);
    expect(mocks.reconcilePersistedEvidence).not.toHaveBeenCalled();
  });

  it("relocates the default static fallback root without changing artifact-relative paths", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/project");
    mocks.readJob.mockImplementation(async (id: string) =>
      id === klingEvidence.jobId
        ? verifiedKlingRecord()
        : rejectedLtxRecord(),
    );

    try {
      await expect(readDemoSummary()).resolves.toBe(validated.summary);
    } finally {
      cwd.mockRestore();
    }

    const readPaths = mocks.readFile.mock.calls.map(([path]) => String(path));
    expect(readPaths).toContain(
      "/project/demo-evidence/static/root/artifacts/jobs/synthetic-hero-kling-o3-001/assessment/comparability.json",
    );
    expect(readPaths).toContain(
      "/project/demo-evidence/static/root/artifacts/source-video",
    );
    expect(
      readPaths.every((path) =>
        path.startsWith("/project/demo-evidence/static/root/artifacts/"),
      ),
    ).toBe(true);
    expect(mocks.jobRoots).toEqual([
      "/project/demo-evidence/static/root/artifacts/jobs",
    ]);
  });

  it("preserves an explicit root for isolated fallback fixtures", async () => {
    mocks.readJob.mockImplementation(async (id: string) =>
      id === klingEvidence.jobId
        ? verifiedKlingRecord()
        : rejectedLtxRecord(),
    );

    await expect(
      readDemoSummary({ evidenceRoot: "/fixture" }),
    ).resolves.toBe(validated.summary);

    const readPaths = mocks.readFile.mock.calls.map(([path]) => String(path));
    expect(readPaths).toContain(
      "/fixture/artifacts/jobs/synthetic-hero-ltx-001/assessment/comparability.json",
    );
    expect(readPaths).toContain(
      "/fixture/artifacts/canonical-preview",
    );
    expect(mocks.jobRoots).toEqual(["/fixture/artifacts/jobs"]);
  });

  it("treats missing ignored artifacts as an unavailable optional projection", async () => {
    const missing = Object.assign(new Error("missing artifacts"), {
      code: "ENOENT",
    });
    mocks.readFile.mockRejectedValue(missing);

    await expect(readDemoSummary()).resolves.toBeNull();
    expect(mocks.readJob).not.toHaveBeenCalled();
    expect(mocks.reconcilePersistedEvidence).not.toHaveBeenCalled();
  });
});
