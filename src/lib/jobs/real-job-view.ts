import type { LocalJobRecord } from "./local-job-store";

function failureCode(record: LocalJobRecord): string | undefined {
  if (!record.failure) return undefined;
  if (record.failure.source === "local_intake") {
    return "CANCELLED_BEFORE_SUBMISSION";
  }
  if (record.failure.source === "fal_submission") {
    return record.failure.code;
  }
  if (record.failure.source === "canonical_verification") {
    return record.failure.code;
  }
  return "GENERATION_FAILED";
}

export function buildRealJobView(record: LocalJobRecord) {
  const code = failureCode(record);
  return {
    id: record.id,
    state: record.state,
    endpoint: record.generation.endpoint,
    generationDigest: record.generation.digest,
    prompt: record.generation.prompt,
    sourceSha256: record.generation.sourceSha256,
    editMaskSha256: record.generation.editMaskSha256,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.sourceProvenance
      ? {
          sourceProvenance: {
            fileSha256: record.sourceProvenance.fileSha256,
            ...record.sourceProvenance.manifest,
          },
        }
      : {}),
    ...(record.fal?.requestId ? { requestId: record.fal.requestId } : {}),
    ...(record.fal?.modelOutput?.sha256
      ? { modelOutputSha256: record.fal.modelOutput.sha256 }
      : {}),
    ...(code ? { failureCode: code } : {}),
    ...(record.failure?.source === "canonical_verification"
      ? { failureDetail: record.failure.detail }
      : {}),
    ...(record.state === "verified" && record.verification
      ? {
          verification: {
            claim: record.verification.claim,
            framesAudited: record.verification.framesAudited,
            changedCoreChannelSamples:
              record.verification.changedCoreChannelSamples,
            worstMaxChannelDelta: record.verification.worstMaxChannelDelta,
            coreHashMatchCount: record.verification.coreHashMatchCount,
          },
        }
      : {}),
  };
}
