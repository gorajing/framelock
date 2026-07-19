import type { LocalJobRecord, LocalJobStore } from "../jobs/local-job-store";
import type { PaidAttemptSnapshot } from "../jobs/paid-attempt-provenance";
import {
  KLING_O3_STANDARD_EDIT_ENDPOINT,
  klingO3EditOutputSchema,
} from "./kling-contract";
import { KLING_FALLBACK_JOB_ID } from "./kling-fallback-request";

export type KlingFallbackFalPort = {
  status(
    endpoint: typeof KLING_O3_STANDARD_EDIT_ENDPOINT,
    requestId: string,
  ): Promise<{ status: string; error?: string; errorType?: string }>;
  result(
    endpoint: typeof KLING_O3_STANDARD_EDIT_ENDPOINT,
    requestId: string,
  ): Promise<{ requestId: string; data: unknown }>;
  downloadOutput(
    jobId: typeof KLING_FALLBACK_JOB_ID,
    url: string,
  ): Promise<{ path: string; sha256: string; bytes: number }>;
};

export type KlingFallbackSafeJobView = {
  id: typeof KLING_FALLBACK_JOB_ID;
  state: LocalJobRecord["state"];
  endpoint: typeof KLING_O3_STANDARD_EDIT_ENDPOINT;
  requestId?: string;
  remoteStatus?: string;
  failureCode?:
    | "SOURCE_UPLOAD_FAILED"
    | "PRICING_OBSERVATION_EXPIRED_BEFORE_SUBMISSION"
    | "INPUT_EVIDENCE_CHANGED_BEFORE_SUBMISSION"
    | "FAL_SUBMISSION_REJECTED"
    | "FAL_SUBMISSION_OUTCOME_UNKNOWN"
    | "GENERATION_FAILED";
  modelOutputSha256?: string;
};

type ControllerDependencies = {
  jobStore: LocalJobStore;
  fal: KlingFallbackFalPort;
};

function paidAttemptSnapshot(record: LocalJobRecord): PaidAttemptSnapshot {
  if (!record.paidAttempt) {
    throw new Error("Kling fallback job is missing paid attempt provenance");
  }
  return record.paidAttempt;
}

function safeView(
  record: LocalJobRecord,
  remoteStatus?: string,
): KlingFallbackSafeJobView {
  if (record.id !== KLING_FALLBACK_JOB_ID) {
    throw new Error("Kling fallback store returned an unexpected job ID");
  }
  const failureCode = record.failure
    ? record.failure.source === "fal_submission"
      ? record.failure.code
      : "GENERATION_FAILED"
    : undefined;
  return {
    id: KLING_FALLBACK_JOB_ID,
    state: record.state,
    endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
    ...(record.fal?.requestId ? { requestId: record.fal.requestId } : {}),
    ...(remoteStatus ? { remoteStatus } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(record.fal?.modelOutput?.sha256
      ? { modelOutputSha256: record.fal.modelOutput.sha256 }
      : {}),
  };
}

export function createKlingFallbackController(
  dependencies: ControllerDependencies,
) {
  let completionFlight: Promise<KlingFallbackSafeJobView> | undefined;

  async function finishCompletedJob(
    record: LocalJobRecord,
  ): Promise<KlingFallbackSafeJobView> {
    if (!record.fal) {
      throw new Error("Submitted Kling job is missing fal provenance");
    }
    const result = await dependencies.fal.result(
      KLING_O3_STANDARD_EDIT_ENDPOINT,
      record.fal.requestId,
    );
    if (result.requestId !== record.fal.requestId) {
      throw new Error("fal result request ID differs from the submitted request");
    }
    const output = klingO3EditOutputSchema.parse(result.data);
    const downloaded = await dependencies.fal.downloadOutput(
      KLING_FALLBACK_JOB_ID,
      output.video.url,
    );
    const completed = await dependencies.jobStore.persistCompletion({
      jobId: record.id,
      generationDigest: record.generation.digest,
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      requestId: record.fal.requestId,
      falStatus: "COMPLETED",
      paidAttempt: paidAttemptSnapshot(record),
      modelOutput: {
        artifactId: `sha256:${downloaded.sha256}`,
        sha256: downloaded.sha256,
        url: output.video.url,
        contentType: output.video.content_type ?? "video/mp4",
      },
    });
    return safeView(completed, "COMPLETED");
  }

  async function pollOnce(): Promise<KlingFallbackSafeJobView> {
    let record = await dependencies.jobStore.readJob(KLING_FALLBACK_JOB_ID);
    if (record.state === "submitting") {
      record = await dependencies.jobStore.reconcileStaleSubmission(
        KLING_FALLBACK_JOB_ID,
      );
    }
    if (record.state !== "submitted" || !record.fal) {
      return safeView(record);
    }
    const status = await dependencies.fal.status(
      KLING_O3_STANDARD_EDIT_ENDPOINT,
      record.fal.requestId,
    );
    if (status.status !== "COMPLETED") {
      return safeView(record, status.status);
    }
    if (status.error) {
      const failed = await dependencies.jobStore.persistCompletion({
        jobId: record.id,
        generationDigest: record.generation.digest,
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        requestId: record.fal.requestId,
        falStatus: "COMPLETED",
        paidAttempt: paidAttemptSnapshot(record),
        error: status.error,
        ...(status.errorType ? { errorType: status.errorType } : {}),
      });
      return safeView(failed, status.status);
    }
    return finishCompletedJob(record);
  }

  function poll(): Promise<KlingFallbackSafeJobView> {
    completionFlight ??= pollOnce().finally(() => {
      completionFlight = undefined;
    });
    return completionFlight;
  }

  return { poll };
}
