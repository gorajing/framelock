import { readdir } from "node:fs/promises";

import type { LocalJobRecord } from "./local-job-store";
import { LocalJobStore } from "./local-job-store";
import {
  paidAttemptBasisSchema,
  paidAttemptPricingObservationSchema,
  type PaidAttemptBasis,
  type PaidAttemptPricingObservation,
} from "./paid-attempt-provenance";

export const INITIAL_PAID_ATTEMPT_CAP = 3 as const;

export type PaidAttemptBudget = Readonly<{
  used: number;
  next: number;
  cap: typeof INITIAL_PAID_ATTEMPT_CAP;
}>;

export type { PaidAttemptPricingObservation };

export class PaidAttemptBudgetError extends Error {
  constructor(
    readonly code:
      | "PAID_ATTEMPT_CAP_REACHED"
      | "PAID_ATTEMPT_SCAN_FAILED",
    message: string,
    readonly budget?: PaidAttemptBudget,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PaidAttemptBudgetError";
  }
}

function scanFailed(message: string, cause?: unknown): PaidAttemptBudgetError {
  return new PaidAttemptBudgetError(
    "PAID_ATTEMPT_SCAN_FAILED",
    message,
    undefined,
    cause,
  );
}

function hasAttemptedPaidSubmission(record: LocalJobRecord): boolean {
  return (
    (record.state === "submitting" && Boolean(record.paidAttempt)) ||
    Boolean(record.fal?.requestId) ||
    record.state === "submission_unknown" ||
    (record.failure?.source === "fal_submission" &&
      ![
        "SOURCE_UPLOAD_FAILED",
        "PRICING_OBSERVATION_EXPIRED_BEFORE_SUBMISSION",
        "INPUT_EVIDENCE_CHANGED_BEFORE_SUBMISSION",
      ].includes(record.failure.code))
  );
}

export function bindPaidAttemptBudget(
  budget: PaidAttemptBudget,
  pricing: PaidAttemptPricingObservation,
): PaidAttemptBasis {
  if (
    budget.used < 0 ||
    budget.next !== budget.used + 1 ||
    budget.next > budget.cap
  ) {
    throw scanFailed("Paid attempt budget cannot authorize this submission");
  }
  return paidAttemptBasisSchema.parse({
    attemptIndex: budget.next,
    attemptCap: budget.cap,
    ...pricing,
  });
}

/**
 * Reads every LocalJobStore directory and derives the fixed paid-attempt budget.
 * Regular root files are metadata, while every directory must contain a valid,
 * provenance-consistent job whose record ID matches its directory name.
 */
export async function inspectPaidAttemptBudget(
  jobStore: LocalJobStore,
): Promise<PaidAttemptBudget> {
  let entries;
  try {
    entries = await readdir(jobStore.root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        used: 0,
        next: 1,
        cap: INITIAL_PAID_ATTEMPT_CAP,
      };
    }
    throw scanFailed("Could not read the LocalJobStore root", error);
  }

  let used = 0;
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.isFile()) {
      continue;
    }
    if (!entry.isDirectory()) {
      throw scanFailed(
        `Unexpected non-file entry ${entry.name} in the LocalJobStore root`,
      );
    }

    let record: LocalJobRecord;
    try {
      record = await jobStore.readJob(entry.name);
    } catch (error) {
      throw scanFailed(`Could not validate job directory ${entry.name}`, error);
    }
    if (record.id !== entry.name) {
      throw scanFailed(
        `Job record ${record.id} does not match directory ${entry.name}`,
      );
    }
    if (hasAttemptedPaidSubmission(record)) {
      used += 1;
    }
  }

  return {
    used,
    next: used + 1,
    cap: INITIAL_PAID_ATTEMPT_CAP,
  };
}

/** Returns the current budget or rejects before submission once all attempts are used. */
export async function assertPaidAttemptAvailable(
  jobStore: LocalJobStore,
): Promise<PaidAttemptBudget> {
  const budget = await inspectPaidAttemptBudget(jobStore);
  if (budget.used >= budget.cap) {
    throw new PaidAttemptBudgetError(
      "PAID_ATTEMPT_CAP_REACHED",
      `Paid fal attempt cap reached (${budget.used}/${budget.cap})`,
      budget,
    );
  }
  return budget;
}

/**
 * Atomically reserves one global paid-attempt slot and the job's submission
 * lease. Pricing is parsed before the lock, while the attempt index is derived
 * from a fresh store scan inside the same critical section as beginSubmission.
 */
export async function reservePaidAttempt(
  jobStore: LocalJobStore,
  jobId: string,
  rawPricing: PaidAttemptPricingObservation,
): Promise<LocalJobRecord> {
  const pricing = paidAttemptPricingObservationSchema.parse(rawPricing);
  return jobStore.withPaidAttemptBudgetLock(async () => {
    const budget = await assertPaidAttemptAvailable(jobStore);
    return jobStore.beginSubmission(
      jobId,
      bindPaidAttemptBudget(budget, pricing),
    );
  });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
