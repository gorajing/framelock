import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  canonicalSha256Schema,
  computeGenerationDigest,
  type GenerationIdentity,
} from "./generation-digest";
import {
  aiSourceProvenanceBindingSchema,
  type AiSourceProvenanceBinding,
} from "./ai-source-provenance";
import {
  pricingReceiptSchema,
  type PricingReceipt,
} from "./pricing-receipt";
import {
  createPaidAttemptSnapshot,
  paidAttemptBasisSchema,
  paidAttemptSnapshotHasValidDigest,
  paidAttemptSnapshotSchema,
  paidAttemptSnapshotsMatch,
  type PaidAttemptBasis,
  type PaidAttemptSnapshot,
} from "./paid-attempt-provenance";

const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const endpointSchema = z.string().trim().min(1);
const requestIdSchema = z.string().trim().min(1);
const LOCK_LEASE_MS = 5 * 60 * 1_000;
const GLOBAL_LOCK_WAIT_MS = 5_000;
const GLOBAL_LOCK_RETRY_MS = 25;
const SUBMISSION_LEASE_MS = 15 * 60 * 1_000;

const ownerLeaseSchema = z.object({
  schemaVersion: z.literal(1),
  ownerPid: z.number().int().positive().safe(),
  ownerHost: z.string().trim().min(1).max(255),
  ownerToken: z.string().trim().min(1).max(128),
  acquiredAt: z.string().datetime(),
  leaseExpiresAt: z.string().datetime(),
});

type OwnerLease = z.infer<typeof ownerLeaseSchema>;

const generationSchema = z.object({
  sourceSha256: canonicalSha256Schema,
  editMaskSha256: canonicalSha256Schema,
  prompt: z.string().trim().min(1).max(2_000),
  endpoint: endpointSchema,
  parameters: z.record(z.string(), z.unknown()),
  digest: canonicalSha256Schema,
});

const modelOutputSchema = z.object({
  artifactId: z.string().min(1),
  sha256: canonicalSha256Schema,
  url: z.string().url(),
  contentType: z.string().min(1),
});

const falSchema = z.object({
  generationDigest: canonicalSha256Schema,
  endpoint: endpointSchema,
  requestId: requestIdSchema,
  sourceUploadUrl: z.string().url().optional(),
  maskUploadUrl: z.string().url().optional(),
  modelOutput: modelOutputSchema.optional(),
});

const assessmentSchema = z.object({
  verdict: z.enum(["not_comparable", "comparable"]),
  sha256: canonicalSha256Schema,
});

const compositionSchema = z.object({
  proofManifestSha256: canonicalSha256Schema,
});

export const CANONICAL_VERIFICATION_FAILURE_DETAILS = {
  CANONICAL_FINALIZATION_REJECTED:
    "Canonical finalization rejected the approved evidence; no proof was promoted.",
  CANONICAL_EVIDENCE_INVALID:
    "Committed canonical evidence failed integrity validation; no proof was promoted.",
  CANONICAL_EVIDENCE_INCOMPLETE:
    "Committed canonical evidence was incomplete; no proof was promoted.",
} as const;

export type CanonicalVerificationFailureCode =
  keyof typeof CANONICAL_VERIFICATION_FAILURE_DETAILS;

const verificationSchema = z.object({
  claim: z.literal(
    "Protected core verified — canonical pre-encode frame sequence.",
  ),
  auditSha256: canonicalSha256Schema,
  runManifestSha256: canonicalSha256Schema,
  previewSha256: canonicalSha256Schema,
  framesAudited: z.literal(121),
  framesWithNonEmptyCore: z.literal(121),
  totalCorePixels: z.number().int().positive(),
  changedCoreChannelSamples: z.literal(0),
  worstMaxChannelDelta: z.literal(0),
  coreHashMatchCount: z.literal(121),
  stage: z.literal("canonical_pre_encode"),
});

const canonicalVerificationFailureSchema = z.discriminatedUnion("code", [
  z.object({
    source: z.literal("canonical_verification"),
    code: z.literal("CANONICAL_FINALIZATION_REJECTED"),
    detail: z.literal(
      CANONICAL_VERIFICATION_FAILURE_DETAILS.CANONICAL_FINALIZATION_REJECTED,
    ),
  }),
  z.object({
    source: z.literal("canonical_verification"),
    code: z.literal("CANONICAL_EVIDENCE_INVALID"),
    detail: z.literal(
      CANONICAL_VERIFICATION_FAILURE_DETAILS.CANONICAL_EVIDENCE_INVALID,
    ),
  }),
  z.object({
    source: z.literal("canonical_verification"),
    code: z.literal("CANONICAL_EVIDENCE_INCOMPLETE"),
    detail: z.literal(
      CANONICAL_VERIFICATION_FAILURE_DETAILS.CANONICAL_EVIDENCE_INCOMPLETE,
    ),
  }),
]);

const failureSchema = z.union([
  z.object({
    source: z.literal("local_intake"),
    code: z.literal("CANCELLED_BEFORE_SUBMISSION"),
  }),
  z.object({
    source: z.literal("fal_submission"),
    code: z.enum([
      "SOURCE_UPLOAD_FAILED",
      "PRICING_OBSERVATION_EXPIRED_BEFORE_SUBMISSION",
      "INPUT_EVIDENCE_CHANGED_BEFORE_SUBMISSION",
      "FAL_SUBMISSION_REJECTED",
      "FAL_SUBMISSION_OUTCOME_UNKNOWN",
    ]),
  }),
  z.object({
    source: z.literal("fal_completion"),
    error: z.string().min(1),
    errorType: z.string().min(1).optional(),
  }),
  canonicalVerificationFailureSchema,
]);

const jobRecordSchema = z.object({
  recordVersion: z.union([z.literal(2), z.literal(3)]).optional(),
  id: jobIdSchema,
  state: z.enum([
    "validated",
    "submitting",
    "submission_unknown",
    "submitted",
    "generated",
    "not_comparable",
    "composited",
    "verified",
    "failed",
  ]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  generation: generationSchema,
  sourceProvenance: aiSourceProvenanceBindingSchema.optional(),
  paidAttempt: paidAttemptSnapshotSchema.optional(),
  fal: falSchema.optional(),
  submissionLease: ownerLeaseSchema.optional(),
  assessment: assessmentSchema.optional(),
  composition: compositionSchema.optional(),
  verification: verificationSchema.optional(),
  failure: failureSchema.optional(),
}).superRefine((record, context) => {
  if (record.recordVersion === 3 && !record.sourceProvenance) {
    context.addIssue({
      code: "custom",
      path: ["sourceProvenance"],
      message: "record version 3 requires AI-source provenance",
    });
  }
  if (record.recordVersion !== 3 && record.sourceProvenance) {
    context.addIssue({
      code: "custom",
      path: ["sourceProvenance"],
      message: "AI-source provenance requires record version 3",
    });
  }
  if (
    record.sourceProvenance &&
    record.sourceProvenance.manifest.canonicalSourceMp4Sha256 !==
      record.generation.sourceSha256
  ) {
    context.addIssue({
      code: "custom",
      path: ["sourceProvenance", "manifest", "canonicalSourceMp4Sha256"],
      message: "AI-source provenance names a different source MP4",
    });
  }
  if (
    record.sourceProvenance &&
    record.sourceProvenance.manifest.foregroundMaskSha256 !==
      record.generation.editMaskSha256
  ) {
    context.addIssue({
      code: "custom",
      path: ["sourceProvenance", "manifest", "foregroundMaskSha256"],
      message: "AI-source provenance names a different restoration mask",
    });
  }
  if (record.state === "submitting" && !record.submissionLease) {
    context.addIssue({
      code: "custom",
      path: ["submissionLease"],
      message: "submitting state requires its paid-call owner lease",
    });
  }
  if (record.state !== "submitting" && record.submissionLease) {
    context.addIssue({
      code: "custom",
      path: ["submissionLease"],
      message: "only submitting state may retain a paid-call owner lease",
    });
  }
  const paidAttemptRequired =
    record.recordVersion !== undefined &&
    ([
      "submitting",
      "submission_unknown",
      "submitted",
      "generated",
      "not_comparable",
      "composited",
      "verified",
    ].includes(record.state) ||
      (record.state === "failed" &&
        record.failure?.source !== "local_intake"));
  if (paidAttemptRequired && !record.paidAttempt) {
    context.addIssue({
      code: "custom",
      path: ["paidAttempt"],
      message: "paid submission state requires its immutable attempt snapshot",
    });
  }
  if (
    record.recordVersion !== undefined &&
    record.paidAttempt &&
    (record.state === "validated" ||
      record.failure?.source === "local_intake")
  ) {
    context.addIssue({
      code: "custom",
      path: ["paidAttempt"],
      message: "pre-submission state cannot contain paid attempt provenance",
    });
  }
  if (
    record.state === "submitting" &&
    record.paidAttempt &&
    record.submissionLease &&
    record.paidAttempt.capturedAt !== record.submissionLease.acquiredAt
  ) {
    context.addIssue({
      code: "custom",
      path: ["paidAttempt", "capturedAt"],
      message: "paid attempt capture must coincide with lease acquisition",
    });
  }
  if (
    record.state === "not_comparable" &&
    record.assessment?.verdict !== "not_comparable"
  ) {
    context.addIssue({
      code: "custom",
      path: ["assessment"],
      message: "not_comparable state requires its persisted assessment",
    });
  }
  if (
    ["composited", "verified"].includes(record.state) &&
    (record.assessment?.verdict !== "comparable" || !record.composition)
  ) {
    context.addIssue({
      code: "custom",
      path: ["composition"],
      message: "composited state requires comparable assessment and proof",
    });
  }
  if (record.state === "verified" && !record.verification) {
    context.addIssue({
      code: "custom",
      path: ["verification"],
      message: "verified state requires a passing canonical audit",
    });
  }
  if (record.state !== "verified" && record.verification) {
    context.addIssue({
      code: "custom",
      path: ["verification"],
      message: "only verified state may retain a passing canonical audit",
    });
  }
  if (
    record.failure?.source === "canonical_verification" &&
    record.state !== "failed"
  ) {
    context.addIssue({
      code: "custom",
      path: ["failure"],
      message: "canonical verification failure requires terminal failed state",
    });
  }
});

export type LocalJobRecord = z.infer<typeof jobRecordSchema>;

export class JobStoreError extends Error {
  constructor(
    readonly code:
      | "JOB_ALREADY_EXISTS"
      | "JOB_ALREADY_ACTIVE"
      | "JOB_NOT_FOUND"
      | "INVALID_JOB_STATE"
      | "PRICING_RECEIPT_MISSING"
      | "PRICING_RECEIPT_MISMATCH"
      | "PROVENANCE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "JobStoreError";
  }
}

type CompletionInput = {
  jobId: string;
  generationDigest: string;
  endpoint: string;
  requestId: string;
  falStatus: "COMPLETED";
  modelOutput?: z.input<typeof modelOutputSchema>;
  error?: string;
  errorType?: string;
  paidAttempt?: PaidAttemptSnapshot;
};

export class LocalJobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async createValidatedJob(input: {
    id: string;
    generation: GenerationIdentity;
    sourceProvenance?: AiSourceProvenanceBinding;
  }): Promise<LocalJobRecord> {
    const id = jobIdSchema.parse(input.id);
    await mkdir(this.root, { recursive: true });
    const jobDirectory = this.jobDirectory(id);
    try {
      await mkdir(jobDirectory);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new JobStoreError("JOB_ALREADY_EXISTS", `Job ${id} already exists`);
      }
      throw error;
    }
    const now = new Date().toISOString();
    const generation = {
      ...input.generation,
      digest: computeGenerationDigest(input.generation),
    };
    const sourceProvenance = input.sourceProvenance
      ? aiSourceProvenanceBindingSchema.parse(input.sourceProvenance)
      : undefined;
    const record = jobRecordSchema.parse({
      recordVersion: sourceProvenance ? 3 : 2,
      id,
      state: "validated",
      createdAt: now,
      updatedAt: now,
      generation,
      ...(sourceProvenance ? { sourceProvenance } : {}),
    });
    try {
      await this.writeAtomic(record);
    } catch (error) {
      await rm(jobDirectory, { recursive: true, force: true });
      throw error;
    }
    return record;
  }

  async readJob(id: string): Promise<LocalJobRecord> {
    const parsedId = jobIdSchema.parse(id);
    try {
      const raw = await readFile(this.recordPath(parsedId), "utf8");
      const record = jobRecordSchema.parse(JSON.parse(raw));
      assertPersistedProvenance(record);
      return record;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new JobStoreError("JOB_NOT_FOUND", `Job ${parsedId} does not exist`);
      }
      throw error;
    }
  }

  async persistPricingReceipt(
    rawReceipt: PricingReceipt,
  ): Promise<PricingReceipt> {
    const parsed = pricingReceiptSchema.safeParse(rawReceipt);
    if (!parsed.success) {
      throw new JobStoreError(
        "PRICING_RECEIPT_MISMATCH",
        "Pricing receipt failed its canonical digest contract",
      );
    }
    const receipt = parsed.data;
    return this.withLock(receipt.jobId, async () => {
      const record = await this.readJob(receipt.jobId);
      if (record.state !== "validated") {
        throw new JobStoreError(
          "INVALID_JOB_STATE",
          `Job ${record.id} cannot refresh pricing from ${record.state}`,
        );
      }
      assertPricingReceiptBinding(record, receipt);
      const directory = join(this.jobDirectory(record.id), "pricing");
      const path = join(directory, `${receipt.pricingObservationDigest}.json`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(
            `${JSON.stringify(receipt, null, 2)}\n`,
            "utf8",
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const existing = await this.readPricingReceipt({
          jobId: record.id,
          generationDigest: record.generation.digest,
          pricingObservationDigest: receipt.pricingObservationDigest,
        });
        if (JSON.stringify(existing) !== JSON.stringify(receipt)) {
          throw new JobStoreError(
            "PRICING_RECEIPT_MISMATCH",
            "Existing pricing receipt differs from the issued receipt",
          );
        }
        return existing;
      }
      return receipt;
    });
  }

  async readPricingReceipt(input: {
    jobId: string;
    generationDigest: string;
    pricingObservationDigest: string;
  }): Promise<PricingReceipt> {
    const id = jobIdSchema.parse(input.jobId);
    const generationDigest = canonicalSha256Schema.parse(
      input.generationDigest,
    );
    const pricingObservationDigest = canonicalSha256Schema.parse(
      input.pricingObservationDigest,
    );
    const record = await this.readJob(id);
    let raw: string;
    try {
      raw = await readFile(
        join(
          this.jobDirectory(id),
          "pricing",
          `${pricingObservationDigest}.json`,
        ),
        "utf8",
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new JobStoreError(
          "PRICING_RECEIPT_MISSING",
          "The exact server-issued pricing receipt is unavailable",
        );
      }
      throw error;
    }
    let receipt: PricingReceipt;
    try {
      receipt = pricingReceiptSchema.parse(JSON.parse(raw));
    } catch {
      throw new JobStoreError(
        "PRICING_RECEIPT_MISMATCH",
        "Persisted pricing receipt failed its canonical digest contract",
      );
    }
    if (
      receipt.pricingObservationDigest !== pricingObservationDigest ||
      receipt.generationDigest !== generationDigest
    ) {
      throw new JobStoreError(
        "PRICING_RECEIPT_MISMATCH",
        "Requested pricing identity differs from its persisted receipt",
      );
    }
    assertPricingReceiptBinding(record, receipt);
    return receipt;
  }

  async withEvidenceWorkflowLock<T>(
    id: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.withOwnedLock(id, ".evidence-workflow.lock", action);
  }

  async withPaidAttemptBudgetLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const lockPath = join(this.root, ".paid-attempt-budget.lock");
    const owner = createOwnerLease(LOCK_LEASE_MS);
    const deadline = Date.now() + GLOBAL_LOCK_WAIT_MS;

    while (true) {
      try {
        await createOwnedLock(lockPath, owner);
        break;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
        if (await reclaimDemonstrablyStaleLock(lockPath)) {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new JobStoreError(
            "JOB_ALREADY_ACTIVE",
            "The global paid-attempt budget is being updated",
          );
        }
        await wait(GLOBAL_LOCK_RETRY_MS);
      }
    }

    try {
      return await action();
    } finally {
      await releaseOwnedLock(lockPath, owner.ownerToken);
    }
  }

  async cancelValidatedJob(id: string): Promise<LocalJobRecord> {
    return this.withLock(id, async () => {
      const record = await this.readJob(id);
      if (record.state !== "validated") {
        throw new JobStoreError(
          "INVALID_JOB_STATE",
          `Job ${record.id} cannot cancel from ${record.state}`,
        );
      }
      const next = jobRecordSchema.parse({
        ...record,
        state: "failed",
        updatedAt: new Date().toISOString(),
        failure: {
          source: "local_intake",
          code: "CANCELLED_BEFORE_SUBMISSION",
        },
      });
      await this.writeAtomic(next);
      return next;
    });
  }

  async beginSubmission(
    id: string,
    rawPaidAttempt?: PaidAttemptBasis,
  ): Promise<LocalJobRecord> {
    const paidAttemptBasis = parseRequiredPaidAttemptBasis(rawPaidAttempt);
    return this.withLock(id, async () => {
      const record = await this.readJob(id);
      if (["submitting", "submitted"].includes(record.state)) {
        throw new JobStoreError(
          "JOB_ALREADY_ACTIVE",
          `Job ${record.id} already has an active submission`,
        );
      }
      if (record.state !== "validated") {
        throw new JobStoreError(
          "INVALID_JOB_STATE",
          `Job ${record.id} cannot submit from ${record.state}`,
        );
      }
      const now = new Date();
      const submissionLease = createOwnerLease(SUBMISSION_LEASE_MS, now);
      const next = jobRecordSchema.parse({
        ...record,
        state: "submitting",
        updatedAt: now.toISOString(),
        submissionLease,
        paidAttempt: createPaidAttemptSnapshot(
          paidAttemptBasis,
          submissionLease.acquiredAt,
        ),
      });
      await this.writeAtomic(next);
      return next;
    });
  }

  async persistSubmission(input: {
    jobId: string;
    generationDigest: string;
    endpoint: string;
    requestId: string;
    sourceUploadUrl?: string;
    maskUploadUrl?: string;
    paidAttempt?: PaidAttemptSnapshot;
  }): Promise<LocalJobRecord> {
    return this.withLock(input.jobId, async () => {
      const record = await this.readJob(input.jobId);
      if (record.state !== "submitting") {
        throw new JobStoreError(
          "INVALID_JOB_STATE",
          `Job ${record.id} cannot persist submission from ${record.state}`,
        );
      }
      assertGenerationProvenance(record, input);
      assertPaidAttemptProvenance(record, input.paidAttempt);
      const next = jobRecordSchema.parse({
        ...withoutSubmissionLease(record),
        state: "submitted",
        updatedAt: new Date().toISOString(),
        fal: {
          generationDigest: input.generationDigest,
          endpoint: input.endpoint,
          requestId: input.requestId,
          ...(input.sourceUploadUrl
            ? { sourceUploadUrl: input.sourceUploadUrl }
            : {}),
          ...(input.maskUploadUrl ? { maskUploadUrl: input.maskUploadUrl } : {}),
        },
      });
      await this.writeAtomic(next);
      return next;
    });
  }

  async persistSubmissionFailure(input: {
    jobId: string;
    generationDigest: string;
    endpoint: string;
    code:
      | "SOURCE_UPLOAD_FAILED"
      | "PRICING_OBSERVATION_EXPIRED_BEFORE_SUBMISSION"
      | "INPUT_EVIDENCE_CHANGED_BEFORE_SUBMISSION"
      | "FAL_SUBMISSION_REJECTED"
      | "FAL_SUBMISSION_OUTCOME_UNKNOWN";
    paidAttempt?: PaidAttemptSnapshot;
  }): Promise<LocalJobRecord> {
    return this.withLock(input.jobId, async () => {
      const record = await this.readJob(input.jobId);
      if (record.state !== "submitting") {
        throw new JobStoreError(
          "INVALID_JOB_STATE",
          `Job ${record.id} cannot record submission failure from ${record.state}`,
        );
      }
      assertGenerationProvenance(record, input);
      assertPaidAttemptProvenance(record, input.paidAttempt);
      const next = jobRecordSchema.parse({
        ...withoutSubmissionLease(record),
        state:
          input.code === "FAL_SUBMISSION_OUTCOME_UNKNOWN"
            ? "submission_unknown"
            : "failed",
        updatedAt: new Date().toISOString(),
        failure: {
          source: "fal_submission",
          code: input.code,
        },
      });
      await this.writeAtomic(next);
      return next;
    });
  }

  async reconcileStaleSubmission(id: string): Promise<LocalJobRecord> {
    const current = await this.readJob(id);
    if (
      current.state !== "submitting" ||
      !current.submissionLease ||
      !isSubmissionLeaseExpired(current.submissionLease)
    ) {
      return current;
    }

    return this.withLock(id, async () => {
      const record = await this.readJob(id);
      if (
        record.state !== "submitting" ||
        !record.submissionLease ||
        !isSubmissionLeaseExpired(record.submissionLease)
      ) {
        return record;
      }
      const next = jobRecordSchema.parse({
        ...withoutSubmissionLease(record),
        state: "submission_unknown",
        updatedAt: new Date().toISOString(),
        failure: {
          source: "fal_submission",
          code: "FAL_SUBMISSION_OUTCOME_UNKNOWN",
        },
      });
      await this.writeAtomic(next);
      return next;
    });
  }

  async persistCompletion(input: CompletionInput): Promise<LocalJobRecord> {
    return this.withLock(input.jobId, async () => {
      const record = await this.readJob(input.jobId);
      assertPaidAttemptProvenance(record, input.paidAttempt);
      if (
        record.state === "generated" &&
        record.fal?.modelOutput &&
        !input.error
      ) {
        assertCompletionProvenance(record, input);
        const replayedOutput = modelOutputSchema.parse(input.modelOutput);
        if (
          JSON.stringify(record.fal.modelOutput) !== JSON.stringify(replayedOutput)
        ) {
          throw new JobStoreError(
            "PROVENANCE_MISMATCH",
            "replayed fal completion has different model-output provenance",
          );
        }
        return record;
      }
      if (record.state !== "submitted" || !record.fal) {
        throw new JobStoreError(
          "INVALID_JOB_STATE",
          `Job ${record.id} cannot complete from ${record.state}`,
        );
      }
      assertGenerationProvenance(record, input);
      assertCompletionProvenance(record, input);
      const base = {
        ...record,
        updatedAt: new Date().toISOString(),
        fal: {
          generationDigest: record.fal.generationDigest,
          endpoint: record.fal.endpoint,
          requestId: record.fal.requestId,
          ...(record.fal.sourceUploadUrl
            ? { sourceUploadUrl: record.fal.sourceUploadUrl }
            : {}),
          ...(record.fal.maskUploadUrl
            ? { maskUploadUrl: record.fal.maskUploadUrl }
            : {}),
        },
      };
      const next = input.error
        ? jobRecordSchema.parse({
            ...base,
            state: "failed",
            failure: {
              source: "fal_completion",
              error: input.error,
              ...(input.errorType ? { errorType: input.errorType } : {}),
            },
          })
        : jobRecordSchema.parse({
            ...base,
            state: "generated",
            fal: {
              ...base.fal,
              modelOutput: modelOutputSchema.parse(input.modelOutput),
            },
          });
      await this.writeAtomic(next);
      return next;
    });
  }

  async persistNotComparable(input: {
    jobId: string;
    generationDigest: string;
    endpoint: string;
    requestId: string;
    modelOutputSha256: string;
    assessmentSha256: string;
  }): Promise<LocalJobRecord> {
    return this.withLock(input.jobId, async () => {
      const record = await this.readJob(input.jobId);
      assertGeneratedProvenance(record, input);
      if (record.state !== "generated") {
        throw new JobStoreError(
          "INVALID_JOB_STATE",
          `Job ${record.id} cannot fail comparability from ${record.state}`,
        );
      }
      const next = jobRecordSchema.parse({
        ...record,
        state: "not_comparable",
        updatedAt: new Date().toISOString(),
        assessment: {
          verdict: "not_comparable",
          sha256: input.assessmentSha256,
        },
      });
      await this.writeAtomic(next);
      return next;
    });
  }

  async persistComposition(input: {
    jobId: string;
    generationDigest: string;
    endpoint: string;
    requestId: string;
    modelOutputSha256: string;
    assessmentSha256: string;
    proofManifestSha256: string;
  }): Promise<LocalJobRecord> {
    return this.withLock(input.jobId, async () => {
      const record = await this.readJob(input.jobId);
      assertGeneratedProvenance(record, input);
      if (record.state !== "generated") {
        throw new JobStoreError(
          "INVALID_JOB_STATE",
          `Job ${record.id} cannot persist composition from ${record.state}`,
        );
      }
      const next = jobRecordSchema.parse({
        ...record,
        state: "composited",
        updatedAt: new Date().toISOString(),
        assessment: {
          verdict: "comparable",
          sha256: input.assessmentSha256,
        },
        composition: {
          proofManifestSha256: input.proofManifestSha256,
        },
      });
      await this.writeAtomic(next);
      return next;
    });
  }

  async persistCanonicalVerificationFailure(input: {
    jobId: string;
    generationDigest: string;
    endpoint: string;
    requestId: string;
    modelOutputSha256: string;
    code: CanonicalVerificationFailureCode;
  }): Promise<LocalJobRecord> {
    return this.withLock(input.jobId, async () => {
      const record = await this.readJob(input.jobId);
      assertGeneratedProvenance(record, input);
      if (record.state !== "generated" && record.state !== "composited") {
        throw new JobStoreError(
          "INVALID_JOB_STATE",
          `Job ${record.id} cannot fail canonical verification from ${record.state}`,
        );
      }
      const next = jobRecordSchema.parse({
        ...record,
        state: "failed",
        updatedAt: new Date().toISOString(),
        failure: {
          source: "canonical_verification",
          code: input.code,
          detail: CANONICAL_VERIFICATION_FAILURE_DETAILS[input.code],
        },
      });
      await this.writeAtomic(next);
      return next;
    });
  }

  async persistVerification(input: {
    jobId: string;
    generationDigest: string;
    endpoint: string;
    requestId: string;
    modelOutputSha256: string;
    proofManifestSha256: string;
    auditSha256: string;
    runManifestSha256: string;
    previewSha256: string;
    framesAudited: 121;
    framesWithNonEmptyCore: 121;
    totalCorePixels: number;
    changedCoreChannelSamples: 0;
    worstMaxChannelDelta: 0;
    coreHashMatchCount: 121;
  }): Promise<LocalJobRecord> {
    return this.withLock(input.jobId, async () => {
      const record = await this.readJob(input.jobId);
      assertGeneratedProvenance(record, input);
      if (
        record.state !== "composited" ||
        record.composition?.proofManifestSha256 !== input.proofManifestSha256
      ) {
        throw new JobStoreError(
          "INVALID_JOB_STATE",
          `Job ${record.id} cannot verify from ${record.state}`,
        );
      }
      const next = jobRecordSchema.parse({
        ...record,
        state: "verified",
        updatedAt: new Date().toISOString(),
        verification: {
          claim:
            "Protected core verified — canonical pre-encode frame sequence.",
          auditSha256: input.auditSha256,
          runManifestSha256: input.runManifestSha256,
          previewSha256: input.previewSha256,
          framesAudited: input.framesAudited,
          framesWithNonEmptyCore: input.framesWithNonEmptyCore,
          totalCorePixels: input.totalCorePixels,
          changedCoreChannelSamples: input.changedCoreChannelSamples,
          worstMaxChannelDelta: input.worstMaxChannelDelta,
          coreHashMatchCount: input.coreHashMatchCount,
          stage: "canonical_pre_encode",
        },
      });
      await this.writeAtomic(next);
      return next;
    });
  }

  private jobDirectory(id: string): string {
    return join(this.root, jobIdSchema.parse(id));
  }

  private recordPath(id: string): string {
    return join(this.jobDirectory(id), "job.json");
  }

  private async writeAtomic(record: LocalJobRecord): Promise<void> {
    const validated = jobRecordSchema.parse(record);
    const jobDirectory = this.jobDirectory(validated.id);
    const temporary = join(jobDirectory, `.job.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.recordPath(validated.id));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    return this.withOwnedLock(id, ".job.lock", action);
  }

  private async withOwnedLock<T>(
    id: string,
    lockName: ".job.lock" | ".evidence-workflow.lock",
    action: () => Promise<T>,
  ): Promise<T> {
    const parsedId = jobIdSchema.parse(id);
    const lockPath = join(this.jobDirectory(parsedId), lockName);
    const owner = createOwnerLease(LOCK_LEASE_MS);
    try {
      await createOwnedLock(lockPath, owner);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        if (await reclaimDemonstrablyStaleLock(lockPath)) {
          try {
            await createOwnedLock(lockPath, owner);
          } catch (retryError) {
            if (!isNodeError(retryError, "EEXIST")) {
              throw retryError;
            }
            throw new JobStoreError(
              "JOB_ALREADY_ACTIVE",
              `Job ${parsedId} is being updated`,
            );
          }
        } else {
          throw new JobStoreError(
            "JOB_ALREADY_ACTIVE",
            `Job ${parsedId} is being updated`,
          );
        }
      } else if (isNodeError(error, "ENOENT")) {
        throw new JobStoreError("JOB_NOT_FOUND", `Job ${parsedId} does not exist`);
      } else {
        throw error;
      }
    }
    try {
      return await action();
    } finally {
      await releaseOwnedLock(lockPath, owner.ownerToken);
    }
  }
}

function createOwnerLease(durationMs: number, now = new Date()): OwnerLease {
  return ownerLeaseSchema.parse({
    schemaVersion: 1,
    ownerPid: process.pid,
    ownerHost: hostname(),
    ownerToken: randomUUID(),
    acquiredAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + durationMs).toISOString(),
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function withoutSubmissionLease(record: LocalJobRecord): LocalJobRecord {
  const next = { ...record };
  delete next.submissionLease;
  return next;
}

function isDemonstrablyStale(owner: OwnerLease): boolean {
  if (
    owner.ownerHost !== hostname() ||
    Date.parse(owner.leaseExpiresAt) > Date.now()
  ) {
    return false;
  }
  try {
    process.kill(owner.ownerPid, 0);
    return false;
  } catch (error) {
    return isNodeError(error, "ESRCH");
  }
}

function isSubmissionLeaseExpired(owner: OwnerLease): boolean {
  return Date.parse(owner.leaseExpiresAt) <= Date.now();
}

async function createOwnedLock(path: string, owner: OwnerLease): Promise<void> {
  const candidate = `${path}.${owner.ownerToken}.candidate`;
  try {
    const handle = await open(candidate, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(candidate, path);
  } finally {
    await unlink(candidate).catch(() => undefined);
  }
}

async function readOwnerLease(path: string): Promise<OwnerLease | undefined> {
  try {
    return ownerLeaseSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

async function reclaimDemonstrablyStaleLock(path: string): Promise<boolean> {
  const observed = await readOwnerLease(path);
  if (!observed || !isDemonstrablyStale(observed)) {
    return false;
  }
  const confirmed = await readOwnerLease(path);
  if (
    !confirmed ||
    confirmed.ownerToken !== observed.ownerToken ||
    !isDemonstrablyStale(confirmed)
  ) {
    return false;
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

async function releaseOwnedLock(path: string, ownerToken: string): Promise<void> {
  const current = await readOwnerLease(path);
  if (current?.ownerToken !== ownerToken) {
    return;
  }
  await unlink(path).catch(() => undefined);
}

function assertGenerationProvenance(
  record: LocalJobRecord,
  input: { generationDigest: string; endpoint: string },
): void {
  if (
    record.generation.digest !== input.generationDigest ||
    record.generation.endpoint !== input.endpoint
  ) {
    throw new JobStoreError(
      "PROVENANCE_MISMATCH",
      "request provenance does not match the validated generation identity",
    );
  }
}

function assertPersistedProvenance(record: LocalJobRecord): void {
  const { digest, ...identity } = record.generation;
  if (computeGenerationDigest(identity) !== digest) {
    throw new JobStoreError(
      "PROVENANCE_MISMATCH",
      "persisted generation digest does not match its identity",
    );
  }
  if (
    record.fal &&
    (record.fal.generationDigest !== digest ||
      record.fal.endpoint !== record.generation.endpoint)
  ) {
    throw new JobStoreError(
      "PROVENANCE_MISMATCH",
      "persisted fal provenance does not match the generation identity",
    );
  }
  if (
    record.paidAttempt &&
    !paidAttemptSnapshotHasValidDigest(record.paidAttempt)
  ) {
    throw new JobStoreError(
      "PROVENANCE_MISMATCH",
      "persisted paid attempt snapshot digest does not match its provenance",
    );
  }
}

function assertPricingReceiptBinding(
  record: LocalJobRecord,
  receipt: PricingReceipt,
): void {
  if (
    record.id !== receipt.jobId ||
    record.generation.digest !== receipt.generationDigest ||
    record.generation.endpoint !== receipt.endpoint ||
    !record.sourceProvenance ||
    record.sourceProvenance.fileSha256 !==
      receipt.sourceProvenanceFileSha256
  ) {
    throw new JobStoreError(
      "PRICING_RECEIPT_MISMATCH",
      "Pricing receipt does not bind the persisted AI-source job",
    );
  }
}

function parseRequiredPaidAttemptBasis(
  candidate: PaidAttemptBasis | undefined,
): PaidAttemptBasis {
  const parsed = paidAttemptBasisSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new JobStoreError(
      "PROVENANCE_MISMATCH",
      "paid attempt authorization is required before submission",
    );
  }
  return parsed.data;
}

function assertPaidAttemptProvenance(
  record: LocalJobRecord,
  candidate: PaidAttemptSnapshot | undefined,
): void {
  if (!record.paidAttempt) {
    if (record.recordVersion === undefined && candidate === undefined) {
      return;
    }
    throw new JobStoreError(
      "PROVENANCE_MISMATCH",
      "submission is missing its persisted paid attempt snapshot",
    );
  }
  if (!paidAttemptSnapshotsMatch(record.paidAttempt, candidate)) {
    throw new JobStoreError(
      "PROVENANCE_MISMATCH",
      "paid attempt provenance differs from the submission lease snapshot",
    );
  }
}

function assertCompletionProvenance(
  record: LocalJobRecord,
  input: { generationDigest: string; endpoint: string; requestId: string },
): void {
  assertGenerationProvenance(record, input);
  if (
    !record.fal ||
    record.fal.endpoint !== input.endpoint ||
    record.fal.requestId !== input.requestId ||
    record.fal.generationDigest !== input.generationDigest
  ) {
    throw new JobStoreError(
      "PROVENANCE_MISMATCH",
      "fal completion does not match the persisted submission",
    );
  }
}

function assertGeneratedProvenance(
  record: LocalJobRecord,
  input: {
    generationDigest: string;
    endpoint: string;
    requestId: string;
    modelOutputSha256: string;
  },
): void {
  assertCompletionProvenance(record, input);
  if (
    !record.fal?.modelOutput ||
    record.fal.modelOutput.sha256 !== input.modelOutputSha256
  ) {
    throw new JobStoreError(
      "PROVENANCE_MISMATCH",
      "canonical evidence does not match the persisted model output",
    );
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export const localJobRecordSchema = jobRecordSchema;
