import { createHash } from "node:crypto";

import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue };

const generationIdentitySchema = z.object({
  sourceSha256: sha256Schema,
  editMaskSha256: sha256Schema,
  prompt: z.string().trim().min(1).max(2_000),
  endpoint: z.string().trim().min(1),
  parameters: z.record(z.string(), z.unknown()),
});

export type GenerationIdentity = z.input<typeof generationIdentitySchema>;

function canonicalize(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Generation parameters must contain finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  throw new TypeError("Generation parameters must be JSON values");
}

export function computeGenerationDigest(values: GenerationIdentity): string {
  const parsed = generationIdentitySchema.parse(values);
  const canonicalPayload = canonicalize({
    editMaskSha256: parsed.editMaskSha256,
    endpoint: parsed.endpoint,
    parameters: parsed.parameters,
    prompt: parsed.prompt,
    sourceSha256: parsed.sourceSha256,
  });

  return createHash("sha256")
    .update(JSON.stringify(canonicalPayload), "utf8")
    .digest("hex");
}

export const canonicalSha256Schema = sha256Schema;
