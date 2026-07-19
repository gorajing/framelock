import { describe, expect, it } from "vitest";

import {
  canonicalJsonSha256,
  embeddedCanonicalJsonSha256,
} from "./canonical-json";
import { calculateProofManifestDigest } from "../jobs/corruption-evidence";
import {
  calculateMotionDemoBindingDigest,
  validateMotionDemoArtifacts,
  type MotionDemoArtifactsInput,
} from "./motion-demo-evidence";

const sha = (byte: string) => byte.repeat(64);
const absolute = (relative: string) => `/project/${relative}`;

function fileRecord(path: string, hash: string, bytes = 100) {
  return { bytes, path, sha256: hash };
}

function passingFrameAudit(index: number) {
  return {
    artifact_integrity_passed: true,
    changed_core_channel_samples: 0,
    changed_core_pixels: 0,
    core_passed: true,
    index,
    maximum_absolute_channel_delta: 0,
    passed: true,
    protected_core_pixels: 100 + index,
    source_core_sha256: sha("a"),
    output_core_sha256: sha("a"),
    stage: "canonical_pre_encode" as const,
  } as const;
}

function fixture(): MotionDemoArtifactsInput {
  const paths = {
    projectRoot: "/project",
    admission: absolute(
      "artifacts/motion-v1/admissions/hero/motion_reshoot_admission.json",
    ),
    audit: absolute(
      "artifacts/motion-v1/admissions/hero/proof/motion_audit.json",
    ),
    temporalMatte: absolute(
      "artifacts/motion-v1/matte/hero/temporal_matte_manifest.json",
    ),
    proofManifest: absolute(
      "artifacts/motion-v1/admissions/hero/proof/proof_manifest.json",
    ),
    negativeSummary: absolute(
      "artifacts/motion-v1/admissions/hero/negative-control/summary.json",
    ),
    negativeAudit: absolute(
      "artifacts/motion-v1/admissions/hero/negative-control/audit.json",
    ),
    corruptionManifest: absolute(
      "artifacts/motion-v1/admissions/hero/negative-control/manifest.json",
    ),
    corruptedFrame: absolute(
      "artifacts/motion-v1/admissions/hero/negative-control/corrupted_composite_000060.png",
    ),
    maskPreviewProvenance: absolute(
      "artifacts/motion-v1/demo/mask-preview-provenance.json",
    ),
  };
  const hashes = {
    admission: sha("1"),
    audit: sha("2"),
    temporalMatte: sha("3"),
    proofManifest: sha("a"),
    negativeSummary: sha("4"),
    negativeAudit: sha("5"),
    corruptionManifest: sha("b"),
    corruptedFrame: sha("c"),
    maskPreviewProvenance: sha("d"),
    source: sha("6"),
    generatedWorld: sha("7"),
    mask: sha("8"),
    verified: sha("9"),
  };
  const bytes = {
    admission: 1_000,
    audit: 2_000,
    temporalMatte: 3_000,
    proofManifest: 3_500,
    negativeSummary: 400,
    negativeAudit: 500,
    corruptionManifest: 4_000,
    corruptedFrame: 4_500,
    maskPreviewProvenance: 600,
    source: 6_000,
    generatedWorld: 7_000,
    mask: 8_000,
    verified: 9_000,
  };
  const temporalMatteUnsigned = {
    schema_version: 1 as const,
    artifact_root: "/project/artifacts/motion-v1/matte/hero",
    artifacts: {},
    contract: {
      frame_count: 121 as const,
      frame_rate_numerator: 24 as const,
      frame_rate_denominator: 1 as const,
      height: 720 as const,
      width: 1280 as const,
    },
    frames: Array.from({ length: 121 }, (_, index) => ({
      index,
      soft_mask_path: absolute(
        `artifacts/motion-v1/matte/hero/foreground_${String(index).padStart(6, "0")}.png`,
      ),
      soft_mask_file_sha256: sha("b"),
      soft_mask_pixels_sha256: sha("e"),
      edit_mask_file_sha256: sha("c"),
      protected_core_pixels: 100 + index,
    })),
    qa: {},
    source: {},
  };
  const temporalMatte = {
    ...temporalMatteUnsigned,
    digest_sha256: embeddedCanonicalJsonSha256({
      ...temporalMatteUnsigned,
      digest_sha256: sha("0"),
    }),
  };
  const maskPreviewSoftMasks = temporalMatte.frames.map((frame) => ({
    file_sha256: frame.soft_mask_file_sha256,
    index: frame.index,
    path: frame.soft_mask_path,
    pixels_sha256: frame.soft_mask_pixels_sha256,
  }));
  const unsignedMaskPreviewProvenance = {
    artifact_root: absolute("artifacts/motion-v1/demo/mask-preview"),
    contract: {
      codec: "h264" as const,
      container: "mp4" as const,
      frame_count: 121 as const,
      frame_rate: "24/1" as const,
      height: 720 as const,
      pixel_format: "yuv420p" as const,
      width: 1280 as const,
    },
    encoder: {},
    kind: "framelock_temporal_mask_preview" as const,
    output: {
      ...fileRecord(
        absolute("artifacts/motion-v1/demo/mask-preview/mask-preview.mp4"),
        hashes.mask,
        bytes.mask,
      ),
      probe: {},
    },
    schema_version: 1 as const,
    source: {
      ordered_soft_mask_digest_sha256: canonicalJsonSha256(
        maskPreviewSoftMasks,
      ),
      soft_masks: maskPreviewSoftMasks,
      temporal_matte_manifest: fileRecord(
        paths.temporalMatte,
        hashes.temporalMatte,
        bytes.temporalMatte,
      ),
      temporal_matte_manifest_digest_sha256: temporalMatte.digest_sha256,
    },
  };
  const maskPreviewProvenance = {
    ...unsignedMaskPreviewProvenance,
    digest_sha256: embeddedCanonicalJsonSha256({
      ...unsignedMaskPreviewProvenance,
      digest_sha256: sha("0"),
    }),
  };
  const proofFrames = Array.from({ length: 121 }, (_, index) => ({
    index,
    source_path: absolute(
      `artifacts/motion-v1/source-decode/frames/frame_${String(index).padStart(6, "0")}.png`,
    ),
    core_mask_path: absolute(
      `artifacts/motion-v1/admissions/hero/proof/core_masks/core_${String(index).padStart(6, "0")}.png`,
    ),
    composite_path: absolute(
      `artifacts/motion-v1/admissions/hero/proof/composite_frames/composite_${String(index).padStart(6, "0")}.png`,
    ),
    source_file_sha256: sha("1"),
    source_rgb_sha256: sha("2"),
    core_mask_file_sha256: sha("3"),
    composite_file_sha256: sha("4"),
  }));
  const unsignedProofManifest = {
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
    digest_sha256: sha("0"),
  };
  const proofManifest = {
    ...unsignedProofManifest,
    digest_sha256: calculateProofManifestDigest(unsignedProofManifest),
  };
  const unsignedCorruptionManifest = {
    ...unsignedProofManifest,
    frames: proofFrames.map((frame, index) =>
      index === 60
        ? { ...frame, composite_path: paths.corruptedFrame }
        : { ...frame },
    ),
  };
  const corruptionManifest = {
    ...unsignedCorruptionManifest,
    digest_sha256: calculateProofManifestDigest(unsignedCorruptionManifest),
  };
  const audit = {
    schema_version: 1 as const,
    claim:
      "Protected core verified — canonical pre-encode frame sequence." as const,
    motion_input_digest_sha256: sha("d"),
    proof_manifest_digest_sha256: proofManifest.digest_sha256,
    source_ingest_digest_sha256: sha("f"),
    source_sequence_digest_sha256: sha("0"),
    audit: {
      artifact_integrity_passed: true as const,
      canonical_contract_passed: true as const,
      core_hash_match_count: 121 as const,
      core_passed: true as const,
      deterministic_composition_checked: true as const,
      deterministic_composition_passed: true as const,
      frame_audits: Array.from({ length: 121 }, (_, index) =>
        passingFrameAudit(index),
      ),
      frames_audited: 121 as const,
      frames_with_nonempty_core: 121 as const,
      manifest_digest_sha256: proofManifest.digest_sha256,
      passed: true as const,
      stage: "canonical_pre_encode" as const,
      total_changed_core_channel_samples: 0 as const,
      total_changed_core_pixels: 0 as const,
      total_core_pixels: 20_000,
      worst_maximum_absolute_channel_delta: 0 as const,
    },
  };
  const admissionUnsigned = {
    schema_version: 2 as const,
    kind: "framelock_motion_reshoot_admission" as const,
    verdict: "admitted" as const,
    claim:
      "Protected core verified — canonical pre-encode frame sequence." as const,
    contract: {
      frame_count: 121 as const,
      frame_rate: "24/1" as const,
      height: 720 as const,
      width: 1280 as const,
    },
    generated: {
      snapshot: fileRecord(
        "/project/artifacts/motion-v1/admissions/hero/inputs/generated-canonical.mp4",
        hashes.generatedWorld,
        bytes.generatedWorld,
      ),
    },
    preview: {
      ...fileRecord(
        "/project/artifacts/motion-v1/admissions/hero/preview.mp4",
        hashes.verified,
        bytes.verified,
      ),
      label: "Preview derived from verified canonical motion frames" as const,
    },
    proof: {
      audit: fileRecord(paths.audit, hashes.audit, bytes.audit),
      audit_passed: true as const,
      proof_manifest: fileRecord(
        paths.proofManifest,
        hashes.proofManifest,
        bytes.proofManifest,
      ),
      proof_manifest_digest_sha256: proofManifest.digest_sha256,
    },
    project_root: "/project",
    source: {
      approved_source: fileRecord(
        "/project/artifacts/motion-v1/source/source-canonical.mp4",
        hashes.source,
        bytes.source,
      ),
    },
    temporal_matte: {
      manifest: fileRecord(
        paths.temporalMatte,
        hashes.temporalMatte,
        bytes.temporalMatte,
      ),
      manifest_digest_sha256: temporalMatte.digest_sha256,
    },
  };
  const admission = {
    ...admissionUnsigned,
    digest_sha256: embeddedCanonicalJsonSha256({
      ...admissionUnsigned,
      digest_sha256: sha("0"),
    }),
  };
  const negativeAudit = {
    schema_version: 1 as const,
    claim: null,
    manifest: structuredClone(corruptionManifest),
    audit: {
      passed: false as const,
      canonical_contract_passed: true as const,
      core_passed: false as const,
      artifact_integrity_passed: false as const,
      frames_audited: 121 as const,
      frames_with_nonempty_core: 121 as const,
      total_changed_core_pixels: 1 as const,
      total_changed_core_channel_samples: 1 as const,
      worst_maximum_absolute_channel_delta: 1 as const,
      core_hash_match_count: 120 as const,
      manifest_digest_sha256: corruptionManifest.digest_sha256,
      stage: "canonical_pre_encode" as const,
      frame_audits: Array.from({ length: 121 }, (_, index) => ({
        index,
        passed: index !== 60,
        stage: "canonical_pre_encode" as const,
        output_core_sha256: index === 60 ? sha("e") : sha("2"),
        changed_core_pixels: index === 60 ? (1 as const) : (0 as const),
        changed_core_channel_samples:
          index === 60 ? (1 as const) : (0 as const),
        maximum_absolute_channel_delta:
          index === 60 ? (1 as const) : (0 as const),
      })),
    },
  };
  const negativeSummary = {
    schema_version: 2 as const,
    fixture: "one_channel_one_pixel_protected_core_corruption" as const,
    corrupted_frame_index: 60 as const,
    corrupted_channel: 1 as const,
    corrupted_frame_path: paths.corruptedFrame,
    corrupted_frame_file_sha256: hashes.corruptedFrame,
    corrupted_frame_rgb_sha256: sha("f"),
    corrupted_frame_output_core_sha256: sha("e"),
    passed: false as const,
    changed_core_pixels: 1 as const,
    changed_core_channel_samples: 1 as const,
    worst_maximum_absolute_channel_delta: 1 as const,
    canonical_artifacts_mutated: false as const,
    manifest_path: paths.corruptionManifest,
    manifest_sha256: hashes.corruptionManifest,
    audit_path: paths.negativeAudit,
    audit_sha256: hashes.negativeAudit,
  };
  const bindingUnsigned = {
    schema_version: 1 as const,
    kind: "framelock_motion_demo_binding" as const,
    admission: {
      path: "artifacts/motion-v1/admissions/hero/motion_reshoot_admission.json",
      sha256: hashes.admission,
      bytes: bytes.admission,
    },
    audit: {
      path: "artifacts/motion-v1/admissions/hero/proof/motion_audit.json",
      sha256: hashes.audit,
      bytes: bytes.audit,
    },
    proof_manifest: {
      path: "artifacts/motion-v1/admissions/hero/proof/proof_manifest.json",
      sha256: hashes.proofManifest,
      bytes: bytes.proofManifest,
    },
    temporal_matte: {
      path: "artifacts/motion-v1/matte/hero/temporal_matte_manifest.json",
      sha256: hashes.temporalMatte,
      bytes: bytes.temporalMatte,
    },
    negative_control: {
      summary: {
        path: "artifacts/motion-v1/admissions/hero/negative-control/summary.json",
        sha256: hashes.negativeSummary,
        bytes: bytes.negativeSummary,
      },
      audit: {
        path: "artifacts/motion-v1/admissions/hero/negative-control/audit.json",
        sha256: hashes.negativeAudit,
        bytes: bytes.negativeAudit,
      },
      manifest: {
        path: "artifacts/motion-v1/admissions/hero/negative-control/manifest.json",
        sha256: hashes.corruptionManifest,
        bytes: bytes.corruptionManifest,
      },
      corrupted_frame: {
        path: "artifacts/motion-v1/admissions/hero/negative-control/corrupted_composite_000060.png",
        sha256: hashes.corruptedFrame,
        bytes: bytes.corruptedFrame,
      },
    },
    mask_preview_provenance: {
      path: "artifacts/motion-v1/demo/mask-preview-provenance.json",
      sha256: hashes.maskPreviewProvenance,
      bytes: bytes.maskPreviewProvenance,
    },
    media: {
      source: {
        url: "/demo/motion/source.mp4" as const,
        sha256: hashes.source,
        bytes: bytes.source,
      },
      generated_world: {
        url: "/demo/motion/generated-world.mp4" as const,
        sha256: hashes.generatedWorld,
        bytes: bytes.generatedWorld,
      },
      mask: {
        url: "/demo/motion/mask.mp4" as const,
        sha256: hashes.mask,
        bytes: bytes.mask,
      },
      verified: {
        url: "/demo/motion/verified.mp4" as const,
        sha256: hashes.verified,
        bytes: bytes.verified,
      },
    },
  };
  const binding = {
    ...bindingUnsigned,
    digest_sha256: calculateMotionDemoBindingDigest({
      ...bindingUnsigned,
      digest_sha256: sha("0"),
    }),
  };

  return {
    binding,
    admission,
    audit,
    proofManifest,
    temporalMatte,
    negativeSummary,
    negativeAudit,
    corruptionManifest,
    maskPreviewProvenance,
    resolvedPaths: paths,
    integrity: {
      admission: { sha256: hashes.admission, bytes: bytes.admission },
      audit: { sha256: hashes.audit, bytes: bytes.audit },
      proofManifest: {
        sha256: hashes.proofManifest,
        bytes: bytes.proofManifest,
      },
      temporalMatte: {
        sha256: hashes.temporalMatte,
        bytes: bytes.temporalMatte,
      },
      negativeSummary: {
        sha256: hashes.negativeSummary,
        bytes: bytes.negativeSummary,
      },
      negativeAudit: {
        sha256: hashes.negativeAudit,
        bytes: bytes.negativeAudit,
      },
      corruptionManifest: {
        sha256: hashes.corruptionManifest,
        bytes: bytes.corruptionManifest,
      },
      corruptedFrame: {
        sha256: hashes.corruptedFrame,
        bytes: bytes.corruptedFrame,
      },
      maskPreviewProvenance: {
        sha256: hashes.maskPreviewProvenance,
        bytes: bytes.maskPreviewProvenance,
      },
      media: {
        source: { sha256: hashes.source, bytes: bytes.source },
        generated_world: {
          sha256: hashes.generatedWorld,
          bytes: bytes.generatedWorld,
        },
        mask: { sha256: hashes.mask, bytes: bytes.mask },
        verified: { sha256: hashes.verified, bytes: bytes.verified },
      },
    },
  };
}

describe("Motion demo evidence projection", () => {
  it("returns MotionDemo-compatible admitted evidence only for one fully bound proof", () => {
    expect(validateMotionDemoArtifacts(fixture())).toEqual({
      media: {
        source: "/demo/motion/source.mp4",
        raw: "/demo/motion/generated-world.mp4",
        mask: "/demo/motion/mask.mp4",
        verified: "/demo/motion/verified.mp4",
      },
      evidence: {
        admission: "admitted",
        audit: {
          claimScope: "canonical_pre_encode_frames",
          framesAudited: 121,
          framesExpected: 121,
          changedProtectedPixels: 0,
          temporalMasksBound: 121,
        },
        negativeControl: {
          status: "bound",
          frameIndex: 60,
          changedProtectedChannelSamples: 1,
          verifierRejected: true,
        },
      },
    });
  });

  it("rejects admission, audit, matte, media and negative-control drift", () => {
    const admissionDrift = fixture();
    admissionDrift.admission.verdict = "rejected" as "admitted";
    expect(() => validateMotionDemoArtifacts(admissionDrift)).toThrow();

    const auditDrift = fixture();
    auditDrift.audit.audit.total_changed_core_pixels = 1 as 0;
    expect(() => validateMotionDemoArtifacts(auditDrift)).toThrow();

    const matteDrift = fixture();
    matteDrift.temporalMatte.frames.pop();
    expect(() => validateMotionDemoArtifacts(matteDrift)).toThrow();

    const maskProvenanceDrift = fixture();
    maskProvenanceDrift.maskPreviewProvenance.source.soft_masks[60].file_sha256 =
      sha("f");
    maskProvenanceDrift.maskPreviewProvenance.source.ordered_soft_mask_digest_sha256 =
      canonicalJsonSha256(
        maskProvenanceDrift.maskPreviewProvenance.source.soft_masks,
      );
    maskProvenanceDrift.maskPreviewProvenance.digest_sha256 =
      embeddedCanonicalJsonSha256(maskProvenanceDrift.maskPreviewProvenance);
    expect(() => validateMotionDemoArtifacts(maskProvenanceDrift)).toThrow(
      "mask preview source sequence differs",
    );

    const mediaDrift = fixture();
    mediaDrift.integrity.media.verified.sha256 = sha("a");
    expect(() => validateMotionDemoArtifacts(mediaDrift)).toThrow(
      "motion demo file binding failed",
    );

    const fakeNegative = fixture();
    fakeNegative.negativeSummary.canonical_artifacts_mutated = true as false;
    expect(() => validateMotionDemoArtifacts(fakeNegative)).toThrow();
  });

  it("rejects a valid-looking binding whose canonical digest was not updated", () => {
    const input = fixture();
    input.binding.media.mask.bytes += 1;
    expect(() => validateMotionDemoArtifacts(input)).toThrow(
      "motion demo binding digest failed",
    );
  });

  it("accepts a relocated checkout only when every runtime suffix still matches the binding", () => {
    const input = fixture();
    input.resolvedPaths.projectRoot = "/relocated/video";
    const bindings = {
      admission: input.binding.admission.path,
      audit: input.binding.audit.path,
      proofManifest: input.binding.proof_manifest.path,
      temporalMatte: input.binding.temporal_matte.path,
      negativeSummary: input.binding.negative_control.summary.path,
      negativeAudit: input.binding.negative_control.audit.path,
      corruptionManifest: input.binding.negative_control.manifest.path,
      corruptedFrame: input.binding.negative_control.corrupted_frame.path,
      maskPreviewProvenance: input.binding.mask_preview_provenance.path,
    };
    for (const [role, relativePath] of Object.entries(bindings)) {
      input.resolvedPaths[role as keyof typeof bindings] =
        `/relocated/video/${relativePath}`;
    }
    expect(validateMotionDemoArtifacts(input).evidence.admission).toBe(
      "admitted",
    );

    input.resolvedPaths.audit = "/relocated/video/artifacts/wrong-audit.json";
    expect(() => validateMotionDemoArtifacts(input)).toThrow(
      "runtime artifact suffix differs",
    );
  });

  it("rejects original-root escapes and declared suffix drift after a valid reseal", () => {
    const escaped = fixture();
    escaped.admission.source.approved_source.path =
      "/different-checkout/source.mp4";
    escaped.admission.digest_sha256 = embeddedCanonicalJsonSha256(
      escaped.admission,
    );
    expect(() => validateMotionDemoArtifacts(escaped)).toThrow(
      "declared artifact path escapes",
    );

    const suffixDrift = fixture();
    suffixDrift.admission.proof.audit.path =
      "/project/artifacts/motion-v1/admissions/other/proof/motion_audit.json";
    suffixDrift.admission.digest_sha256 = embeddedCanonicalJsonSha256(
      suffixDrift.admission,
    );
    expect(() => validateMotionDemoArtifacts(suffixDrift)).toThrow(
      "declared artifact suffix differs",
    );
  });

  it("rejects proof lineage drift beyond the one frame-60 path substitution", () => {
    const extraMutation = fixture();
    extraMutation.corruptionManifest.frames[59].source_file_sha256 = sha("f");
    extraMutation.corruptionManifest.digest_sha256 =
      calculateProofManifestDigest(extraMutation.corruptionManifest);
    extraMutation.negativeAudit.manifest = structuredClone(
      extraMutation.corruptionManifest,
    );
    extraMutation.negativeAudit.audit.manifest_digest_sha256 =
      extraMutation.corruptionManifest.digest_sha256;
    expect(() => validateMotionDemoArtifacts(extraMutation)).toThrow(
      "negative manifest differs beyond the deliberate frame",
    );

    const embeddedDrift = fixture();
    embeddedDrift.negativeAudit.manifest.frames[12].composite_path =
      "/project/artifacts/motion-v1/admissions/other/composite.png";
    expect(() => validateMotionDemoArtifacts(embeddedDrift)).toThrow(
      "corruption audit embeds a different manifest",
    );
  });

  it("requires the admitted proof record and actual corrupted frame identity", () => {
    const proofRecordDrift = fixture();
    proofRecordDrift.admission.proof.proof_manifest.sha256 = sha("f");
    proofRecordDrift.admission.digest_sha256 = embeddedCanonicalJsonSha256(
      proofRecordDrift.admission,
    );
    expect(() => validateMotionDemoArtifacts(proofRecordDrift)).toThrow(
      "motion admission proof-manifest binding failed",
    );

    const corruptedFileDrift = fixture();
    corruptedFileDrift.integrity.corruptedFrame.sha256 = sha("f");
    expect(() => validateMotionDemoArtifacts(corruptedFileDrift)).toThrow(
      "motion demo file binding failed",
    );
  });

  it("rejects a substituted corrupted PNG after resealing its top-level binding", () => {
    const substituted = fixture();
    substituted.binding.negative_control.corrupted_frame.sha256 = sha("f");
    substituted.integrity.corruptedFrame.sha256 = sha("f");
    substituted.binding.digest_sha256 = calculateMotionDemoBindingDigest(
      substituted.binding,
    );

    expect(() => validateMotionDemoArtifacts(substituted)).toThrow(
      "corrupted frame identity failed",
    );
  });

  it("rejects legacy v1 corruption evidence even when its outer binding is valid", () => {
    const legacy = fixture();
    const summary = legacy.negativeSummary;
    legacy.negativeSummary = {
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
    } as unknown as MotionDemoArtifactsInput["negativeSummary"];

    expect(() => validateMotionDemoArtifacts(legacy)).toThrow(
      "motion negative control requires artifact-bound v2 evidence",
    );
  });
});
