import { createHash } from "node:crypto";

function encodeString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entry]) => `${encodeString(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON accepts only JSON-compatible values");
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function embeddedCanonicalJsonSha256(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Manifest must be a JSON object");
  }
  const payload = { ...(value as Record<string, unknown>) };
  delete payload.digest_sha256;
  return canonicalJsonSha256(payload);
}
