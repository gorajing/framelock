import { describe, expect, it } from "vitest";

import {
  AI_SOURCE_PROVENANCE_LABEL,
  AiSourceProvenanceError,
  assertAiSourceProvenanceMediaBindings,
  parseAiSourceProvenanceBytes,
} from "./ai-source-provenance";

const SHA = {
  original: "10".repeat(32),
  bundle: "20".repeat(32),
  plate: "30".repeat(32),
  source: "40".repeat(32),
  mask: "50".repeat(32),
  contactSheet: "60".repeat(32),
  approval: "70".repeat(32),
} as const;

function validProvenance() {
  return {
    schemaVersion: 1,
    provenanceLabel: AI_SOURCE_PROVENANCE_LABEL,
    originalImageSha256: SHA.original,
    sourceBundleManifestSha256: SHA.bundle,
    normalizedPlateSha256: SHA.plate,
    canonicalSourceMp4Sha256: SHA.source,
    foregroundMaskSha256: SHA.mask,
    contactSheetSha256: SHA.contactSheet,
    approval: {
      recordSha256: SHA.approval,
      approvedAt: "2026-07-18T01:02:03.000Z",
      reviewer: "FrameLock executor",
      note: "FRM-01 is coherent, unbranded and suitable for a static mask.",
    },
  } as const;
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("AI-source provenance contract", () => {
  it("parses only the fixed AI-generated source manifest", () => {
    expect(parseAiSourceProvenanceBytes(encode(validProvenance()))).toEqual(
      validProvenance(),
    );
  });

  it("rejects unknown top-level and approval fields", () => {
    expect(() =>
      parseAiSourceProvenanceBytes(
        encode({ ...validProvenance(), cameraOriginal: true }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_PROVENANCE_SCHEMA" }),
    );

    expect(() =>
      parseAiSourceProvenanceBytes(
        encode({
          ...validProvenance(),
          approval: { ...validProvenance().approval, accepted: true },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_PROVENANCE_SCHEMA" }),
    );
  });

  it("rejects malformed hashes, labels, timestamps and empty approval text", () => {
    const invalidValues = [
      { ...validProvenance(), provenanceLabel: "camera_original" },
      { ...validProvenance(), canonicalSourceMp4Sha256: "source-latest" },
      {
        ...validProvenance(),
        approval: {
          ...validProvenance().approval,
          approvedAt: "not-a-timestamp",
        },
      },
      {
        ...validProvenance(),
        approval: { ...validProvenance().approval, note: "   " },
      },
    ];

    for (const value of invalidValues) {
      expect(() => parseAiSourceProvenanceBytes(encode(value))).toThrowError(
        expect.objectContaining({ code: "INVALID_PROVENANCE_SCHEMA" }),
      );
    }
  });

  it("enforces its byte bound before decoding JSON", () => {
    const bytes = encode(validProvenance());

    expect(() =>
      parseAiSourceProvenanceBytes(bytes, bytes.byteLength - 1),
    ).toThrowError(expect.objectContaining({ code: "PROVENANCE_TOO_LARGE" }));
    expect(() => parseAiSourceProvenanceBytes(new Uint8Array())).toThrowError(
      expect.objectContaining({ code: "INVALID_PROVENANCE_JSON" }),
    );
    expect(() =>
      parseAiSourceProvenanceBytes(new Uint8Array([0xff])),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_PROVENANCE_JSON" }),
    );
  });

  it("binds the exact prepared source MP4 and foreground mask hashes", () => {
    const provenance = parseAiSourceProvenanceBytes(encode(validProvenance()));

    expect(
      assertAiSourceProvenanceMediaBindings(provenance, {
        canonicalSourceMp4Sha256: SHA.source,
        foregroundMaskSha256: SHA.mask,
      }),
    ).toBe(provenance);
    expect(() =>
      assertAiSourceProvenanceMediaBindings(provenance, {
        canonicalSourceMp4Sha256: "80".repeat(32),
        foregroundMaskSha256: SHA.mask,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "PROVENANCE_SOURCE_MISMATCH" }),
    );
    expect(() =>
      assertAiSourceProvenanceMediaBindings(provenance, {
        canonicalSourceMp4Sha256: SHA.source,
        foregroundMaskSha256: "90".repeat(32),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "PROVENANCE_MASK_MISMATCH" }),
    );
  });

  it("uses stable errors that do not reflect uploaded JSON", () => {
    let error: unknown;
    try {
      parseAiSourceProvenanceBytes(
        new TextEncoder().encode('{"secret":"do-not-reflect"}'),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AiSourceProvenanceError);
    expect(String(error)).not.toContain("do-not-reflect");
  });
});
