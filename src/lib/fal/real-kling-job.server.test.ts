import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

vi.mock("server-only", () => ({}));
vi.mock("./client.server", () => ({
  fal: {
    storage: { upload: vi.fn() },
    queue: { status: vi.fn(), result: vi.fn() },
  },
}));

import { ActiveJobRegistry } from "../jobs/active-job-registry";
import { LocalJobStore } from "../jobs/local-job-store";
import type { PaidAttemptPricingObservation } from "../jobs/paid-attempt-pricing";
import { computePricingObservationDigest } from "../jobs/pricing-receipt";
import type { RealKlingFalPort } from "./real-kling-job-core";
import {
  KLING_O3_STANDARD_EDIT_ENDPOINT,
  KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
} from "./kling-contract";
import { REAL_KLING_PAID_CONFIRMATION } from "./real-kling-request";
import { createRealKlingJobRuntime } from "./real-kling-job.server";

const JOB_ID = "ai_pricing_receipt_01";
const PROMPT = "Transform the exterior into a rain-soaked neon greenhouse.";
const PRICING_BASE = {
  unitPriceUsd: "0.126",
  billingUnit: "seconds",
  estimatedUnits: "5.041666667",
  estimatedCostUsd: "0.63525",
  pricingSource: "authenticated_fal_platform_pricing_api_v1_models_pricing",
} as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("real Kling runtime pricing receipt boundary", () => {
  let root: string;
  let jobsRoot: string;
  let runsRoot: string;
  let jobs: LocalJobStore;
  let activeJobs: ActiveJobRegistry;
  let sourceBytes: Uint8Array;
  let maskBytes: Uint8Array;
  let provenanceBytes: Uint8Array;
  let generationDigest: string;
  let provenanceFileSha256: string;
  let pricing: typeof PRICING_BASE & { priceObservedAt: string };
  let now: Date;
  let observePricing: Mock<() => Promise<PaidAttemptPricingObservation>>;
  let assertPaidRuntimeReady: Mock<() => void>;
  let fal: RealKlingFalPort;

  beforeEach(async () => {
    const priceObservedAt = new Date(Date.now() - 1_000);
    pricing = {
      ...PRICING_BASE,
      priceObservedAt: priceObservedAt.toISOString(),
    };
    now = new Date(priceObservedAt.getTime() + 1_000);
    root = await mkdtemp(join(tmpdir(), "framelock-pricing-runtime-"));
    jobsRoot = join(root, "jobs");
    runsRoot = join(root, "runs");
    jobs = new LocalJobStore(jobsRoot);
    activeJobs = new ActiveJobRegistry(
      jobsRoot,
      async (jobId) => (await jobs.readJob(jobId)).state,
    );
    sourceBytes = new TextEncoder().encode("canonical ai source mp4 bytes");
    maskBytes = new TextEncoder().encode("static foreground mask bytes");
    const sourceSha256 = sha256(sourceBytes);
    const maskSha256 = sha256(maskBytes);
    const provenance = {
      schemaVersion: 1 as const,
      provenanceLabel: "ai_generated_source" as const,
      originalImageSha256: "11".repeat(32),
      sourceBundleManifestSha256: "22".repeat(32),
      normalizedPlateSha256: "33".repeat(32),
      canonicalSourceMp4Sha256: sourceSha256,
      foregroundMaskSha256: maskSha256,
      contactSheetSha256: "44".repeat(32),
      approval: {
        recordSha256: "55".repeat(32),
        approvedAt: "2026-07-18T08:45:23.000Z",
        reviewer: "FrameLock executor",
        note: "Declared local visual approval metadata.",
      },
    };
    provenanceBytes = new TextEncoder().encode(
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    provenanceFileSha256 = sha256(provenanceBytes);
    const record = await jobs.createValidatedJob({
      id: JOB_ID,
      generation: {
        sourceSha256,
        editMaskSha256: maskSha256,
        prompt: PROMPT,
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        parameters: KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
      },
      sourceProvenance: {
        fileSha256: provenanceFileSha256,
        manifest: provenance,
      },
    });
    generationDigest = record.generation.digest;
    const inputs = join(runsRoot, JOB_ID, "inputs");
    await mkdir(inputs, { recursive: true });
    await Promise.all([
      writeFile(join(inputs, "source.mp4"), sourceBytes),
      writeFile(join(inputs, "foreground.png"), maskBytes),
      writeFile(join(inputs, "source-provenance.json"), provenanceBytes),
    ]);
    await activeJobs.claim({ jobId: JOB_ID });

    observePricing = vi.fn(async () => pricing);
    assertPaidRuntimeReady = vi.fn();
    fal = {
      uploadSource: vi.fn(async () => "https://fal.media/source.mp4"),
      submit: vi.fn(async () => ({
        requestId: "fal-request-01",
        remoteStatus: "IN_QUEUE",
      })),
      status: vi.fn(async () => ({ status: "IN_QUEUE" })),
      result: vi.fn(),
      downloadOutput: vi.fn(),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function runtime() {
    return createRealKlingJobRuntime({
      jobs,
      activeJobs,
      runsRoot,
      observePricing,
      now: () => new Date(now),
      assertPaidRuntimeReady,
      fal,
    });
  }

  it("refreshes and persists a no-spend receipt bound to job, generation and provenance", async () => {
    const receipt = await runtime().refreshPricing(JOB_ID);

    expect(observePricing).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      jobId: JOB_ID,
      generationDigest,
      sourceProvenanceFileSha256: provenanceFileSha256,
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      pricingObservation: pricing,
      pricingObservationDigest: computePricingObservationDigest(pricing),
    });
    await expect(
      jobs.readPricingReceipt({
        jobId: JOB_ID,
        generationDigest,
        pricingObservationDigest: receipt.pricingObservationDigest,
      }),
    ).resolves.toEqual(receipt);
    expect(assertPaidRuntimeReady).not.toHaveBeenCalled();
    expect(fal.uploadSource).not.toHaveBeenCalled();
    expect(fal.submit).not.toHaveBeenCalled();
  });

  it("requires the persisted receipt before runtime-key readiness, reservation or fal IO", async () => {
    await expect(
      runtime().submit({
        jobId: JOB_ID,
        generationDigest,
        authorization: REAL_KLING_PAID_CONFIRMATION,
        pricingObservationDigest: computePricingObservationDigest(pricing),
      }),
    ).rejects.toMatchObject({ code: "PRICING_RECEIPT_REQUIRED" });

    expect(assertPaidRuntimeReady).not.toHaveBeenCalled();
    expect(fal.uploadSource).not.toHaveBeenCalled();
    expect(fal.submit).not.toHaveBeenCalled();
    expect((await jobs.readJob(JOB_ID)).state).toBe("validated");
  });

  it("reopens persisted source, mask and provenance before the paid boundary", async () => {
    const receipt = await runtime().refreshPricing(JOB_ID);
    await writeFile(
      join(runsRoot, JOB_ID, "inputs", "foreground.png"),
      new TextEncoder().encode("tampered mask"),
    );

    await expect(
      runtime().submit({
        jobId: JOB_ID,
        generationDigest,
        authorization: REAL_KLING_PAID_CONFIRMATION,
        pricingObservationDigest: receipt.pricingObservationDigest,
      }),
    ).rejects.toMatchObject({ code: "AI_SOURCE_EVIDENCE_MISMATCH" });

    expect(assertPaidRuntimeReady).not.toHaveBeenCalled();
    expect(fal.uploadSource).not.toHaveBeenCalled();
    expect(fal.submit).not.toHaveBeenCalled();
    expect((await jobs.readJob(JOB_ID)).state).toBe("validated");
  });

  it("uses the exact resolved receipt for one fake submission", async () => {
    const receipt = await runtime().refreshPricing(JOB_ID);

    const submitted = await runtime().submit({
      jobId: JOB_ID,
      generationDigest,
      authorization: REAL_KLING_PAID_CONFIRMATION,
      pricingObservationDigest: receipt.pricingObservationDigest,
    });

    expect(submitted).toMatchObject({
      id: JOB_ID,
      state: "submitted",
      requestId: "fal-request-01",
    });
    expect(assertPaidRuntimeReady).toHaveBeenCalledOnce();
    expect(fal.uploadSource).toHaveBeenCalledOnce();
    expect(fal.submit).toHaveBeenCalledOnce();
    expect((await jobs.readJob(JOB_ID)).paidAttempt).toMatchObject(pricing);
  });

  it.each(["foreground.png", "source-provenance.json"])(
    "rehashes %s after source upload and makes no paid POST if it changed",
    async (filename) => {
      const receipt = await runtime().refreshPricing(JOB_ID);
      fal.uploadSource = vi.fn(async () => {
        await writeFile(
          join(runsRoot, JOB_ID, "inputs", filename),
          new TextEncoder().encode(`tampered ${filename}`),
        );
        return "https://fal.media/source.mp4";
      });

      const failed = await runtime().submit({
        jobId: JOB_ID,
        generationDigest,
        authorization: REAL_KLING_PAID_CONFIRMATION,
        pricingObservationDigest: receipt.pricingObservationDigest,
      });

      expect(failed).toMatchObject({
        state: "failed",
        failureCode: "INPUT_EVIDENCE_CHANGED_BEFORE_SUBMISSION",
      });
      expect(fal.uploadSource).toHaveBeenCalledOnce();
      expect(fal.submit).not.toHaveBeenCalled();
    },
  );
});
