import "server-only";

import { join } from "node:path";

import { LocalJobStore, type LocalJobRecord } from "../jobs/local-job-store";
import { fal } from "./client.server";
import { downloadFalMedia } from "./fal-media-download";
import { LTX_ENDPOINT, ltxOutputSchema } from "./ltx-contract";

const JOB_ROOT = join(process.cwd(), "artifacts", "jobs");

const completionFlights = new Map<string, Promise<SafeJobView>>();

export type SyntheticAttempt = 1;

export type SafeJobView = {
  id: string;
  state: LocalJobRecord["state"];
  endpoint: typeof LTX_ENDPOINT;
  requestId?: string;
  remoteStatus?: string;
  failureCode?: "GENERATION_FAILED";
  modelOutputSha256?: string;
};

function jobId(attempt: SyntheticAttempt): string {
  return `synthetic-hero-ltx-${String(attempt).padStart(3, "0")}`;
}

function store(): LocalJobStore {
  return new LocalJobStore(JOB_ROOT);
}

function safeView(
  record: LocalJobRecord,
  remoteStatus?: string,
): SafeJobView {
  return {
    id: record.id,
    state: record.state,
    endpoint: LTX_ENDPOINT,
    ...(record.fal?.requestId ? { requestId: record.fal.requestId } : {}),
    ...(remoteStatus ? { remoteStatus } : {}),
    ...(record.failure ? { failureCode: "GENERATION_FAILED" as const } : {}),
    ...(record.fal?.modelOutput?.sha256
      ? { modelOutputSha256: record.fal.modelOutput.sha256 }
      : {}),
  };
}

function falError(status: unknown): { error: string; errorType?: string } | null {
  if (!status || typeof status !== "object") {
    return null;
  }
  const record = status as Record<string, unknown>;
  if (typeof record.error !== "string" || !record.error) {
    return null;
  }
  return {
    error: record.error,
    ...(typeof record.error_type === "string"
      ? { errorType: record.error_type }
      : {}),
  };
}

async function downloadModelOutput(
  record: LocalJobRecord,
  urlValue: string,
): Promise<{ path: string; sha256: string; bytes: number }> {
  return downloadFalMedia({
    url: urlValue,
    destination: join(JOB_ROOT, record.id, "model-output.mp4"),
  });
}

async function finishCompletedJob(record: LocalJobRecord): Promise<SafeJobView> {
  if (!record.fal) {
    throw new Error("Submitted job is missing fal provenance");
  }
  const jobStore = store();
  const result = await fal.queue.result(LTX_ENDPOINT, {
    requestId: record.fal.requestId,
  });
  if (result.requestId !== record.fal.requestId) {
    throw new Error("fal result request ID differs from the submitted request");
  }
  const output = ltxOutputSchema.parse(result.data);
  const downloaded = await downloadModelOutput(record, output.video.url);
  const completed = await jobStore.persistCompletion({
    jobId: record.id,
    generationDigest: record.generation.digest,
    endpoint: LTX_ENDPOINT,
    requestId: record.fal.requestId,
    falStatus: "COMPLETED",
    paidAttempt: record.paidAttempt,
    modelOutput: {
      artifactId: `sha256:${downloaded.sha256}`,
      sha256: downloaded.sha256,
      url: output.video.url,
      contentType: output.video.content_type ?? "video/mp4",
    },
  });
  return safeView(completed, "COMPLETED");
}

async function pollSyntheticAttemptOnce(
  attempt: SyntheticAttempt,
): Promise<SafeJobView> {
  const id = jobId(attempt);
  const jobStore = store();
  const record = await jobStore.readJob(id);
  if (record.state !== "submitted" || !record.fal) {
    return safeView(record);
  }
  const status = await fal.queue.status(LTX_ENDPOINT, {
    requestId: record.fal.requestId,
    logs: true,
  });
  if (status.status !== "COMPLETED") {
    return safeView(record, status.status);
  }
  const remoteError = falError(status);
  if (remoteError) {
    const failed = await jobStore.persistCompletion({
      jobId: record.id,
      generationDigest: record.generation.digest,
      endpoint: LTX_ENDPOINT,
      requestId: record.fal.requestId,
      falStatus: "COMPLETED",
      paidAttempt: record.paidAttempt,
      ...remoteError,
    });
    return safeView(failed, status.status);
  }
  return finishCompletedJob(record);
}

export function pollSyntheticAttempt(
  attempt: SyntheticAttempt,
): Promise<SafeJobView> {
  const id = jobId(attempt);
  const existingFlight = completionFlights.get(id);
  if (existingFlight) {
    return existingFlight;
  }
  const flight = pollSyntheticAttemptOnce(attempt).finally(() => {
    completionFlights.delete(id);
  });
  completionFlights.set(id, flight);
  return flight;
}
