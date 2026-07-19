import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "../fal/kling-contract";
import type {
  CommittedFinalizationEvidence,
  FinalizationEvidence,
  GenerationAssessmentEvidence,
  GenerationReviewEvidence,
} from "../media/framelock-cli-core";
import { FrameLockCliError } from "../media/framelock-cli-core";
import { LocalJobStore } from "../jobs/local-job-store";
import {
  APPROVE_REVIEW_PHRASE,
  createRealJobReviewService,
  realJobApprovalSchema,
  RealJobReviewError,
} from "./real-job-review";

const JOB_ID = "real_review_001";
const REQUEST_ID = "request-review-001";
const CLAIM =
  "Protected core verified — canonical pre-encode frame sequence.";
const SOURCE = new TextEncoder().encode("source-video");
const MASK = new TextEncoder().encode("foreground-mask");
const MODEL = new TextEncoder().encode("model-output");
const FRAMES = Array.from({ length: 121 }, (_, index) => index);
const REVIEW_INDICES = [0, 60, 120] as const;

describe("real generated-result review boundary", () => {
  let root: string;
  let jobsRoot: string;
  let runsRoot: string;
  let store: LocalJobStore;
  let generationDigest: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-real-review-"));
    jobsRoot = join(root, "jobs");
    runsRoot = join(root, "runs");
    store = new LocalJobStore(jobsRoot);
    generationDigest = await createGeneratedJob({ store, jobsRoot, runsRoot });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("assesses the active generated job with the fixed third-attempt pricing and returns only redacted review evidence", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });

    const result = await service.review(JOB_ID);

    expect(cli.assessGeneration).toHaveBeenCalledWith({
      mediaPath: join(jobsRoot, JOB_ID, "model-output.mp4"),
      outputDirectory: join(jobsRoot, JOB_ID, "assessment"),
      jobRecordPath: join(jobsRoot, JOB_ID, "job.json"),
      paidAttemptIndex: 3,
      paidAttemptCap: 3,
      unitPriceUsd: "0.14",
      billingUnit: "seconds",
      estimatedUnits: "5.041666667",
      estimatedCostUsd: "0.7058333334",
      pricingSource: "authenticated_fal_pricing_and_estimate",
      priceObservedAt: "2026-07-17T18:47:33.000Z",
      snapshotCapturedAt: expect.any(String),
      snapshotDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(cli.prepareGenerationReview).toHaveBeenCalledWith({
      sourceProofDirectory: join(runsRoot, JOB_ID, "proof"),
      foregroundMaskPath: join(runsRoot, JOB_ID, "inputs", "foreground.png"),
      generatedMediaPath: join(jobsRoot, JOB_ID, "model-output.mp4"),
      generationAssessmentPath: join(
        jobsRoot,
        JOB_ID,
        "assessment",
        "comparability.json",
      ),
      jobRecordPath: join(jobsRoot, JOB_ID, "job.json"),
      outputDirectory: join(jobsRoot, JOB_ID, "canonical"),
    });
    expect(result.job).toMatchObject({
      id: JOB_ID,
      state: "generated",
      generationDigest,
      requestId: REQUEST_ID,
    });
    expect(result.review!).toMatchObject({
      state: "awaiting_visual_geometry_approval",
      overlays: [
        { frame: 0, url: `/api/jobs/${JOB_ID}/media/overlay-0` },
        { frame: 60, url: `/api/jobs/${JOB_ID}/media/overlay-60` },
        { frame: 120, url: `/api/jobs/${JOB_ID}/media/overlay-120` },
      ],
    });
    expect(result.review!.overlaySha256s).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain("https://fal.media");
  });

  it("uses the immutable paid-attempt snapshot instead of inventing attempt or price evidence", async () => {
    await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "framelock-real-review-snapshot-"));
    jobsRoot = join(root, "jobs");
    runsRoot = join(root, "runs");
    store = new LocalJobStore(jobsRoot);
    await createGeneratedJob({
      store,
      jobsRoot,
      runsRoot,
      paidAttempt: {
        attemptIndex: 1,
        attemptCap: 3,
        unitPriceUsd: "0.15",
        billingUnit: "seconds",
        estimatedUnits: "5.041666667",
        estimatedCostUsd: "0.7562500001",
        pricingSource: "authenticated_test_price_snapshot",
        priceObservedAt: "2026-07-17T18:47:33.000Z",
      },
    });
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });

    await service.review(JOB_ID);

    expect(cli.assessGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        paidAttemptIndex: 1,
        paidAttemptCap: 3,
        unitPriceUsd: "0.15",
        estimatedCostUsd: "0.7562500001",
        pricingSource: "authenticated_test_price_snapshot",
        priceObservedAt: "2026-07-17T18:47:33.000Z",
      }),
    );
  });

  it("rejects an assessment whose pricing snapshot drifts after persistence", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    const assessmentPath = join(
      jobsRoot,
      JOB_ID,
      "assessment",
      "comparability.json",
    );
    const assessment = JSON.parse(await readFile(assessmentPath, "utf8"));
    assessment.pricing.estimated_cost_usd = "0.0000000001";
    await writeJson(assessmentPath, assessment);

    await expect(
      service.approve(JOB_ID, approvalFor(reviewed.review!)),
    ).rejects.toMatchObject({ code: "EVIDENCE_INVALID" });
    expect(cli.finalizeGenerationProof).not.toHaveBeenCalled();
  });

  it("persists an honest not_comparable terminal state using the assessment file hash", async () => {
    const cli = fakeCli({
      store,
      jobsRoot,
      runsRoot,
      verdict: "not_comparable",
    });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });

    const result = await service.review(JOB_ID);
    const assessmentPath = join(
      jobsRoot,
      JOB_ID,
      "assessment",
      "comparability.json",
    );

    expect(result).toEqual({
      job: expect.objectContaining({ state: "not_comparable" }),
    });
    expect(await store.readJob(JOB_ID)).toMatchObject({
      state: "not_comparable",
      assessment: {
        verdict: "not_comparable",
        sha256: await sha256File(assessmentPath),
      },
    });
    expect(cli.prepareGenerationReview).not.toHaveBeenCalled();
  });

  it("fails closed for a foreign active job, a traversal ID and stale persisted review hashes", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: "other_job" }) },
      cli,
      jobsRoot,
      runsRoot,
    });

    await expect(service.review(JOB_ID)).rejects.toSatisfy(
      (error) =>
        error instanceof RealJobReviewError &&
        error.code === "ACTIVE_JOB_MISMATCH",
    );
    await expect(service.review("../job")).rejects.toBeInstanceOf(Error);
    expect(cli.assessGeneration).not.toHaveBeenCalled();

    const activeService = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await activeService.review(JOB_ID);
    const review = reviewed.review!;
    await writeFile(
      join(jobsRoot, JOB_ID, "canonical", "geometry_overlays", "overlay_000060.png"),
      "tampered",
    );

    await expect(
      activeService.approve(JOB_ID, approvalFor(review)),
    ).rejects.toMatchObject({ code: "EVIDENCE_INVALID" });
    expect(cli.finalizeGenerationProof).not.toHaveBeenCalled();
  });

  it("rejects review schema v2 when its source-audio binding is absent", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    const path = join(jobsRoot, JOB_ID, "canonical", "review_manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    delete manifest.digest_sha256;
    manifest.schema_version = 2;
    manifest.digest_sha256 = sha256(canonicalJson(manifest));
    await writeJson(path, manifest);

    await expect(
      service.approve(JOB_ID, {
        ...approvalFor(reviewed.review!),
        reviewManifestSha256: await sha256File(path),
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_INVALID" });
    expect(cli.finalizeGenerationProof).not.toHaveBeenCalled();
  });

  it("rejects evidence reached through a symlinked ancestor directory", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    const assessmentDirectory = join(jobsRoot, JOB_ID, "assessment");
    const foreignDirectory = join(root, "foreign-assessment");
    await rename(assessmentDirectory, foreignDirectory);
    await symlink(foreignDirectory, assessmentDirectory, "dir");

    await expect(
      service.approve(JOB_ID, approvalFor(reviewed.review!)),
    ).rejects.toMatchObject({ code: "EVIDENCE_INVALID" });
    expect(cli.finalizeGenerationProof).not.toHaveBeenCalled();
  });

  it("requires the exact approval contract then validates final evidence before promoting generated to verified", async () => {
    expect(() =>
      realJobApprovalSchema.parse({
        approval: "approve",
        reviewManifestSha256: "11".repeat(32),
        overlaySha256s: ["22".repeat(32), "33".repeat(32), "44".repeat(32)],
        reviewer: "Human reviewer",
        visualNote: "Position, scale and silhouette match at all three frames.",
      }),
    ).toThrow();

    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    const review = reviewed.review!;
    const approval = approvalFor(review);

    await expect(
      service.approve(JOB_ID, {
        ...approval,
        overlaySha256s: [
          "00".repeat(32),
          approval.overlaySha256s[1],
          approval.overlaySha256s[2],
        ],
      }),
    ).rejects.toMatchObject({ code: "STALE_REVIEW_HASHES" });
    expect(cli.finalizeGenerationProof).not.toHaveBeenCalled();

    const result = await service.approve(JOB_ID, approval);
    if (!("proof" in result)) {
      throw new Error("expected passing canonical proof evidence");
    }

    expect(cli.finalizeGenerationProof).toHaveBeenCalledWith({
      preparedReviewDirectory: join(jobsRoot, JOB_ID, "canonical"),
      reviewManifestSha256: review.reviewManifestSha256,
      overlaySha256s: review.overlaySha256s,
      reviewer: approval.reviewer,
      visualNote: approval.visualNote,
    });
    expect(result.job).toMatchObject({
      state: "verified",
      verification: {
        claim: CLAIM,
        framesAudited: 121,
        changedCoreChannelSamples: 0,
        worstMaxChannelDelta: 0,
        coreHashMatchCount: 121,
      },
    });
    expect(result.proof).toMatchObject({
      claim: CLAIM,
      framesAudited: 121,
      protectedCorePixels: 22_029_381,
      changedCoreChannelSamples: 0,
      worstMaxChannelDelta: 0,
      coreHashMatchCount: 121,
      exports: {
        canonicalFrames: `/api/jobs/${JOB_ID}/media/canonical-frames`,
        canonicalExportManifest: `/api/jobs/${JOB_ID}/media/canonical-export-manifest`,
        proofManifest: `/api/jobs/${JOB_ID}/media/proof-manifest`,
        audit: `/api/jobs/${JOB_ID}/media/audit`,
        runManifest: `/api/jobs/${JOB_ID}/media/run-manifest`,
        preview: `/api/jobs/${JOB_ID}/media/preview`,
      },
    });
    expect((await store.readJob(JOB_ID)).state).toBe("verified");
  });

  it("reopens a verified canonical bundle read-only without consulting the active-job pointer", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const activeJobs = { read: vi.fn(async () => ({ jobId: JOB_ID })) };
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs,
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    await service.approve(JOB_ID, approvalFor(reviewed.review!));
    const before = await store.readJob(JOB_ID);
    activeJobs.read.mockClear();

    const reopened = await service.readVerified(JOB_ID);

    expect(activeJobs.read).not.toHaveBeenCalled();
    expect(reopened).toMatchObject({
      job: { id: JOB_ID, state: "verified" },
      proof: {
        claim: CLAIM,
        framesAudited: 121,
        proofManifestSha256: before.composition?.proofManifestSha256,
        auditSha256: before.verification?.auditSha256,
        runManifestSha256: before.verification?.runManifestSha256,
        previewSha256: before.verification?.previewSha256,
      },
    });
    expect(await store.readJob(JOB_ID)).toEqual(before);
  });

  it("rejects a corrupted canonical bundle on verified read without changing the ledger", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    await service.approve(JOB_ID, approvalFor(reviewed.review!));
    const before = await store.readJob(JOB_ID);
    await writeFile(
      join(jobsRoot, JOB_ID, "canonical", "proof_manifest.json"),
      "tampered",
    );

    await expect(service.readVerified(JOB_ID)).rejects.toMatchObject({
      code: "EVIDENCE_INVALID",
    });
    expect(await store.readJob(JOB_ID)).toEqual(before);
  });

  it("reconciles complete finalization outputs after a Node crash without rerunning the CLI and remains idempotent", async () => {
    const firstCli = fakeCli({ store, jobsRoot, runsRoot });
    const firstService = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli: firstCli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await firstService.review(JOB_ID);
    const review = reviewed.review!;
    const approval = approvalFor(review);
    await writeFinalEvidence({
      jobsRoot,
      store,
      approval,
      review,
    });

    const recoveryCli = fakeCli({ store, jobsRoot, runsRoot });
    const recoveryService = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli: recoveryCli,
      jobsRoot,
      runsRoot,
    });
    const recovered = await recoveryService.approve(JOB_ID, approval);
    const repeated = await recoveryService.approve(JOB_ID, approval);

    expect(recoveryCli.finalizeGenerationProof).not.toHaveBeenCalled();
    expect(recovered.job.state).toBe("verified");
    expect(repeated).toEqual(recovered);
  });

  it("resumes a persisted composited job from committed approval evidence without rerunning the finalizer", async () => {
    const firstCli = fakeCli({ store, jobsRoot, runsRoot });
    const firstService = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli: firstCli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await firstService.review(JOB_ID);
    const approval = approvalFor(reviewed.review!);
    await writeFinalEvidence({
      jobsRoot,
      store,
      approval,
      review: reviewed.review!,
    });
    const record = await store.readJob(JOB_ID);
    await store.persistComposition({
      jobId: JOB_ID,
      generationDigest: record.generation.digest,
      endpoint: record.generation.endpoint,
      requestId: record.fal!.requestId,
      modelOutputSha256: record.fal!.modelOutput!.sha256,
      assessmentSha256: await sha256File(
        join(jobsRoot, JOB_ID, "assessment", "comparability.json"),
      ),
      proofManifestSha256: await sha256File(
        join(jobsRoot, JOB_ID, "canonical", "proof_manifest.json"),
      ),
    });

    const recoveryCli = fakeCli({ store, jobsRoot, runsRoot });
    const recoveryService = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli: recoveryCli,
      jobsRoot,
      runsRoot,
    });
    const recovered = await recoveryService.resumeVerification(JOB_ID);
    const repeated = await recoveryService.resumeVerification(JOB_ID);

    expect(recoveryCli.finalizeGenerationProof).not.toHaveBeenCalled();
    expect(recovered).toMatchObject({
      job: { state: "verified" },
      proof: { claim: CLAIM, framesAudited: 121 },
    });
    expect(repeated).toEqual(recovered);
  });

  it("does not let the recovery action bypass approval for a generated job", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });

    await expect(service.resumeVerification(JOB_ID)).rejects.toMatchObject({
      code: "INVALID_JOB_STATE",
    });
    expect(cli.validateFinalizationCommit).not.toHaveBeenCalled();
    expect(cli.finalizeGenerationProof).not.toHaveBeenCalled();
    expect((await store.readJob(JOB_ID)).state).toBe("generated");
  });

  it("does not promote complete-looking outputs without a durable finalization commit marker", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    const approval = approvalFor(reviewed.review!);
    await writeFinalEvidence({ jobsRoot, store, approval, review: reviewed.review! });
    await rm(
      join(jobsRoot, JOB_ID, "canonical", ".finalization-committed.json"),
    );

    await expect(service.approve(JOB_ID, approval)).rejects.toMatchObject({
      code: "CLI_EXECUTION_FAILED",
    });
    expect(cli.finalizeGenerationProof).toHaveBeenCalledOnce();
    expect((await store.readJob(JOB_ID)).state).toBe("generated");
  });

  it("persists a typed canonical finalization rejection after approval without promoting proof", async () => {
    const cli = fakeCli({
      store,
      jobsRoot,
      runsRoot,
      finalizationFailure: true,
    });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);

    const result = await service.approve(
      JOB_ID,
      approvalFor(reviewed.review!),
    );

    expect(result).toEqual({
      job: expect.objectContaining({
        state: "failed",
        failureCode: "CANONICAL_FINALIZATION_REJECTED",
        failureDetail:
          "Canonical finalization rejected the approved evidence; no proof was promoted.",
      }),
    });
    expect(await store.readJob(JOB_ID)).toMatchObject({
      state: "failed",
      failure: {
        source: "canonical_verification",
        code: "CANONICAL_FINALIZATION_REJECTED",
      },
    });
    expect(result).not.toHaveProperty("proof");
  });

  it("keeps an ambiguous finalizer process failure generated and unverified", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    cli.finalizeGenerationProof.mockRejectedValueOnce(
      new FrameLockCliError("CLI_EXECUTION_FAILED"),
    );

    await expect(
      service.approve(JOB_ID, approvalFor(reviewed.review!)),
    ).rejects.toMatchObject({ code: "CLI_EXECUTION_FAILED" });
    expect(await store.readJob(JOB_ID)).toMatchObject({ state: "generated" });
    expect(await store.readJob(JOB_ID)).not.toHaveProperty("verification");
  });

  it("admits only one approval finalizer for a job at a time", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    const approval = approvalFor(reviewed.review!);
    const finalize = cli.finalizeGenerationProof.getMockImplementation()!;
    let release!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    cli.finalizeGenerationProof.mockImplementationOnce(async (request) => {
      signalEntered();
      await gate;
      return finalize(request);
    });

    const first = service.approve(JOB_ID, approval);
    await entered;

    await expect(service.approve(JOB_ID, approval)).rejects.toMatchObject({
      code: "JOB_ALREADY_ACTIVE",
    });
    expect(cli.finalizeGenerationProof).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({
      job: { state: "verified" },
    });
  });

  it("does not reconcile a partial or mismatched finalization set", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    const approval = approvalFor(reviewed.review!);
    await writeFile(join(jobsRoot, JOB_ID, "canonical", "audit.json"), "{}\n");

    await expect(service.approve(JOB_ID, approval)).rejects.toMatchObject({
      code: "CLI_EXECUTION_FAILED",
    });
    expect(cli.finalizeGenerationProof).toHaveBeenCalledOnce();
    expect((await store.readJob(JOB_ID)).state).toBe("generated");
  });

  it("routes a journal-owned partial finalization back through recovery", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    const approval = approvalFor(reviewed.review!);
    const directory = join(jobsRoot, JOB_ID, "canonical");
    await writeFile(join(directory, "audit.json"), "partial-owned-output");
    await writeJson(join(directory, ".finalization-transaction.json"), {
      schema_version: 1,
      test_fixture: "Python owns journal validation",
    });

    await expect(service.approve(JOB_ID, approval)).resolves.toMatchObject({
      job: { state: "verified" },
    });
    expect(cli.finalizeGenerationProof).toHaveBeenCalledOnce();
    await expect(
      lstat(join(directory, ".finalization-transaction.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a terminal evidence failure when the committed canonical archive hash changed", async () => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    const review = reviewed.review!;
    const approval = approvalFor(review);
    await writeFinalEvidence({
      jobsRoot,
      store,
      approval,
      review,
    });
    await writeFile(
      join(jobsRoot, JOB_ID, "canonical", "canonical_frames.zip"),
      "different-archive-bytes",
    );

    await expect(service.approve(JOB_ID, approval)).resolves.toMatchObject({
      job: {
        state: "failed",
        failureCode: "CANONICAL_EVIDENCE_INVALID",
      },
    });
    expect(cli.finalizeGenerationProof).not.toHaveBeenCalled();
    expect((await store.readJob(JOB_ID)).state).toBe("failed");
  });

  it.each([
    ["schema v6 without its audio binding", 6, undefined],
    [
      "schema v5 carrying an unversioned audio binding",
      5,
      {
        manifest_path: "/tmp/foreign-source-audio.json",
        manifest_sha256: "aa".repeat(32),
        source_audio_present: false,
        normalized_audio_path: null,
        normalized_audio_sha256: null,
        normalization_operation: "absent_source_no_track",
        target_sample_count: 242_000,
        preview_audio_policy: "silent_no_source_audio",
        claim_scope: "outside_pixel_verification_claim",
      },
    ],
    [
      "schema v6 carrying audio that is not bound to review evidence",
      6,
      {
        manifest_path: "/tmp/foreign-source-audio.json",
        manifest_sha256: "aa".repeat(32),
        source_audio_present: false,
        normalized_audio_path: null,
        normalized_audio_sha256: null,
        normalization_operation: "absent_source_no_track",
        target_sample_count: 242_000,
        preview_audio_policy: "silent_no_source_audio",
        claim_scope: "outside_pixel_verification_claim",
      },
    ],
  ])("persists a terminal evidence failure for %s", async (_label, schemaVersion, audio) => {
    const cli = fakeCli({ store, jobsRoot, runsRoot });
    const service = createRealJobReviewService({
      jobs: store,
      activeJobs: { read: async () => ({ jobId: JOB_ID }) },
      cli,
      jobsRoot,
      runsRoot,
    });
    const reviewed = await service.review(JOB_ID);
    const approval = approvalFor(reviewed.review!);
    await writeFinalEvidence({ jobsRoot, store, approval, review: reviewed.review! });
    const runPath = join(jobsRoot, JOB_ID, "canonical", "run_manifest.json");
    const run = JSON.parse(await readFile(runPath, "utf8"));
    delete run.digest_sha256;
    run.schema_version = schemaVersion;
    if (audio === undefined) delete run.audio;
    else run.audio = audio;
    run.digest_sha256 = sha256(canonicalJson(run));
    await writeJson(runPath, run);
    await writeFinalizationCommitMarker(
      join(jobsRoot, JOB_ID, "canonical"),
      approval.reviewManifestSha256,
    );

    await expect(service.approve(JOB_ID, approval)).resolves.toMatchObject({
      job: {
        state: "failed",
        failureCode: "CANONICAL_EVIDENCE_INVALID",
      },
    });
    expect((await store.readJob(JOB_ID)).state).toBe("failed");
  });
});

function approvalFor(review: {
  reviewManifestSha256: string;
  overlaySha256s: readonly [string, string, string];
}) {
  return {
    approval: APPROVE_REVIEW_PHRASE,
    reviewManifestSha256: review.reviewManifestSha256,
    overlaySha256s: review.overlaySha256s,
    reviewer: "Human reviewer",
    visualNote: "Position, scale and silhouette match at frames 0, 60 and 120.",
  } as const;
}

function fakeCli(input: {
  store: LocalJobStore;
  jobsRoot: string;
  runsRoot: string;
  verdict?: "not_comparable" | "comparable_pending_visual_approval";
  finalizationFailure?: boolean;
}) {
  return {
    assessGeneration: vi.fn(async (request): Promise<GenerationAssessmentEvidence> => {
      const assessment = await writeAssessmentEvidence({
        ...input,
        outputDirectory: request.outputDirectory,
        verdict: input.verdict ?? "comparable_pending_visual_approval",
      });
      return assessment;
    }),
    prepareGenerationReview: vi.fn(
      async (request): Promise<GenerationReviewEvidence> =>
        writeReviewEvidence({
          ...input,
          outputDirectory: request.outputDirectory,
        }),
    ),
    validateFinalizationCommit: vi.fn(
      async (request): Promise<CommittedFinalizationEvidence> => {
        const markerPath = join(
          request.preparedReviewDirectory,
          ".finalization-committed.json",
        );
        let marker: {
          schema_version: 1;
          attempt_id: string;
          review_manifest_sha256: string;
          outputs: unknown[];
        };
        try {
          marker = JSON.parse(await readFile(markerPath, "utf8"));
        } catch {
          throw new FrameLockCliError("CLI_EXECUTION_FAILED");
        }
        const journalPath = join(
          request.preparedReviewDirectory,
          ".finalization-transaction.json",
        );
        let staleJournalReconciled = false;
        try {
          await rm(journalPath);
          staleJournalReconciled = true;
        } catch (error) {
          if (!isTestNodeError(error, "ENOENT")) throw error;
        }
        return {
          state: "committed",
          marker: markerPath,
          marker_sha256: await sha256File(markerPath),
          schema_version: marker.schema_version,
          attempt_id: marker.attempt_id,
          review_manifest_sha256: marker.review_manifest_sha256,
          output_count: marker.outputs.length as 9,
          stale_journal_reconciled: staleJournalReconciled,
        };
      },
    ),
    finalizeGenerationProof: vi.fn(
      async (request): Promise<FinalizationEvidence> => {
        if (input.finalizationFailure) {
          return {
            state: "verification_failed",
            claim: null,
            code: "CANONICAL_FINALIZATION_REJECTED",
            detail:
              "Canonical finalization rejected the approved evidence; no proof was promoted.",
          };
        }
        const directory = request.preparedReviewDirectory;
        const journalPath = join(directory, ".finalization-transaction.json");
        const ownedPaths = [
          "composite_frames",
          "proof_manifest.json",
          "audit.json",
          "preview.mp4",
          "run_manifest.json",
          "canonical_frames.zip",
          "canonical_frames_manifest.json",
          "corruption_fixture",
          ".finalization-committed.json",
        ].map((path) => join(directory, path));
        const journalExists = await pathExistsForTest(journalPath);
        if (!journalExists && (await anyPathExists(ownedPaths))) {
          throw new FrameLockCliError("CLI_EXECUTION_FAILED");
        }
        if (journalExists) {
          await Promise.all(
            ownedPaths.map((path) =>
              rm(path, { recursive: true, force: true }),
            ),
          );
          await rm(journalPath, { force: true });
        }
        return writeFinalEvidence({
          jobsRoot: input.jobsRoot,
          store: input.store,
          approval: {
            approval: APPROVE_REVIEW_PHRASE,
            reviewManifestSha256: request.reviewManifestSha256,
            overlaySha256s: request.overlaySha256s,
            reviewer: request.reviewer,
            visualNote: request.visualNote,
          },
          review: {
            reviewManifestSha256: request.reviewManifestSha256,
            overlaySha256s: request.overlaySha256s,
          },
        });
      },
    ),
  };
}

async function createGeneratedJob(input: {
  store: LocalJobStore;
  jobsRoot: string;
  runsRoot: string;
  paidAttempt?: {
    attemptIndex: number;
    attemptCap: number;
    unitPriceUsd: string;
    billingUnit: string;
    estimatedUnits: string;
    estimatedCostUsd: string;
    pricingSource: string;
    priceObservedAt: string;
  };
}) {
  const sourceSha256 = sha256(SOURCE);
  const editMaskSha256 = sha256(MASK);
  const modelOutputSha256 = sha256(MODEL);
  const created = await input.store.createValidatedJob({
    id: JOB_ID,
    generation: {
      sourceSha256,
      editMaskSha256,
      prompt: "Replace only the unprotected exterior with a neon laboratory.",
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      parameters: { shot_type: "customize", keep_audio: false },
    },
  });
  await mkdir(join(input.runsRoot, JOB_ID, "inputs"), { recursive: true });
  await mkdir(join(input.runsRoot, JOB_ID, "proof"), { recursive: true });
  await Promise.all([
    writeFile(join(input.runsRoot, JOB_ID, "inputs", "source.mp4"), SOURCE),
    writeFile(join(input.runsRoot, JOB_ID, "inputs", "foreground.png"), MASK),
    writeJson(join(input.runsRoot, JOB_ID, "proof", "proof_manifest.json"), {
      schema_version: 1,
      digest_sha256: "10".repeat(32),
      frames: FRAMES,
    }),
    writeFile(join(input.jobsRoot, JOB_ID, "model-output.mp4"), MODEL),
  ]);
  const submitting = await input.store.beginSubmission(
    JOB_ID,
    input.paidAttempt ?? {
      attemptIndex: 3,
      attemptCap: 3,
      unitPriceUsd: "0.14",
      billingUnit: "seconds",
      estimatedUnits: "5.041666667",
      estimatedCostUsd: "0.7058333334",
      pricingSource: "authenticated_fal_pricing_and_estimate",
      priceObservedAt: "2026-07-17T18:47:33.000Z",
    },
  );
  await input.store.persistSubmission({
    jobId: JOB_ID,
    generationDigest: created.generation.digest,
    endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
    requestId: REQUEST_ID,
    paidAttempt: submitting.paidAttempt,
  });
  await input.store.persistCompletion({
    jobId: JOB_ID,
    generationDigest: created.generation.digest,
    endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
    requestId: REQUEST_ID,
    falStatus: "COMPLETED",
    paidAttempt: submitting.paidAttempt,
    modelOutput: {
      artifactId: `sha256:${modelOutputSha256}`,
      sha256: modelOutputSha256,
      url: "https://fal.media/model-output.mp4",
      contentType: "video/mp4",
    },
  });
  return created.generation.digest;
}

async function writeAssessmentEvidence(input: {
  store: LocalJobStore;
  jobsRoot: string;
  outputDirectory: string;
  verdict: "not_comparable" | "comparable_pending_visual_approval";
}): Promise<GenerationAssessmentEvidence> {
  const record = await input.store.readJob(JOB_ID);
  const paidAttempt = record.paidAttempt;
  if (!paidAttempt) throw new Error("test job is missing paid-attempt evidence");
  const assessmentPath = join(input.outputDirectory, "comparability.json");
  const rawProbePath = join(input.outputDirectory, "ffprobe.raw.json");
  await mkdir(input.outputDirectory, { recursive: true });
  await writeJson(rawProbePath, { streams: [], format: {} });
  await writeJson(assessmentPath, {
    schema_version: 1,
    rule_version: "framelock-comparability-p0-v1",
    verdict: input.verdict,
    attempt: {
      cap: paidAttempt.attemptCap,
      index: paidAttempt.attemptIndex,
    },
    pricing: {
      billing_unit: paidAttempt.billingUnit,
      estimated_cost_usd: paidAttempt.estimatedCostUsd,
      estimated_units: paidAttempt.estimatedUnits,
      source: paidAttempt.pricingSource,
      unit_price_usd: paidAttempt.unitPriceUsd,
      price_observed_at: paidAttempt.priceObservedAt,
      snapshot_captured_at: paidAttempt.capturedAt,
      snapshot_digest_sha256: paidAttempt.digestSha256,
    },
    model_output: {
      bytes: MODEL.byteLength,
      path: join(input.jobsRoot, JOB_ID, "model-output.mp4"),
      sha256: sha256(MODEL),
    },
    job_provenance: record,
    probe: {
      path: rawProbePath,
      raw_json_sha256: await sha256File(rawProbePath),
    },
    media: { width: 1280, height: 720, frame_count: 121, frame_rate: "24/1" },
    normalization_applied: false,
    visual_geometry_approval:
      input.verdict === "not_comparable"
        ? "not_reached_automatic_gate_failed"
        : "pending_human_review",
  });
  return {
    assessment: assessmentPath,
    raw_probe: rawProbePath,
    verdict: input.verdict,
  };
}

async function writeReviewEvidence(input: {
  store: LocalJobStore;
  jobsRoot: string;
  runsRoot: string;
  outputDirectory: string;
}): Promise<GenerationReviewEvidence> {
  const record = await input.store.readJob(JOB_ID);
  const generatedDirectory = join(input.outputDirectory, "generated_frames");
  const overlayDirectory = join(input.outputDirectory, "geometry_overlays");
  await Promise.all([
    mkdir(generatedDirectory, { recursive: true }),
    mkdir(overlayDirectory, { recursive: true }),
  ]);
  const generatedFrames = await Promise.all(
    FRAMES.map(async (index) => {
      const path = join(generatedDirectory, `frame_${String(index).padStart(6, "0")}.png`);
      await writeFile(path, `generated-${index}`);
      return {
        source_index: index,
        path,
        file_sha256: await sha256File(path),
        rgb_sha256: sha256(`rgb-${index}`),
      };
    }),
  );
  const overlays = await Promise.all(
    REVIEW_INDICES.map(async (index) => {
      const path = join(overlayDirectory, `overlay_${String(index).padStart(6, "0")}.png`);
      await writeFile(path, `overlay-${index}`);
      return { source_index: index, path, sha256: await sha256File(path) };
    }),
  );
  const assessmentPath = join(
    input.jobsRoot,
    JOB_ID,
    "assessment",
    "comparability.json",
  );
  const proofPath = join(input.runsRoot, JOB_ID, "proof", "proof_manifest.json");
  const maskPath = join(input.runsRoot, JOB_ID, "inputs", "foreground.png");
  const unsigned = {
    schema_version: 1,
    prepared_at: new Date().toISOString(),
    review_state: "awaiting_visual_geometry_approval",
    reviewed_source_indices: REVIEW_INDICES,
    job: {
      id: JOB_ID,
      endpoint: record.generation.endpoint,
      request_id: record.fal?.requestId,
      generation_digest: record.generation.digest,
      source_sha256: record.generation.sourceSha256,
      restoration_mask_sha256: record.generation.editMaskSha256,
      model_output_sha256: record.fal?.modelOutput?.sha256,
    },
    generation_assessment: {
      path: assessmentPath,
      sha256: await sha256File(assessmentPath),
      rule_version: "framelock-comparability-p0-v1",
      automatic_checks_passed: true,
    },
    source_proof: {
      directory: join(input.runsRoot, JOB_ID, "proof"),
      proof_manifest_sha256: await sha256File(proofPath),
      ingest_digest_sha256: "10".repeat(32),
    },
    prepared_foreground_mask: {
      path: maskPath,
      sha256: await sha256File(maskPath),
    },
    generated_decode_provenance: {
      decoded_frame_count: 121,
      width: 1280,
      height: 720,
      frame_rate_numerator: 24,
      frame_rate_denominator: 1,
      source_file_sha256: sha256(MODEL),
      source_media_path: join(input.jobsRoot, JOB_ID, "model-output.mp4"),
    },
    generated_frames: generatedFrames,
    geometry_overlays: overlays,
  };
  const manifest = {
    ...unsigned,
    digest_sha256: sha256(canonicalJson(unsigned)),
  };
  const reviewManifestPath = join(input.outputDirectory, "review_manifest.json");
  await writeJson(reviewManifestPath, manifest);
  return {
    generated_frames: 121,
    geometry_overlays: overlays.map((item) => item.path) as [string, string, string],
    geometry_overlay_sha256s: overlays.map((item) => item.sha256) as [string, string, string],
    review_manifest: reviewManifestPath,
    review_manifest_sha256: await sha256File(reviewManifestPath),
    review_manifest_digest_sha256: manifest.digest_sha256,
    review_state: "awaiting_visual_geometry_approval",
  };
}

async function writeFinalEvidence(input: {
  jobsRoot: string;
  store: LocalJobStore;
  approval: {
    approval: typeof APPROVE_REVIEW_PHRASE;
    reviewManifestSha256: string;
    overlaySha256s: readonly [string, string, string];
    reviewer: string;
    visualNote: string;
  };
  review: {
    reviewManifestSha256: string;
    overlaySha256s: readonly [string, string, string];
  };
}): Promise<FinalizationEvidence> {
  const directory = join(input.jobsRoot, JOB_ID, "canonical");
  const proofPath = join(directory, "proof_manifest.json");
  const auditPath = join(directory, "audit.json");
  const previewPath = join(directory, "preview.mp4");
  const runPath = join(directory, "run_manifest.json");
  const archivePath = join(directory, "canonical_frames.zip");
  const exportManifestPath = join(
    directory,
    "canonical_frames_manifest.json",
  );
  const differenceHeatmapPath = join(
    directory,
    "difference_heatmap_000060.png",
  );
  const corruptionDirectory = join(directory, "corruption_fixture");
  const corruptionManifestPath = join(
    corruptionDirectory,
    "corruption_manifest.json",
  );
  const corruptionAuditPath = join(
    corruptionDirectory,
    "corruption_audit.json",
  );
  const corruptionSummaryPath = join(
    corruptionDirectory,
    "corruption_summary.json",
  );
  const proofDigest = "90".repeat(32);
  const record = await input.store.readJob(JOB_ID);
  const runsRoot = resolve(input.jobsRoot, "..", "runs");
  const sourceFrameDirectory = join(
    runsRoot,
    JOB_ID,
    "proof",
    "source_frames",
  );
  const coreMaskDirectory = join(
    runsRoot,
    JOB_ID,
    "proof",
    "core_masks",
  );
  const staticMaskDirectory = join(
    runsRoot,
    JOB_ID,
    "proof",
    "masks",
  );
  const protectedCorePath = join(staticMaskDirectory, "protected_core.png");
  const boundaryRingPath = join(staticMaskDirectory, "feather_boundary.png");
  await Promise.all([
    mkdir(join(directory, "composite_frames"), { recursive: true }),
    mkdir(corruptionDirectory, { recursive: true }),
    mkdir(sourceFrameDirectory, { recursive: true }),
    mkdir(coreMaskDirectory, { recursive: true }),
    mkdir(staticMaskDirectory, { recursive: true }),
  ]);
  const proofFrames = await Promise.all(
    FRAMES.map(async (index) => {
      const suffix = String(index).padStart(6, "0");
      const sourcePath = join(sourceFrameDirectory, `frame_${suffix}.png`);
      const coreMaskPath = join(coreMaskDirectory, `core_${suffix}.png`);
      const generatedPath = join(
        directory,
        "generated_frames",
        `frame_${suffix}.png`,
      );
      const compositePath = join(
        directory,
        "composite_frames",
        `composite_${suffix}.png`,
      );
      await Promise.all([
        writeFile(sourcePath, `source-frame-${index}`),
        writeFile(coreMaskPath, `core-mask-${index}`),
        writeFile(compositePath, `composite-${index}`),
      ]);
      return {
        index,
        source_path: sourcePath,
        core_mask_path: coreMaskPath,
        generated_path: generatedPath,
        composite_path: compositePath,
        source_file_sha256: await sha256File(sourcePath),
        source_rgb_sha256: sha256(`source-rgb-${index}`),
        core_mask_file_sha256: await sha256File(coreMaskPath),
        generated_file_sha256: await sha256File(generatedPath),
        generated_rgb_sha256: sha256(`generated-rgb-${index}`),
        composite_file_sha256: await sha256File(compositePath),
      };
    }),
  );
  await Promise.all([
    writeFile(protectedCorePath, "core-mask-60"),
    writeFile(boundaryRingPath, "boundary-ring-60"),
    writeFile(differenceHeatmapPath, "difference-heatmap-60"),
  ]);
  await writeJson(proofPath, {
    schema_version: 2,
    digest_sha256: proofDigest,
    expected_frame_count: 121,
    expected_width: 1280,
    expected_height: 720,
    generation_binding: {
      prepared_foreground_mask_path: join(
        runsRoot,
        JOB_ID,
        "inputs",
        "foreground.png",
      ),
      prepared_foreground_mask_file_sha256: sha256(MASK),
      generated_media_provenance: {
        source_media_path: join(input.jobsRoot, JOB_ID, "model-output.mp4"),
        source_file_sha256: sha256(MODEL),
        decoded_frame_count: 121,
        width: 1280,
        height: 720,
        frame_rate_numerator: 24,
        frame_rate_denominator: 1,
      },
    },
    frames: proofFrames,
  });
  await writeJson(auditPath, {
    schema_version: 1,
    claim: CLAIM,
    audit: {
      passed: true,
      canonical_contract_passed: true,
      core_passed: true,
      artifact_integrity_passed: true,
      frames_audited: 121,
      frames_with_nonempty_core: 121,
      total_core_pixels: 22_029_381,
      total_changed_core_pixels: 0,
      total_changed_core_channel_samples: 0,
      worst_maximum_absolute_channel_delta: 0,
      core_hash_match_count: 121,
      manifest_digest_sha256: proofDigest,
      deterministic_composition_checked: true,
      deterministic_composition_passed: true,
      stage: "canonical_pre_encode",
      frame_audits: FRAMES.map((index) => ({ index, passed: true })),
    },
    manifest: { digest_sha256: proofDigest, frames: FRAMES },
  });
  await writeFile(previewPath, "verified-preview");
  const archiveEntries = await Promise.all(
    proofFrames.map(async (frame, index) => [
      `canonical_frames/frame_${String(index).padStart(6, "0")}.png`,
      await readFile(frame.composite_path),
    ] as const),
  );
  const archiveTotalUncompressedBytes = archiveEntries.reduce(
    (total, [, bytes]) => total + bytes.length,
    0,
  );
  await writeFile(archivePath, buildStoredZip(archiveEntries));
  await writeJson(exportManifestPath, {
    schema_version: 1,
    artifact: "canonical_rgb24_png_sequence",
    claim_scope:
      "Packaging of proof-bound canonical pre-encode RGB24 PNG frames; the proof manifest remains authoritative.",
    frame_count: 121,
    proof_manifest_digest_sha256: proofDigest,
    total_uncompressed_bytes: archiveTotalUncompressedBytes,
    archive: {
      format: "zip",
      compression: "stored",
      sha256: await sha256File(archivePath),
    },
    frames: FRAMES.map((index) => ({
      source_index: index,
      archive_path: `canonical_frames/frame_${String(index).padStart(6, "0")}.png`,
      file_sha256: proofFrames[index].composite_file_sha256,
    })),
  });
  await writeFile(
    join(corruptionDirectory, "corrupted_composite_000060.png"),
    "corrupted-pixel",
  );
  const corruptionDigest = "91".repeat(32);
  await writeJson(corruptionManifestPath, {
    schema_version: 2,
    digest_sha256: corruptionDigest,
    frames: FRAMES,
  });
  await writeJson(corruptionAuditPath, {
    schema_version: 1,
    claim: null,
    audit: {
      passed: false,
      canonical_contract_passed: true,
      total_changed_core_pixels: 1,
      total_changed_core_channel_samples: 1,
      worst_maximum_absolute_channel_delta: 1,
      frames_audited: 121,
      manifest_digest_sha256: corruptionDigest,
    },
  });
  await writeJson(corruptionSummaryPath, {
    fixture: "one_channel_one_pixel_protected_core_corruption",
    corrupted_frame_index: 60,
    corrupted_channel: 1,
    passed: false,
    changed_core_pixels: 1,
    changed_core_channel_samples: 1,
    worst_maximum_absolute_channel_delta: 1,
    canonical_artifacts_mutated: false,
    manifest_path: corruptionManifestPath,
    manifest_sha256: await sha256File(corruptionManifestPath),
    audit_path: corruptionAuditPath,
    audit_sha256: await sha256File(corruptionAuditPath),
  });
  const unsignedRun = {
    schema_version: 5,
    created_at: new Date().toISOString(),
    claim: CLAIM,
    job: {
      id: JOB_ID,
      endpoint: record.generation.endpoint,
      request_id: record.fal?.requestId,
      generation_digest: record.generation.digest,
      source_sha256: record.generation.sourceSha256,
      restoration_mask_sha256: record.generation.editMaskSha256,
      model_output_sha256: record.fal?.modelOutput?.sha256,
    },
    generation_assessment: {
      path: join(input.jobsRoot, JOB_ID, "assessment", "comparability.json"),
      sha256: await sha256File(
        join(input.jobsRoot, JOB_ID, "assessment", "comparability.json"),
      ),
      rule_version: "framelock-comparability-p0-v1",
      automatic_checks_passed: true,
    },
    visual_geometry_approval: {
      passed: true,
      reviewer: input.approval.reviewer,
      reviewed_source_indices: REVIEW_INDICES,
      reviewed_overlay_sha256s: input.approval.overlaySha256s,
      review_manifest_sha256: input.approval.reviewManifestSha256,
      note: input.approval.visualNote,
    },
    review_evidence: {
      manifest_path: join(directory, "review_manifest.json"),
      manifest_sha256: input.review.reviewManifestSha256,
      manifest_digest_sha256: JSON.parse(
        await readFile(join(directory, "review_manifest.json"), "utf8"),
      ).digest_sha256,
      prepared_before_approval: true,
    },
    proof: {
      manifest_path: proofPath,
      manifest_sha256: await sha256File(proofPath),
      manifest_digest_sha256: proofDigest,
      audit_path: auditPath,
      audit_sha256: await sha256File(auditPath),
      frames_audited: 121,
      changed_core_channel_samples: 0,
      deterministic_composition_checked: true,
      deterministic_composition_passed: true,
    },
    preview: {
      path: previewPath,
      sha256: await sha256File(previewPath),
      label: "Preview derived from verified canonical frames",
    },
    exports: {
      canonical_frames: {
        archive_path: archivePath,
        archive_sha256: await sha256File(archivePath),
        manifest_path: exportManifestPath,
        manifest_sha256: await sha256File(exportManifestPath),
        frame_count: 121,
        total_uncompressed_bytes: archiveTotalUncompressedBytes,
        label: "Proof-bound canonical pre-encode RGB24 PNG sequence",
      },
    },
    visualizations: {
      protected_core_frame_60: {
        path: protectedCorePath,
        sha256: await sha256File(protectedCorePath),
        claim_scope: "exactness_contract_mask",
      },
      boundary_ring_frame_60: {
        path: boundaryRingPath,
        sha256: await sha256File(boundaryRingPath),
        claim_scope: "visual_only_not_exactness_contract",
      },
      difference_heatmap_frame_60: {
        path: differenceHeatmapPath,
        sha256: await sha256File(differenceHeatmapPath),
        source_file_sha256: proofFrames[60].source_file_sha256,
        composite_file_sha256: proofFrames[60].composite_file_sha256,
        claim_scope: "visual_only_not_verifier_output",
      },
    },
    negative_test: {
      fixture: "one_channel_one_pixel_protected_core_corruption",
      verifier: "verify_persisted_sequence",
      frame_index: 60,
      channel: 1,
      passed: false,
      claim: null,
      canonical_artifacts_mutated: false,
      changed_core_pixels: 1,
      changed_core_channel_samples: 1,
      worst_maximum_absolute_channel_delta: 1,
      manifest_path: corruptionManifestPath,
      manifest_sha256: await sha256File(corruptionManifestPath),
      audit_path: corruptionAuditPath,
      audit_sha256: await sha256File(corruptionAuditPath),
      summary_path: corruptionSummaryPath,
      summary_sha256: await sha256File(corruptionSummaryPath),
    },
  };
  await writeJson(runPath, {
    ...unsignedRun,
    digest_sha256: sha256(canonicalJson(unsignedRun)),
  });
  await writeFinalizationCommitMarker(
    directory,
    input.approval.reviewManifestSha256,
  );
  return {
    audit: auditPath,
    canonical_contract_passed: true,
    changed_core_channel_samples: 0,
    claim: CLAIM,
    manifest: proofPath,
    preview: previewPath,
    run_manifest: runPath,
  };
}

async function writeFinalizationCommitMarker(
  directory: string,
  reviewManifestSha256: string,
) {
  const fileRecord = async (path: string) => {
    const absolutePath = join(directory, path);
    return {
      path,
      kind: "file",
      sha256: await sha256File(absolutePath),
      size_bytes: (await lstat(absolutePath)).size,
    };
  };
  const compositeFiles = await Promise.all(
    FRAMES.map(async (index) => ({
      path: `composite_${String(index).padStart(6, "0")}.png`,
      sha256: await sha256File(
        join(
          directory,
          "composite_frames",
          `composite_${String(index).padStart(6, "0")}.png`,
        ),
      ),
    })),
  );
  const corruptionFiles = await Promise.all(
    [
      "corrupted_composite_000060.png",
      "corruption_audit.json",
      "corruption_manifest.json",
      "corruption_summary.json",
    ].map(async (path) => ({
      path,
      sha256: await sha256File(join(directory, "corruption_fixture", path)),
    })),
  );
  const outputs = [
    {
      path: "composite_frames",
      kind: "directory",
      file_count: compositeFiles.length,
      tree_digest_sha256: sha256(canonicalJson(compositeFiles)),
    },
    await fileRecord("proof_manifest.json"),
    await fileRecord("audit.json"),
    await fileRecord("preview.mp4"),
    await fileRecord("run_manifest.json"),
    await fileRecord("canonical_frames.zip"),
    await fileRecord("canonical_frames_manifest.json"),
    await fileRecord("difference_heatmap_000060.png"),
    {
      path: "corruption_fixture",
      kind: "directory",
      file_count: corruptionFiles.length,
      tree_digest_sha256: sha256(canonicalJson(corruptionFiles)),
    },
  ];
  const unsigned = {
    schema_version: 1,
    attempt_id: "00000000-0000-4000-8000-000000000001",
    review_manifest_sha256: reviewManifestSha256,
    outputs,
  };
  await writeJson(join(directory, ".finalization-committed.json"), {
    ...unsigned,
    digest_sha256: sha256(canonicalJson(unsigned)),
  });
}

async function writeJson(path: string, payload: unknown) {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function pathExistsForTest(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isTestNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function anyPathExists(paths: readonly string[]): Promise<boolean> {
  return (await Promise.all(paths.map(pathExistsForTest))).some(Boolean);
}

function isTestNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(([key, item]) => `${asciiJsonString(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return asciiJsonString(value);
  return JSON.stringify(value);
}

function asciiJsonString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function buildStoredZip(entries: readonly (readonly [string, Buffer])[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
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
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
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
