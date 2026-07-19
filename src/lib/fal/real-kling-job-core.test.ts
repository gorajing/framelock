import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import { LocalJobStore } from "../jobs/local-job-store";
import {
  bindPaidAttemptBudget,
  inspectPaidAttemptBudget,
} from "../jobs/paid-attempt-budget";
import { paidAttemptPricingObservationDigest } from "../jobs/paid-attempt-provenance";
import { FalSubmissionError } from "./fal-queue-single-submit";
import {
  KLING_O3_STANDARD_EDIT_ENDPOINT,
  KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
} from "./kling-contract";
import {
  KLING_O3_STANDARD_EDIT_PRICING_MAX_AGE_MS,
} from "./kling-pricing";
import {
  createRealKlingJobController,
  type RealKlingFalPort,
} from "./real-kling-job-core";
import { REAL_KLING_PAID_CONFIRMATION } from "./real-kling-request";

const JOB_ID = "real-hero-kling-o3-007";
const PROMPT =
  "Replace the room with a storm-lit glass studio while preserving the product.";
const EDIT_MASK_SHA256 = "22".repeat(32);
const MODEL_OUTPUT_SHA256 = "33".repeat(32);
const REQUEST_ID = "fal-real-kling-request-7";
const FRESH_NOW = "2026-07-17T19:47:33.000Z";
const TEST_PRICING = {
  unitPriceUsd: "0.14",
  billingUnit: "seconds",
  estimatedUnits: "5.041666667",
  estimatedCostUsd: "0.7058333334",
  pricingSource: "authenticated_fal_pricing_and_estimate",
  priceObservedAt: "2026-07-17T18:47:33.000Z",
} as const;
const TEST_PRICING_DIGEST =
  paidAttemptPricingObservationDigest(TEST_PRICING);
const PAID_ATTEMPT = bindPaidAttemptBudget(
  { used: 0, next: 1, cap: 3 },
  TEST_PRICING,
);
const PAID_CONFIRMATION = {
  authorization: REAL_KLING_PAID_CONFIRMATION,
  pricingObservationDigest: TEST_PRICING_DIGEST,
} as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("generic real-source Kling O3 controller", () => {
  let root: string;
  let jobStore: LocalJobStore;
  let sourceBytes: Uint8Array;
  let sourceSha256: string;
  let falPort: RealKlingFalPort;
  let assertPaidRuntimeReady: Mock<() => void>;
  let assertInputEvidenceCurrentBeforePaidPost: Mock<() => Promise<void>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-real-kling-controller-"));
    jobStore = new LocalJobStore(root);
    sourceBytes = new TextEncoder().encode("owned real camera source bytes");
    sourceSha256 = sha256(sourceBytes);
    assertPaidRuntimeReady = vi.fn();
    assertInputEvidenceCurrentBeforePaidPost = vi.fn(async () => undefined);
    falPort = {
      uploadSource: vi.fn(async () => "https://fal.media/real-source.mp4"),
      submit: vi.fn(async () => ({
        requestId: REQUEST_ID,
        remoteStatus: "IN_QUEUE",
      })),
      status: vi.fn(async () => ({ status: "COMPLETED" })),
      result: vi.fn(async () => ({
        requestId: REQUEST_ID,
        data: {
          video: {
            url: "https://fal.media/real-generated.mp4",
            content_type: "video/mp4",
          },
        },
      })),
      downloadOutput: vi.fn(async () => ({
        path: join(root, JOB_ID, "model-output.mp4"),
        sha256: MODEL_OUTPUT_SHA256,
        bytes: 4_321,
      })),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function controller(
    overrides: Partial<Parameters<typeof createRealKlingJobController>[0]> = {},
  ) {
    return createRealKlingJobController({
      jobStore,
      jobId: JOB_ID,
      sourceBytes,
      sourceSha256,
      editMaskSha256: EDIT_MASK_SHA256,
      prompt: PROMPT,
      now: () => new Date(FRESH_NOW),
      assertPaidRuntimeReady,
      assertInputEvidenceCurrentBeforePaidPost,
      fal: falPort,
      ...overrides,
    });
  }

  it("prepares an arbitrary validated job without calling fal", async () => {
    const prepared = await controller().prepare();

    expect(prepared).toEqual({
      id: JOB_ID,
      state: "validated",
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      generationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      prompt: PROMPT,
      sourceSha256,
      editMaskSha256: EDIT_MASK_SHA256,
    });
    expect(falPort.uploadSource).not.toHaveBeenCalled();
    expect(falPort.submit).not.toHaveBeenCalled();

    const persisted = await jobStore.readJob(JOB_ID);
    expect(persisted.generation).toEqual({
      sourceSha256,
      editMaskSha256: EDIT_MASK_SHA256,
      prompt: PROMPT,
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      parameters: KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
      digest: prepared.generationDigest,
    });
  });

  it("rejects invalid source bytes, hashes and prompts before creating a job", async () => {
    expect(() =>
      controller({ sourceSha256: "00".repeat(32) }),
    ).toThrow(/source bytes.*sha-256/i);
    expect(() => controller({ editMaskSha256: "mask-latest" })).toThrow();
    expect(() => controller({ prompt: "   " })).toThrow();
    expect(() => controller({ prompt: "x".repeat(2_001) })).toThrow();
    expect(() => controller({ sourceBytes: new Uint8Array() })).toThrow(
      /source bytes.*empty/i,
    );

    await expect(jobStore.readJob(JOB_ID)).rejects.toMatchObject({
      code: "JOB_NOT_FOUND",
    });
    expect(falPort.uploadSource).not.toHaveBeenCalled();
    expect(falPort.submit).not.toHaveBeenCalled();
  });

  it("requires an exact job-and-generation confirmation before any fal call", async () => {
    const subject = controller();
    const prepared = await subject.prepare();

    await expect(
      subject.submit(
        {
          jobId: JOB_ID,
          generationDigest: "ff".repeat(32),
          ...PAID_CONFIRMATION,
        },
        TEST_PRICING,
      ),
    ).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    await expect(
      subject.submit(
        {
          jobId: "different-job",
          generationDigest: prepared.generationDigest,
          ...PAID_CONFIRMATION,
        },
        TEST_PRICING,
      ),
    ).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });

    expect((await jobStore.readJob(JOB_ID)).state).toBe("validated");
    expect(falPort.uploadSource).not.toHaveBeenCalled();
    expect(falPort.submit).not.toHaveBeenCalled();
  });

  it("rejects missing or drifted pricing consent before reserving an attempt", async () => {
    const subject = controller();
    const prepared = await subject.prepare();

    await expect(
      subject.submit(
        {
          jobId: prepared.id,
          generationDigest: prepared.generationDigest,
          authorization: REAL_KLING_PAID_CONFIRMATION,
          pricingObservationDigest: "f".repeat(64),
        },
        TEST_PRICING,
      ),
    ).rejects.toMatchObject({ code: "PRICING_CONFIRMATION_MISMATCH" });

    expect((await jobStore.readJob(JOB_ID)).state).toBe("validated");
    expect(await inspectPaidAttemptBudget(jobStore)).toEqual({
      used: 0,
      next: 1,
      cap: 3,
    });
    expect(falPort.uploadSource).not.toHaveBeenCalled();
    expect(falPort.submit).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "stale",
      priceObservedAt: new Date(
        Date.parse(FRESH_NOW) - KLING_O3_STANDARD_EDIT_PRICING_MAX_AGE_MS - 1,
      ).toISOString(),
    },
    {
      label: "future",
      priceObservedAt: new Date(Date.parse(FRESH_NOW) + 1).toISOString(),
    },
  ])(
    "rejects a $label pricing observation before runtime readiness, reservation or fal IO",
    async ({ priceObservedAt }) => {
      const paidAttemptPricing = {
        ...TEST_PRICING,
        priceObservedAt,
      };
      const subject = controller();
      const prepared = await subject.prepare();

      await expect(
        subject.submit(
          {
            jobId: prepared.id,
            generationDigest: prepared.generationDigest,
            authorization: REAL_KLING_PAID_CONFIRMATION,
            pricingObservationDigest:
              paidAttemptPricingObservationDigest(paidAttemptPricing),
          },
          paidAttemptPricing,
        ),
      ).rejects.toMatchObject({ code: "PRICING_OBSERVATION_NOT_CURRENT" });

      expect(assertPaidRuntimeReady).not.toHaveBeenCalled();
      expect(await inspectPaidAttemptBudget(jobStore)).toEqual({
        used: 0,
        next: 1,
        cap: 3,
      });
      expect((await jobStore.readJob(JOB_ID)).state).toBe("validated");
      expect(falPort.uploadSource).not.toHaveBeenCalled();
      expect(falPort.submit).not.toHaveBeenCalled();
      expect(falPort.status).not.toHaveBeenCalled();
      expect(falPort.result).not.toHaveBeenCalled();
      expect(falPort.downloadOutput).not.toHaveBeenCalled();
    },
  );

  it("submits an intake-created validated job without preparing it twice", async () => {
    const existing = await jobStore.createValidatedJob({
      id: JOB_ID,
      generation: {
        sourceSha256,
        editMaskSha256: EDIT_MASK_SHA256,
        prompt: PROMPT,
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        parameters: KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
      },
    });
    const subject = controller();

    const submitted = await subject.submit(
      {
        jobId: existing.id,
        generationDigest: existing.generation.digest,
        ...PAID_CONFIRMATION,
      },
      TEST_PRICING,
    );

    expect(submitted).toMatchObject({
      id: JOB_ID,
      state: "submitted",
      generationDigest: existing.generation.digest,
      requestId: REQUEST_ID,
    });
    expect(falPort.uploadSource).toHaveBeenCalledTimes(1);
    expect(falPort.submit).toHaveBeenCalledTimes(1);
    expect(assertPaidRuntimeReady).toHaveBeenCalledTimes(1);
  });

  it("submits the exact fixed Kling endpoint and input once after confirmation", async () => {
    const originalBytes = Uint8Array.from(sourceBytes);
    const subject = controller();
    sourceBytes.fill(0);
    const prepared = await subject.prepare();

    const submitted = await subject.submit(
      {
        jobId: prepared.id,
        generationDigest: prepared.generationDigest,
        ...PAID_CONFIRMATION,
      },
      TEST_PRICING,
    );

    expect(falPort.uploadSource).toHaveBeenCalledTimes(1);
    expect(falPort.uploadSource).toHaveBeenCalledWith({
      jobId: JOB_ID,
      sourceBytes: originalBytes,
      sourceSha256,
    });
    expect(falPort.submit).toHaveBeenCalledTimes(1);
    expect(falPort.submit).toHaveBeenCalledWith(
      KLING_O3_STANDARD_EDIT_ENDPOINT,
      {
        prompt: PROMPT,
        video_url: "https://fal.media/real-source.mp4",
        ...KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
      },
    );
    expect(submitted).toEqual({
      id: JOB_ID,
      state: "submitted",
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      generationDigest: prepared.generationDigest,
      prompt: PROMPT,
      sourceSha256,
      editMaskSha256: EDIT_MASK_SHA256,
      requestId: REQUEST_ID,
      remoteStatus: "IN_QUEUE",
    });

    await expect(
      subject.submit(
        {
          jobId: prepared.id,
          generationDigest: prepared.generationDigest,
          ...PAID_CONFIRMATION,
        },
        TEST_PRICING,
      ),
    ).rejects.toMatchObject({ code: "JOB_ALREADY_ACTIVE" });
    expect(falPort.uploadSource).toHaveBeenCalledTimes(1);
    expect(falPort.submit).toHaveBeenCalledTimes(1);

    const persisted = await jobStore.readJob(JOB_ID);
    expect(persisted.fal).not.toHaveProperty("maskUploadUrl");
  });

  it("rejects a controller whose generation identity differs from the prepared job", async () => {
    const prepared = await controller().prepare();
    const changed = controller({ prompt: `${PROMPT} Add snowfall.` });

    await expect(
      changed.submit(
        {
          jobId: prepared.id,
          generationDigest: prepared.generationDigest,
          ...PAID_CONFIRMATION,
        },
        TEST_PRICING,
      ),
    ).rejects.toMatchObject({ code: "GENERATION_IDENTITY_MISMATCH" });
    expect((await jobStore.readJob(JOB_ID)).state).toBe("validated");
    expect(falPort.uploadSource).not.toHaveBeenCalled();
    expect(falPort.submit).not.toHaveBeenCalled();
  });

  it("permits only one concurrent submit attempt at the store boundary", async () => {
    const subject = controller();
    const prepared = await subject.prepare();
    const confirmation = {
      jobId: prepared.id,
      generationDigest: prepared.generationDigest,
      ...PAID_CONFIRMATION,
    };

    const outcomes = await Promise.allSettled([
      subject.submit(confirmation, TEST_PRICING),
      subject.submit(confirmation, TEST_PRICING),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(
      1,
    );
    expect(falPort.uploadSource).toHaveBeenCalledTimes(1);
    expect(falPort.submit).toHaveBeenCalledTimes(1);
  });

  it("does not let two jobs reserve the final global paid-attempt slot", async () => {
    for (const [index, id] of ["spent-one", "spent-two"].entries()) {
      const spent = await jobStore.createValidatedJob({
        id,
        generation: {
          sourceSha256,
          editMaskSha256: EDIT_MASK_SHA256,
          prompt: PROMPT,
          endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
          parameters: KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
        },
      });
      const active = await jobStore.beginSubmission(
        spent.id,
        bindPaidAttemptBudget(
          { used: index, next: index + 1, cap: 3 },
          TEST_PRICING,
        ),
      );
      await jobStore.persistSubmissionFailure({
        jobId: spent.id,
        generationDigest: spent.generation.digest,
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        code: "FAL_SUBMISSION_REJECTED",
        paidAttempt: active.paidAttempt,
      });
    }

    const candidates = ["candidate-a", "candidate-b"].map((jobId) =>
      createRealKlingJobController({
        jobStore: new LocalJobStore(root),
        jobId,
        sourceBytes,
        sourceSha256,
        editMaskSha256: EDIT_MASK_SHA256,
        prompt: PROMPT,
        now: () => new Date(FRESH_NOW),
        assertPaidRuntimeReady,
        assertInputEvidenceCurrentBeforePaidPost,
        fal: falPort,
      }),
    );
    const prepared = await Promise.all(
      candidates.map((candidate) => candidate.prepare()),
    );

    const outcomes = await Promise.allSettled(
      candidates.map((candidate, index) =>
        candidate.submit(
          {
            jobId: prepared[index].id,
            generationDigest: prepared[index].generationDigest,
            authorization: REAL_KLING_PAID_CONFIRMATION,
            pricingObservationDigest: TEST_PRICING_DIGEST,
          },
          TEST_PRICING,
        ),
      ),
    );

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome.status === "rejected"),
    ).toMatchObject({
      reason: {
        code: "PAID_ATTEMPT_CAP_REACHED",
        budget: { used: 3, next: 4, cap: 3 },
      },
    });
    expect(falPort.uploadSource).toHaveBeenCalledTimes(1);
    expect(falPort.submit).toHaveBeenCalledTimes(1);
    await expect(inspectPaidAttemptBudget(jobStore)).resolves.toEqual({
      used: 3,
      next: 4,
      cap: 3,
    });
  });

  it("records source-upload failure without making a paid submit call", async () => {
    falPort.uploadSource = vi.fn(async () => {
      throw new Error("upload unavailable");
    });
    const subject = controller();
    const prepared = await subject.prepare();

    const failed = await subject.submit(
      {
        jobId: prepared.id,
        generationDigest: prepared.generationDigest,
        ...PAID_CONFIRMATION,
      },
      TEST_PRICING,
    );

    expect(failed).toMatchObject({
      state: "failed",
      failureCode: "SOURCE_UPLOAD_FAILED",
    });
    expect(falPort.submit).not.toHaveBeenCalled();
  });

  it("records an ambiguous paid POST once and never retries it", async () => {
    falPort.submit = vi.fn(async () => {
      throw new FalSubmissionError("FAL_SUBMISSION_OUTCOME_UNKNOWN");
    });
    const subject = controller();
    const prepared = await subject.prepare();
    const confirmation = {
      jobId: prepared.id,
      generationDigest: prepared.generationDigest,
      ...PAID_CONFIRMATION,
    };

    const unknown = await subject.submit(confirmation, TEST_PRICING);

    expect(unknown).toMatchObject({
      state: "submission_unknown",
      failureCode: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
    });
    await expect(subject.submit(confirmation, TEST_PRICING)).rejects.toMatchObject({
      code: "INVALID_JOB_STATE",
    });
    expect(falPort.submit).toHaveBeenCalledTimes(1);
  });

  it("terminalizes an accepted paid request when its first local persistence write fails", async () => {
    const persistSubmission = vi
      .spyOn(jobStore, "persistSubmission")
      .mockRejectedValueOnce(new Error("simulated pre-rename persistence failure"));
    const subject = controller();
    const prepared = await subject.prepare();

    const unknown = await subject.submit(
      {
        jobId: prepared.id,
        generationDigest: prepared.generationDigest,
        ...PAID_CONFIRMATION,
      },
      TEST_PRICING,
    );

    expect(unknown).toMatchObject({
      state: "submission_unknown",
      failureCode: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
    });
    expect(persistSubmission).toHaveBeenCalledTimes(1);
    expect(falPort.submit).toHaveBeenCalledTimes(1);
    expect((await jobStore.readJob(JOB_ID)).state).toBe("submission_unknown");
  });

  it("recovers the exact accepted request when persistence committed before surfacing an error", async () => {
    const persistSubmission = jobStore.persistSubmission.bind(jobStore);
    vi.spyOn(jobStore, "persistSubmission").mockImplementationOnce(
      async (input) => {
        await persistSubmission(input);
        throw new Error("simulated post-rename persistence failure");
      },
    );
    const subject = controller();
    const prepared = await subject.prepare();

    const submitted = await subject.submit(
      {
        jobId: prepared.id,
        generationDigest: prepared.generationDigest,
        ...PAID_CONFIRMATION,
      },
      TEST_PRICING,
    );

    expect(submitted).toMatchObject({
      state: "submitted",
      requestId: REQUEST_ID,
    });
    expect(falPort.submit).toHaveBeenCalledTimes(1);
    expect((await jobStore.readJob(JOB_ID)).state).toBe("submitted");
  });

  it("makes no paid POST when source upload crosses the submission lease deadline", async () => {
    falPort.uploadSource = vi.fn(async () => {
      const recordPath = join(root, JOB_ID, "job.json");
      const expired = JSON.parse(await readFile(recordPath, "utf8"));
      expired.submissionLease.leaseExpiresAt = "2000-01-01T00:15:00.000Z";
      await writeFile(
        recordPath,
        `${JSON.stringify(expired, null, 2)}\n`,
        "utf8",
      );
      return "https://fal.media/real-source.mp4";
    });
    const subject = controller();
    const prepared = await subject.prepare();

    const unknown = await subject.submit(
      {
        jobId: prepared.id,
        generationDigest: prepared.generationDigest,
        ...PAID_CONFIRMATION,
      },
      TEST_PRICING,
    );

    expect(unknown).toMatchObject({
      state: "submission_unknown",
      failureCode: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
    });
    expect(falPort.uploadSource).toHaveBeenCalledTimes(1);
    expect(falPort.submit).not.toHaveBeenCalled();
  });

  it("makes no paid POST when the authorized price expires during source upload", async () => {
    let currentTime = new Date(FRESH_NOW);
    falPort.uploadSource = vi.fn(async () => {
      currentTime = new Date(
        Date.parse(TEST_PRICING.priceObservedAt) +
          KLING_O3_STANDARD_EDIT_PRICING_MAX_AGE_MS +
          1,
      );
      return "https://fal.media/real-source.mp4";
    });
    const subject = controller({ now: () => currentTime });
    const prepared = await subject.prepare();

    const expired = await subject.submit(
      {
        jobId: prepared.id,
        generationDigest: prepared.generationDigest,
        ...PAID_CONFIRMATION,
      },
      TEST_PRICING,
    );

    expect(expired).toMatchObject({
      state: "failed",
      failureCode: "PRICING_OBSERVATION_EXPIRED_BEFORE_SUBMISSION",
    });
    expect(falPort.uploadSource).toHaveBeenCalledTimes(1);
    expect(falPort.submit).not.toHaveBeenCalled();
    expect(await inspectPaidAttemptBudget(jobStore)).toEqual({
      used: 0,
      next: 1,
      cap: 3,
    });
  });

  it("makes no paid POST when bound input evidence changes during source upload", async () => {
    assertInputEvidenceCurrentBeforePaidPost.mockRejectedValueOnce(
      new Error("mask changed after initial rehash"),
    );
    const subject = controller();
    const prepared = await subject.prepare();

    const changed = await subject.submit(
      {
        jobId: prepared.id,
        generationDigest: prepared.generationDigest,
        ...PAID_CONFIRMATION,
      },
      TEST_PRICING,
    );

    expect(changed).toMatchObject({
      state: "failed",
      failureCode: "INPUT_EVIDENCE_CHANGED_BEFORE_SUBMISSION",
    });
    expect(assertInputEvidenceCurrentBeforePaidPost).toHaveBeenCalledOnce();
    expect(falPort.uploadSource).toHaveBeenCalledOnce();
    expect(falPort.submit).not.toHaveBeenCalled();
    expect(await inspectPaidAttemptBudget(jobStore)).toEqual({
      used: 0,
      next: 1,
      cap: 3,
    });
  });

  it("keeps a raced accepted POST terminal-unknown and never submits twice", async () => {
    falPort.submit = vi.fn(async () => {
      const recordPath = join(root, JOB_ID, "job.json");
      const expired = JSON.parse(await readFile(recordPath, "utf8"));
      expired.submissionLease.leaseExpiresAt = "2000-01-01T00:15:00.000Z";
      await writeFile(
        recordPath,
        `${JSON.stringify(expired, null, 2)}\n`,
        "utf8",
      );
      await jobStore.reconcileStaleSubmission(JOB_ID);
      return { requestId: REQUEST_ID, remoteStatus: "IN_QUEUE" };
    });
    const subject = controller();
    const prepared = await subject.prepare();

    const unknown = await subject.submit(
      {
        jobId: prepared.id,
        generationDigest: prepared.generationDigest,
        ...PAID_CONFIRMATION,
      },
      TEST_PRICING,
    );

    expect(unknown).toMatchObject({
      state: "submission_unknown",
      failureCode: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
    });
    expect(falPort.submit).toHaveBeenCalledTimes(1);
    expect((await jobStore.readJob(JOB_ID)).state).toBe("submission_unknown");
  });

  it("terminalizes a crash-stale submitting job without any fal call", async () => {
    const subject = controller();
    const prepared = await subject.prepare();
    await jobStore.beginSubmission(JOB_ID, PAID_ATTEMPT);
    const recordPath = join(root, JOB_ID, "job.json");
    const stale = JSON.parse(await readFile(recordPath, "utf8"));
    stale.submissionLease = {
      schemaVersion: 1,
      ownerPid: 2_147_483_647,
      ownerHost: hostname(),
      ownerToken: "crashed-real-paid-submit-owner",
      acquiredAt: stale.paidAttempt.capturedAt,
      leaseExpiresAt: "2000-01-01T00:15:00.000Z",
    };
    await writeFile(recordPath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");

    const recovered = await subject.poll();

    expect(recovered).toMatchObject({
      state: "submission_unknown",
      generationDigest: prepared.generationDigest,
      failureCode: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
    });
    expect(falPort.uploadSource).not.toHaveBeenCalled();
    expect(falPort.submit).not.toHaveBeenCalled();
    expect(falPort.status).not.toHaveBeenCalled();
    expect(falPort.result).not.toHaveBeenCalled();
    expect(falPort.downloadOutput).not.toHaveBeenCalled();
  });

  it("polls only persisted provenance and completes with a redacted view", async () => {
    const subject = controller();
    const prepared = await subject.prepare();
    await subject.submit(
      {
        jobId: prepared.id,
        generationDigest: prepared.generationDigest,
        ...PAID_CONFIRMATION,
      },
      TEST_PRICING,
    );

    const generated = await subject.poll();

    expect(falPort.status).toHaveBeenCalledWith(
      KLING_O3_STANDARD_EDIT_ENDPOINT,
      REQUEST_ID,
    );
    expect(falPort.result).toHaveBeenCalledWith(
      KLING_O3_STANDARD_EDIT_ENDPOINT,
      REQUEST_ID,
    );
    expect(falPort.downloadOutput).toHaveBeenCalledWith(
      JOB_ID,
      "https://fal.media/real-generated.mp4",
    );
    expect(generated).toEqual({
      id: JOB_ID,
      state: "generated",
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      generationDigest: prepared.generationDigest,
      prompt: PROMPT,
      sourceSha256,
      editMaskSha256: EDIT_MASK_SHA256,
      requestId: REQUEST_ID,
      remoteStatus: "COMPLETED",
      modelOutputSha256: MODEL_OUTPUT_SHA256,
    });
    expect(JSON.stringify(generated)).not.toContain("real-source.mp4");
    expect(JSON.stringify(generated)).not.toContain("real-generated.mp4");
  });
});
