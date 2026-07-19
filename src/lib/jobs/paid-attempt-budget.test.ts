import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LTX_ENDPOINT } from "../fal/ltx-contract";
import { LocalJobStore } from "./local-job-store";
import {
  INITIAL_PAID_ATTEMPT_CAP,
  assertPaidAttemptAvailable,
  inspectPaidAttemptBudget,
} from "./paid-attempt-budget";

const generation = {
  sourceSha256: "11".repeat(32),
  editMaskSha256: "22".repeat(32),
  prompt: "Replace the exterior while preserving the protected foreground",
  endpoint: LTX_ENDPOINT,
  parameters: { seed: 42 },
} as const;
const PAID_ATTEMPT_BASIS = {
  attemptIndex: 1,
  attemptCap: INITIAL_PAID_ATTEMPT_CAP,
  unitPriceUsd: "0.01",
  billingUnit: "seconds",
  estimatedUnits: "5",
  estimatedCostUsd: "0.05",
  pricingSource: "paid attempt budget test fixture",
  priceObservedAt: "2000-01-01T00:00:00.000Z",
} as const;

describe("paid fal attempt budget", () => {
  let root: string;
  let store: LocalJobStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-paid-attempt-budget-"));
    store = new LocalJobStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createValidated(id: string) {
    return store.createValidatedJob({ id, generation });
  }

  async function persistFailure(
    id: string,
    code:
      | "SOURCE_UPLOAD_FAILED"
      | "PRICING_OBSERVATION_EXPIRED_BEFORE_SUBMISSION"
      | "INPUT_EVIDENCE_CHANGED_BEFORE_SUBMISSION"
      | "FAL_SUBMISSION_REJECTED"
      | "FAL_SUBMISSION_OUTCOME_UNKNOWN",
  ) {
    const created = await createValidated(id);
    const active = await store.beginSubmission(id, PAID_ATTEMPT_BASIS);
    return store.persistSubmissionFailure({
      jobId: id,
      generationDigest: created.generation.digest,
      endpoint: LTX_ENDPOINT,
      code,
      paidAttempt: active.paidAttempt,
    });
  }

  async function persistSubmitted(id: string) {
    const created = await createValidated(id);
    const active = await store.beginSubmission(id, PAID_ATTEMPT_BASIS);
    return store.persistSubmission({
      jobId: id,
      generationDigest: created.generation.digest,
      endpoint: LTX_ENDPOINT,
      requestId: `fal-request-${id}`,
      paidAttempt: active.paidAttempt,
    });
  }

  it("reports an empty missing root and ignores non-job root files", async () => {
    const missing = new LocalJobStore(join(root, "not-created"));

    await expect(inspectPaidAttemptBudget(missing)).resolves.toEqual({
      used: 0,
      next: 1,
      cap: INITIAL_PAID_ATTEMPT_CAP,
    });

    await writeFile(join(root, "active-job.json"), "not job json\n", "utf8");
    await writeFile(join(root, ".active-job.lock"), "root metadata\n", "utf8");
    await expect(inspectPaidAttemptBudget(store)).resolves.toEqual({
      used: 0,
      next: 1,
      cap: 3,
    });
  });

  it("counts active reservations plus persisted or ambiguous paid evidence", async () => {
    await createValidated("validated-only");
    await createValidated("locally-cancelled");
    await store.cancelValidatedJob("locally-cancelled");
    await persistFailure("source-upload-failed", "SOURCE_UPLOAD_FAILED");
    await persistFailure(
      "price-expired-before-post",
      "PRICING_OBSERVATION_EXPIRED_BEFORE_SUBMISSION",
    );
    await persistFailure(
      "input-evidence-changed-before-post",
      "INPUT_EVIDENCE_CHANGED_BEFORE_SUBMISSION",
    );
    await createValidated("submitting-no-request");
    await store.beginSubmission("submitting-no-request", PAID_ATTEMPT_BASIS);

    await persistSubmitted("persisted-request");
    await persistFailure("submission-rejected", "FAL_SUBMISSION_REJECTED");
    await persistFailure(
      "submission-unknown",
      "FAL_SUBMISSION_OUTCOME_UNKNOWN",
    );

    await expect(inspectPaidAttemptBudget(store)).resolves.toEqual({
      used: 4,
      next: 5,
      cap: 3,
    });
  });

  it("returns the next allowed attempt below the fixed initial cap", async () => {
    await persistSubmitted("attempt-one");
    await persistFailure("attempt-two", "FAL_SUBMISSION_REJECTED");

    await expect(assertPaidAttemptAvailable(store)).resolves.toEqual({
      used: 2,
      next: 3,
      cap: 3,
    });
  });

  it("rejects at the cap with a stable error code and budget snapshot", async () => {
    await persistSubmitted("attempt-one");
    await persistFailure("attempt-two", "FAL_SUBMISSION_REJECTED");
    await persistFailure(
      "attempt-three",
      "FAL_SUBMISSION_OUTCOME_UNKNOWN",
    );

    await expect(assertPaidAttemptAvailable(store)).rejects.toMatchObject({
      code: "PAID_ATTEMPT_CAP_REACHED",
      budget: { used: 3, next: 4, cap: 3 },
    });
  });

  it("fails closed when a job directory has no record", async () => {
    await mkdir(join(root, "missing-record"));

    await expect(inspectPaidAttemptBudget(store)).rejects.toMatchObject({
      code: "PAID_ATTEMPT_SCAN_FAILED",
    });
  });

  it("fails closed when a job record is malformed", async () => {
    await createValidated("malformed-record");
    await writeFile(
      join(root, "malformed-record", "job.json"),
      "{ definitely not json }\n",
      "utf8",
    );

    await expect(inspectPaidAttemptBudget(store)).rejects.toMatchObject({
      code: "PAID_ATTEMPT_SCAN_FAILED",
    });
  });

  it("fails closed when a record ID differs from its job directory", async () => {
    await createValidated("directory-id");
    const path = join(root, "directory-id", "job.json");
    const mismatched = JSON.parse(await readFile(path, "utf8"));
    mismatched.id = "another-id";
    await writeFile(path, `${JSON.stringify(mismatched, null, 2)}\n`, "utf8");

    await expect(inspectPaidAttemptBudget(store)).rejects.toMatchObject({
      code: "PAID_ATTEMPT_SCAN_FAILED",
    });
  });

  it("fails closed on unexpected symbolic links in the job root", async () => {
    await createValidated("real-directory");
    await symlink(
      join(root, "real-directory"),
      join(root, "linked-job-directory"),
    );

    await expect(inspectPaidAttemptBudget(store)).rejects.toMatchObject({
      code: "PAID_ATTEMPT_SCAN_FAILED",
    });
  });

  it("fails closed when the configured root is not a directory", async () => {
    const fileRoot = join(root, "jobs-as-file");
    await writeFile(fileRoot, "not a directory\n", "utf8");

    await expect(
      inspectPaidAttemptBudget(new LocalJobStore(fileRoot)),
    ).rejects.toMatchObject({ code: "PAID_ATTEMPT_SCAN_FAILED" });
  });
});
