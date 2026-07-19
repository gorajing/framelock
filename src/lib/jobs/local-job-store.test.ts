import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LTX_ENDPOINT } from "../fal/ltx-contract";
import {
  KLING_O3_STANDARD_EDIT_ENDPOINT,
  KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
} from "../fal/kling-contract";
import { computeGenerationDigest } from "./generation-digest";
import { LocalJobStore } from "./local-job-store";
import { createPricingReceipt } from "./pricing-receipt";

const JOB_ID = "job_hero";
const REQUEST_ID = "fal_request_hero";
const PAID_ATTEMPT_BASIS = {
  attemptIndex: 1,
  attemptCap: 3,
  unitPriceUsd: "0.01",
  billingUnit: "seconds",
  estimatedUnits: "5",
  estimatedCostUsd: "0.05",
  pricingSource: "local job store test fixture",
  priceObservedAt: "2000-01-01T00:00:00.000Z",
} as const;

const generationIdentity = {
  sourceSha256: "11".repeat(32),
  editMaskSha256: "22".repeat(32),
  prompt: "Transform the exterior into a stormy neon market",
  endpoint: LTX_ENDPOINT,
  parameters: {
    video_strength: 1,
    num_frames: 121,
    frames_per_second: 24,
    num_inference_steps: 15,
    guidance_scale: 1,
    generate_audio: false,
    seed: 42,
    enable_prompt_expansion: false,
    enable_safety_checker: true,
    video_quality: "high",
    video_write_mode: "balanced",
  },
} as const;

const modelOutput = {
  artifactId: "model_output_hero",
  sha256: "33".repeat(32),
  url: "https://fal.media/frame-lock-result.mp4",
  contentType: "video/mp4",
} as const;

const sourceProvenance = {
  fileSha256: "44".repeat(32),
  manifest: {
    schemaVersion: 1 as const,
    provenanceLabel: "ai_generated_source" as const,
    originalImageSha256: "55".repeat(32),
    sourceBundleManifestSha256: "66".repeat(32),
    normalizedPlateSha256: "77".repeat(32),
    canonicalSourceMp4Sha256: generationIdentity.sourceSha256,
    foregroundMaskSha256: generationIdentity.editMaskSha256,
    contactSheetSha256: "88".repeat(32),
    approval: {
      recordSha256: "99".repeat(32),
      approvedAt: "2026-07-18T01:02:03.000Z",
      reviewer: "FrameLock executor",
      note: "FRM-01 passed the frozen visual criteria.",
    },
  },
} as const;

describe("localhost P0 job store", () => {
  let root: string;
  let store: LocalJobStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-job-store-"));
    store = new LocalJobStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createValidatedJob() {
    return store.createValidatedJob({
      id: JOB_ID,
      generation: generationIdentity,
    });
  }

  it("persists a versioned AI-source provenance binding beside the generation identity", async () => {
    const created = await store.createValidatedJob({
      id: JOB_ID,
      generation: generationIdentity,
      sourceProvenance,
    });

    expect(created).toMatchObject({
      recordVersion: 3,
      sourceProvenance,
    });
    await expect(store.readJob(JOB_ID)).resolves.toEqual(created);
  });

  it("rejects AI-source provenance that names different generation media", async () => {
    await expect(
      store.createValidatedJob({
        id: JOB_ID,
        generation: generationIdentity,
        sourceProvenance: {
          ...sourceProvenance,
          manifest: {
            ...sourceProvenance.manifest,
            canonicalSourceMp4Sha256: "aa".repeat(32),
          },
        },
      }),
    ).rejects.toThrow();
  });

  it("persists and reopens an immutable pricing receipt without mutating the job record", async () => {
    const created = await store.createValidatedJob({
      id: JOB_ID,
      generation: {
        ...generationIdentity,
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        parameters: KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
      },
      sourceProvenance,
    });
    const before = await readFile(join(root, JOB_ID, "job.json"), "utf8");
    const receipt = createPricingReceipt({
      jobId: JOB_ID,
      generationDigest: created.generation.digest,
      sourceProvenanceFileSha256: sourceProvenance.fileSha256,
      pricingObservation: {
        unitPriceUsd: "0.126",
        billingUnit: "seconds",
        estimatedUnits: "5.041666667",
        estimatedCostUsd: "0.63525",
        pricingSource: "authenticated_fal_platform_pricing_api_v1_models_pricing",
        priceObservedAt: "2026-07-18T08:45:00.000Z",
      },
    });

    await expect(store.persistPricingReceipt(receipt)).resolves.toEqual(receipt);
    const receiptPath = join(
      root,
      JOB_ID,
      "pricing",
      `${receipt.pricingObservationDigest}.json`,
    );
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
    await expect(
      store.readPricingReceipt({
        jobId: JOB_ID,
        generationDigest: created.generation.digest,
        pricingObservationDigest: receipt.pricingObservationDigest,
      }),
    ).resolves.toEqual(receipt);
    expect(await readFile(join(root, JOB_ID, "job.json"), "utf8")).toBe(before);
    await expect(store.persistPricingReceipt(receipt)).resolves.toEqual(receipt);
  });

  it("fails closed for missing, tampered or cross-generation pricing receipts", async () => {
    const created = await store.createValidatedJob({
      id: JOB_ID,
      generation: {
        ...generationIdentity,
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        parameters: KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
      },
      sourceProvenance,
    });
    const receipt = createPricingReceipt({
      jobId: JOB_ID,
      generationDigest: created.generation.digest,
      sourceProvenanceFileSha256: sourceProvenance.fileSha256,
      pricingObservation: {
        unitPriceUsd: "0.126",
        billingUnit: "seconds",
        estimatedUnits: "5.041666667",
        estimatedCostUsd: "0.63525",
        pricingSource: "authenticated_fal_platform_pricing_api_v1_models_pricing",
        priceObservedAt: "2026-07-18T08:45:00.000Z",
      },
    });

    await expect(
      store.readPricingReceipt({
        jobId: JOB_ID,
        generationDigest: created.generation.digest,
        pricingObservationDigest: receipt.pricingObservationDigest,
      }),
    ).rejects.toMatchObject({ code: "PRICING_RECEIPT_MISSING" });
    await expect(
      store.persistPricingReceipt({
        ...receipt,
        generationDigest: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "PRICING_RECEIPT_MISMATCH" });

    await store.persistPricingReceipt(receipt);
    const receiptPath = join(
      root,
      JOB_ID,
      "pricing",
      `${receipt.pricingObservationDigest}.json`,
    );
    const tampered = JSON.parse(await readFile(receiptPath, "utf8"));
    tampered.pricingObservation.estimatedCostUsd = "999";
    await writeFile(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    await expect(
      store.readPricingReceipt({
        jobId: JOB_ID,
        generationDigest: created.generation.digest,
        pricingObservationDigest: receipt.pricingObservationDigest,
      }),
    ).rejects.toMatchObject({ code: "PRICING_RECEIPT_MISMATCH" });
  });

  async function createSubmittedJob() {
    const created = await createValidatedJob();
    const active = await store.beginSubmission(JOB_ID, PAID_ATTEMPT_BASIS);
    await store.persistSubmission({
      jobId: JOB_ID,
      generationDigest: created.generation.digest,
      endpoint: LTX_ENDPOINT,
      requestId: REQUEST_ID,
      paidAttempt: active.paidAttempt,
    });

    return created.generation.digest;
  }

  async function currentPaidAttempt() {
    const paidAttempt = (await store.readJob(JOB_ID)).paidAttempt;
    if (!paidAttempt) {
      throw new Error("test job is missing paid attempt provenance");
    }
    return paidAttempt;
  }

  it("uses an active submission state to reject a duplicate paid submission", async () => {
    const created = await createValidatedJob();

    const active = await store.beginSubmission(JOB_ID, PAID_ATTEMPT_BASIS);
    expect(active.state).toBe("submitting");
    expect(active.generation.digest).toBe(
      computeGenerationDigest(generationIdentity),
    );

    await expect(
      store.beginSubmission(JOB_ID, PAID_ATTEMPT_BASIS),
    ).rejects.toMatchObject({
      code: "JOB_ALREADY_ACTIVE",
    });

    expect((await store.readJob(JOB_ID)).state).toBe("submitting");
    expect((await store.readJob(JOB_ID)).generation.digest).toBe(
      created.generation.digest,
    );
  });

  it("serializes the evidence workflow independently from atomic job-state updates", async () => {
    await createValidatedJob();
    let release!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = store.withEvidenceWorkflowLock(JOB_ID, async () => {
      signalEntered();
      await gate;
      return "first";
    });
    await entered;

    await expect(
      store.withEvidenceWorkflowLock(JOB_ID, async () => "second"),
    ).rejects.toMatchObject({ code: "JOB_ALREADY_ACTIVE" });

    release();
    await expect(first).resolves.toBe("first");
    await expect(
      store.withEvidenceWorkflowLock(JOB_ID, async () => "after"),
    ).resolves.toBe("after");
  });

  it("cancels only a validated job while preserving its terminal record", async () => {
    await createValidatedJob();

    const cancelled = await store.cancelValidatedJob(JOB_ID);

    expect(cancelled).toMatchObject({
      id: JOB_ID,
      state: "failed",
      failure: {
        source: "local_intake",
        code: "CANCELLED_BEFORE_SUBMISSION",
      },
    });
    expect(await new LocalJobStore(root).readJob(JOB_ID)).toEqual(cancelled);
    expect(await readFile(join(root, JOB_ID, "job.json"), "utf8")).toContain(
      "CANCELLED_BEFORE_SUBMISSION",
    );
    await expect(
      store.beginSubmission(JOB_ID, PAID_ATTEMPT_BASIS),
    ).rejects.toMatchObject({
      code: "INVALID_JOB_STATE",
    });
    await expect(store.cancelValidatedJob(JOB_ID)).rejects.toMatchObject({
      code: "INVALID_JOB_STATE",
    });
  });

  it("reclaims only an expired lock whose recorded local owner is dead", async () => {
    await createValidatedJob();
    await writeFile(
      join(root, JOB_ID, ".job.lock"),
      `${JSON.stringify({
        schemaVersion: 1,
        ownerPid: 2_147_483_647,
        ownerHost: hostname(),
        ownerToken: "dead-expired-owner",
        acquiredAt: "2000-01-01T00:00:00.000Z",
        leaseExpiresAt: "2000-01-01T00:15:00.000Z",
      })}\n`,
      "utf8",
    );

    const active = await store.beginSubmission(JOB_ID, PAID_ATTEMPT_BASIS);

    expect(active.state).toBe("submitting");
  });

  it.each([
    [
      "live owner",
      {
        ownerPid: process.pid,
        ownerHost: hostname(),
        leaseExpiresAt: "2000-01-01T00:15:00.000Z",
      },
    ],
    [
      "unexpired lease",
      {
        ownerPid: 2_147_483_647,
        ownerHost: hostname(),
        leaseExpiresAt: "2999-01-01T00:15:00.000Z",
      },
    ],
    [
      "owner on another host",
      {
        ownerPid: 2_147_483_647,
        ownerHost: "another-host.invalid",
        leaseExpiresAt: "2000-01-01T00:15:00.000Z",
      },
    ],
  ])("does not reclaim a lock with a %s", async (_label, owner) => {
    await createValidatedJob();
    await writeFile(
      join(root, JOB_ID, ".job.lock"),
      `${JSON.stringify({
        schemaVersion: 1,
        ownerPid: owner.ownerPid,
        ownerHost: owner.ownerHost,
        ownerToken: `protected-${_label}`,
        acquiredAt: "2000-01-01T00:00:00.000Z",
        leaseExpiresAt: owner.leaseExpiresAt,
      })}\n`,
      "utf8",
    );

    await expect(
      store.beginSubmission(JOB_ID, PAID_ATTEMPT_BASIS),
    ).rejects.toMatchObject({
      code: "JOB_ALREADY_ACTIVE",
    });
    expect((await store.readJob(JOB_ID)).state).toBe("validated");
  });

  it("records an ambiguous paid submission as terminal unknown and never retries it", async () => {
    const created = await createValidatedJob();
    const active = await store.beginSubmission(JOB_ID, PAID_ATTEMPT_BASIS);

    const unknown = await store.persistSubmissionFailure({
      jobId: JOB_ID,
      generationDigest: created.generation.digest,
      endpoint: LTX_ENDPOINT,
      code: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
      paidAttempt: active.paidAttempt,
    });

    expect(unknown).toMatchObject({
      state: "submission_unknown",
      failure: {
        source: "fal_submission",
        code: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
      },
    });
    await expect(
      store.beginSubmission(JOB_ID, PAID_ATTEMPT_BASIS),
    ).rejects.toMatchObject({
      code: "INVALID_JOB_STATE",
    });
  });

  it("terminalizes an expired submission lease even while its owner process is alive", async () => {
    await createValidatedJob();
    await store.beginSubmission(JOB_ID, PAID_ATTEMPT_BASIS);
    const recordPath = join(root, JOB_ID, "job.json");
    const stale = JSON.parse(await readFile(recordPath, "utf8"));
    stale.submissionLease = {
      ...stale.submissionLease,
      ownerPid: process.pid,
      ownerHost: hostname(),
      leaseExpiresAt: "2000-01-01T00:15:00.000Z",
    };
    await writeFile(recordPath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");

    const reconciled = await store.reconcileStaleSubmission(JOB_ID);

    expect(reconciled).toMatchObject({
      state: "submission_unknown",
      failure: {
        source: "fal_submission",
        code: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
      },
    });
  });

  it("persists the exact request, endpoint and model-output provenance atomically", async () => {
    const generationDigest = await createSubmittedJob();

    await store.persistCompletion({
      jobId: JOB_ID,
      generationDigest,
      endpoint: LTX_ENDPOINT,
      requestId: REQUEST_ID,
      falStatus: "COMPLETED",
      paidAttempt: await currentPaidAttempt(),
      modelOutput,
    });

    const reopened = new LocalJobStore(root);
    const persisted = await reopened.readJob(JOB_ID);
    const diskRecord = JSON.parse(
      await readFile(join(root, JOB_ID, "job.json"), "utf8"),
    );

    expect(persisted).toEqual(diskRecord);
    expect(persisted).toMatchObject({
      id: JOB_ID,
      state: "generated",
      generation: {
        ...generationIdentity,
        digest: generationDigest,
      },
      fal: {
        generationDigest,
        endpoint: LTX_ENDPOINT,
        requestId: REQUEST_ID,
        modelOutput,
      },
    });

    const writeDebris = (await readdir(join(root, JOB_ID))).filter((name) =>
      name.includes(".tmp"),
    );
    expect(writeDebris).toEqual([]);
  });

  it("idempotently reopens the same completion after a crash/retry", async () => {
    const generationDigest = await createSubmittedJob();
    const completion = {
      jobId: JOB_ID,
      generationDigest,
      endpoint: LTX_ENDPOINT,
      requestId: REQUEST_ID,
      falStatus: "COMPLETED" as const,
      paidAttempt: await currentPaidAttempt(),
      modelOutput,
    };

    const first = await store.persistCompletion(completion);
    const replay = await store.persistCompletion(completion);

    expect(replay).toEqual(first);
    expect(replay.state).toBe("generated");
  });

  it("persists a failed comparability gate as a terminal honest state", async () => {
    const generationDigest = await createSubmittedJob();
    await store.persistCompletion({
      jobId: JOB_ID,
      generationDigest,
      endpoint: LTX_ENDPOINT,
      requestId: REQUEST_ID,
      falStatus: "COMPLETED",
      paidAttempt: await currentPaidAttempt(),
      modelOutput,
    });

    const assessed = await store.persistNotComparable({
      jobId: JOB_ID,
      generationDigest,
      endpoint: LTX_ENDPOINT,
      requestId: REQUEST_ID,
      modelOutputSha256: modelOutput.sha256,
      assessmentSha256: "44".repeat(32),
    });

    expect(assessed).toMatchObject({
      state: "not_comparable",
      assessment: {
        verdict: "not_comparable",
        sha256: "44".repeat(32),
      },
    });
  });

  it("persists a definitive canonical finalization rejection as a terminal failed record", async () => {
    const generationDigest = await createSubmittedJob();
    await store.persistCompletion({
      jobId: JOB_ID,
      generationDigest,
      endpoint: LTX_ENDPOINT,
      requestId: REQUEST_ID,
      falStatus: "COMPLETED",
      paidAttempt: await currentPaidAttempt(),
      modelOutput,
    });

    const failed = await store.persistCanonicalVerificationFailure({
      jobId: JOB_ID,
      generationDigest,
      endpoint: LTX_ENDPOINT,
      requestId: REQUEST_ID,
      modelOutputSha256: modelOutput.sha256,
      code: "CANONICAL_FINALIZATION_REJECTED",
    });

    expect(failed).toMatchObject({
      state: "failed",
      failure: {
        source: "canonical_verification",
        code: "CANONICAL_FINALIZATION_REJECTED",
        detail:
          "Canonical finalization rejected the approved evidence; no proof was promoted.",
      },
    });
    expect(failed).not.toHaveProperty("verification");
    await expect(
      store.persistCanonicalVerificationFailure({
        jobId: JOB_ID,
        generationDigest,
        endpoint: LTX_ENDPOINT,
        requestId: REQUEST_ID,
        modelOutputSha256: modelOutput.sha256,
        code: "CANONICAL_FINALIZATION_REJECTED",
      }),
    ).rejects.toMatchObject({ code: "INVALID_JOB_STATE" });

    const path = join(root, JOB_ID, "job.json");
    const tampered = JSON.parse(await readFile(path, "utf8"));
    tampered.failure.detail = "private verifier stderr";
    await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    await expect(new LocalJobStore(root).readJob(JOB_ID)).rejects.toBeInstanceOf(
      Error,
    );
  });

  it("binds comparable composition and passing canonical audit before verified", async () => {
    const generationDigest = await createSubmittedJob();
    await store.persistCompletion({
      jobId: JOB_ID,
      generationDigest,
      endpoint: LTX_ENDPOINT,
      requestId: REQUEST_ID,
      falStatus: "COMPLETED",
      paidAttempt: await currentPaidAttempt(),
      modelOutput,
    });
    const proofManifestSha256 = "55".repeat(32);
    const composited = await store.persistComposition({
      jobId: JOB_ID,
      generationDigest,
      endpoint: LTX_ENDPOINT,
      requestId: REQUEST_ID,
      modelOutputSha256: modelOutput.sha256,
      assessmentSha256: "44".repeat(32),
      proofManifestSha256,
    });
    expect(composited.state).toBe("composited");

    const verified = await store.persistVerification({
      jobId: JOB_ID,
      generationDigest,
      endpoint: LTX_ENDPOINT,
      requestId: REQUEST_ID,
      modelOutputSha256: modelOutput.sha256,
      proofManifestSha256,
      auditSha256: "66".repeat(32),
      runManifestSha256: "77".repeat(32),
      previewSha256: "88".repeat(32),
      framesAudited: 121,
      framesWithNonEmptyCore: 121,
      totalCorePixels: 22_029_381,
      changedCoreChannelSamples: 0,
      worstMaxChannelDelta: 0,
      coreHashMatchCount: 121,
    });

    expect(verified).toMatchObject({
      state: "verified",
      assessment: { verdict: "comparable" },
      composition: { proofManifestSha256 },
      verification: {
        claim:
          "Protected core verified — canonical pre-encode frame sequence.",
        framesAudited: 121,
        changedCoreChannelSamples: 0,
        worstMaxChannelDelta: 0,
        coreHashMatchCount: 121,
      },
    });
    expect(await new LocalJobStore(root).readJob(JOB_ID)).toEqual(verified);
  });

  it("rejects a persisted green verification claim on every non-verified state", async () => {
    const generationDigest = await createSubmittedJob();
    await store.persistCompletion({
      jobId: JOB_ID,
      generationDigest,
      endpoint: LTX_ENDPOINT,
      requestId: REQUEST_ID,
      falStatus: "COMPLETED",
      paidAttempt: await currentPaidAttempt(),
      modelOutput,
    });
    const path = join(root, JOB_ID, "job.json");
    const tampered = JSON.parse(await readFile(path, "utf8"));
    tampered.verification = {
      claim: "Protected core verified — canonical pre-encode frame sequence.",
      auditSha256: "66".repeat(32),
      runManifestSha256: "77".repeat(32),
      previewSha256: "88".repeat(32),
      framesAudited: 121,
      framesWithNonEmptyCore: 121,
      totalCorePixels: 22_029_381,
      changedCoreChannelSamples: 0,
      worstMaxChannelDelta: 0,
      coreHashMatchCount: 121,
      stage: "canonical_pre_encode",
    };
    await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    await expect(new LocalJobStore(root).readJob(JOB_ID)).rejects.toBeInstanceOf(
      Error,
    );
  });

  it("recomputes the generation digest whenever a record is reopened", async () => {
    await createValidatedJob();
    const path = join(root, JOB_ID, "job.json");
    const tampered = JSON.parse(await readFile(path, "utf8"));
    tampered.generation.digest = "ff".repeat(32);
    await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    await expect(new LocalJobStore(root).readJob(JOB_ID)).rejects.toMatchObject({
      code: "PROVENANCE_MISMATCH",
    });
  });

  it.each([
    ["request", { requestId: "fal_request_from_another_job" }],
    [
      "endpoint",
      { endpoint: "fal-ai/kling-video/o3/standard/video-to-video" },
    ],
    ["generation digest", { generationDigest: "ff".repeat(32) }],
  ])(
    "rejects a model output whose %s provenance was swapped",
    async (_label, mutation) => {
      const generationDigest = await createSubmittedJob();
      const before = await readFile(join(root, JOB_ID, "job.json"), "utf8");

      await expect(
        store.persistCompletion({
          jobId: JOB_ID,
          generationDigest,
          endpoint: LTX_ENDPOINT,
          requestId: REQUEST_ID,
          falStatus: "COMPLETED",
          paidAttempt: await currentPaidAttempt(),
          modelOutput,
          ...mutation,
        }),
      ).rejects.toMatchObject({ code: "PROVENANCE_MISMATCH" });

      const after = await readFile(join(root, JOB_ID, "job.json"), "utf8");
      expect(after).toBe(before);
      expect((await store.readJob(JOB_ID)).state).toBe("submitted");
      expect(await store.readJob(JOB_ID)).not.toHaveProperty("fal.modelOutput");
    },
  );

  it("records an error-bearing fal completion as failed, never generated", async () => {
    const generationDigest = await createSubmittedJob();

    const failed = await store.persistCompletion({
      jobId: JOB_ID,
      generationDigest,
      endpoint: LTX_ENDPOINT,
      requestId: REQUEST_ID,
      falStatus: "COMPLETED",
      paidAttempt: await currentPaidAttempt(),
      error: "Runner failed after completion was reported",
      errorType: "INTERNAL_SERVER_ERROR",
      modelOutput,
    });

    expect(failed).toMatchObject({
      state: "failed",
      fal: {
        generationDigest,
        endpoint: LTX_ENDPOINT,
        requestId: REQUEST_ID,
      },
      failure: {
        source: "fal_completion",
        error: "Runner failed after completion was reported",
        errorType: "INTERNAL_SERVER_ERROR",
      },
    });
    expect(failed).not.toHaveProperty("fal.modelOutput");

    await expect(
      store.persistCompletion({
        jobId: JOB_ID,
        generationDigest,
        endpoint: LTX_ENDPOINT,
        requestId: REQUEST_ID,
        falStatus: "COMPLETED",
        paidAttempt: await currentPaidAttempt(),
        modelOutput,
      }),
    ).rejects.toMatchObject({ code: "INVALID_JOB_STATE" });

    expect((await store.readJob(JOB_ID)).state).toBe("failed");
  });
});
