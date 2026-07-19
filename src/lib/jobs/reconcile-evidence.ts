import type { LocalJobRecord } from "./local-job-store";
import { LocalJobStore } from "./local-job-store";

type GeneratedEvidence = {
  jobId: string;
  generationDigest: string;
  endpoint: string;
  requestId: string;
  modelOutputSha256: string;
  assessmentSha256: string;
};

type VerifiedEvidence = GeneratedEvidence & {
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
};

export type PersistedEvidence = {
  rejected: GeneratedEvidence;
  verified: VerifiedEvidence;
};

export async function reconcilePersistedEvidence(
  store: LocalJobStore,
  evidence: PersistedEvidence,
): Promise<{
  rejectedState: "not_comparable";
  verifiedState: "verified";
}> {
  let [rejected, verified] = await Promise.all([
    store.readJob(evidence.rejected.jobId),
    store.readJob(evidence.verified.jobId),
  ]);
  assertGeneratedEvidence(rejected, evidence.rejected);
  assertGeneratedEvidence(verified, evidence.verified);
  assertReconcilableStates(rejected, verified);

  if (rejected.state === "not_comparable") {
    assertRejectedTerminalEvidence(rejected, evidence.rejected);
  }
  if (verified.state === "composited" || verified.state === "verified") {
    assertCompositionEvidence(verified, evidence.verified);
  }
  if (verified.state === "verified") {
    assertVerificationEvidence(verified, evidence.verified);
  }

  if (rejected.state === "generated") {
    rejected = await store.persistNotComparable({
      jobId: evidence.rejected.jobId,
      generationDigest: evidence.rejected.generationDigest,
      endpoint: evidence.rejected.endpoint,
      requestId: evidence.rejected.requestId,
      modelOutputSha256: evidence.rejected.modelOutputSha256,
      assessmentSha256: evidence.rejected.assessmentSha256,
    });
  }
  if (verified.state === "generated") {
    verified = await store.persistComposition({
      jobId: evidence.verified.jobId,
      generationDigest: evidence.verified.generationDigest,
      endpoint: evidence.verified.endpoint,
      requestId: evidence.verified.requestId,
      modelOutputSha256: evidence.verified.modelOutputSha256,
      assessmentSha256: evidence.verified.assessmentSha256,
      proofManifestSha256: evidence.verified.proofManifestSha256,
    });
  }
  if (verified.state === "composited") {
    verified = await store.persistVerification({
      jobId: evidence.verified.jobId,
      generationDigest: evidence.verified.generationDigest,
      endpoint: evidence.verified.endpoint,
      requestId: evidence.verified.requestId,
      modelOutputSha256: evidence.verified.modelOutputSha256,
      proofManifestSha256: evidence.verified.proofManifestSha256,
      auditSha256: evidence.verified.auditSha256,
      runManifestSha256: evidence.verified.runManifestSha256,
      previewSha256: evidence.verified.previewSha256,
      framesAudited: evidence.verified.framesAudited,
      framesWithNonEmptyCore: evidence.verified.framesWithNonEmptyCore,
      totalCorePixels: evidence.verified.totalCorePixels,
      changedCoreChannelSamples:
        evidence.verified.changedCoreChannelSamples,
      worstMaxChannelDelta: evidence.verified.worstMaxChannelDelta,
      coreHashMatchCount: evidence.verified.coreHashMatchCount,
    });
  }
  if (rejected.state !== "not_comparable" || verified.state !== "verified") {
    throw new Error("evidence reconciliation did not reach terminal states");
  }
  return {
    rejectedState: rejected.state,
    verifiedState: verified.state,
  };
}

function assertGeneratedEvidence(
  record: LocalJobRecord,
  evidence: GeneratedEvidence,
): void {
  if (record.id !== evidence.jobId) {
    throw new Error("evidence job ID does not match persisted job");
  }
  if (record.generation.digest !== evidence.generationDigest) {
    throw new Error("evidence generation digest does not match persisted job");
  }
  if (record.generation.endpoint !== evidence.endpoint) {
    throw new Error("evidence endpoint does not match persisted job");
  }
  if (
    record.fal?.requestId !== evidence.requestId ||
    record.fal.generationDigest !== evidence.generationDigest ||
    record.fal.endpoint !== evidence.endpoint
  ) {
    throw new Error("evidence fal request does not match persisted job");
  }
  if (record.fal.modelOutput?.sha256 !== evidence.modelOutputSha256) {
    throw new Error("evidence model output does not match persisted job");
  }
}

function assertReconcilableStates(
  rejected: LocalJobRecord,
  verified: LocalJobRecord,
): void {
  if (!["generated", "not_comparable"].includes(rejected.state)) {
    throw new Error(`rejected evidence cannot reconcile from ${rejected.state}`);
  }
  if (!["generated", "composited", "verified"].includes(verified.state)) {
    throw new Error(`verified evidence cannot reconcile from ${verified.state}`);
  }
}

function assertRejectedTerminalEvidence(
  record: LocalJobRecord,
  evidence: GeneratedEvidence,
): void {
  if (
    record.assessment?.verdict !== "not_comparable" ||
    record.assessment.sha256 !== evidence.assessmentSha256
  ) {
    throw new Error("persisted rejected assessment differs from evidence");
  }
}

function assertCompositionEvidence(
  record: LocalJobRecord,
  evidence: VerifiedEvidence,
): void {
  if (
    record.assessment?.verdict !== "comparable" ||
    record.assessment.sha256 !== evidence.assessmentSha256 ||
    record.composition?.proofManifestSha256 !== evidence.proofManifestSha256
  ) {
    throw new Error("persisted composition differs from evidence");
  }
}

function assertVerificationEvidence(
  record: LocalJobRecord,
  evidence: VerifiedEvidence,
): void {
  const verification = record.verification;
  if (
    !verification ||
    verification.auditSha256 !== evidence.auditSha256 ||
    verification.runManifestSha256 !== evidence.runManifestSha256 ||
    verification.previewSha256 !== evidence.previewSha256 ||
    verification.framesAudited !== evidence.framesAudited ||
    verification.framesWithNonEmptyCore !==
      evidence.framesWithNonEmptyCore ||
    verification.totalCorePixels !== evidence.totalCorePixels ||
    verification.changedCoreChannelSamples !==
      evidence.changedCoreChannelSamples ||
    verification.worstMaxChannelDelta !== evidence.worstMaxChannelDelta ||
    verification.coreHashMatchCount !== evidence.coreHashMatchCount
  ) {
    throw new Error("persisted verification differs from evidence");
  }
}
