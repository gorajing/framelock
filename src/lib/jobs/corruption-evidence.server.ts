import "server-only";

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { z } from "zod";

import {
  type CorruptionEvidenceInput,
  validateCorruptionEvidence,
} from "./corruption-evidence";
import { LocalJobStore } from "./local-job-store";

export const DEFAULT_CORRUPTION_JOB_ID =
  "synthetic-hero-kling-o3-001" as const;

const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const artifactsRoot = join(process.cwd(), "artifacts");
const jobsRoot = join(artifactsRoot, "jobs");
const jobs = new LocalJobStore(jobsRoot);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readOwnedFile(
  root: string,
  path: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; sha256: string }> {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const traversal = relative(resolvedRoot, resolvedPath);
  if (!traversal || traversal.startsWith("..")) {
    throw new Error("corruption evidence path escaped its job root");
  }
  const facts = await lstat(resolvedPath);
  if (!facts.isFile() || facts.isSymbolicLink() || facts.size > maxBytes) {
    throw new Error("corruption evidence is not a bounded regular file");
  }
  const canonicalPath = await realpath(resolvedPath);
  if (relative(resolvedRoot, canonicalPath).startsWith("..")) {
    throw new Error("corruption evidence resolved outside its job root");
  }
  const bytes = await readFile(resolvedPath);
  return {
    bytes,
    sha256: sha256(bytes),
  };
}

async function readOwnedJson(
  root: string,
  path: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; json: unknown; sha256: string }> {
  const artifact = await readOwnedFile(root, path, maxBytes);
  return {
    ...artifact,
    json: JSON.parse(artifact.bytes.toString("utf8")) as unknown,
  };
}

export async function readCorruptionEvidence(
  rawJobId: string = DEFAULT_CORRUPTION_JOB_ID,
) {
  const jobId = jobIdSchema.parse(rawJobId);
  const record = await jobs.readJob(jobId);
  if (
    record.state !== "verified" ||
    !record.composition ||
    !record.verification
  ) {
    throw new Error("corruption evidence requires a verified job");
  }
  const jobRoot = join(jobsRoot, jobId);
  const canonicalRoot = join(jobRoot, "canonical");
  const corruptionRoot = join(canonicalRoot, "corruption_fixture");
  const paths = {
    proofManifest: join(canonicalRoot, "proof_manifest.json"),
    runManifest: join(canonicalRoot, "run_manifest.json"),
    corruptionManifest: join(corruptionRoot, "corruption_manifest.json"),
    corruptionAudit: join(corruptionRoot, "corruption_audit.json"),
    corruptionSummary: join(corruptionRoot, "corruption_summary.json"),
    corruptedFrame: join(
      corruptionRoot,
      "corrupted_composite_000060.png",
    ),
  };
  const [proof, run, negative, audit, summary, corruptedFrame] =
    await Promise.all([
      readOwnedJson(jobRoot, paths.proofManifest, 16 * 1024 * 1024),
      readOwnedJson(jobRoot, paths.runManifest, 4 * 1024 * 1024),
      readOwnedJson(jobRoot, paths.corruptionManifest, 16 * 1024 * 1024),
      readOwnedJson(jobRoot, paths.corruptionAudit, 32 * 1024 * 1024),
      readOwnedJson(jobRoot, paths.corruptionSummary, 64 * 1024),
      readOwnedFile(jobRoot, paths.corruptedFrame, 32 * 1024 * 1024),
    ]);
  if (
    proof.sha256 !== record.composition.proofManifestSha256 ||
    run.sha256 !== record.verification.runManifestSha256
  ) {
    throw new Error("verified job no longer matches its proof evidence");
  }
  const runBinding =
    run.json &&
    typeof run.json === "object" &&
    !Array.isArray(run.json) &&
    "negative_test" in run.json
      ? (run.json as { negative_test: CorruptionEvidenceInput["runBinding"] })
          .negative_test
      : undefined;
  return validateCorruptionEvidence({
    jobId,
    expected: {
      proofManifestPath: paths.proofManifest,
      proofManifestSha256: record.composition.proofManifestSha256,
      corruptionManifestPath: paths.corruptionManifest,
      corruptionAuditPath: paths.corruptionAudit,
      corruptionSummaryPath: paths.corruptionSummary,
      corruptedFramePath: paths.corruptedFrame,
    },
    integrity: {
      proofManifestSha256: proof.sha256,
      corruptionManifestSha256: negative.sha256,
      corruptionAuditSha256: audit.sha256,
      corruptionSummarySha256: summary.sha256,
      corruptedFrameSha256: corruptedFrame.sha256,
    },
    proofManifest: proof.json as CorruptionEvidenceInput["proofManifest"],
    corruptionManifest:
      negative.json as CorruptionEvidenceInput["corruptionManifest"],
    audit: audit.json as CorruptionEvidenceInput["audit"],
    summary: summary.json as CorruptionEvidenceInput["summary"],
    ...(runBinding ? { runBinding } : {}),
  });
}
