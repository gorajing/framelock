import { z } from "zod";

export const AI_SOURCE_PROVENANCE_LABEL = "ai_generated_source" as const;
export const AI_SOURCE_PROVENANCE_FILENAME = "source-provenance.json" as const;
export const AI_SOURCE_PROVENANCE_MAX_BYTES = 256 * 1024;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const aiSourceProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    provenanceLabel: z.literal(AI_SOURCE_PROVENANCE_LABEL),
    originalImageSha256: sha256Schema,
    sourceBundleManifestSha256: sha256Schema,
    normalizedPlateSha256: sha256Schema,
    canonicalSourceMp4Sha256: sha256Schema,
    foregroundMaskSha256: sha256Schema,
    contactSheetSha256: sha256Schema,
    approval: z
      .object({
        recordSha256: sha256Schema,
        approvedAt: z.string().datetime({ offset: true }),
        reviewer: z.string().trim().min(1).max(200),
        note: z.string().trim().min(1).max(2_000),
      })
      .strict(),
  })
  .strict();

export type AiSourceProvenance = z.infer<typeof aiSourceProvenanceSchema>;

export const aiSourceProvenanceBindingSchema = z
  .object({
    fileSha256: sha256Schema,
    manifest: aiSourceProvenanceSchema,
  })
  .strict();

export type AiSourceProvenanceBinding = z.infer<
  typeof aiSourceProvenanceBindingSchema
>;

export type AiSourceProvenanceErrorCode =
  | "INVALID_PROVENANCE_JSON"
  | "INVALID_PROVENANCE_SCHEMA"
  | "PREPARED_INPUT_PATH_MISMATCH"
  | "PROVENANCE_ALREADY_EXISTS"
  | "PROVENANCE_MASK_MISMATCH"
  | "PROVENANCE_SOURCE_MISMATCH"
  | "PROVENANCE_TOO_LARGE";

export class AiSourceProvenanceError extends Error {
  constructor(readonly code: AiSourceProvenanceErrorCode) {
    super(code);
    this.name = "AiSourceProvenanceError";
  }
}

export function parseAiSourceProvenanceBytes(
  bytes: Uint8Array,
  maxBytes = AI_SOURCE_PROVENANCE_MAX_BYTES,
): AiSourceProvenance {
  if (bytes.byteLength > maxBytes) {
    throw new AiSourceProvenanceError("PROVENANCE_TOO_LARGE");
  }
  if (bytes.byteLength === 0) {
    throw new AiSourceProvenanceError("INVALID_PROVENANCE_JSON");
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AiSourceProvenanceError("INVALID_PROVENANCE_JSON");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new AiSourceProvenanceError("INVALID_PROVENANCE_JSON");
  }

  const result = aiSourceProvenanceSchema.safeParse(parsed);
  if (!result.success) {
    throw new AiSourceProvenanceError("INVALID_PROVENANCE_SCHEMA");
  }
  return result.data;
}

export function assertAiSourceProvenanceMediaBindings(
  provenance: AiSourceProvenance,
  bindings: Readonly<{
    canonicalSourceMp4Sha256: string;
    foregroundMaskSha256: string;
  }>,
): AiSourceProvenance {
  if (
    provenance.canonicalSourceMp4Sha256 !==
    bindings.canonicalSourceMp4Sha256
  ) {
    throw new AiSourceProvenanceError("PROVENANCE_SOURCE_MISMATCH");
  }
  if (provenance.foregroundMaskSha256 !== bindings.foregroundMaskSha256) {
    throw new AiSourceProvenanceError("PROVENANCE_MASK_MISMATCH");
  }
  return provenance;
}
