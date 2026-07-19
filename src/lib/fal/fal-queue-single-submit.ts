import { z } from "zod";

import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "./kling-contract";

export const FAL_PAID_SUBMISSION_TIMEOUT_MS = 30_000;

const DEFINITIVE_REJECTION_STATUSES = new Set([
  400, 401, 403, 404, 405, 413, 415, 422,
]);

const submissionResponseSchema = z.object({
  request_id: z.string().trim().min(1),
  status: z.string().trim().min(1).optional(),
});

export type FalSubmissionFailureCode =
  | "FAL_SUBMISSION_REJECTED"
  | "FAL_SUBMISSION_OUTCOME_UNKNOWN";

export class FalSubmissionError extends Error {
  constructor(readonly code: FalSubmissionFailureCode) {
    super(code);
    this.name = "FalSubmissionError";
  }
}

type KlingQueueInput = {
  prompt: string;
  video_url: string;
  keep_audio: false;
  shot_type: "customize";
};

/**
 * Performs the paid queue POST exactly once at the network-call boundary.
 *
 * The fal SDK intentionally retries queue submissions. That is desirable for
 * many workloads but unsafe for this fixed paid demo because fal exposes no
 * documented idempotency key. Native fetch has no automatic retry, while the
 * fal header also prevents platform-side runner requeues.
 */
export async function submitFalQueueOnce(input: {
  endpoint: typeof KLING_O3_STANDARD_EDIT_ENDPOINT;
  input: KlingQueueInput;
  credentials: string;
  fetchImpl?: typeof fetch;
}): Promise<{ requestId: string; remoteStatus?: string }> {
  const credentials = input.credentials.trim();
  if (!credentials) {
    throw new TypeError("fal credentials are required");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`https://queue.fal.run/${input.endpoint}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Key ${credentials}`,
        "Content-Type": "application/json",
        "X-Fal-No-Retry": "1",
        "X-Fal-Object-Lifecycle-Preference":
          '{"expiration_duration_seconds":3600}',
        "x-app-fal-disable-fallback": "true",
      },
      body: JSON.stringify(input.input),
      redirect: "error",
      signal: AbortSignal.timeout(FAL_PAID_SUBMISSION_TIMEOUT_MS),
    });
  } catch {
    throw new FalSubmissionError("FAL_SUBMISSION_OUTCOME_UNKNOWN");
  }

  if (!response.ok) {
    const code: FalSubmissionFailureCode =
      DEFINITIVE_REJECTION_STATUSES.has(response.status)
        ? "FAL_SUBMISSION_REJECTED"
        : "FAL_SUBMISSION_OUTCOME_UNKNOWN";
    throw new FalSubmissionError(code);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new FalSubmissionError("FAL_SUBMISSION_OUTCOME_UNKNOWN");
  }
  const parsed = submissionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new FalSubmissionError("FAL_SUBMISSION_OUTCOME_UNKNOWN");
  }
  return {
    requestId: parsed.data.request_id,
    ...(parsed.data.status ? { remoteStatus: parsed.data.status } : {}),
  };
}
