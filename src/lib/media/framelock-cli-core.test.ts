import { describe, expect, it, vi } from "vitest";

import {
  FrameLockCliError,
  createFrameLockCliBridge,
  type FrameLockCliProcessPort,
} from "./framelock-cli-core";

const SHA = "a".repeat(64);

function validPreparationPayload() {
  return {
    state: "validated",
    claim: null,
    next_step: "generation",
    run_directory: "/tmp/framelock/runs/real_hero_001",
    source: "/tmp/framelock/runs/real_hero_001/inputs/source.mp4",
    source_sha256: SHA,
    foreground_mask:
      "/tmp/framelock/runs/real_hero_001/inputs/foreground.png",
    foreground_mask_sha256: SHA,
    protected_core_pixels_per_frame: 100,
    proof_manifest:
      "/tmp/framelock/runs/real_hero_001/proof/proof_manifest.json",
    proof_manifest_sha256: SHA,
    summary:
      "/tmp/framelock/runs/real_hero_001/source_preparation.json",
  };
}

describe("FrameLock media CLI bridge", () => {
  it("uses fixed argv, bounded execution and a secret-free child environment", async () => {
    const run = vi.fn<FrameLockCliProcessPort["run"]>(async () => ({
      stdout: JSON.stringify(validPreparationPayload()),
      stderr: "",
    }));
    const bridge = createFrameLockCliBridge({
      executable: "/repo/.venv/bin/framelock-media",
      cwd: "/repo",
      environment: {
        PATH: "/safe/bin",
        LANG: "en_US.UTF-8",
        FAL_KEY: "runtime-secret",
        FAL_ADMIN_KEY: "admin-secret",
        UNRELATED_SECRET: "must-not-propagate",
      },
      process: { run },
    });

    const result = await bridge.prepareSource({
      sourcePath: "/tmp/upload/source.mp4",
      foregroundMaskPath: "/tmp/upload/foreground.png",
      outputDirectory: "/tmp/framelock/runs/real_hero_001",
    });

    expect(result).toEqual(validPreparationPayload());
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      "/repo/.venv/bin/framelock-media",
      [
        "prepare-source",
        "--source",
        "/tmp/upload/source.mp4",
        "--foreground-mask",
        "/tmp/upload/foreground.png",
        "--output",
        "/tmp/framelock/runs/real_hero_001",
      ],
      {
        cwd: "/repo",
        encoding: "utf8",
        env: {
          LANG: "en_US.UTF-8",
          PATH: "/safe/bin",
        },
        maxBuffer: 256 * 1024,
        timeout: 2 * 60 * 1_000,
        windowsHide: true,
      },
    );
  });

  it("rejects malformed output instead of treating subprocess text as evidence", async () => {
    const bridge = createFrameLockCliBridge({
      executable: "/repo/.venv/bin/framelock-media",
      cwd: "/repo",
      environment: {},
      process: {
        async run() {
          return {
            stdout: JSON.stringify({ ...validPreparationPayload(), claim: "verified" }),
            stderr: "",
          };
        },
      },
    });

    await expect(
      bridge.prepareSource({
        sourcePath: "/tmp/source.mp4",
        foregroundMaskPath: "/tmp/mask.png",
        outputDirectory: "/tmp/run",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CLI_OUTPUT" });
  });

  it("normalizes process failures without reflecting stderr or secrets", async () => {
    const bridge = createFrameLockCliBridge({
      executable: "/repo/.venv/bin/framelock-media",
      cwd: "/repo",
      environment: { FAL_KEY: "do-not-reflect" },
      process: {
        async run() {
          throw new Error("stderr includes do-not-reflect");
        },
      },
    });

    const error = await bridge
      .prepareSource({
        sourcePath: "/tmp/source.mp4",
        foregroundMaskPath: "/tmp/mask.png",
        outputDirectory: "/tmp/run",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FrameLockCliError);
    expect(error).toMatchObject({ code: "CLI_EXECUTION_FAILED" });
    expect(String(error)).not.toContain("do-not-reflect");
  });

  it("runs assessment, review preparation and finalization with hash-bound argv", async () => {
    const jobRoot = "/tmp/framelock/jobs/real_hero_001";
    const run = vi.fn<FrameLockCliProcessPort["run"]>(
      async (_executable, arguments_) => {
        if (arguments_[0] === "assess-generation") {
          return {
            stdout: JSON.stringify({
              assessment: `${jobRoot}/assessment/comparability.json`,
              raw_probe: `${jobRoot}/assessment/ffprobe.raw.json`,
              verdict: "comparable_pending_visual_approval",
            }),
            stderr: "",
          };
        }
        if (arguments_[0] === "prepare-generation-review") {
          return {
            stdout: JSON.stringify({
              generated_frames: 121,
              geometry_overlays: [0, 60, 120].map(
                (index) => `${jobRoot}/canonical/geometry_overlays/frame_${index}.png`,
              ),
              geometry_overlay_sha256s: ["b".repeat(64), "c".repeat(64), "d".repeat(64)],
              review_manifest: `${jobRoot}/canonical/review_manifest.json`,
              review_manifest_sha256: "e".repeat(64),
              review_manifest_digest_sha256: "f".repeat(64),
              review_state: "awaiting_visual_geometry_approval",
            }),
            stderr: "",
          };
        }
        return {
          stdout: JSON.stringify({
            audit: `${jobRoot}/canonical/audit.json`,
            canonical_contract_passed: true,
            changed_core_channel_samples: 0,
            claim:
              "Protected core verified — canonical pre-encode frame sequence.",
            manifest: `${jobRoot}/canonical/proof_manifest.json`,
            preview: `${jobRoot}/canonical/preview.mp4`,
            run_manifest: `${jobRoot}/canonical/run_manifest.json`,
          }),
          stderr: "",
        };
      },
    );
    const bridge = createFrameLockCliBridge({
      executable: "/repo/.venv/bin/framelock-media",
      cwd: "/repo",
      environment: { PATH: "/safe/bin", FAL_KEY: "must-not-propagate" },
      process: { run },
    });

    const assessment = await bridge.assessGeneration({
      mediaPath: `${jobRoot}/model-output.mp4`,
      outputDirectory: `${jobRoot}/assessment`,
      jobRecordPath: `${jobRoot}/job.json`,
      paidAttemptIndex: 3,
      paidAttemptCap: 3,
      unitPriceUsd: "0.14",
      billingUnit: "seconds",
      estimatedUnits: "5.041666667",
      estimatedCostUsd: "0.7058333334",
      pricingSource: "authenticated_fal_pricing_and_estimate",
      priceObservedAt: "2026-07-17T18:47:33.000Z",
      snapshotCapturedAt: "2026-07-17T19:00:00.000Z",
      snapshotDigestSha256: "9".repeat(64),
    });
    expect(assessment.verdict).toBe("comparable_pending_visual_approval");

    const review = await bridge.prepareGenerationReview({
      sourceProofDirectory: "/tmp/framelock/runs/real_hero_001/proof",
      foregroundMaskPath:
        "/tmp/framelock/runs/real_hero_001/inputs/foreground.png",
      generatedMediaPath: `${jobRoot}/model-output.mp4`,
      generationAssessmentPath: assessment.assessment,
      jobRecordPath: `${jobRoot}/job.json`,
      outputDirectory: `${jobRoot}/canonical`,
    });
    expect(review.geometry_overlays).toHaveLength(3);

    const finalized = await bridge.finalizeGenerationProof({
      preparedReviewDirectory: `${jobRoot}/canonical`,
      reviewManifestSha256: review.review_manifest_sha256,
      overlaySha256s: review.geometry_overlay_sha256s,
      reviewer: "local-owner",
      visualNote: "Frames 0, 60 and 120 preserve source geometry.",
    });
    if ("state" in finalized) {
      throw new Error("expected passing finalization evidence");
    }
    expect(finalized.changed_core_channel_samples).toBe(0);

    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0]?.[1]).toEqual([
      "assess-generation",
      "--media",
      `${jobRoot}/model-output.mp4`,
      "--output",
      `${jobRoot}/assessment`,
      "--job-record",
      `${jobRoot}/job.json`,
      "--paid-attempt-index",
      "3",
      "--paid-attempt-cap",
      "3",
      "--unit-price-usd",
      "0.14",
      "--billing-unit",
      "seconds",
      "--estimated-units",
      "5.041666667",
      "--estimated-cost-usd",
      "0.7058333334",
      "--pricing-source",
      "authenticated_fal_pricing_and_estimate",
      "--price-observed-at",
      "2026-07-17T18:47:33.000Z",
      "--snapshot-captured-at",
      "2026-07-17T19:00:00.000Z",
      "--snapshot-digest-sha256",
      "9".repeat(64),
    ]);
    expect(run.mock.calls[2]?.[1]).toEqual([
      "finalize-generation-proof",
      "--prepared-review-directory",
      `${jobRoot}/canonical`,
      "--geometry-approval",
      "APPROVE 0 60 120",
      "--review-manifest-sha256",
      "e".repeat(64),
      "--overlay-sha256",
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
      "--reviewer",
      "local-owner",
      "--visual-note",
      "Frames 0, 60 and 120 preserve source geometry.",
    ]);
    expect(run.mock.calls.every((call) => call[2].env.FAL_KEY === undefined)).toBe(
      true,
    );
  });

  it("validates a committed finalization through fixed, secret-free argv", async () => {
    const root = "/tmp/framelock/jobs/real_hero_001/canonical";
    const reviewSha256 = "e".repeat(64);
    const run = vi.fn<FrameLockCliProcessPort["run"]>(async () => ({
      stdout: JSON.stringify({
        state: "committed",
        marker: `${root}/.finalization-committed.json`,
        marker_sha256: "a".repeat(64),
        schema_version: 1,
        attempt_id: "00000000-0000-4000-8000-000000000001",
        review_manifest_sha256: reviewSha256,
        output_count: 9,
        stale_journal_reconciled: true,
      }),
      stderr: "",
    }));
    const bridge = createFrameLockCliBridge({
      executable: "/repo/.venv/bin/framelock-media",
      cwd: "/repo",
      environment: { PATH: "/safe/bin", FAL_KEY: "must-not-propagate" },
      process: { run },
    });

    await expect(
      bridge.validateFinalizationCommit({
        preparedReviewDirectory: root,
        reviewManifestSha256: reviewSha256,
      }),
    ).resolves.toMatchObject({
      state: "committed",
      stale_journal_reconciled: true,
    });
    expect(run).toHaveBeenCalledWith(
      "/repo/.venv/bin/framelock-media",
      [
        "validate-finalization-commit",
        "--prepared-review-directory",
        root,
        "--review-manifest-sha256",
        reviewSha256,
      ],
      expect.objectContaining({
        env: { PATH: "/safe/bin" },
        timeout: 5 * 60 * 1_000,
      }),
    );
  });

  it("parses a typed canonical finalization rejection without reflecting internal errors", async () => {
    const root = "/tmp/framelock/jobs/real_hero_001/canonical";
    const bridge = createFrameLockCliBridge({
      executable: "/repo/.venv/bin/framelock-media",
      cwd: "/repo",
      environment: { FAL_KEY: "must-not-propagate" },
      process: {
        async run() {
          return {
            stdout: JSON.stringify({
              state: "verification_failed",
              claim: null,
              code: "CANONICAL_FINALIZATION_REJECTED",
              detail:
                "Canonical finalization rejected the approved evidence; no proof was promoted.",
            }),
            stderr: "private implementation detail",
          };
        },
      },
    });

    await expect(
      bridge.finalizeGenerationProof({
        preparedReviewDirectory: root,
        reviewManifestSha256: "e".repeat(64),
        overlaySha256s: ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
        reviewer: "local-owner",
        visualNote: "Frames 0, 60 and 120 preserve source geometry.",
      }),
    ).resolves.toEqual({
      state: "verification_failed",
      claim: null,
      code: "CANONICAL_FINALIZATION_REJECTED",
      detail:
        "Canonical finalization rejected the approved evidence; no proof was promoted.",
    });
  });
});
