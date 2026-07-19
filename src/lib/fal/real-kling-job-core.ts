import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalSha256Schema,
  computeGenerationDigest,
} from "../jobs/generation-digest";
import type { LocalJobRecord, LocalJobStore } from "../jobs/local-job-store";
import {
  reservePaidAttempt,
} from "../jobs/paid-attempt-budget";
import {
  paidAttemptPricingObservationSchema,
  type PaidAttemptPricingObservation,
} from "../jobs/paid-attempt-pricing";
import {
  paidAttemptSnapshotsMatch,
  type PaidAttemptSnapshot,
} from "../jobs/paid-attempt-provenance";
import { paidAttemptPricingObservationDigest } from "../jobs/paid-attempt-provenance";
import { FalSubmissionError } from "./fal-queue-single-submit";
import {
  KLING_O3_STANDARD_EDIT_ENDPOINT,
  KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
  buildKlingO3EditInput,
  klingO3EditOutputSchema,
} from "./kling-contract";
import { isKlingO3StandardEditPricingObservationCurrent } from "./kling-pricing";
import { REAL_KLING_PAID_CONFIRMATION } from "./real-kling-request";

const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const promptSchema = z.string().trim().min(1).max(2_000);

const generationConfirmationSchema = z
  .object({
    jobId: jobIdSchema,
    generationDigest: canonicalSha256Schema,
    authorization: z.literal(REAL_KLING_PAID_CONFIRMATION),
    pricingObservationDigest: canonicalSha256Schema,
  })
  .strict();

type KlingInput = ReturnType<typeof buildKlingO3EditInput>;

export type RealKlingGenerationConfirmation = z.infer<
  typeof generationConfirmationSchema
>;

export type RealKlingFalPort = {
  uploadSource(input: {
    jobId: string;
    sourceBytes: Uint8Array;
    sourceSha256: string;
  }): Promise<string>;
  submit(
    endpoint: typeof KLING_O3_STANDARD_EDIT_ENDPOINT,
    input: KlingInput,
  ): Promise<{ requestId: string; remoteStatus?: string }>;
  status(
    endpoint: typeof KLING_O3_STANDARD_EDIT_ENDPOINT,
    requestId: string,
  ): Promise<{ status: string; error?: string; errorType?: string }>;
  result(
    endpoint: typeof KLING_O3_STANDARD_EDIT_ENDPOINT,
    requestId: string,
  ): Promise<{ requestId: string; data: unknown }>;
  downloadOutput(
    jobId: string,
    url: string,
  ): Promise<{ path: string; sha256: string; bytes: number }>;
};

export type RealKlingSafeJobView = {
  id: string;
  state: LocalJobRecord["state"];
  endpoint: typeof KLING_O3_STANDARD_EDIT_ENDPOINT;
  generationDigest: string;
  prompt: string;
  sourceSha256: string;
  editMaskSha256: string;
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
  jobId: string;
  sourceBytes: Uint8Array;
  sourceSha256: string;
  editMaskSha256: string;
  prompt: string;
  now: () => Date;
  assertPaidRuntimeReady: () => void;
  assertInputEvidenceCurrentBeforePaidPost: () => Promise<void>;
  fal: RealKlingFalPort;
};

export class RealKlingJobError extends Error {
  constructor(
    readonly code:
      | "CONFIRMATION_MISMATCH"
      | "GENERATION_IDENTITY_MISMATCH"
      | "SOURCE_SHA256_MISMATCH"
      | "PRICING_CONFIRMATION_MISMATCH"
      | "PRICING_OBSERVATION_NOT_CURRENT"
      | "PAID_ATTEMPT_PROVENANCE_MISSING"
      | "SUBMISSION_PERSISTENCE_UNRESOLVED",
    message: string,
  ) {
    super(message);
    this.name = "RealKlingJobError";
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function failureCode(
  record: LocalJobRecord,
): RealKlingSafeJobView["failureCode"] {
  if (!record.failure) {
    return undefined;
  }
  return record.failure.source === "fal_submission"
    ? record.failure.code
    : "GENERATION_FAILED";
}

/**
 * Coordinates one generic Kling O3 job without owning credentials or network IO.
 *
 * `prepare` is optional when an intake step already created the validated job.
 * `submit` always reopens that persisted job and requires its exact digest as an
 * explicit confirmation before acquiring the crash-safe paid-call lease.
 */
export function createRealKlingJobController(
  dependencies: ControllerDependencies,
) {
  const jobId = jobIdSchema.parse(dependencies.jobId);
  const sourceBytes = Uint8Array.from(dependencies.sourceBytes);
  if (sourceBytes.byteLength === 0) {
    throw new TypeError("Source bytes must not be empty");
  }
  const sourceSha256 = canonicalSha256Schema.parse(dependencies.sourceSha256);
  if (sha256Bytes(sourceBytes) !== sourceSha256) {
    throw new RealKlingJobError(
      "SOURCE_SHA256_MISMATCH",
      "Source bytes do not match the supplied SHA-256",
    );
  }
  const editMaskSha256 = canonicalSha256Schema.parse(
    dependencies.editMaskSha256,
  );
  const prompt = promptSchema.parse(dependencies.prompt);
  const generation = {
    sourceSha256,
    editMaskSha256,
    prompt,
    endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
    parameters: KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
  };
  const expectedGenerationDigest = computeGenerationDigest(generation);
  let completionFlight: Promise<RealKlingSafeJobView> | undefined;

  function assertExpectedIdentity(record: LocalJobRecord): void {
    if (
      record.id !== jobId ||
      record.generation.endpoint !== KLING_O3_STANDARD_EDIT_ENDPOINT ||
      record.generation.digest !== expectedGenerationDigest
    ) {
      throw new RealKlingJobError(
        "GENERATION_IDENTITY_MISMATCH",
        `Job ${jobId} does not match this controller's validated generation identity`,
      );
    }
  }

  function safeView(
    record: LocalJobRecord,
    remoteStatus?: string,
  ): RealKlingSafeJobView {
    assertExpectedIdentity(record);
    const code = failureCode(record);
    return {
      id: record.id,
      state: record.state,
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      generationDigest: record.generation.digest,
      prompt: record.generation.prompt,
      sourceSha256: record.generation.sourceSha256,
      editMaskSha256: record.generation.editMaskSha256,
      ...(record.fal?.requestId ? { requestId: record.fal.requestId } : {}),
      ...(remoteStatus ? { remoteStatus } : {}),
      ...(code ? { failureCode: code } : {}),
      ...(record.fal?.modelOutput?.sha256
        ? { modelOutputSha256: record.fal.modelOutput.sha256 }
        : {}),
    };
  }

  function paidAttemptSnapshot(record: LocalJobRecord): PaidAttemptSnapshot {
    if (!record.paidAttempt) {
      throw new RealKlingJobError(
        "PAID_ATTEMPT_PROVENANCE_MISSING",
        `Job ${jobId} is missing its paid attempt snapshot`,
      );
    }
    return record.paidAttempt;
  }

  function isExactPersistedSubmission(
    record: LocalJobRecord,
    input: {
      requestId: string;
      sourceUploadUrl: string;
      paidAttempt: PaidAttemptSnapshot;
    },
  ): boolean {
    return (
      record.state === "submitted" &&
      record.fal?.generationDigest === expectedGenerationDigest &&
      record.fal.endpoint === KLING_O3_STANDARD_EDIT_ENDPOINT &&
      record.fal.requestId === input.requestId &&
      record.fal.sourceUploadUrl === input.sourceUploadUrl &&
      paidAttemptSnapshotsMatch(input.paidAttempt, record.paidAttempt)
    );
  }

  async function recoverSubmissionPersistence(
    input: {
      requestId: string;
      sourceUploadUrl: string;
      paidAttempt: PaidAttemptSnapshot;
    },
    remoteStatus?: string,
  ): Promise<RealKlingSafeJobView> {
    const recover = async (): Promise<RealKlingSafeJobView | undefined> => {
      const current = await dependencies.jobStore.readJob(jobId);
      assertExpectedIdentity(current);
      if (isExactPersistedSubmission(current, input)) {
        return safeView(current, remoteStatus);
      }
      if (
        current.state === "submission_unknown" &&
        current.failure?.source === "fal_submission" &&
        current.failure.code === "FAL_SUBMISSION_OUTCOME_UNKNOWN" &&
        paidAttemptSnapshotsMatch(input.paidAttempt, current.paidAttempt)
      ) {
        return safeView(current);
      }
      if (current.state !== "submitting") {
        return undefined;
      }
      return safeView(
        await dependencies.jobStore.persistSubmissionFailure({
          jobId,
          generationDigest: expectedGenerationDigest,
          endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
          code: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
          paidAttempt: input.paidAttempt,
        }),
      );
    };

    try {
      const recovered = await recover();
      if (recovered) {
        return recovered;
      }
    } catch {
      try {
        const recovered = await recover();
        if (recovered) {
          return recovered;
        }
      } catch {
        // The durable state could not be established after a second read.
      }
    }
    throw new RealKlingJobError(
      "SUBMISSION_PERSISTENCE_UNRESOLVED",
      "The paid submission outcome could not be durably reconciled; do not retry it",
    );
  }

  async function prepare(): Promise<RealKlingSafeJobView> {
    const created = await dependencies.jobStore.createValidatedJob({
      id: jobId,
      generation,
    });
    return safeView(created);
  }

  async function submit(
    confirmation: RealKlingGenerationConfirmation,
    rawPaidAttemptPricing: PaidAttemptPricingObservation,
  ): Promise<RealKlingSafeJobView> {
    const parsed = generationConfirmationSchema.parse(confirmation);
    const paidAttemptPricing = paidAttemptPricingObservationSchema.parse(
      rawPaidAttemptPricing,
    );
    const expectedPricingObservationDigest =
      paidAttemptPricingObservationDigest(paidAttemptPricing);
    if (parsed.jobId !== jobId) {
      throw new RealKlingJobError(
        "CONFIRMATION_MISMATCH",
        "Paid submission confirmation does not match the exact job generation digest",
      );
    }

    const validated = await dependencies.jobStore.readJob(jobId);
    assertExpectedIdentity(validated);
    if (
      parsed.generationDigest !== expectedGenerationDigest ||
      validated.generation.digest !== parsed.generationDigest
    ) {
      throw new RealKlingJobError(
        "CONFIRMATION_MISMATCH",
        "Paid submission confirmation differs from the persisted generation digest",
      );
    }
    if (
      parsed.pricingObservationDigest !== expectedPricingObservationDigest
    ) {
      throw new RealKlingJobError(
        "PRICING_CONFIRMATION_MISMATCH",
        "Paid submission confirmation differs from the server pricing observation",
      );
    }
    if (
      !isKlingO3StandardEditPricingObservationCurrent(
        paidAttemptPricing,
        dependencies.now(),
      )
    ) {
      throw new RealKlingJobError(
        "PRICING_OBSERVATION_NOT_CURRENT",
        "Paid submission requires a current, non-future authenticated pricing observation",
      );
    }

    dependencies.assertPaidRuntimeReady();

    const active = await reservePaidAttempt(
      dependencies.jobStore,
      jobId,
      paidAttemptPricing,
    );
    const paidAttempt = paidAttemptSnapshot(active);
    if (
      paidAttemptPricingObservationDigest(paidAttempt) !==
      parsed.pricingObservationDigest
    ) {
      throw new RealKlingJobError(
        "PRICING_CONFIRMATION_MISMATCH",
        "Persisted paid attempt pricing differs from the authorized observation",
      );
    }

    let sourceUrl: string;
    let input: KlingInput;
    try {
      sourceUrl = await dependencies.fal.uploadSource({
        jobId,
        sourceBytes: Uint8Array.from(sourceBytes),
        sourceSha256,
      });
      input = buildKlingO3EditInput({ prompt, sourceUrl });
    } catch {
      return safeView(
        await dependencies.jobStore.persistSubmissionFailure({
          jobId,
          generationDigest: expectedGenerationDigest,
          endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
          code: "SOURCE_UPLOAD_FAILED",
          paidAttempt,
        }),
      );
    }

    const beforePaidPost =
      await dependencies.jobStore.reconcileStaleSubmission(jobId);
    assertExpectedIdentity(beforePaidPost);
    if (
      beforePaidPost.state !== "submitting" ||
      beforePaidPost.submissionLease?.ownerToken !==
        active.submissionLease?.ownerToken ||
      !paidAttemptSnapshotsMatch(paidAttempt, beforePaidPost.paidAttempt)
    ) {
      return safeView(beforePaidPost);
    }
    try {
      await dependencies.assertInputEvidenceCurrentBeforePaidPost();
    } catch {
      return safeView(
        await dependencies.jobStore.persistSubmissionFailure({
          jobId,
          generationDigest: expectedGenerationDigest,
          endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
          code: "INPUT_EVIDENCE_CHANGED_BEFORE_SUBMISSION",
          paidAttempt,
        }),
      );
    }

    const afterInputRehash =
      await dependencies.jobStore.reconcileStaleSubmission(jobId);
    assertExpectedIdentity(afterInputRehash);
    if (
      afterInputRehash.state !== "submitting" ||
      afterInputRehash.submissionLease?.ownerToken !==
        active.submissionLease?.ownerToken ||
      !paidAttemptSnapshotsMatch(paidAttempt, afterInputRehash.paidAttempt)
    ) {
      return safeView(afterInputRehash);
    }
    if (
      !isKlingO3StandardEditPricingObservationCurrent(
        paidAttempt,
        dependencies.now(),
      )
    ) {
      return safeView(
        await dependencies.jobStore.persistSubmissionFailure({
          jobId,
          generationDigest: expectedGenerationDigest,
          endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
          code: "PRICING_OBSERVATION_EXPIRED_BEFORE_SUBMISSION",
          paidAttempt,
        }),
      );
    }

    let submitted: { requestId: string; remoteStatus?: string };
    try {
      submitted = await dependencies.fal.submit(
        KLING_O3_STANDARD_EDIT_ENDPOINT,
        input,
      );
    } catch (error) {
      const code =
        error instanceof FalSubmissionError
          ? error.code
          : "FAL_SUBMISSION_OUTCOME_UNKNOWN";
      return safeView(
        await dependencies.jobStore.persistSubmissionFailure({
          jobId,
          generationDigest: expectedGenerationDigest,
          endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
          code,
          paidAttempt,
        }),
      );
    }

    try {
      const persisted = await dependencies.jobStore.persistSubmission({
        jobId,
        generationDigest: expectedGenerationDigest,
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        requestId: submitted.requestId,
        sourceUploadUrl: sourceUrl,
        paidAttempt,
      });
      return safeView(persisted, submitted.remoteStatus);
    } catch {
      return recoverSubmissionPersistence(
        {
          requestId: submitted.requestId,
          sourceUploadUrl: sourceUrl,
          paidAttempt,
        },
        submitted.remoteStatus,
      );
    }
  }

  async function finishCompletedJob(
    record: LocalJobRecord,
  ): Promise<RealKlingSafeJobView> {
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
      jobId,
      output.video.url,
    );
    const completed = await dependencies.jobStore.persistCompletion({
      jobId,
      generationDigest: expectedGenerationDigest,
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

  async function pollOnce(): Promise<RealKlingSafeJobView> {
    let record = await dependencies.jobStore.readJob(jobId);
    assertExpectedIdentity(record);
    if (record.state === "submitting") {
      record = await dependencies.jobStore.reconcileStaleSubmission(jobId);
      assertExpectedIdentity(record);
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
        jobId,
        generationDigest: expectedGenerationDigest,
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

  function poll(): Promise<RealKlingSafeJobView> {
    completionFlight ??= pollOnce().finally(() => {
      completionFlight = undefined;
    });
    return completionFlight;
  }

  return { poll, prepare, submit };
}
