import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { validateSyntheticFixtureBytes } from "./synthetic-fixture-preflight";

const bytes = (value: string) => Buffer.from(value, "utf8");
const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

function auditFor(source: Buffer) {
  return {
    claim: "Protected core verified — canonical pre-encode frame sequence.",
    audit: {
      passed: true,
      canonical_contract_passed: true,
      total_changed_core_channel_samples: 0,
    },
    manifest: {
      digest_sha256: "aa".repeat(32),
      media_provenance: { source_file_sha256: sha256(source) },
    },
  };
}

describe("fixed synthetic fixture preflight", () => {
  it("returns the same validated byte objects that will be uploaded", () => {
    const sourceBytes = bytes("source");
    const restorationMaskBytes = bytes("mask");
    const result = validateSyntheticFixtureBytes({
      audit: auditFor(sourceBytes),
      sourceBytes,
      restorationMaskBytes,
      expectedRestorationMaskSha256: sha256(restorationMaskBytes),
    });

    expect(result.sourceBytes).toBe(sourceBytes);
    expect(result.restorationMaskBytes).toBe(restorationMaskBytes);
    expect(result.sourceSha256).toBe(sha256(sourceBytes));
    expect(result.restorationMaskSha256).toBe(sha256(restorationMaskBytes));
  });

  it("rejects changed source bytes before any upload", () => {
    const original = bytes("source");
    expect(() =>
      validateSyntheticFixtureBytes({
        audit: auditFor(original),
        sourceBytes: bytes("changed"),
        restorationMaskBytes: bytes("mask"),
        expectedRestorationMaskSha256: sha256(bytes("mask")),
      }),
    ).toThrow("source hash");
  });

  it("rejects a restoration mask outside the frozen fixture", () => {
    const sourceBytes = bytes("source");
    expect(() =>
      validateSyntheticFixtureBytes({
        audit: auditFor(sourceBytes),
        sourceBytes,
        restorationMaskBytes: bytes("changed-mask"),
        expectedRestorationMaskSha256: sha256(bytes("mask")),
      }),
    ).toThrow("restoration mask hash");
  });
});
