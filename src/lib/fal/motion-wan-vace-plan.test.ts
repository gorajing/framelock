import { describe, expect, it } from "vitest";

import {
  MOTION_V1_APPROVED_SOURCE_URL,
  MOTION_V1_SELECTED_ENVIRONMENT_URL,
  MOTION_V1_TEMPORAL_MASK_URL_PLACEHOLDER,
  MOTION_V1_WAN_VACE_ENDPOINT,
  MOTION_V1_WAN_VACE_PLAN_VERSION,
  WAN_VACE_CANDIDATE_SEEDS,
  WanVacePlanError,
  assertWanVacePlanEvolution,
  buildMotionWanVaceCandidateDrafts,
  prepareMotionWanVaceSubmission,
  resolveMotionWanVaceMaskUrl,
  validateMotionWanVaceCandidateSet,
} from "./motion-wan-vace-plan";

const RESOLVED_MASK_URL =
  "https://v3b.fal.media/files/b/0aa2d000/framelock-vace-edit-mask.mp4";

describe("Motion v1 Wan VACE candidate plans", () => {
  it("builds three deterministic quality-first drafts from the approved media", () => {
    const first = buildMotionWanVaceCandidateDrafts();
    const second = buildMotionWanVaceCandidateDrafts();

    expect(MOTION_V1_WAN_VACE_ENDPOINT).toBe("fal-ai/wan-vace-14b");
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect(first.map((plan) => plan.falInputTemplate.seed)).toEqual(
      WAN_VACE_CANDIDATE_SEEDS,
    );

    for (const plan of first) {
      expect(plan).toMatchObject({
        schemaVersion: 1,
        state: "awaiting_temporal_mask_upload",
        planVersion: MOTION_V1_WAN_VACE_PLAN_VERSION,
        endpoint: MOTION_V1_WAN_VACE_ENDPOINT,
        source: {
          falUrl: MOTION_V1_APPROVED_SOURCE_URL,
          width: 1280,
          height: 720,
          frameCount: 121,
          frameRate: "24/1",
        },
        environmentReference: {
          falUrl: MOTION_V1_SELECTED_ENVIRONMENT_URL,
        },
        pricingEstimate: {
          unitPriceUsd: "0.08",
          billingUnit: "video-second at 16 frames per second",
          estimatedUnits: "7.5625",
          estimatedCostUsd: "0.605",
        },
        falInputTemplate: {
          task: "inpainting",
          video_url: MOTION_V1_APPROVED_SOURCE_URL,
          mask_video_url: MOTION_V1_TEMPORAL_MASK_URL_PLACEHOLDER,
          ref_image_urls: [MOTION_V1_SELECTED_ENVIRONMENT_URL],
          match_input_num_frames: true,
          num_frames: 121,
          match_input_frames_per_second: true,
          frames_per_second: 24,
          resolution: "720p",
          aspect_ratio: "16:9",
          num_inference_steps: 30,
          guidance_scale: 5,
          sampler: "unipc",
          shift: 5,
          enable_safety_checker: true,
          enable_prompt_expansion: false,
          preprocess: false,
          acceleration: "none",
          video_quality: "maximum",
          video_write_mode: "balanced",
          num_interpolated_frames: 0,
          temporal_downsample_factor: 0,
          enable_auto_downsample: false,
          sync_mode: false,
          return_frames_zip: true,
        },
      });
      expect(plan.falInputTemplate.prompt).toContain("locked eye-level camera");
      expect(plan.falInputTemplate.prompt).toContain("distant train");
      expect(plan.falInputTemplate.negative_prompt).toContain("camera movement");
      expect(plan.falInputTemplate.negative_prompt).toContain("extra person");
    }
  });

  it("admits a candidate set only when fal inputs differ by seed", () => {
    const plans = buildMotionWanVaceCandidateDrafts();

    expect(validateMotionWanVaceCandidateSet(plans)).toEqual(plans);

    const changedPrompt = structuredClone(plans);
    changedPrompt[1].falInputTemplate.prompt += " Add a moving camera.";
    expect(() => validateMotionWanVaceCandidateSet(changedPrompt)).toThrow(
      WanVacePlanError,
    );
  });

  it("requires an explicit plan-version change for non-seed evolution", () => {
    const baseline = buildMotionWanVaceCandidateDrafts()[0];
    const changedPrompt = structuredClone(baseline);
    changedPrompt.falInputTemplate.prompt += " Add heavier rain.";

    expect(() => assertWanVacePlanEvolution(baseline, changedPrompt)).toThrow(
      WanVacePlanError,
    );

    changedPrompt.planVersion = "motion-v1-wan-vace.v2";
    expect(() =>
      assertWanVacePlanEvolution(baseline, changedPrompt),
    ).not.toThrow();
  });

  it("cannot shape a paid submission while the mask URL is unresolved", () => {
    const draft = buildMotionWanVaceCandidateDrafts()[0];

    expect(() => prepareMotionWanVaceSubmission(draft)).toThrowError(
      expect.objectContaining({ code: "MASK_UPLOAD_UNRESOLVED" }),
    );
  });

  it("resolves only a clean fal CDN mask URL and removes the placeholder", () => {
    const draft = buildMotionWanVaceCandidateDrafts()[0];
    const ready = resolveMotionWanVaceMaskUrl(draft, RESOLVED_MASK_URL);
    const submission = prepareMotionWanVaceSubmission(ready);

    expect(ready.state).toBe("ready_for_submission");
    expect(submission).toEqual({
      endpoint: MOTION_V1_WAN_VACE_ENDPOINT,
      falInput: {
        ...draft.falInputTemplate,
        mask_video_url: RESOLVED_MASK_URL,
      },
      estimatedCostUsd: "0.605",
    });
    expect(JSON.stringify(submission)).not.toContain(
      MOTION_V1_TEMPORAL_MASK_URL_PLACEHOLDER,
    );

    for (const unsafeUrl of [
      MOTION_V1_TEMPORAL_MASK_URL_PLACEHOLDER,
      "http://v3b.fal.media/files/mask.mp4",
      "https://fal.media.attacker.example/files/mask.mp4",
      "https://v3b.fal.media/files/mask.mp4?replace=1",
      "https://v3b.fal.media/not-files/mask.mp4",
    ]) {
      expect(() => resolveMotionWanVaceMaskUrl(draft, unsafeUrl)).toThrow(
        WanVacePlanError,
      );
    }
  });
});
