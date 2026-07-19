import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "../fal/kling-contract";
import { LTX_ENDPOINT } from "../fal/ltx-contract";
import { LocalJobStore } from "./local-job-store";
import {
  reconcilePersistedEvidence,
  type PersistedEvidence,
} from "./reconcile-evidence";

const LTX_ID = "synthetic-hero-ltx-001";
const KLING_ID = "synthetic-hero-kling-o3-001";
const LTX_REQUEST = "ltx-request";
const KLING_REQUEST = "kling-request";
const LTX_OUTPUT = "33".repeat(32);
const KLING_OUTPUT = "44".repeat(32);
const PAID_ATTEMPT_BASIS = {
  attemptIndex: 1,
  attemptCap: 3,
  unitPriceUsd: "0.01",
  billingUnit: "seconds",
  estimatedUnits: "5",
  estimatedCostUsd: "0.05",
  pricingSource: "reconcile evidence test fixture",
  priceObservedAt: "2000-01-01T00:00:00.000Z",
} as const;

describe("persisted evidence reconciliation", () => {
  let root: string;
  let store: LocalJobStore;
  let evidence: PersistedEvidence;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-reconcile-"));
    store = new LocalJobStore(root);
    const ltx = await createGeneratedJob({
      store,
      id: LTX_ID,
      endpoint: LTX_ENDPOINT,
      requestId: LTX_REQUEST,
      modelOutputSha256: LTX_OUTPUT,
    });
    const kling = await createGeneratedJob({
      store,
      id: KLING_ID,
      endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
      requestId: KLING_REQUEST,
      modelOutputSha256: KLING_OUTPUT,
    });
    evidence = {
      rejected: {
        jobId: LTX_ID,
        generationDigest: ltx.generation.digest,
        endpoint: LTX_ENDPOINT,
        requestId: LTX_REQUEST,
        modelOutputSha256: LTX_OUTPUT,
        assessmentSha256: "55".repeat(32),
      },
      verified: {
        jobId: KLING_ID,
        generationDigest: kling.generation.digest,
        endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
        requestId: KLING_REQUEST,
        modelOutputSha256: KLING_OUTPUT,
        assessmentSha256: "66".repeat(32),
        proofManifestSha256: "77".repeat(32),
        auditSha256: "88".repeat(32),
        runManifestSha256: "99".repeat(32),
        previewSha256: "aa".repeat(32),
        framesAudited: 121,
        framesWithNonEmptyCore: 121,
        totalCorePixels: 22_029_381,
        changedCoreChannelSamples: 0,
        worstMaxChannelDelta: 0,
        coreHashMatchCount: 121,
      },
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("moves the rejected and passing jobs to their honest terminal states", async () => {
    const result = await reconcilePersistedEvidence(store, evidence);

    expect(result).toEqual({
      rejectedState: "not_comparable",
      verifiedState: "verified",
    });
    expect(await store.readJob(LTX_ID)).toMatchObject({
      state: "not_comparable",
      assessment: {
        verdict: "not_comparable",
        sha256: evidence.rejected.assessmentSha256,
      },
    });
    expect(await store.readJob(KLING_ID)).toMatchObject({
      state: "verified",
      assessment: {
        verdict: "comparable",
        sha256: evidence.verified.assessmentSha256,
      },
      composition: {
        proofManifestSha256: evidence.verified.proofManifestSha256,
      },
      verification: {
        auditSha256: evidence.verified.auditSha256,
        runManifestSha256: evidence.verified.runManifestSha256,
        previewSha256: evidence.verified.previewSha256,
        changedCoreChannelSamples: 0,
      },
    });
  });

  it("is idempotent after restart and never rewrites terminal evidence", async () => {
    const first = await reconcilePersistedEvidence(store, evidence);
    const second = await reconcilePersistedEvidence(
      new LocalJobStore(root),
      evidence,
    );

    expect(second).toEqual(first);
  });

  it("rejects mismatched evidence before promoting either job", async () => {
    const mismatched = structuredClone(evidence);
    mismatched.verified.generationDigest = "ff".repeat(32);

    await expect(
      reconcilePersistedEvidence(store, mismatched),
    ).rejects.toThrow(/generation digest/i);
    expect((await store.readJob(LTX_ID)).state).toBe("generated");
    expect((await store.readJob(KLING_ID)).state).toBe("generated");
  });
});

async function createGeneratedJob(input: {
  store: LocalJobStore;
  id: string;
  endpoint: string;
  requestId: string;
  modelOutputSha256: string;
}) {
  const created = await input.store.createValidatedJob({
    id: input.id,
    generation: {
      sourceSha256: "11".repeat(32),
      editMaskSha256: "22".repeat(32),
      prompt: `Fixed prompt for ${input.id}`,
      endpoint: input.endpoint,
      parameters: { fixed: true },
    },
  });
  const active = await input.store.beginSubmission(
    input.id,
    PAID_ATTEMPT_BASIS,
  );
  await input.store.persistSubmission({
    jobId: input.id,
    generationDigest: created.generation.digest,
    endpoint: input.endpoint,
    requestId: input.requestId,
    paidAttempt: active.paidAttempt,
  });
  await input.store.persistCompletion({
    jobId: input.id,
    generationDigest: created.generation.digest,
    endpoint: input.endpoint,
    requestId: input.requestId,
    falStatus: "COMPLETED",
    paidAttempt: active.paidAttempt,
    modelOutput: {
      artifactId: `sha256:${input.modelOutputSha256}`,
      sha256: input.modelOutputSha256,
      url: "https://fal.media/model-output.mp4",
      contentType: "video/mp4",
    },
  });
  return created;
}
