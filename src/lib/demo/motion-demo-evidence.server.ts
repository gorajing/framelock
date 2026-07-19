import "server-only";

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  parseMotionDemoBinding,
  validateMotionDemoArtifacts,
  type MotionDemoProjection,
} from "./motion-demo-evidence";

export const DEFAULT_MOTION_DEMO_BINDING_PATH =
  "artifacts/motion-v1/demo/motion-demo-binding.json" as const;
export const DEFAULT_MOTION_DEMO_EVIDENCE_ROOT =
  "demo-evidence/motion/root" as const;

type MotionDemoReadOptions = Readonly<{
  projectRoot?: string;
  bindingPath?: string;
}>;

type ReadArtifact = {
  bytes: Buffer;
  json: unknown;
  path: string;
  sha256: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolvedOwnedPath(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error("motion demo path escaped its root");
  }
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const traversal = relative(resolvedRoot, resolvedPath);
  if (!traversal || traversal.startsWith("..") || isAbsolute(traversal)) {
    throw new Error("motion demo path escaped its root");
  }
  return resolvedPath;
}

async function readOwnedFile(
  root: string,
  relativePath: string,
  maxBytes: number,
  expectedBytes?: number,
): Promise<{ bytes: Buffer; path: string; sha256: string }> {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolvedOwnedPath(resolvedRoot, relativePath);
  const facts = await lstat(resolvedPath);
  if (
    !facts.isFile() ||
    facts.isSymbolicLink() ||
    facts.size <= 0 ||
    facts.size > maxBytes ||
    (expectedBytes !== undefined && facts.size !== expectedBytes)
  ) {
    throw new Error("motion demo evidence is not a bounded regular file");
  }
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(resolvedRoot),
    realpath(resolvedPath),
  ]);
  const traversal = relative(canonicalRoot, canonicalPath);
  if (!traversal || traversal.startsWith("..") || isAbsolute(traversal)) {
    throw new Error("motion demo evidence resolved outside its root");
  }
  const bytes = await readFile(resolvedPath);
  if (bytes.length !== facts.size) {
    throw new Error("motion demo evidence changed while it was read");
  }
  return { bytes, path: resolvedPath, sha256: sha256(bytes) };
}

async function readOwnedJson(
  root: string,
  relativePath: string,
  maxBytes: number,
  expectedBytes?: number,
): Promise<ReadArtifact> {
  const artifact = await readOwnedFile(
    root,
    relativePath,
    maxBytes,
    expectedBytes,
  );
  return {
    ...artifact,
    json: JSON.parse(artifact.bytes.toString("utf8")) as unknown,
  };
}

function publicRelativePath(url: string): string {
  if (!url.startsWith("/") || url.includes("?") || url.includes("#")) {
    throw new Error("motion demo media URL is not a fixed public asset");
  }
  return url.slice(1);
}

export async function readRequiredMotionDemoEvidence(
  options: MotionDemoReadOptions = {},
): Promise<MotionDemoProjection> {
  const hostProjectRoot =
    options.projectRoot === undefined
      ? process.cwd()
      : resolve(/*turbopackIgnore: true*/ options.projectRoot);
  const evidenceRoot =
    options.projectRoot === undefined
      ? join(hostProjectRoot, DEFAULT_MOTION_DEMO_EVIDENCE_ROOT)
      : hostProjectRoot;
  const publicRoot = join(hostProjectRoot, "public");
  const bindingArtifact = await readOwnedJson(
    evidenceRoot,
    options.bindingPath ?? DEFAULT_MOTION_DEMO_BINDING_PATH,
    256 * 1024,
  );
  const binding = parseMotionDemoBinding(bindingArtifact.json);

  const [
    admission,
    audit,
    proofManifest,
    matte,
    negativeSummary,
    negativeAudit,
    corruptionManifest,
    corruptedFrame,
    maskPreviewProvenance,
    source,
    generatedWorld,
    mask,
    verified,
  ] = await Promise.all([
      readOwnedJson(
        evidenceRoot,
        binding.admission.path,
        4 * 1024 * 1024,
        binding.admission.bytes,
      ),
      readOwnedJson(
        evidenceRoot,
        binding.audit.path,
        32 * 1024 * 1024,
        binding.audit.bytes,
      ),
      readOwnedJson(
        evidenceRoot,
        binding.proof_manifest.path,
        32 * 1024 * 1024,
        binding.proof_manifest.bytes,
      ),
      readOwnedJson(
        evidenceRoot,
        binding.temporal_matte.path,
        32 * 1024 * 1024,
        binding.temporal_matte.bytes,
      ),
      readOwnedJson(
        evidenceRoot,
        binding.negative_control.summary.path,
        256 * 1024,
        binding.negative_control.summary.bytes,
      ),
      readOwnedJson(
        evidenceRoot,
        binding.negative_control.audit.path,
        32 * 1024 * 1024,
        binding.negative_control.audit.bytes,
      ),
      readOwnedJson(
        evidenceRoot,
        binding.negative_control.manifest.path,
        32 * 1024 * 1024,
        binding.negative_control.manifest.bytes,
      ),
      readOwnedFile(
        evidenceRoot,
        binding.negative_control.corrupted_frame.path,
        32 * 1024 * 1024,
        binding.negative_control.corrupted_frame.bytes,
      ),
      readOwnedJson(
        evidenceRoot,
        binding.mask_preview_provenance.path,
        4 * 1024 * 1024,
        binding.mask_preview_provenance.bytes,
      ),
      readOwnedFile(
        publicRoot,
        publicRelativePath(binding.media.source.url),
        512 * 1024 * 1024,
        binding.media.source.bytes,
      ),
      readOwnedFile(
        publicRoot,
        publicRelativePath(binding.media.generated_world.url),
        512 * 1024 * 1024,
        binding.media.generated_world.bytes,
      ),
      readOwnedFile(
        publicRoot,
        publicRelativePath(binding.media.mask.url),
        512 * 1024 * 1024,
        binding.media.mask.bytes,
      ),
      readOwnedFile(
        publicRoot,
        publicRelativePath(binding.media.verified.url),
        512 * 1024 * 1024,
        binding.media.verified.bytes,
      ),
    ]);

  return validateMotionDemoArtifacts({
    binding,
    admission: admission.json as never,
    audit: audit.json as never,
    proofManifest: proofManifest.json as never,
    temporalMatte: matte.json as never,
    negativeSummary: negativeSummary.json as never,
    negativeAudit: negativeAudit.json as never,
    corruptionManifest: corruptionManifest.json as never,
    maskPreviewProvenance: maskPreviewProvenance.json as never,
    resolvedPaths: {
      projectRoot: evidenceRoot,
      admission: admission.path,
      audit: audit.path,
      proofManifest: proofManifest.path,
      temporalMatte: matte.path,
      negativeSummary: negativeSummary.path,
      negativeAudit: negativeAudit.path,
      corruptionManifest: corruptionManifest.path,
      corruptedFrame: corruptedFrame.path,
      maskPreviewProvenance: maskPreviewProvenance.path,
    },
    integrity: {
      admission: { sha256: admission.sha256, bytes: admission.bytes.length },
      audit: { sha256: audit.sha256, bytes: audit.bytes.length },
      proofManifest: {
        sha256: proofManifest.sha256,
        bytes: proofManifest.bytes.length,
      },
      temporalMatte: { sha256: matte.sha256, bytes: matte.bytes.length },
      negativeSummary: {
        sha256: negativeSummary.sha256,
        bytes: negativeSummary.bytes.length,
      },
      negativeAudit: {
        sha256: negativeAudit.sha256,
        bytes: negativeAudit.bytes.length,
      },
      corruptionManifest: {
        sha256: corruptionManifest.sha256,
        bytes: corruptionManifest.bytes.length,
      },
      corruptedFrame: {
        sha256: corruptedFrame.sha256,
        bytes: corruptedFrame.bytes.length,
      },
      maskPreviewProvenance: {
        sha256: maskPreviewProvenance.sha256,
        bytes: maskPreviewProvenance.bytes.length,
      },
      media: {
        source: { sha256: source.sha256, bytes: source.bytes.length },
        generated_world: {
          sha256: generatedWorld.sha256,
          bytes: generatedWorld.bytes.length,
        },
        mask: { sha256: mask.sha256, bytes: mask.bytes.length },
        verified: { sha256: verified.sha256, bytes: verified.bytes.length },
      },
    },
  });
}

export async function readMotionDemoEvidence(
  options: MotionDemoReadOptions = {},
): Promise<MotionDemoProjection | null> {
  try {
    return await readRequiredMotionDemoEvidence(options);
  } catch {
    return null;
  }
}
