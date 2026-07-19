import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { ActiveJobRegistry } from "../jobs/active-job-registry";
import {
  AiSourceProvenanceError,
  assertAiSourceProvenanceMediaBindings,
  parseAiSourceProvenanceBytes,
} from "../jobs/ai-source-provenance";
import {
  JobStoreError,
  LocalJobStore,
  type LocalJobRecord,
} from "../jobs/local-job-store";
import { assertPaidAttemptAvailable } from "../jobs/paid-attempt-budget";
import type { PaidAttemptPricingObservation } from "../jobs/paid-attempt-pricing";
import {
  createPricingReceipt,
  type PricingReceipt,
} from "../jobs/pricing-receipt";
import { fal } from "./client.server";
import { downloadFalMedia } from "./fal-media-download";
import { submitFalQueueOnce } from "./fal-queue-single-submit";
import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "./kling-contract";
import { observeKlingO3StandardEditPricing } from "./kling-pricing.server";
import {
  createRealKlingJobController,
  type RealKlingFalPort,
} from "./real-kling-job-core";
import { REAL_KLING_PAID_CONFIRMATION } from "./real-kling-request";

const artifactsRoot = join(process.cwd(), "artifacts");
const jobsRoot = join(artifactsRoot, "jobs");
const runsRoot = join(artifactsRoot, "runs");
const jobs = new LocalJobStore(jobsRoot);
const activeJobs = new ActiveJobRegistry(
  jobsRoot,
  async (jobId) => (await jobs.readJob(jobId)).state,
);

export class RealKlingRuntimeError extends Error {
  constructor(
    readonly code:
      | "ACTIVE_JOB_MISMATCH"
      | "AI_SOURCE_EVIDENCE_MISMATCH"
      | "FAL_KEY_MISSING"
      | "PRICING_RECEIPT_REQUIRED",
  ) {
    super(code);
    this.name = "RealKlingRuntimeError";
  }
}

function requireRuntimeKey(): void {
  if (!process.env.FAL_KEY) {
    throw new RealKlingRuntimeError("FAL_KEY_MISSING");
  }
}

function normalizeRemoteStatus(status: unknown): {
  status: string;
  error?: string;
  errorType?: string;
} {
  if (!status || typeof status !== "object") {
    throw new Error("fal returned an invalid queue status");
  }
  const record = status as Record<string, unknown>;
  if (typeof record.status !== "string" || !record.status) {
    throw new Error("fal queue status is missing a state");
  }
  return {
    status: record.status,
    ...(typeof record.error === "string" && record.error
      ? { error: record.error }
      : {}),
    ...(typeof record.error_type === "string" && record.error_type
      ? { errorType: record.error_type }
      : {}),
  };
}

function createFalPort(): RealKlingFalPort {
  return {
    async uploadSource({ jobId, sourceBytes }) {
      return fal.storage.upload(
        new File([new Uint8Array(sourceBytes)], `${jobId}-source.mp4`, {
          type: "video/mp4",
        }),
        { lifecycle: { expiresIn: "1h" } },
      );
    },
    async submit(endpoint, input) {
      return submitFalQueueOnce({
        endpoint,
        input,
        credentials: process.env.FAL_KEY ?? "",
      });
    },
    async status(endpoint, requestId) {
      return normalizeRemoteStatus(
        await fal.queue.status(endpoint, { requestId, logs: true }),
      );
    },
    async result(endpoint, requestId) {
      const result = await fal.queue.result(endpoint, { requestId });
      return { requestId: result.requestId, data: result.data };
    },
    async downloadOutput(jobId, url) {
      return downloadFalMedia({
        url,
        destination: join(jobsRoot, jobId, "model-output.mp4"),
      });
    },
  };
}

type RealKlingJobRuntimeDependencies = Readonly<{
  jobs: LocalJobStore;
  activeJobs: Pick<ActiveJobRegistry, "read">;
  runsRoot: string;
  observePricing(): Promise<PaidAttemptPricingObservation>;
  now(): Date;
  assertPaidRuntimeReady(): void;
  fal: RealKlingFalPort;
}>;

type BoundAiSourceEvidence = Readonly<{
  record: LocalJobRecord;
  sourceProvenance: NonNullable<LocalJobRecord["sourceProvenance"]>;
  sourceBytes: Uint8Array;
}>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createRealKlingJobRuntime(
  dependencies: RealKlingJobRuntimeDependencies,
) {
  async function assertActiveJob(jobId: string): Promise<void> {
    if ((await dependencies.activeJobs.read())?.jobId !== jobId) {
      throw new RealKlingRuntimeError("ACTIVE_JOB_MISMATCH");
    }
  }

  async function readBoundAiSourceEvidence(
    jobId: string,
  ): Promise<BoundAiSourceEvidence> {
    const record = await dependencies.jobs.readJob(jobId);
    if (
      record.generation.endpoint !== KLING_O3_STANDARD_EDIT_ENDPOINT ||
      !record.sourceProvenance
    ) {
      throw new RealKlingRuntimeError("AI_SOURCE_EVIDENCE_MISMATCH");
    }
    try {
      const inputs = join(dependencies.runsRoot, jobId, "inputs");
      const [sourceBuffer, maskBuffer, provenanceBuffer] = await Promise.all([
        readFile(join(inputs, "source.mp4")),
        readFile(join(inputs, "foreground.png")),
        readFile(join(inputs, "source-provenance.json")),
      ]);
      const sourceBytes = new Uint8Array(sourceBuffer);
      const maskBytes = new Uint8Array(maskBuffer);
      const provenanceBytes = new Uint8Array(provenanceBuffer);
      const provenance = parseAiSourceProvenanceBytes(provenanceBytes);
      assertAiSourceProvenanceMediaBindings(provenance, {
        canonicalSourceMp4Sha256: sha256(sourceBytes),
        foregroundMaskSha256: sha256(maskBytes),
      });
      if (
        sha256(sourceBytes) !== record.generation.sourceSha256 ||
        sha256(maskBytes) !== record.generation.editMaskSha256 ||
        sha256(provenanceBytes) !== record.sourceProvenance.fileSha256 ||
        !isDeepStrictEqual(provenance, record.sourceProvenance.manifest)
      ) {
        throw new AiSourceProvenanceError("PROVENANCE_SOURCE_MISMATCH");
      }
      return {
        record,
        sourceProvenance: record.sourceProvenance,
        sourceBytes,
      };
    } catch {
      throw new RealKlingRuntimeError("AI_SOURCE_EVIDENCE_MISMATCH");
    }
  }

  function controller(evidence: BoundAiSourceEvidence) {
    return createRealKlingJobController({
      jobStore: dependencies.jobs,
      jobId: evidence.record.id,
      sourceBytes: evidence.sourceBytes,
      sourceSha256: evidence.record.generation.sourceSha256,
      editMaskSha256: evidence.record.generation.editMaskSha256,
      prompt: evidence.record.generation.prompt,
      now: dependencies.now,
      assertPaidRuntimeReady: dependencies.assertPaidRuntimeReady,
      async assertInputEvidenceCurrentBeforePaidPost() {
        const reopened = await readBoundAiSourceEvidence(evidence.record.id);
        if (
          !isDeepStrictEqual(
            reopened.record.generation,
            evidence.record.generation,
          ) ||
          !isDeepStrictEqual(
            reopened.sourceProvenance,
            evidence.sourceProvenance,
          ) ||
          sha256(reopened.sourceBytes) !== sha256(evidence.sourceBytes)
        ) {
          throw new RealKlingRuntimeError("AI_SOURCE_EVIDENCE_MISMATCH");
        }
      },
      fal: dependencies.fal,
    });
  }

  async function refreshPricing(jobId: string): Promise<PricingReceipt> {
    await assertActiveJob(jobId);
    await assertPaidAttemptAvailable(dependencies.jobs);
    const evidence = await readBoundAiSourceEvidence(jobId);
    if (evidence.record.state !== "validated") {
      throw new JobStoreError(
        "INVALID_JOB_STATE",
        `Job ${jobId} cannot refresh pricing from ${evidence.record.state}`,
      );
    }
    const pricingObservation = await dependencies.observePricing();
    return dependencies.jobs.persistPricingReceipt(
      createPricingReceipt({
        jobId,
        generationDigest: evidence.record.generation.digest,
        sourceProvenanceFileSha256: evidence.sourceProvenance.fileSha256,
        pricingObservation,
      }),
    );
  }

  async function submit(input: {
    jobId: string;
    generationDigest: string;
    authorization: typeof REAL_KLING_PAID_CONFIRMATION;
    pricingObservationDigest: string;
  }) {
    await assertActiveJob(input.jobId);
    await assertPaidAttemptAvailable(dependencies.jobs);
    const evidence = await readBoundAiSourceEvidence(input.jobId);
    let receipt: PricingReceipt;
    try {
      receipt = await dependencies.jobs.readPricingReceipt({
        jobId: input.jobId,
        generationDigest: input.generationDigest,
        pricingObservationDigest: input.pricingObservationDigest,
      });
    } catch (error) {
      if (
        error instanceof JobStoreError &&
        [
          "PRICING_RECEIPT_MISSING",
          "PRICING_RECEIPT_MISMATCH",
        ].includes(error.code)
      ) {
        throw new RealKlingRuntimeError("PRICING_RECEIPT_REQUIRED");
      }
      throw error;
    }
    return controller(evidence).submit(
      {
        jobId: input.jobId,
        generationDigest: input.generationDigest,
        authorization: input.authorization,
        pricingObservationDigest: input.pricingObservationDigest,
      },
      receipt.pricingObservation,
    );
  }

  async function poll(jobId: string) {
    await assertActiveJob(jobId);
    dependencies.assertPaidRuntimeReady();
    return controller(await readBoundAiSourceEvidence(jobId)).poll();
  }

  return { refreshPricing, submit, poll };
}

const runtimeController = createRealKlingJobRuntime({
  jobs,
  activeJobs,
  runsRoot,
  observePricing: observeKlingO3StandardEditPricing,
  now: () => new Date(),
  assertPaidRuntimeReady: requireRuntimeKey,
  fal: createFalPort(),
});

export const refreshRealKlingPricing = runtimeController.refreshPricing;
export const submitRealKlingJob = runtimeController.submit;
export const pollRealKlingJob = runtimeController.poll;

export { KLING_O3_STANDARD_EDIT_ENDPOINT };
