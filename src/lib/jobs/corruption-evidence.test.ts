import { describe, expect, it } from "vitest";

import {
  calculateProofManifestDigest,
  validateCorruptionEvidence,
  type CorruptionEvidenceInput,
} from "./corruption-evidence";

const sha = (byte: string) => byte.repeat(64);

function fixture(): CorruptionEvidenceInput {
  const proofFrames = Array.from({ length: 121 }, (_, index) => ({
    index,
    source_path: `/proof/source_${String(index).padStart(6, "0")}.png`,
    core_mask_path: `/proof/core_${String(index).padStart(6, "0")}.png`,
    composite_path: `/proof/composite_${String(index).padStart(6, "0")}.png`,
    source_file_sha256: sha("1"),
    source_rgb_sha256: sha("2"),
    core_mask_file_sha256: sha("3"),
    composite_file_sha256: sha("4"),
  }));
  const unsignedProof = {
    schema_version: 1 as const,
    expected_width: 1280 as const,
    expected_height: 720 as const,
    expected_frame_count: 121 as const,
    ingest_schema_version: 1 as const,
    ingest_digest_sha256: sha("5"),
    mask_parameters: { foreground_threshold: 128, erosion_radius: 4 },
    media_provenance: null,
    generation_binding: null,
    frames: proofFrames,
  };
  const provisionalProof = {
    ...unsignedProof,
    digest_sha256: sha("0"),
  };
  const proof = {
    ...provisionalProof,
    digest_sha256: calculateProofManifestDigest(provisionalProof),
  };
  const corruptionPath =
    "/jobs/real_01/canonical/corruption_fixture/corrupted_composite_000060.png";
  const negativeFrames = proofFrames.map((frame, index) =>
    index === 60 ? { ...frame, composite_path: corruptionPath } : frame,
  );
  const unsignedNegative = { ...unsignedProof, frames: negativeFrames };
  const provisionalNegative = {
    ...unsignedNegative,
    digest_sha256: sha("0"),
  };
  const negative = {
    ...provisionalNegative,
    digest_sha256: calculateProofManifestDigest(provisionalNegative),
  };
  const manifestPath =
    "/jobs/real_01/canonical/corruption_fixture/corruption_manifest.json";
  const auditPath =
    "/jobs/real_01/canonical/corruption_fixture/corruption_audit.json";
  const summaryPath =
    "/jobs/real_01/canonical/corruption_fixture/corruption_summary.json";
  return {
    jobId: "real_01",
    expected: {
      proofManifestPath: "/jobs/real_01/canonical/proof_manifest.json",
      proofManifestSha256: sha("a"),
      corruptionManifestPath: manifestPath,
      corruptionAuditPath: auditPath,
      corruptionSummaryPath: summaryPath,
      corruptedFramePath: corruptionPath,
    },
    integrity: {
      proofManifestSha256: sha("a"),
      corruptionManifestSha256: sha("b"),
      corruptionAuditSha256: sha("c"),
      corruptionSummarySha256: sha("d"),
      corruptedFrameSha256: sha("e"),
    },
    proofManifest: proof,
    corruptionManifest: negative,
    audit: {
      schema_version: 1,
      claim: null,
      manifest: negative,
      audit: {
        passed: false,
        canonical_contract_passed: true,
        core_passed: false,
        artifact_integrity_passed: false,
        frames_audited: 121,
        frames_with_nonempty_core: 121,
        total_changed_core_pixels: 1,
        total_changed_core_channel_samples: 1,
        worst_maximum_absolute_channel_delta: 1,
        core_hash_match_count: 120,
        manifest_digest_sha256: negative.digest_sha256,
        stage: "canonical_pre_encode",
        frame_audits: Array.from({ length: 121 }, (_, index) => ({
          index,
          output_core_sha256: index === 60 ? sha("6") : sha("2"),
        })),
      },
    },
    summary: {
      schema_version: 2,
      fixture: "one_channel_one_pixel_protected_core_corruption",
      corrupted_frame_index: 60,
      corrupted_channel: 1,
      corrupted_frame_path: corruptionPath,
      corrupted_frame_file_sha256: sha("e"),
      corrupted_frame_rgb_sha256: sha("7"),
      corrupted_frame_output_core_sha256: sha("6"),
      passed: false,
      changed_core_pixels: 1,
      changed_core_channel_samples: 1,
      worst_maximum_absolute_channel_delta: 1,
      canonical_artifacts_mutated: false,
      manifest_path: manifestPath,
      manifest_sha256: sha("b"),
      audit_path: auditPath,
      audit_sha256: sha("c"),
    },
    runBinding: {
      fixture: "one_channel_one_pixel_protected_core_corruption",
      frame_index: 60,
      channel: 1,
      passed: false,
      claim: null,
      canonical_artifacts_mutated: false,
      changed_core_pixels: 1,
      changed_core_channel_samples: 1,
      worst_maximum_absolute_channel_delta: 1,
      manifest_path: manifestPath,
      manifest_sha256: sha("b"),
      audit_path: auditPath,
      audit_sha256: sha("c"),
      summary_path: summaryPath,
      summary_sha256: sha("d"),
    },
  };
}

function legacyFixture(): CorruptionEvidenceInput {
  const input = fixture();
  const summary = input.summary;
  input.summary = {
    fixture: summary.fixture,
    corrupted_frame_index: summary.corrupted_frame_index,
    corrupted_channel: summary.corrupted_channel,
    passed: summary.passed,
    changed_core_pixels: summary.changed_core_pixels,
    changed_core_channel_samples: summary.changed_core_channel_samples,
    worst_maximum_absolute_channel_delta:
      summary.worst_maximum_absolute_channel_delta,
    canonical_artifacts_mutated: summary.canonical_artifacts_mutated,
    manifest_path: summary.manifest_path,
    manifest_sha256: summary.manifest_sha256,
    audit_path: summary.audit_path,
    audit_sha256: summary.audit_sha256,
  } as unknown as CorruptionEvidenceInput["summary"];
  return input;
}

describe("persisted corruption evidence", () => {
  it("accepts one exact claim-less verifier failure bound to the proof", () => {
    expect(validateCorruptionEvidence(fixture())).toEqual({
      jobId: "real_01",
      frameIndex: 60,
      channel: 1,
      changedCorePixels: 1,
      changedCoreChannelSamples: 1,
      worstMaximumAbsoluteChannelDelta: 1,
      coreHashMatchCount: 120,
      auditSha256: sha("c"),
      manifestSha256: sha("b"),
      summarySha256: sha("d"),
      runBound: true,
      artifactBound: true,
      summarySchemaVersion: 2,
    });
  });

  it("reopens legacy v1 evidence only as explicitly artifact-unbound", () => {
    const legacy = legacyFixture();
    legacy.integrity.corruptedFrameSha256 = sha("f");

    expect(validateCorruptionEvidence(legacy)).toEqual({
      jobId: "real_01",
      frameIndex: 60,
      channel: 1,
      changedCorePixels: 1,
      changedCoreChannelSamples: 1,
      worstMaximumAbsoluteChannelDelta: 1,
      coreHashMatchCount: 120,
      auditSha256: sha("c"),
      manifestSha256: sha("b"),
      summarySha256: sha("d"),
      runBound: true,
      artifactBound: false,
      summarySchemaVersion: 1,
    });
  });

  it("rejects hardcoded-looking evidence when a hash or frame binding drifts", () => {
    const hashDrift = fixture();
    hashDrift.summary.audit_sha256 = sha("e");
    expect(() => validateCorruptionEvidence(hashDrift)).toThrow(
      "corruption evidence hash binding failed",
    );

    const frameDrift = fixture();
    frameDrift.corruptionManifest.frames[61].composite_path =
      "/different.png";
    frameDrift.corruptionManifest.digest_sha256 =
      calculateProofManifestDigest(frameDrift.corruptionManifest);
    frameDrift.audit.manifest = structuredClone(
      frameDrift.corruptionManifest,
    );
    frameDrift.audit.audit.manifest_digest_sha256 =
      frameDrift.corruptionManifest.digest_sha256;
    expect(() => validateCorruptionEvidence(frameDrift)).toThrow();

    const fakePass = fixture();
    (fakePass.audit.audit as { passed: boolean }).passed = true;
    expect(() => validateCorruptionEvidence(fakePass)).toThrow();
  });

  it("rejects a substituted corrupted PNG even when its outer binding is resealed", () => {
    const substituted = fixture();
    substituted.integrity.corruptedFrameSha256 = sha("f");

    expect(() => validateCorruptionEvidence(substituted)).toThrow(
      "corrupted frame identity failed",
    );
  });

  it("rejects a corrupted-frame core hash that differs from frame 60 audit", () => {
    const staleAuditLineage = fixture();
    if (!("schema_version" in staleAuditLineage.summary)) {
      throw new Error("fixture must use artifact-bound v2 evidence");
    }
    staleAuditLineage.summary.corrupted_frame_output_core_sha256 = sha("f");

    expect(() => validateCorruptionEvidence(staleAuditLineage)).toThrow(
      "corrupted frame audit binding failed",
    );
  });
});
