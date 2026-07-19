import "server-only";

import { join } from "node:path";

import { LocalJobStore } from "../jobs/local-job-store";
import { fal } from "./client.server";
import { downloadFalMedia } from "./fal-media-download";
import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "./kling-contract";
import { KLING_FALLBACK_JOB_ID } from "./kling-fallback-request";
import {
  createKlingFallbackController,
  type KlingFallbackFalPort,
  type KlingFallbackSafeJobView,
} from "./synthetic-kling-job-core";

const JOB_ROOT = join(process.cwd(), "artifacts", "jobs");
const jobs = new LocalJobStore(JOB_ROOT);

function normalizeRemoteError(status: unknown): {
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

function createFalPort(): KlingFallbackFalPort {
  return {
    async status(endpoint, requestId) {
      const status = await fal.queue.status(endpoint, {
        requestId,
        logs: true,
      });
      return normalizeRemoteError(status);
    },
    async result(endpoint, requestId) {
      const result = await fal.queue.result(endpoint, { requestId });
      return { requestId: result.requestId, data: result.data };
    },
    async downloadOutput(jobId, url) {
      return downloadFalMedia({
        url,
        destination: join(JOB_ROOT, jobId, "model-output.mp4"),
      });
    },
  };
}

const historicalController = createKlingFallbackController({
  jobStore: jobs,
  fal: createFalPort(),
});

function requireRuntimeKey(): void {
  if (!process.env.FAL_KEY) {
    throw new Error("FAL_KEY is not configured in the server environment");
  }
}

export async function pollKlingFallback(): Promise<KlingFallbackSafeJobView> {
  requireRuntimeKey();
  return historicalController.poll();
}

export { KLING_FALLBACK_JOB_ID, KLING_O3_STANDARD_EDIT_ENDPOINT };
