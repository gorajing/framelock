import { z } from "zod";

import {
  validateCorruptionEvidence,
  type CorruptionEvidenceInput,
} from "../jobs/corruption-evidence";
import {
  canonicalJsonSha256,
  embeddedCanonicalJsonSha256,
} from "./canonical-json";

export const MOTION_VERIFIED_CLAIM =
  "Protected core verified — canonical pre-encode frame sequence." as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePathSchema = z.string().startsWith("/");
const relativeProjectPathSchema = z
  .string()
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/,
  );

const identitySchema = z
  .object({
    bytes: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

const boundFileSchema = identitySchema
  .extend({ path: relativeProjectPathSchema })
  .strict();

const artifactFileSchema = identitySchema
  .extend({ path: absolutePathSchema })
  .strict();

function mediaSchema<const Url extends string>(url: Url) {
  return identitySchema.extend({ url: z.literal(url) }).strict();
}

const motionDemoBindingSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("framelock_motion_demo_binding"),
    digest_sha256: sha256Schema,
    admission: boundFileSchema,
    audit: boundFileSchema,
    proof_manifest: boundFileSchema,
    temporal_matte: boundFileSchema,
    negative_control: z
      .object({
        summary: boundFileSchema,
        audit: boundFileSchema,
        manifest: boundFileSchema,
        corrupted_frame: boundFileSchema,
      })
      .strict(),
    mask_preview_provenance: boundFileSchema,
    media: z
      .object({
        source: mediaSchema("/demo/motion/source.mp4"),
        generated_world: mediaSchema(
          "/demo/motion/generated-world.mp4",
        ),
        mask: mediaSchema("/demo/motion/mask.mp4"),
        verified: mediaSchema("/demo/motion/verified.mp4"),
      })
      .strict(),
  })
  .strict();

const contractSchema = z
  .object({
    frame_count: z.literal(121),
    frame_rate: z.literal("24/1"),
    height: z.literal(720),
    width: z.literal(1280),
  })
  .strict();

const admissionSchema = z
  .object({
    schema_version: z.union([z.literal(1), z.literal(2)]),
    kind: z.literal("framelock_motion_reshoot_admission"),
    digest_sha256: sha256Schema,
    verdict: z.literal("admitted"),
    claim: z.literal(MOTION_VERIFIED_CLAIM),
    contract: contractSchema,
    generated: z
      .object({ snapshot: artifactFileSchema })
      .passthrough(),
    preview: artifactFileSchema
      .extend({
        label: z.literal(
          "Preview derived from verified canonical motion frames",
        ),
      })
      .strict(),
    proof: z
      .object({
        audit: artifactFileSchema,
        audit_passed: z.literal(true),
        proof_manifest: artifactFileSchema,
        proof_manifest_digest_sha256: sha256Schema,
      })
      .passthrough(),
    project_root: absolutePathSchema,
    source: z
      .object({ approved_source: artifactFileSchema })
      .passthrough(),
    temporal_matte: z
      .object({
        manifest: artifactFileSchema,
        manifest_digest_sha256: sha256Schema,
      })
      .passthrough(),
  })
  .strict();

const passingFrameAuditSchema = z
  .object({
    artifact_integrity_passed: z.literal(true),
    changed_core_channel_samples: z.literal(0),
    changed_core_pixels: z.literal(0),
    core_passed: z.literal(true),
    index: z.number().int().min(0).max(120),
    maximum_absolute_channel_delta: z.literal(0),
    output_core_sha256: sha256Schema,
    passed: z.literal(true),
    protected_core_pixels: z.number().int().positive(),
    source_core_sha256: sha256Schema,
    stage: z.literal("canonical_pre_encode"),
  })
  .passthrough();

const passingFrameAuditsSchema = z
  .array(passingFrameAuditSchema)
  .length(121)
  .superRefine((frames, context) => {
    frames.forEach((frame, index) => {
      if (frame.index !== index) {
        context.addIssue({
          code: "custom",
          path: [index, "index"],
          message: "Motion audit frame indices must be consecutive",
        });
      }
      if (frame.source_core_sha256 !== frame.output_core_sha256) {
        context.addIssue({
          code: "custom",
          path: [index, "output_core_sha256"],
          message: "Protected core hash differs",
        });
      }
    });
  });

const motionAuditSchema = z
  .object({
    schema_version: z.literal(1),
    claim: z.literal(MOTION_VERIFIED_CLAIM),
    motion_input_digest_sha256: sha256Schema,
    proof_manifest_digest_sha256: sha256Schema,
    source_ingest_digest_sha256: sha256Schema,
    source_sequence_digest_sha256: sha256Schema,
    audit: z
      .object({
        artifact_integrity_passed: z.literal(true),
        canonical_contract_passed: z.literal(true),
        core_hash_match_count: z.literal(121),
        core_passed: z.literal(true),
        deterministic_composition_checked: z.literal(true),
        deterministic_composition_passed: z.literal(true),
        frame_audits: passingFrameAuditsSchema,
        frames_audited: z.literal(121),
        frames_with_nonempty_core: z.literal(121),
        manifest_digest_sha256: sha256Schema,
        passed: z.literal(true),
        stage: z.literal("canonical_pre_encode"),
        total_changed_core_channel_samples: z.literal(0),
        total_changed_core_pixels: z.literal(0),
        total_core_pixels: z.number().int().positive(),
        worst_maximum_absolute_channel_delta: z.literal(0),
      })
      .strict(),
  })
  .strict();

const temporalMatteFrameSchema = z
  .object({
    index: z.number().int().min(0).max(120),
    soft_mask_path: absolutePathSchema,
    soft_mask_file_sha256: sha256Schema,
    soft_mask_pixels_sha256: sha256Schema,
    edit_mask_file_sha256: sha256Schema,
    protected_core_pixels: z.number().int().positive(),
  })
  .passthrough();

const temporalMatteSchema = z
  .object({
    schema_version: z.literal(1),
    digest_sha256: sha256Schema,
    contract: z
      .object({
        frame_count: z.literal(121),
        frame_rate_numerator: z.literal(24),
        frame_rate_denominator: z.literal(1),
        height: z.literal(720),
        width: z.literal(1280),
      })
      .passthrough(),
    frames: z
      .array(temporalMatteFrameSchema)
      .length(121)
      .superRefine((frames, context) => {
        frames.forEach((frame, index) => {
          if (frame.index !== index) {
            context.addIssue({
              code: "custom",
              path: [index, "index"],
              message: "Temporal matte frame indices must be consecutive",
            });
          }
        });
      }),
  })
  .passthrough();

const negativeFrameAuditSchema = z
  .object({
    index: z.number().int().min(0).max(120),
    passed: z.boolean(),
    stage: z.literal("canonical_pre_encode"),
    changed_core_pixels: z.number().int().min(0),
    changed_core_channel_samples: z.number().int().min(0),
    maximum_absolute_channel_delta: z.number().int().min(0),
  })
  .passthrough();

const negativeAuditSchema = z
  .object({
    schema_version: z.literal(1),
    claim: z.null(),
    manifest: z.unknown(),
    audit: z
      .object({
        passed: z.literal(false),
        canonical_contract_passed: z.literal(true),
        core_passed: z.literal(false),
        artifact_integrity_passed: z.literal(false),
        frames_audited: z.literal(121),
        frames_with_nonempty_core: z.literal(121),
        total_changed_core_pixels: z.literal(1),
        total_changed_core_channel_samples: z.literal(1),
        worst_maximum_absolute_channel_delta: z.literal(1),
        core_hash_match_count: z.literal(120),
        manifest_digest_sha256: sha256Schema,
        stage: z.literal("canonical_pre_encode"),
        frame_audits: z.array(negativeFrameAuditSchema).length(121),
      })
      .passthrough(),
  })
  .passthrough();

const resolvedPathsSchema = z
  .object({
    projectRoot: absolutePathSchema,
    admission: absolutePathSchema,
    audit: absolutePathSchema,
    proofManifest: absolutePathSchema,
    temporalMatte: absolutePathSchema,
    negativeSummary: absolutePathSchema,
    negativeAudit: absolutePathSchema,
    corruptionManifest: absolutePathSchema,
    corruptedFrame: absolutePathSchema,
    maskPreviewProvenance: absolutePathSchema,
  })
  .strict();

const integritySchema = z
  .object({
    admission: identitySchema,
    audit: identitySchema,
    proofManifest: identitySchema,
    temporalMatte: identitySchema,
    negativeSummary: identitySchema,
    negativeAudit: identitySchema,
    corruptionManifest: identitySchema,
    corruptedFrame: identitySchema,
    maskPreviewProvenance: identitySchema,
    media: z
      .object({
        source: identitySchema,
        generated_world: identitySchema,
        mask: identitySchema,
        verified: identitySchema,
      })
      .strict(),
  })
  .strict();

const maskPreviewSoftMaskSchema = z
  .object({
    file_sha256: sha256Schema,
    index: z.number().int().min(0).max(120),
    path: absolutePathSchema,
    pixels_sha256: sha256Schema,
  })
  .strict();

const maskPreviewProvenanceSchema = z
  .object({
    artifact_root: absolutePathSchema,
    contract: z
      .object({
        codec: z.literal("h264"),
        container: z.literal("mp4"),
        frame_count: z.literal(121),
        frame_rate: z.literal("24/1"),
        height: z.literal(720),
        pixel_format: z.literal("yuv420p"),
        width: z.literal(1280),
      })
      .strict(),
    digest_sha256: sha256Schema,
    encoder: z.record(z.string(), z.unknown()),
    kind: z.literal("framelock_temporal_mask_preview"),
    output: artifactFileSchema
      .extend({ probe: z.record(z.string(), z.unknown()) })
      .strict(),
    schema_version: z.literal(1),
    source: z
      .object({
        ordered_soft_mask_digest_sha256: sha256Schema,
        soft_masks: z.array(maskPreviewSoftMaskSchema).length(121),
        temporal_matte_manifest: artifactFileSchema,
        temporal_matte_manifest_digest_sha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

export type MotionDemoBinding = z.output<typeof motionDemoBindingSchema>;

export type MotionDemoArtifactsInput = {
  binding: z.input<typeof motionDemoBindingSchema>;
  admission: z.input<typeof admissionSchema>;
  audit: z.input<typeof motionAuditSchema>;
  proofManifest: CorruptionEvidenceInput["proofManifest"];
  temporalMatte: z.input<typeof temporalMatteSchema>;
  negativeSummary: CorruptionEvidenceInput["summary"];
  negativeAudit: CorruptionEvidenceInput["audit"];
  corruptionManifest: CorruptionEvidenceInput["corruptionManifest"];
  maskPreviewProvenance: z.input<typeof maskPreviewProvenanceSchema>;
  resolvedPaths: z.input<typeof resolvedPathsSchema>;
  integrity: z.input<typeof integritySchema>;
};

export type MotionDemoProjection = Readonly<{
  media: Readonly<{
    source: "/demo/motion/source.mp4";
    raw: "/demo/motion/generated-world.mp4";
    mask: "/demo/motion/mask.mp4";
    verified: "/demo/motion/verified.mp4";
  }>;
  evidence: Readonly<{
    admission: "admitted";
    audit: Readonly<{
      claimScope: "canonical_pre_encode_frames";
      framesAudited: 121;
      framesExpected: 121;
      changedProtectedPixels: 0;
      temporalMasksBound: 121;
    }>;
    negativeControl: Readonly<{
      status: "bound";
      frameIndex: 60;
      changedProtectedChannelSamples: 1;
      verifierRejected: true;
    }>;
  }>;
}>;

function fail(message: string): never {
  throw new Error(message);
}

function identityMatches(
  expected: { sha256: string; bytes: number },
  actual: { sha256: string; bytes: number },
): boolean {
  return expected.sha256 === actual.sha256 && expected.bytes === actual.bytes;
}

function projectRelativeSuffix(
  projectRoot: string,
  absolutePath: string,
  role: string,
): string {
  const normalizedRoot =
    projectRoot.length > 1 && projectRoot.endsWith("/")
      ? projectRoot.slice(0, -1)
      : projectRoot;
  const prefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  if (!absolutePath.startsWith(prefix)) {
    fail(`${role} declared artifact path escapes its original project root`);
  }
  const suffix = absolutePath.slice(prefix.length);
  const segments = suffix.split("/");
  if (
    !suffix ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(`${role} declared artifact path is noncanonical`);
  }
  return suffix;
}

function requireDeclaredSuffix(
  projectRoot: string,
  declaredPath: string,
  bindingPath: string,
  role: string,
): void {
  if (projectRelativeSuffix(projectRoot, declaredPath, role) !== bindingPath) {
    fail(`${role} declared artifact suffix differs from the binding`);
  }
}

function requireRuntimeSuffix(
  runtimeRoot: string,
  runtimePath: string,
  bindingPath: string,
  role: string,
): void {
  if (projectRelativeSuffix(runtimeRoot, runtimePath, role) !== bindingPath) {
    fail(`${role} runtime artifact suffix differs from the binding`);
  }
}

function originalBoundPath(projectRoot: string, bindingPath: string): string {
  return `${projectRoot.endsWith("/") ? projectRoot.slice(0, -1) : projectRoot}/${bindingPath}`;
}

function assertDeclaredArtifactPathsUnderRoot(
  value: unknown,
  projectRoot: string,
  role: string,
): void {
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach((item) => visit(item));
      return;
    }
    if (!entry || typeof entry !== "object") return;
    Object.entries(entry as Record<string, unknown>).forEach(
      ([childKey, child]) => {
        const artifactPathKey =
          childKey === "path" ||
          childKey.endsWith("_path") ||
          childKey === "artifact_root" ||
          childKey === "root";
        if (
          childKey !== "project_root" &&
          artifactPathKey &&
          typeof child === "string" &&
          child.startsWith("/")
        ) {
          projectRelativeSuffix(projectRoot, child, `${role}.${childKey}`);
        } else {
          visit(child);
        }
      },
    );
  };
  visit(value);
}

export function parseMotionDemoBinding(value: unknown): MotionDemoBinding {
  return motionDemoBindingSchema.parse(value);
}

export function calculateMotionDemoBindingDigest(
  value: z.input<typeof motionDemoBindingSchema>,
): string {
  const binding = motionDemoBindingSchema.parse(value);
  return embeddedCanonicalJsonSha256(binding);
}

export function validateMotionDemoArtifacts(
  input: MotionDemoArtifactsInput,
): MotionDemoProjection {
  const binding = motionDemoBindingSchema.parse(input.binding);
  if (calculateMotionDemoBindingDigest(binding) !== binding.digest_sha256) {
    fail("motion demo binding digest failed");
  }
  const admission = admissionSchema.parse(input.admission);
  const audit = motionAuditSchema.parse(input.audit);
  const matte = temporalMatteSchema.parse(input.temporalMatte);
  const negativeAudit = negativeAuditSchema.parse(input.negativeAudit);
  const maskPreview = maskPreviewProvenanceSchema.parse(
    input.maskPreviewProvenance,
  );
  const paths = resolvedPathsSchema.parse(input.resolvedPaths);
  const integrity = integritySchema.parse(input.integrity);

  if (
    embeddedCanonicalJsonSha256(input.admission) !==
    admission.digest_sha256
  ) {
    fail("motion admission canonical digest failed");
  }
  const fileBindings = [
    [binding.admission, integrity.admission],
    [binding.audit, integrity.audit],
    [binding.proof_manifest, integrity.proofManifest],
    [binding.temporal_matte, integrity.temporalMatte],
    [binding.negative_control.summary, integrity.negativeSummary],
    [binding.negative_control.audit, integrity.negativeAudit],
    [binding.negative_control.manifest, integrity.corruptionManifest],
    [binding.negative_control.corrupted_frame, integrity.corruptedFrame],
    [binding.mask_preview_provenance, integrity.maskPreviewProvenance],
    [binding.media.source, integrity.media.source],
    [binding.media.generated_world, integrity.media.generated_world],
    [binding.media.mask, integrity.media.mask],
    [binding.media.verified, integrity.media.verified],
  ] as const;
  if (
    fileBindings.some(
      ([expected, actual]) => !identityMatches(expected, actual),
    )
  ) {
    fail("motion demo file binding failed");
  }

  const runtimeBindings = [
    [paths.admission, binding.admission.path, "admission"],
    [paths.audit, binding.audit.path, "audit"],
    [paths.proofManifest, binding.proof_manifest.path, "proof manifest"],
    [paths.temporalMatte, binding.temporal_matte.path, "temporal matte"],
    [
      paths.negativeSummary,
      binding.negative_control.summary.path,
      "negative summary",
    ],
    [
      paths.negativeAudit,
      binding.negative_control.audit.path,
      "negative audit",
    ],
    [
      paths.corruptionManifest,
      binding.negative_control.manifest.path,
      "corruption manifest",
    ],
    [
      paths.corruptedFrame,
      binding.negative_control.corrupted_frame.path,
      "corrupted frame",
    ],
    [
      paths.maskPreviewProvenance,
      binding.mask_preview_provenance.path,
      "mask preview provenance",
    ],
  ] as const;
  runtimeBindings.forEach(([runtimePath, bindingPath, role]) =>
    requireRuntimeSuffix(paths.projectRoot, runtimePath, bindingPath, role),
  );

  const originalRoot = admission.project_root;
  [
    [input.admission, "admission"],
    [input.proofManifest, "proof manifest"],
    [input.temporalMatte, "temporal matte"],
    [input.negativeSummary, "negative summary"],
    [input.negativeAudit, "negative audit"],
    [input.corruptionManifest, "corruption manifest"],
    [input.maskPreviewProvenance, "mask preview provenance"],
  ].forEach(([artifact, role]) =>
    assertDeclaredArtifactPathsUnderRoot(
      artifact,
      originalRoot,
      role as string,
    ),
  );

  if (
    !identityMatches(admission.proof.audit, integrity.audit) ||
    !identityMatches(
      admission.temporal_matte.manifest,
      integrity.temporalMatte,
    )
  ) {
    fail("motion admission referenced artifact binding failed");
  }
  requireDeclaredSuffix(
    originalRoot,
    admission.proof.audit.path,
    binding.audit.path,
    "motion audit",
  );
  requireDeclaredSuffix(
    originalRoot,
    admission.temporal_matte.manifest.path,
    binding.temporal_matte.path,
    "temporal matte",
  );
  if (
    !identityMatches(
      admission.proof.proof_manifest,
      integrity.proofManifest,
    )
  ) {
    fail("motion admission proof-manifest binding failed");
  }
  requireDeclaredSuffix(
    originalRoot,
    admission.proof.proof_manifest.path,
    binding.proof_manifest.path,
    "motion proof manifest",
  );
  if (
    admission.proof.proof_manifest_digest_sha256 !==
      input.proofManifest.digest_sha256 ||
    audit.proof_manifest_digest_sha256 !== input.proofManifest.digest_sha256 ||
    audit.audit.manifest_digest_sha256 !== input.proofManifest.digest_sha256
  ) {
    fail("motion audit names a different proof manifest");
  }
  if (
    matte.digest_sha256 !==
    admission.temporal_matte.manifest_digest_sha256
  ) {
    fail("temporal matte differs from the admitted matte digest");
  }
  if (
    embeddedCanonicalJsonSha256(input.maskPreviewProvenance) !==
    maskPreview.digest_sha256
  ) {
    fail("mask preview canonical digest failed");
  }
  requireDeclaredSuffix(
    originalRoot,
    maskPreview.source.temporal_matte_manifest.path,
    binding.temporal_matte.path,
    "mask preview temporal matte",
  );
  if (
    !identityMatches(
      maskPreview.source.temporal_matte_manifest,
      integrity.temporalMatte,
    ) ||
    maskPreview.source.temporal_matte_manifest_digest_sha256 !==
      matte.digest_sha256 ||
    !identityMatches(maskPreview.output, binding.media.mask)
  ) {
    fail("mask preview provenance binding failed");
  }
  if (
    canonicalJsonSha256(maskPreview.source.soft_masks) !==
    maskPreview.source.ordered_soft_mask_digest_sha256
  ) {
    fail("mask preview ordered soft-mask digest failed");
  }
  maskPreview.source.soft_masks.forEach((record, index) => {
    const matteFrame = matte.frames[index];
    if (
      record.index !== index ||
      !matteFrame ||
      record.path !== matteFrame.soft_mask_path ||
      record.file_sha256 !== matteFrame.soft_mask_file_sha256 ||
      record.pixels_sha256 !== matteFrame.soft_mask_pixels_sha256
    ) {
      fail("mask preview source sequence differs from the temporal matte");
    }
  });
  if (
    !identityMatches(admission.source.approved_source, binding.media.source) ||
    !identityMatches(
      admission.generated.snapshot,
      binding.media.generated_world,
    ) ||
    !identityMatches(admission.preview, binding.media.verified)
  ) {
    fail("public motion media differs from admitted media");
  }

  const corruptionEvidence = validateCorruptionEvidence({
    jobId: "motion-demo",
    expected: {
      proofManifestPath: originalBoundPath(
        originalRoot,
        binding.proof_manifest.path,
      ),
      proofManifestSha256: binding.proof_manifest.sha256,
      corruptionManifestPath: originalBoundPath(
        originalRoot,
        binding.negative_control.manifest.path,
      ),
      corruptionAuditPath: originalBoundPath(
        originalRoot,
        binding.negative_control.audit.path,
      ),
      corruptionSummaryPath: originalBoundPath(
        originalRoot,
        binding.negative_control.summary.path,
      ),
      corruptedFramePath: originalBoundPath(
        originalRoot,
        binding.negative_control.corrupted_frame.path,
      ),
    },
    integrity: {
      proofManifestSha256: integrity.proofManifest.sha256,
      corruptionManifestSha256: integrity.corruptionManifest.sha256,
      corruptionAuditSha256: integrity.negativeAudit.sha256,
      corruptionSummarySha256: integrity.negativeSummary.sha256,
      corruptedFrameSha256: integrity.corruptedFrame.sha256,
    },
    proofManifest: input.proofManifest,
    corruptionManifest: input.corruptionManifest,
    audit: input.negativeAudit,
    summary: input.negativeSummary,
  });
  if (!corruptionEvidence.artifactBound) {
    fail("motion negative control requires artifact-bound v2 evidence");
  }
  if (
    corruptionEvidence.frameIndex !== 60 ||
    corruptionEvidence.changedCorePixels !== 1 ||
    corruptionEvidence.changedCoreChannelSamples !== 1
  ) {
    fail("negative-control lineage is invalid");
  }

  const negativeFrames = [...negativeAudit.audit.frame_audits].sort(
    (left, right) => left.index - right.index,
  );
  if (
    negativeFrames.some((frame, index) => frame.index !== index) ||
    negativeFrames.reduce(
      (total, frame) => total + frame.changed_core_pixels,
      0,
    ) !== 1 ||
    negativeFrames.reduce(
      (total, frame) => total + frame.changed_core_channel_samples,
      0,
    ) !== 1
  ) {
    fail("negative-control frame sequence is invalid");
  }
  const corruptedFrame = negativeFrames[60];
  if (
    !corruptedFrame ||
    corruptedFrame.passed ||
    corruptedFrame.changed_core_pixels !== 1 ||
    corruptedFrame.changed_core_channel_samples !== 1 ||
    corruptedFrame.maximum_absolute_channel_delta !== 1 ||
    negativeFrames.some(
      (frame, index) =>
        index !== 60 &&
        (!frame.passed ||
          frame.changed_core_pixels !== 0 ||
          frame.changed_core_channel_samples !== 0 ||
          frame.maximum_absolute_channel_delta !== 0),
    )
  ) {
    fail("negative control is not the exact frame-60 one-sample failure");
  }

  return {
    media: {
      source: binding.media.source.url,
      raw: binding.media.generated_world.url,
      mask: binding.media.mask.url,
      verified: binding.media.verified.url,
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
  };
}
