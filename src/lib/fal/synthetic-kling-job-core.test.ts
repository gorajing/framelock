import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalJobStore } from "../jobs/local-job-store";
import { bindPaidAttemptBudget } from "../jobs/paid-attempt-budget";
import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "./kling-contract";
import {
  KLING_FALLBACK_JOB_ID,
  KLING_FALLBACK_PROMPT,
} from "./kling-fallback-request";
import {
  createKlingFallbackController,
  type KlingFallbackFalPort,
} from "./synthetic-kling-job-core";

const SOURCE_SHA256 = "11".repeat(32);
const RESTORATION_MASK_SHA256 = "22".repeat(32);
const MODEL_OUTPUT_SHA256 = "33".repeat(32);
const REQUEST_ID = "fal-kling-request-1";
const HISTORICAL_PRICING = {
  unitPriceUsd: "0.14",
  billingUnit: "seconds",
  estimatedUnits: "5.041666667",
  estimatedCostUsd: "0.7058333334",
  pricingSource: "authenticated_fal_pricing_and_estimate",
  priceObservedAt: "2026-07-17T18:47:33.000Z",
} as const;
const PAID_ATTEMPT = bindPaidAttemptBudget(
  { used: 0, next: 1, cap: 3 },
  HISTORICAL_PRICING,
);

describe("historical Kling reconciliation controller", () => {
  let root: string;
  let jobStore: LocalJobStore;
  let falPort: KlingFallbackFalPort;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-kling-controller-"));
    jobStore = new LocalJobStore(root);
    falPort = {
      status: vi.fn(async () => ({ status: "COMPLETED" })),
      result: vi.fn(async () => ({
        requestId: REQUEST_ID,
        data: {
          video: {
            url: "https://fal.media/generated.mp4",
            content_type: "video/mp4",
          },
        },
      })),
      downloadOutput: vi.fn(async () => ({
        path: join(root, KLING_FALLBACK_JOB_ID, "model-output.mp4"),
        sha256: MODEL_OUTPUT_SHA256,
        bytes: 1234,
      })),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function controller() {
    return createKlingFallbackController({
      jobStore,
      fal: falPort,
    });
  }

  async function seedSubmittedJob() {
    const created = await jobStore.createValidatedJob({
      id: KLING_FALLBACK_JOB_ID,
      generation: {
        sourceSha256: SOURCE_SHA256,
        editMaskSha256: RESTORATION_MASK_SHA256,
        prompt: KLING_FALLBACK_PROMPT,
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        parameters: {},
      },
    });
    const active = await jobStore.beginSubmission(created.id, PAID_ATTEMPT);
    if (!active.paidAttempt) {
      throw new Error("seeded historical job is missing paid provenance");
    }
    return jobStore.persistSubmission({
      jobId: created.id,
      generationDigest: created.generation.digest,
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      requestId: REQUEST_ID,
      sourceUploadUrl: "https://fal.media/source.mp4",
      paidAttempt: active.paidAttempt,
    });
  }

  it("exposes no legacy paid submission capability", () => {
    expect(controller()).not.toHaveProperty("submit");
  });

  it("terminalizes a crash-stale submitting job without any fal call", async () => {
    const created = await jobStore.createValidatedJob({
      id: KLING_FALLBACK_JOB_ID,
      generation: {
        sourceSha256: SOURCE_SHA256,
        editMaskSha256: RESTORATION_MASK_SHA256,
        prompt: KLING_FALLBACK_PROMPT,
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        parameters: {},
      },
    });
    await jobStore.beginSubmission(created.id, PAID_ATTEMPT);
    const recordPath = join(root, KLING_FALLBACK_JOB_ID, "job.json");
    const stale = JSON.parse(await readFile(recordPath, "utf8"));
    stale.submissionLease = {
      schemaVersion: 1,
      ownerPid: 2_147_483_647,
      ownerHost: hostname(),
      ownerToken: "crashed-paid-submit-owner",
      acquiredAt: stale.paidAttempt.capturedAt,
      leaseExpiresAt: "2000-01-01T00:15:00.000Z",
    };
    await writeFile(recordPath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");

    const subject = controller();
    const recovered = await subject.poll();

    expect(recovered).toMatchObject({
      state: "submission_unknown",
      failureCode: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
    });
    expect(falPort.status).not.toHaveBeenCalled();
    expect(falPort.result).not.toHaveBeenCalled();
    expect(falPort.downloadOutput).not.toHaveBeenCalled();
    expect((await jobStore.readJob(KLING_FALLBACK_JOB_ID)).state).toBe(
      "submission_unknown",
    );
  });

  it("polls only the persisted request and returns a redacted generated view", async () => {
    await seedSubmittedJob();
    const subject = controller();

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
      KLING_FALLBACK_JOB_ID,
      "https://fal.media/generated.mp4",
    );
    expect(generated).toEqual({
      id: KLING_FALLBACK_JOB_ID,
      state: "generated",
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      requestId: REQUEST_ID,
      remoteStatus: "COMPLETED",
      modelOutputSha256: MODEL_OUTPUT_SHA256,
    });
    expect(JSON.stringify(generated)).not.toContain("source.mp4");
    expect(JSON.stringify(generated)).not.toContain("generated.mp4");
  });

  it("coalesces concurrent completion polls into one result/download", async () => {
    await seedSubmittedJob();
    const subject = controller();

    const [first, second] = await Promise.all([subject.poll(), subject.poll()]);

    expect(second).toEqual(first);
    expect(falPort.status).toHaveBeenCalledTimes(1);
    expect(falPort.result).toHaveBeenCalledTimes(1);
    expect(falPort.downloadOutput).toHaveBeenCalledTimes(1);
  });

  it("refuses a result whose request ID differs from persisted provenance", async () => {
    falPort.result = vi.fn(async () => ({
      requestId: "another-request",
      data: { video: { url: "https://fal.media/generated.mp4" } },
    }));
    await seedSubmittedJob();
    const subject = controller();

    await expect(subject.poll()).rejects.toThrow(
      "differs from the submitted request",
    );
    expect(falPort.downloadOutput).not.toHaveBeenCalled();
    expect((await jobStore.readJob(KLING_FALLBACK_JOB_ID)).state).toBe(
      "submitted",
    );
  });

  it("records an error-bearing completion as terminal failed", async () => {
    falPort.status = vi.fn(async () => ({
      status: "COMPLETED",
      error: "Runner failed",
      errorType: "INTERNAL_SERVER_ERROR",
    }));
    await seedSubmittedJob();
    const subject = controller();

    const failed = await subject.poll();

    expect(failed).toEqual({
      id: KLING_FALLBACK_JOB_ID,
      state: "failed",
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      requestId: REQUEST_ID,
      remoteStatus: "COMPLETED",
      failureCode: "GENERATION_FAILED",
    });
    expect(JSON.stringify(failed)).not.toContain("Runner failed");
    expect(falPort.result).not.toHaveBeenCalled();
    expect(falPort.downloadOutput).not.toHaveBeenCalled();
  });
});
