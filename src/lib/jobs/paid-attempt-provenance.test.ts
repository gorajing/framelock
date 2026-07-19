import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LTX_ENDPOINT } from "../fal/ltx-contract";
import { LocalJobStore } from "./local-job-store";
import {
  bindPaidAttemptBudget,
  inspectPaidAttemptBudget,
  type PaidAttemptPricingObservation,
} from "./paid-attempt-budget";
import { paidAttemptPricingObservationDigest } from "./paid-attempt-provenance";

const pricing: PaidAttemptPricingObservation = {
  unitPriceUsd: "0.14",
  billingUnit: "seconds",
  estimatedUnits: "5.041666667",
  estimatedCostUsd: "0.7058333334",
  pricingSource: "authenticated_fal_pricing_and_estimate",
  priceObservedAt: "2026-07-17T18:47:33.000Z",
};

const generation = {
  sourceSha256: "11".repeat(32),
  editMaskSha256: "22".repeat(32),
  prompt: "Replace the exterior while preserving the protected foreground",
  endpoint: LTX_ENDPOINT,
  parameters: { seed: 42 },
} as const;

const modelOutput = {
  artifactId: "model-output",
  sha256: "33".repeat(32),
  url: "https://example.test/model-output.mp4",
  contentType: "video/mp4",
} as const;

describe("immutable paid-attempt provenance", () => {
  let root: string;
  let store: LocalJobStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-paid-provenance-"));
    store = new LocalJobStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function create(id: string) {
    return store.createValidatedJob({ id, generation });
  }

  it("derives a deterministic digest from every displayed pricing field", () => {
    expect(paidAttemptPricingObservationDigest(pricing)).toBe(
      "036a25b92d2ae159f8036287b242b0533508b4a2791753a6c1286ef81e426aa7",
    );
    expect(
      paidAttemptPricingObservationDigest({
        ...pricing,
        estimatedCostUsd: "0.7058333335",
      }),
    ).not.toBe(paidAttemptPricingObservationDigest(pricing));
  });

  it("captures attempt one and pricing in the same record write as the lease", async () => {
    await create("attempt-one");
    const budget = await inspectPaidAttemptBudget(store);
    const basis = bindPaidAttemptBudget(budget, pricing);

    const active = await store.beginSubmission("attempt-one", basis);

    expect(active.paidAttempt).toMatchObject({
      schemaVersion: 1,
      attemptIndex: 1,
      attemptCap: 3,
      ...pricing,
      digestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(active.paidAttempt?.capturedAt).toBe(
      active.submissionLease?.acquiredAt,
    );
    const disk = JSON.parse(
      await readFile(join(root, "attempt-one", "job.json"), "utf8"),
    );
    expect(disk.paidAttempt).toEqual(active.paidAttempt);
    expect(disk.state).toBe("submitting");
  });

  it("uses the current store's next attempt rather than a hardcoded index", async () => {
    const first = await create("attempt-one");
    const firstActive = await store.beginSubmission(
      first.id,
      bindPaidAttemptBudget(await inspectPaidAttemptBudget(store), pricing),
    );
    await store.persistSubmission({
      jobId: first.id,
      generationDigest: first.generation.digest,
      endpoint: LTX_ENDPOINT,
      requestId: "request-one",
      paidAttempt: firstActive.paidAttempt,
    });
    const budget = await inspectPaidAttemptBudget(store);
    expect(budget).toEqual({ used: 1, next: 2, cap: 3 });

    await create("attempt-two");
    const second = await store.beginSubmission(
      "attempt-two",
      bindPaidAttemptBudget(budget, pricing),
    );

    expect(second.paidAttempt).toMatchObject({
      attemptIndex: 2,
      attemptCap: 3,
    });
  });

  it("rejects a missing snapshot before acquiring the submission lease", async () => {
    await create("missing-snapshot");

    await expect(
      store.beginSubmission("missing-snapshot"),
    ).rejects.toMatchObject({ code: "PROVENANCE_MISMATCH" });
    expect((await store.readJob("missing-snapshot")).state).toBe("validated");
  });

  it("rejects missing or drifted snapshot provenance at submission persistence", async () => {
    const created = await create("drifted-snapshot");
    const active = await store.beginSubmission(
      created.id,
      bindPaidAttemptBudget(await inspectPaidAttemptBudget(store), pricing),
    );

    await expect(
      store.persistSubmission({
        jobId: created.id,
        generationDigest: created.generation.digest,
        endpoint: LTX_ENDPOINT,
        requestId: "request-drifted",
      }),
    ).rejects.toMatchObject({ code: "PROVENANCE_MISMATCH" });
    await expect(
      store.persistSubmission({
        jobId: created.id,
        generationDigest: created.generation.digest,
        endpoint: LTX_ENDPOINT,
        requestId: "request-drifted",
        paidAttempt: {
          ...active.paidAttempt!,
          estimatedCostUsd: "9.99",
        },
      }),
    ).rejects.toMatchObject({ code: "PROVENANCE_MISMATCH" });
    expect((await store.readJob(created.id)).state).toBe("submitting");
  });

  it("preserves the snapshot through generation and accepts only an exact replay", async () => {
    const created = await create("completion-replay");
    const active = await store.beginSubmission(
      created.id,
      bindPaidAttemptBudget(await inspectPaidAttemptBudget(store), pricing),
    );
    const submitted = await store.persistSubmission({
      jobId: created.id,
      generationDigest: created.generation.digest,
      endpoint: LTX_ENDPOINT,
      requestId: "request-replay",
      paidAttempt: active.paidAttempt,
    });
    const completion = {
      jobId: created.id,
      generationDigest: created.generation.digest,
      endpoint: LTX_ENDPOINT,
      requestId: "request-replay",
      falStatus: "COMPLETED" as const,
      modelOutput,
      paidAttempt: submitted.paidAttempt,
    };

    const generated = await store.persistCompletion(completion);
    await expect(store.persistCompletion(completion)).resolves.toEqual(
      generated,
    );
    await expect(
      store.persistCompletion({
        ...completion,
        paidAttempt: {
          ...submitted.paidAttempt!,
          priceObservedAt: "2026-07-18T00:00:00.000Z",
        },
      }),
    ).rejects.toMatchObject({ code: "PROVENANCE_MISMATCH" });
    expect(generated.paidAttempt).toEqual(active.paidAttempt);
  });

  it("rejects persisted snapshot drift against its captured digest", async () => {
    const created = await create("disk-drift");
    const active = await store.beginSubmission(
      created.id,
      bindPaidAttemptBudget(await inspectPaidAttemptBudget(store), pricing),
    );
    await store.persistSubmission({
      jobId: created.id,
      generationDigest: created.generation.digest,
      endpoint: LTX_ENDPOINT,
      requestId: "request-disk-drift",
      paidAttempt: active.paidAttempt,
    });
    const path = join(root, created.id, "job.json");
    const drifted = JSON.parse(await readFile(path, "utf8"));
    drifted.paidAttempt.unitPriceUsd = "1.40";
    await writeFile(path, `${JSON.stringify(drifted, null, 2)}\n`, "utf8");

    await expect(store.readJob(created.id)).rejects.toMatchObject({
      code: "PROVENANCE_MISMATCH",
    });
  });
});
