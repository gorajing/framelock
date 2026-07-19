import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const decimalSchema = z.string().regex(/^\d+(?:\.\d+)?$/);
const absolutePathSchema = z.string().min(1).refine(isAbsolute, {
  message: "Expected an absolute path",
});

const sourcePreparationSchema = z
  .object({
    state: z.literal("validated"),
    claim: z.null(),
    next_step: z.literal("generation"),
    run_directory: absolutePathSchema,
    source: absolutePathSchema,
    source_sha256: sha256Schema,
    foreground_mask: absolutePathSchema,
    foreground_mask_sha256: sha256Schema,
    protected_core_pixels_per_frame: z.number().int().positive(),
    proof_manifest: absolutePathSchema,
    proof_manifest_sha256: sha256Schema,
    summary: absolutePathSchema,
  })
  .strict();

export type SourcePreparationEvidence = z.infer<
  typeof sourcePreparationSchema
>;

const generationAssessmentSchema = z
  .object({
    assessment: absolutePathSchema,
    raw_probe: absolutePathSchema,
    verdict: z.enum([
      "not_comparable",
      "comparable_pending_visual_approval",
    ]),
  })
  .strict();

const generationReviewSchema = z
  .object({
    generated_frames: z.literal(121),
    geometry_overlays: z.tuple([
      absolutePathSchema,
      absolutePathSchema,
      absolutePathSchema,
    ]),
    geometry_overlay_sha256s: z.tuple([
      sha256Schema,
      sha256Schema,
      sha256Schema,
    ]),
    review_manifest: absolutePathSchema,
    review_manifest_sha256: sha256Schema,
    review_manifest_digest_sha256: sha256Schema,
    review_state: z.literal("awaiting_visual_geometry_approval"),
  })
  .strict();

const finalizationSchema = z
  .object({
    audit: absolutePathSchema,
    canonical_contract_passed: z.literal(true),
    changed_core_channel_samples: z.literal(0),
    claim: z.literal(
      "Protected core verified — canonical pre-encode frame sequence.",
    ),
    manifest: absolutePathSchema,
    preview: absolutePathSchema,
    run_manifest: absolutePathSchema,
  })
  .strict();

const finalizationFailureSchema = z
  .object({
    state: z.literal("verification_failed"),
    claim: z.null(),
    code: z.literal("CANONICAL_FINALIZATION_REJECTED"),
    detail: z.literal(
      "Canonical finalization rejected the approved evidence; no proof was promoted.",
    ),
  })
  .strict();

const finalizationOutcomeSchema = z.union([
  finalizationSchema,
  finalizationFailureSchema,
]);

const committedFinalizationSchema = z
  .object({
    state: z.literal("committed"),
    marker: absolutePathSchema,
    marker_sha256: sha256Schema,
    schema_version: z.literal(1),
    attempt_id: z.string().uuid(),
    review_manifest_sha256: sha256Schema,
    output_count: z.literal(9),
    stale_journal_reconciled: z.boolean(),
  })
  .strict();

export type GenerationAssessmentEvidence = z.infer<
  typeof generationAssessmentSchema
>;
export type GenerationReviewEvidence = z.infer<typeof generationReviewSchema>;
export type FinalizationSuccessEvidence = z.infer<typeof finalizationSchema>;
export type FinalizationFailureEvidence = z.infer<
  typeof finalizationFailureSchema
>;
export type FinalizationEvidence = z.infer<typeof finalizationOutcomeSchema>;
export type CommittedFinalizationEvidence = z.infer<
  typeof committedFinalizationSchema
>;

type ProcessEnvironment = Readonly<Record<string, string | undefined>>;

export type FrameLockCliProcessOptions = Readonly<{
  cwd: string;
  encoding: "utf8";
  env: ProcessEnvironment;
  maxBuffer: number;
  timeout: number;
  windowsHide: true;
}>;

export type FrameLockCliProcessPort = Readonly<{
  run(
    executable: string,
    arguments_: readonly string[],
    options: FrameLockCliProcessOptions,
  ): Promise<{ stdout: string; stderr: string }>;
}>;

type BridgeOptions = Readonly<{
  executable: string;
  cwd: string;
  environment: ProcessEnvironment;
  process: FrameLockCliProcessPort;
}>;

type PrepareSourceInput = Readonly<{
  sourcePath: string;
  foregroundMaskPath: string;
  outputDirectory: string;
}>;

type AssessGenerationInput = Readonly<{
  mediaPath: string;
  outputDirectory: string;
  jobRecordPath: string;
  paidAttemptIndex: number;
  paidAttemptCap: number;
  unitPriceUsd: string;
  billingUnit: string;
  estimatedUnits: string;
  estimatedCostUsd: string;
  pricingSource: string;
  priceObservedAt: string;
  snapshotCapturedAt: string;
  snapshotDigestSha256: string;
}>;

type PrepareGenerationReviewInput = Readonly<{
  sourceProofDirectory: string;
  foregroundMaskPath: string;
  generatedMediaPath: string;
  generationAssessmentPath: string;
  jobRecordPath: string;
  outputDirectory: string;
}>;

type FinalizeGenerationProofInput = Readonly<{
  preparedReviewDirectory: string;
  reviewManifestSha256: string;
  overlaySha256s: readonly [string, string, string];
  reviewer: string;
  visualNote: string;
}>;

type ValidateFinalizationCommitInput = Readonly<{
  preparedReviewDirectory: string;
  reviewManifestSha256: string;
}>;

export class FrameLockCliError extends Error {
  constructor(
    readonly code: "CLI_EXECUTION_FAILED" | "INVALID_CLI_OUTPUT",
  ) {
    super(code);
    this.name = "FrameLockCliError";
  }
}

function childEnvironment(environment: ProcessEnvironment): ProcessEnvironment {
  const allowed = ["LANG", "LC_ALL", "PATH", "SYSTEMROOT", "TMPDIR"] as const;
  return Object.fromEntries(
    allowed.flatMap((name) =>
      environment[name] === undefined ? [] : [[name, environment[name]]],
    ),
  );
}

function isWithin(root: string, candidate: string): boolean {
  const traversal = relative(root, candidate);
  return traversal === "" || (!traversal.startsWith("..") && !isAbsolute(traversal));
}

function parsePreparationEvidence(
  stdout: string,
  expectedOutputDirectory: string,
): SourcePreparationEvidence {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new FrameLockCliError("INVALID_CLI_OUTPUT");
  }
  const parsed = sourcePreparationSchema.safeParse(payload);
  if (!parsed.success) {
    throw new FrameLockCliError("INVALID_CLI_OUTPUT");
  }

  const expectedRoot = resolve(expectedOutputDirectory);
  const evidence = parsed.data;
  if (
    resolve(evidence.run_directory) !== expectedRoot ||
    ![
      evidence.source,
      evidence.foreground_mask,
      evidence.proof_manifest,
      evidence.summary,
    ].every((path) => isWithin(expectedRoot, resolve(path)))
  ) {
    throw new FrameLockCliError("INVALID_CLI_OUTPUT");
  }
  return evidence;
}

function parseJson<T>(schema: z.ZodType<T>, stdout: string): T {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new FrameLockCliError("INVALID_CLI_OUTPUT");
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new FrameLockCliError("INVALID_CLI_OUTPUT");
  }
  return parsed.data;
}

function assertOutputPaths(root: string, paths: readonly string[]): void {
  const resolvedRoot = resolve(root);
  if (!paths.every((path) => isWithin(resolvedRoot, resolve(path)))) {
    throw new FrameLockCliError("INVALID_CLI_OUTPUT");
  }
}

export function createFrameLockCliBridge(options: BridgeOptions) {
  const executable = resolve(options.executable);
  const cwd = resolve(options.cwd);
  const env = childEnvironment(options.environment);

  async function runCommand(
    arguments_: readonly string[],
    timeout: number,
  ): Promise<string> {
    try {
      return (
        await options.process.run(executable, arguments_, {
          cwd,
          encoding: "utf8",
          env,
          maxBuffer: 256 * 1024,
          timeout,
          windowsHide: true,
        })
      ).stdout;
    } catch {
      throw new FrameLockCliError("CLI_EXECUTION_FAILED");
    }
  }

  return {
    async prepareSource(
      input: PrepareSourceInput,
    ): Promise<SourcePreparationEvidence> {
      const sourcePath = resolve(input.sourcePath);
      const foregroundMaskPath = resolve(input.foregroundMaskPath);
      const outputDirectory = resolve(input.outputDirectory);
      const stdout = await runCommand(
        [
          "prepare-source",
          "--source",
          sourcePath,
          "--foreground-mask",
          foregroundMaskPath,
          "--output",
          outputDirectory,
        ],
        2 * 60 * 1_000,
      );
      return parsePreparationEvidence(stdout, outputDirectory);
    },

    async assessGeneration(
      input: AssessGenerationInput,
    ): Promise<GenerationAssessmentEvidence> {
      const attempt = z
        .object({
          index: z.number().int().positive(),
          cap: z.number().int().positive(),
        })
        .refine((value) => value.index <= value.cap)
        .parse({ index: input.paidAttemptIndex, cap: input.paidAttemptCap });
      const pricing = z
        .object({
          unitPriceUsd: decimalSchema,
          billingUnit: z.string().trim().min(1).max(64),
          estimatedUnits: decimalSchema,
          estimatedCostUsd: decimalSchema,
          pricingSource: z.string().trim().min(1).max(256),
          priceObservedAt: z.string().datetime(),
          snapshotCapturedAt: z.string().datetime(),
          snapshotDigestSha256: sha256Schema,
        })
        .parse(input);
      const outputDirectory = resolve(input.outputDirectory);
      const stdout = await runCommand(
        [
          "assess-generation",
          "--media",
          resolve(input.mediaPath),
          "--output",
          outputDirectory,
          "--job-record",
          resolve(input.jobRecordPath),
          "--paid-attempt-index",
          String(attempt.index),
          "--paid-attempt-cap",
          String(attempt.cap),
          "--unit-price-usd",
          pricing.unitPriceUsd,
          "--billing-unit",
          pricing.billingUnit,
          "--estimated-units",
          pricing.estimatedUnits,
          "--estimated-cost-usd",
          pricing.estimatedCostUsd,
          "--pricing-source",
          pricing.pricingSource,
          "--price-observed-at",
          pricing.priceObservedAt,
          "--snapshot-captured-at",
          pricing.snapshotCapturedAt,
          "--snapshot-digest-sha256",
          pricing.snapshotDigestSha256,
        ],
        2 * 60 * 1_000,
      );
      const evidence = parseJson(generationAssessmentSchema, stdout);
      assertOutputPaths(outputDirectory, [
        evidence.assessment,
        evidence.raw_probe,
      ]);
      return evidence;
    },

    async prepareGenerationReview(
      input: PrepareGenerationReviewInput,
    ): Promise<GenerationReviewEvidence> {
      const outputDirectory = resolve(input.outputDirectory);
      const stdout = await runCommand(
        [
          "prepare-generation-review",
          "--source-proof-directory",
          resolve(input.sourceProofDirectory),
          "--foreground-mask",
          resolve(input.foregroundMaskPath),
          "--generated-media",
          resolve(input.generatedMediaPath),
          "--generation-assessment",
          resolve(input.generationAssessmentPath),
          "--job-record",
          resolve(input.jobRecordPath),
          "--output",
          outputDirectory,
        ],
        5 * 60 * 1_000,
      );
      const evidence = parseJson(generationReviewSchema, stdout);
      assertOutputPaths(outputDirectory, [
        ...evidence.geometry_overlays,
        evidence.review_manifest,
      ]);
      return evidence;
    },

    async finalizeGenerationProof(
      input: FinalizeGenerationProofInput,
    ): Promise<FinalizationEvidence> {
      const preparedReviewDirectory = resolve(input.preparedReviewDirectory);
      const overlaySha256s = z
        .tuple([sha256Schema, sha256Schema, sha256Schema])
        .parse(input.overlaySha256s);
      const reviewManifestSha256 = sha256Schema.parse(
        input.reviewManifestSha256,
      );
      const reviewer = z.string().trim().min(1).max(200).parse(input.reviewer);
      const visualNote = z
        .string()
        .trim()
        .min(1)
        .max(2_000)
        .parse(input.visualNote);
      const stdout = await runCommand(
        [
          "finalize-generation-proof",
          "--prepared-review-directory",
          preparedReviewDirectory,
          "--geometry-approval",
          "APPROVE 0 60 120",
          "--review-manifest-sha256",
          reviewManifestSha256,
          "--overlay-sha256",
          ...overlaySha256s,
          "--reviewer",
          reviewer,
          "--visual-note",
          visualNote,
        ],
        5 * 60 * 1_000,
      );
      const evidence = parseJson(finalizationOutcomeSchema, stdout);
      if ("state" in evidence) {
        return evidence;
      }
      assertOutputPaths(preparedReviewDirectory, [
        evidence.audit,
        evidence.manifest,
        evidence.preview,
        evidence.run_manifest,
      ]);
      return evidence;
    },

    async validateFinalizationCommit(
      input: ValidateFinalizationCommitInput,
    ): Promise<CommittedFinalizationEvidence> {
      const preparedReviewDirectory = resolve(input.preparedReviewDirectory);
      const reviewManifestSha256 = sha256Schema.parse(
        input.reviewManifestSha256,
      );
      const stdout = await runCommand(
        [
          "validate-finalization-commit",
          "--prepared-review-directory",
          preparedReviewDirectory,
          "--review-manifest-sha256",
          reviewManifestSha256,
        ],
        5 * 60 * 1_000,
      );
      const evidence = parseJson(committedFinalizationSchema, stdout);
      assertOutputPaths(preparedReviewDirectory, [evidence.marker]);
      if (evidence.review_manifest_sha256 !== reviewManifestSha256) {
        throw new FrameLockCliError("INVALID_CLI_OUTPUT");
      }
      return evidence;
    },
  };
}
