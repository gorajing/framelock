import { AI_SOURCE_PROVENANCE_MAX_BYTES } from "./ai-source-provenance";

export const OWNERSHIP_CONFIRMATION =
  "I own or control the rights to this AI-generated source and derived media." as const;

export const REAL_JOB_UPLOAD_LIMITS = {
  sourceBytes: 50 * 1024 * 1024,
  maskBytes: 10 * 1024 * 1024,
  provenanceBytes: AI_SOURCE_PROVENANCE_MAX_BYTES,
} as const;

type UploadLimits = Readonly<{
  sourceBytes: number;
  maskBytes: number;
  provenanceBytes: number;
}>;

export type RealJobIntake = Readonly<{
  source: File;
  foregroundMask: File;
  sourceProvenance: File;
  prompt: string;
}>;

export class RealJobIntakeError extends Error {
  constructor(
    readonly code:
      | "DUPLICATE_FIELD"
      | "INVALID_MASK_FILE"
      | "INVALID_MASK_TYPE"
      | "INVALID_PROMPT"
      | "INVALID_PROVENANCE_FILE"
      | "INVALID_PROVENANCE_TYPE"
      | "INVALID_SOURCE_FILE"
      | "INVALID_SOURCE_TYPE"
      | "MASK_TOO_LARGE"
      | "OWNERSHIP_NOT_CONFIRMED"
      | "PROVENANCE_TOO_LARGE"
      | "SOURCE_TOO_LARGE"
      | "UNEXPECTED_FIELD",
  ) {
    super(code);
    this.name = "RealJobIntakeError";
  }
}

const EXPECTED_FIELDS = new Set([
  "foregroundMask",
  "ownershipConfirmation",
  "prompt",
  "source",
  "sourceProvenance",
]);

function oneValue(form: FormData, field: string): FormDataEntryValue | null {
  const values = form.getAll(field);
  if (values.length > 1) {
    throw new RealJobIntakeError("DUPLICATE_FIELD");
  }
  return values[0] ?? null;
}

export function parseRealJobIntake(
  form: FormData,
  limits: UploadLimits = REAL_JOB_UPLOAD_LIMITS,
): RealJobIntake {
  for (const field of form.keys()) {
    if (!EXPECTED_FIELDS.has(field)) {
      throw new RealJobIntakeError("UNEXPECTED_FIELD");
    }
  }

  const source = oneValue(form, "source");
  if (!(source instanceof File) || source.size === 0) {
    throw new RealJobIntakeError("INVALID_SOURCE_FILE");
  }
  if (source.type !== "video/mp4") {
    throw new RealJobIntakeError("INVALID_SOURCE_TYPE");
  }
  if (source.size > limits.sourceBytes) {
    throw new RealJobIntakeError("SOURCE_TOO_LARGE");
  }

  const foregroundMask = oneValue(form, "foregroundMask");
  if (!(foregroundMask instanceof File) || foregroundMask.size === 0) {
    throw new RealJobIntakeError("INVALID_MASK_FILE");
  }
  if (foregroundMask.type !== "image/png") {
    throw new RealJobIntakeError("INVALID_MASK_TYPE");
  }
  if (foregroundMask.size > limits.maskBytes) {
    throw new RealJobIntakeError("MASK_TOO_LARGE");
  }

  const sourceProvenance = oneValue(form, "sourceProvenance");
  if (!(sourceProvenance instanceof File) || sourceProvenance.size === 0) {
    throw new RealJobIntakeError("INVALID_PROVENANCE_FILE");
  }
  if (sourceProvenance.type !== "application/json") {
    throw new RealJobIntakeError("INVALID_PROVENANCE_TYPE");
  }
  if (sourceProvenance.size > limits.provenanceBytes) {
    throw new RealJobIntakeError("PROVENANCE_TOO_LARGE");
  }

  const rawPrompt = oneValue(form, "prompt");
  const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
  if (prompt.length < 1 || prompt.length > 2_000) {
    throw new RealJobIntakeError("INVALID_PROMPT");
  }

  if (oneValue(form, "ownershipConfirmation") !== OWNERSHIP_CONFIRMATION) {
    throw new RealJobIntakeError("OWNERSHIP_NOT_CONFIRMED");
  }

  return { foregroundMask, prompt, source, sourceProvenance };
}
