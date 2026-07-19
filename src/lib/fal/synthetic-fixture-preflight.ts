import { createHash } from "node:crypto";

import { z } from "zod";

const canonicalSha256 = z.string().regex(/^[a-f0-9]{64}$/);

const auditPreflightSchema = z.object({
  claim: z.literal(
    "Protected core verified — canonical pre-encode frame sequence.",
  ),
  audit: z.object({
    passed: z.literal(true),
    canonical_contract_passed: z.literal(true),
    total_changed_core_channel_samples: z.literal(0),
  }),
  manifest: z.object({
    digest_sha256: canonicalSha256,
    media_provenance: z.object({
      source_file_sha256: canonicalSha256,
    }),
  }),
});

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateSyntheticFixtureBytes(input: {
  audit: unknown;
  sourceBytes: Buffer;
  restorationMaskBytes: Buffer;
  expectedRestorationMaskSha256: string;
}): {
  sourceBytes: Buffer;
  restorationMaskBytes: Buffer;
  sourceSha256: string;
  restorationMaskSha256: string;
} {
  const audit = auditPreflightSchema.parse(input.audit);
  const expectedMaskSha256 = canonicalSha256.parse(
    input.expectedRestorationMaskSha256,
  );
  const sourceSha256 = sha256Bytes(input.sourceBytes);
  const restorationMaskSha256 = sha256Bytes(input.restorationMaskBytes);
  if (sourceSha256 !== audit.manifest.media_provenance.source_file_sha256) {
    throw new Error("Synthetic source hash differs from the verified proof bundle");
  }
  if (restorationMaskSha256 !== expectedMaskSha256) {
    throw new Error(
      "Synthetic restoration mask hash differs from the frozen fixture",
    );
  }
  return {
    sourceBytes: input.sourceBytes,
    restorationMaskBytes: input.restorationMaskBytes,
    sourceSha256,
    restorationMaskSha256,
  };
}
