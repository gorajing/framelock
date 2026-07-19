import { describe, expect, it } from "vitest";

import { buildDemoSummary, validateDemoArtifacts } from "./demo-summary";

const SHA = {
  klingAssessment: "10".repeat(32),
  ltxAssessment: "11".repeat(32),
  audit: "12".repeat(32),
  proofManifest: "13".repeat(32),
  proofDigest: "14".repeat(32),
  source: "15".repeat(32),
  raw: "16".repeat(32),
  preview: "17".repeat(32),
  runManifest: "18".repeat(32),
  runDigest: "19".repeat(32),
  reviewManifest: "20".repeat(32),
  reviewDigest: "21".repeat(32),
  sourceProofManifest: "22".repeat(32),
  ingestDigest: "23".repeat(32),
  restorationMask: "24".repeat(32),
  timestamps: "25".repeat(32),
  generationDigest: "26".repeat(32),
  ltxGenerationDigest: "27".repeat(32),
  ltxOutput: "28".repeat(32),
  sourceFrames: ["31".repeat(32), "32".repeat(32), "33".repeat(32)],
  rawFrames: ["34".repeat(32), "35".repeat(32), "36".repeat(32)],
  rawRgb: ["37".repeat(32), "38".repeat(32), "39".repeat(32)],
  compositeFrames: ["40".repeat(32), "41".repeat(32), "42".repeat(32)],
  overlayFrames: ["43".repeat(32), "44".repeat(32), "45".repeat(32)],
} as const;

const REVIEW_INDICES = [0, 60, 120] as const;

function selectedValue(values: readonly string[], index: number, fallback: string) {
  const selected = REVIEW_INDICES.indexOf(index as 0 | 60 | 120);
  return selected === -1 ? fallback : values[selected];
}

function makeProofFrames() {
  return Array.from({ length: 121 }, (_, index) => ({
    index,
    source_file_sha256: selectedValue(SHA.sourceFrames, index, "51".repeat(32)),
    source_rgb_sha256: "52".repeat(32),
    core_mask_file_sha256: "53".repeat(32),
    generated_file_sha256: selectedValue(SHA.rawFrames, index, "54".repeat(32)),
    generated_rgb_sha256: selectedValue(SHA.rawRgb, index, "55".repeat(32)),
    composite_file_sha256: selectedValue(
      SHA.compositeFrames,
      index,
      "56".repeat(32),
    ),
  }));
}

function makeProvenance() {
  return {
    source_file_sha256: SHA.raw,
    presentation_timestamps_sha256: SHA.timestamps,
    decoded_frame_count: 121,
    frame_rate_numerator: 24,
    frame_rate_denominator: 1,
    width: 1280,
    height: 720,
    max_pts_residual_microseconds: 0,
  };
}

function makeArtifacts() {
  const requestId = "019f72e4-5e1e-7143-bf91-e3aac20328da";
  const endpoint =
    "fal-ai/kling-video/o3/standard/video-to-video/edit" as const;
  const frames = makeProofFrames();
  const provenance = makeProvenance();
  const proofManifest = {
    schema_version: 2,
    ingest_schema_version: 1,
    digest_sha256: SHA.proofDigest,
    ingest_digest_sha256: SHA.ingestDigest,
    expected_frame_count: 121,
    expected_height: 720,
    expected_width: 1280,
    generation_binding: {
      prepared_foreground_mask_file_sha256: SHA.restorationMask,
      generated_media_provenance: provenance,
    },
    frames,
  };
  const overlays = REVIEW_INDICES.map((source_index, index) => ({
    source_index,
    sha256: SHA.overlayFrames[index],
  }));

  return {
    klingAssessment: {
      schema_version: 1,
      rule_version: "framelock-comparability-p0-v1",
      automatic_checks_passed: true,
      failed_checks: [],
      verdict: "comparable_pending_visual_approval",
      attempt: { index: 2, cap: 3 },
      media: {
        width: 1280,
        height: 720,
        frame_count: 121,
        frame_rate: "24/1",
        display_aspect_ratio: "16/9",
        max_timestamp_residual_microseconds: 0,
      },
      pricing: {
        billing_unit: "seconds",
        estimated_cost_usd: "0.705833",
        estimated_units: "5.041666667",
        source: "authenticated_fal_pricing_and_estimate",
        unit_price_usd: "0.14",
      },
      job_provenance: {
        id: "synthetic-hero-kling-o3-001",
        generation: {
          digest: SHA.generationDigest,
          sourceSha256: SHA.source,
          editMaskSha256: SHA.restorationMask,
          endpoint,
        },
        fal: {
          endpoint,
          requestId,
          generationDigest: SHA.generationDigest,
          modelOutput: {
            sha256: SHA.raw,
            url: "https://signed.example/secret-output.mp4",
          },
          sourceUploadUrl: "https://signed.example/secret-source.mp4",
        },
        local_path: "/Users/example/private/job.json",
      },
    },
    ltxAssessment: {
      schema_version: 1,
      rule_version: "framelock-comparability-p0-v1",
      automatic_checks_passed: false,
      failed_checks: ["display_aspect_ratio"],
      verdict: "not_comparable",
      normalization_applied: false,
      normalization_plan: "not_permitted",
      visual_geometry_note:
        "Cropping and aspect-distorting scaling are outside the frozen contract.",
      attempt: { index: 1, cap: 3 },
      checks: [
        {
          name: "display_aspect_ratio",
          actual: "5/3",
          expected: "16/9",
          passed: false,
        },
      ],
      pricing: {
        billing_unit: "megapixels",
        estimated_cost_usd: "0.268468992",
        estimated_units: "111.5136",
        source: "authenticated_fal_pricing",
        unit_price_usd: "0.0024075",
      },
      job_provenance: {
        id: "synthetic-hero-ltx-001",
        generation: { digest: SHA.ltxGenerationDigest },
        fal: {
          endpoint: "fal-ai/ltx-2.3-quality/inpaint",
          requestId: "019f72d1-0702-71b1-9832-e618f81455cb",
          generationDigest: SHA.ltxGenerationDigest,
          modelOutput: { sha256: SHA.ltxOutput },
        },
      },
    },
    proofManifest,
    reviewManifest: {
      schema_version: 1,
      digest_sha256: SHA.reviewDigest,
      review_state: "awaiting_visual_geometry_approval",
      reviewed_source_indices: REVIEW_INDICES,
      job: {
        endpoint,
        id: "synthetic-hero-kling-o3-001",
        generation_digest: SHA.generationDigest,
        model_output_sha256: SHA.raw,
        request_id: requestId,
        restoration_mask_sha256: SHA.restorationMask,
        source_sha256: SHA.source,
      },
      generation_assessment: {
        automatic_checks_passed: true,
        rule_version: "framelock-comparability-p0-v1",
        sha256: SHA.klingAssessment,
      },
      source_proof: {
        ingest_digest_sha256: SHA.ingestDigest,
        proof_manifest_sha256: SHA.sourceProofManifest,
      },
      prepared_foreground_mask: { sha256: SHA.restorationMask },
      generated_decode_provenance: provenance,
      generated_frames: frames.map((frame) => ({
        source_index: frame.index,
        file_sha256: frame.generated_file_sha256,
        rgb_sha256: frame.generated_rgb_sha256,
      })),
      geometry_overlays: overlays,
    },
    audit: {
      schema_version: 1,
      claim:
        "Protected core verified — canonical pre-encode frame sequence.",
      audit: {
        artifact_integrity_passed: true,
        canonical_contract_passed: true,
        core_hash_match_count: 121,
        core_passed: true,
        deterministic_composition_checked: true,
        deterministic_composition_passed: true,
        frames_audited: 121,
        frames_with_nonempty_core: 121,
        manifest_digest_sha256: SHA.proofDigest,
        passed: true,
        stage: "canonical_pre_encode",
        total_changed_core_channel_samples: 0,
        total_changed_core_pixels: 0,
        total_core_pixels: 22_029_381,
        worst_maximum_absolute_channel_delta: 0,
      },
      manifest: proofManifest,
    },
    runManifest: {
      schema_version: 2,
      claim:
        "Protected core verified — canonical pre-encode frame sequence.",
      digest_sha256: SHA.runDigest,
      generation_assessment: {
        automatic_checks_passed: true,
        rule_version: "framelock-comparability-p0-v1",
        sha256: SHA.klingAssessment,
      },
      job: {
        endpoint,
        id: "synthetic-hero-kling-o3-001",
        generation_digest: SHA.generationDigest,
        model_output_sha256: SHA.raw,
        request_id: requestId,
        restoration_mask_sha256: SHA.restorationMask,
        source_sha256: SHA.source,
      },
      source_proof: {
        ingest_digest_sha256: SHA.ingestDigest,
        proof_manifest_sha256: SHA.sourceProofManifest,
      },
      generated_decode_provenance: provenance,
      review_evidence: {
        manifest_digest_sha256: SHA.reviewDigest,
        manifest_sha256: SHA.reviewManifest,
        prepared_before_approval: true,
        geometry_overlays: overlays,
      },
      proof: {
        audit_sha256: SHA.audit,
        changed_core_channel_samples: 0,
        deterministic_composition_checked: true,
        deterministic_composition_passed: true,
        frames_audited: 121,
        manifest_digest_sha256: SHA.proofDigest,
        manifest_sha256: SHA.proofManifest,
      },
      preview: {
        label: "Preview derived from verified canonical frames",
        sha256: SHA.preview,
      },
      visual_geometry_approval: {
        note:
          "First, middle and final frames preserve the centered package geometry.",
        passed: true,
        review_manifest_sha256: SHA.reviewManifest,
        reviewed_overlay_sha256s: [...SHA.overlayFrames] as [
          string,
          string,
          string,
        ],
        reviewed_source_indices: REVIEW_INDICES,
        reviewer: "Independent visual review",
      },
    },
    integrity: {
      klingAssessmentSha256: SHA.klingAssessment,
      ltxAssessmentSha256: SHA.ltxAssessment,
      auditSha256: SHA.audit,
      proofManifestSha256: SHA.proofManifest,
      reviewManifestSha256: SHA.reviewManifest,
      reviewManifestCanonicalDigestSha256: SHA.reviewDigest,
      runManifestSha256: SHA.runManifest,
      runManifestCanonicalDigestSha256: SHA.runDigest,
      sourceProofManifestSha256: SHA.sourceProofManifest,
      sourceVideoSha256: SHA.source,
      rawVideoSha256: SHA.raw,
      previewVideoSha256: SHA.preview,
      servedFrames: {
        source: [...SHA.sourceFrames] as [string, string, string],
        raw: [...SHA.rawFrames] as [string, string, string],
        composite: [...SHA.compositeFrames] as [string, string, string],
        overlay: [...SHA.overlayFrames] as [string, string, string],
      },
    },
  };
}

describe("FrameLock demo summary v2", () => {
  it("projects a small verified public result and returns reconciler evidence", () => {
    const artifacts = makeArtifacts();
    const { evidence, summary } = validateDemoArtifacts(artifacts);

    expect(summary).toMatchObject({
      schemaVersion: 2,
      status: "verified",
      projectionLabel: "Legacy synthetic proof — read-only projection",
      fixture: "Synthetic diagnostic fixture",
      selectedGenerator: {
        name: "Kling O3 Standard Edit",
        requestId: "019f72e4-5e1e-7143-bf91-e3aac20328da",
      },
      proof: {
        framesAudited: 121,
        changedCoreChannelSamples: 0,
        deterministicCompositionChecked: true,
        deterministicCompositionPassed: true,
      },
    });
    expect(evidence).toMatchObject({
      kling: {
        generationDigest: SHA.generationDigest,
        assessmentSha256: SHA.klingAssessment,
        modelOutputSha256: SHA.raw,
      },
      ltx: {
        generationDigest: SHA.ltxGenerationDigest,
        assessmentSha256: SHA.ltxAssessment,
        modelOutputSha256: SHA.ltxOutput,
      },
      proof: {
        manifestSha256: SHA.proofManifest,
        auditSha256: SHA.audit,
        runSha256: SHA.runManifest,
        reviewSha256: SHA.reviewManifest,
        previewSha256: SHA.preview,
      },
    });

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("artifacts/");
    expect(serialized).not.toContain("UploadUrl");
  });

  it.each([
    ["v1 run", (value: ReturnType<typeof makeArtifacts>) => {
      value.runManifest.schema_version = 1;
    }],
    ["v1 proof", (value: ReturnType<typeof makeArtifacts>) => {
      value.proofManifest.schema_version = 1;
      value.audit.manifest.schema_version = 1;
    }],
    ["missing generation binding", (value: ReturnType<typeof makeArtifacts>) => {
      delete (value.proofManifest as Partial<typeof value.proofManifest>).generation_binding;
      delete (value.audit.manifest as Partial<typeof value.audit.manifest>).generation_binding;
    }],
    ["missing review evidence", (value: ReturnType<typeof makeArtifacts>) => {
      delete (value.runManifest as Partial<typeof value.runManifest>).review_evidence;
    }],
  ])("rejects %s evidence", (_label, mutate) => {
    const artifacts = makeArtifacts();
    mutate(artifacts);
    expect(() => buildDemoSummary(artifacts)).toThrow();
  });

  it("rejects an unchecked or failed deterministic composition", () => {
    const artifacts = makeArtifacts();
    artifacts.audit.audit.deterministic_composition_passed = false;
    artifacts.runManifest.proof.deterministic_composition_passed = false;
    expect(() => buildDemoSummary(artifacts)).toThrow();
  });

  it("rejects approval bound to a different overlay", () => {
    const artifacts = makeArtifacts();
    artifacts.runManifest.visual_geometry_approval.reviewed_overlay_sha256s[1] =
      "99".repeat(32);
    expect(() => buildDemoSummary(artifacts)).toThrow(/approval overlay/i);
  });

  it("rejects a served PNG whose bytes differ from proof evidence", () => {
    const artifacts = makeArtifacts();
    artifacts.integrity.servedFrames.source[0] = "99".repeat(32);
    expect(() => buildDemoSummary(artifacts)).toThrow(/served source frame/i);
  });

  it("rejects a review manifest whose canonical digest no longer matches", () => {
    const artifacts = makeArtifacts();
    artifacts.integrity.reviewManifestCanonicalDigestSha256 = "99".repeat(32);
    expect(() => buildDemoSummary(artifacts)).toThrow(/review manifest digest/i);
  });
});
