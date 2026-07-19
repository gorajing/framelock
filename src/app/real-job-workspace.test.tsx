import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  APPROVE_REVIEW_PHRASE,
  PROTECTED_CORE_CLAIM,
  PricingReceiptEvidence,
  RealJobWorkspace,
  buildPricingRefreshRequest,
  buildRealJobIntakeForm,
  buildPaidRunRequest,
  buildReviewApprovalPayload,
  isPaidActionReady,
  mergeJobWorkspaceView,
  paidAuthorizationReducer,
  parseBoundPricingReceipt,
  type GenerationReviewEvidence,
} from "./real-job-workspace";
import type { PricingReceiptView } from "../lib/jobs/paid-attempt-pricing";

const SHA = {
  generation: "10".repeat(32),
  manifest: "20".repeat(32),
  manifestDigest: "30".repeat(32),
  overlay0: "40".repeat(32),
  overlay60: "50".repeat(32),
  overlay120: "60".repeat(32),
  proof: "70".repeat(32),
  audit: "80".repeat(32),
  run: "90".repeat(32),
  preview: "a0".repeat(32),
  source: "b0".repeat(32),
  mask: "c0".repeat(32),
  provenanceFile: "d0".repeat(32),
  originalImage: "e0".repeat(32),
  sourceBundle: "f0".repeat(32),
  normalizedPlate: "11".repeat(32),
  contactSheet: "12".repeat(32),
  approvalRecord: "13".repeat(32),
  pricingObservation: "14".repeat(32),
  pricingReceipt: "15".repeat(32),
} as const;

const baseJob = {
  id: "ai_source_01",
  endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit" as const,
  generationDigest: SHA.generation,
  prompt: "Turn the room into a moonlit glass conservatory.",
  sourceSha256: SHA.source,
  editMaskSha256: SHA.mask,
  sourceProvenance: {
    fileSha256: SHA.provenanceFile,
    schemaVersion: 1 as const,
    provenanceLabel: "ai_generated_source" as const,
    originalImageSha256: SHA.originalImage,
    sourceBundleManifestSha256: SHA.sourceBundle,
    normalizedPlateSha256: SHA.normalizedPlate,
    canonicalSourceMp4Sha256: SHA.source,
    foregroundMaskSha256: SHA.mask,
    contactSheetSha256: SHA.contactSheet,
    approval: {
      recordSha256: SHA.approvalRecord,
      approvedAt: "2026-07-18T01:02:03.000Z",
      reviewer: "FrameLock executor",
      note: "FRM-01 passed the frozen AI-source criteria.",
    },
  },
};

const review: GenerationReviewEvidence = {
  state: "review_ready",
  reviewManifestSha256: SHA.manifest,
  reviewManifestDigestSha256: SHA.manifestDigest,
  overlaySha256s: [SHA.overlay0, SHA.overlay60, SHA.overlay120],
  overlays: [
    { frame: 0, url: "/api/jobs/ai_source_01/media/overlay-0", sha256: SHA.overlay0 },
    { frame: 60, url: "/api/jobs/ai_source_01/media/overlay-60", sha256: SHA.overlay60 },
    { frame: 120, url: "/api/jobs/ai_source_01/media/overlay-120", sha256: SHA.overlay120 },
  ],
};

const pricingReceipt: PricingReceiptView = {
  schemaVersion: 1,
  jobId: baseJob.id,
  generationDigest: SHA.generation,
  sourceProvenanceFileSha256: SHA.provenanceFile,
  endpoint: "fal-ai/kling-video/o3/standard/video-to-video/edit",
  currency: "USD",
  pricingObservation: {
    unitPriceUsd: "0.126",
    billingUnit: "second",
    estimatedUnits: "5.041667",
    estimatedCostUsd: "0.635250042",
    pricingSource: "https://api.fal.ai/v1/models/pricing",
    priceObservedAt: "2026-07-18T08:30:00.000Z",
  },
  pricingObservationDigest: SHA.pricingObservation,
  receiptDigestSha256: SHA.pricingReceipt,
};

describe("AI-source workspace", () => {
  it("renders the frozen intake contract and keeps the paid action gated", () => {
    const markup = renderToStaticMarkup(<RealJobWorkspace />);

    expect(markup).toContain("Source");
    expect(markup).toContain("Protect");
    expect(markup).toContain("Reshoot");
    expect(markup).toContain('accept="video/mp4"');
    expect(markup).toContain('accept="image/png"');
    expect(markup).toContain('accept="application/json"');
    expect(markup).toContain("1280 × 720 / 121 frames / 24 fps / MP4");
    expect(markup).toContain("AI-source provenance JSON");
    expect(markup).toContain("ai_generated_source");
    expect(markup).toContain("Local restoration mask");
    expect(markup).toContain(
      "Kling receives source MP4 + prompt, not this mask",
    );
    expect(markup).toContain(
      "I own or control the rights to this AI-generated source and derived media.",
    );
    expect(markup).toContain("No verification claim exists at intake.");
    expect(markup).toContain("Attempt budget loading");
    expect(markup).not.toContain(
      "Protected core verified — canonical pre-encode frame sequence.",
    );
    expect(markup).not.toContain("Real-camera");
    expect(markup).not.toContain("Original source");
  });

  it("submits the required provenance file under the frozen multipart field", () => {
    const source = new File([new Uint8Array([1])], "source.mp4", {
      type: "video/mp4",
    });
    const foregroundMask = new File([new Uint8Array([2])], "mask.png", {
      type: "image/png",
    });
    const sourceProvenance = new File(["{}"], "source-provenance.json", {
      type: "application/json",
    });

    const form = buildRealJobIntakeForm({
      source,
      foregroundMask,
      sourceProvenance,
      prompt: "Move the AI product into a moonlit gallery.",
    });

    expect(form.get("source")).toBe(source);
    expect(form.get("foregroundMask")).toBe(foregroundMask);
    expect(form.get("sourceProvenance")).toBe(sourceProvenance);
    expect(form.get("prompt")).toBe(
      "Move the AI product into a moonlit gallery.",
    );
    expect(form.get("ownershipConfirmation")).toBe(
      "I own or control the rights to this AI-generated source and derived media.",
    );
  });

  it("treats generated model output as untrusted and exposes an explicit review action", () => {
    const markup = renderToStaticMarkup(
      <RealJobWorkspace
        initialJob={{ ...baseJob, state: "generated" }}
      />,
    );

    expect(markup).toContain("Model output / untrusted");
    expect(markup).toContain("Prepare review");
    expect(markup).toContain("No protected-core claim exists yet.");
    expect(markup).not.toContain(PROTECTED_CORE_CLAIM);
    expect(markup).not.toContain("data-verified-playback");
  });

  it("offers a no-fal recovery action for persisted composited evidence", () => {
    const markup = renderToStaticMarkup(
      <RealJobWorkspace
        initialJob={{ ...baseJob, state: "composited" }}
      />,
    );

    expect(markup).toContain("Canonical finalization interrupted.");
    expect(markup).toContain("Resume canonical verification — no fal call");
    expect(markup).not.toContain("No result was promoted.");
    expect(markup).not.toContain("Run one paid generation");
    expect(markup).not.toContain(PROTECTED_CORE_CLAIM);
  });

  it("retains hash-bound source identity but shows no estimate before a receipt refresh", () => {
    const markup = renderToStaticMarkup(
      <RealJobWorkspace initialJob={{ ...baseJob, state: "validated" }} />,
    );

    expect(markup).toContain(baseJob.prompt);
    expect(markup).toContain(SHA.source);
    expect(markup).toContain(SHA.mask);
    expect(markup).toContain("/api/jobs/ai_source_01/media/source");
    expect(markup).toContain("/api/jobs/ai_source_01/media/mask");
    expect(markup).toContain("Declared, hash-bound AI-source provenance");
    expect(markup).toContain("ai_generated_source");
    expect(markup).toContain(SHA.provenanceFile);
    expect(markup).toContain(SHA.originalImage);
    expect(markup).toContain(SHA.sourceBundle);
    expect(markup).toContain(SHA.normalizedPlate);
    expect(markup).toContain(SHA.contactSheet);
    expect(markup).toContain(SHA.approvalRecord);
    expect(markup).toContain("FrameLock executor");
    expect(markup).toContain("FRM-01 passed the frozen AI-source criteria.");
    expect(markup).toContain("Independently checked bytes");
    expect(markup).toContain("Declared provenance fields");
    expect(markup).toContain("Price not refreshed");
    expect(markup).toContain("Refresh current price — no generation");
    expect(markup).not.toContain("$0.126");
    expect(markup).not.toContain(SHA.pricingObservation);
    expect(markup).not.toContain(SHA.pricingReceipt);
    expect(markup).toContain("Attempt — of 3");
    expect(markup).not.toContain(
      "I authorize one paid Kling O3 generation for this exact digest.",
    );
    expect(markup).not.toContain("Type pricing suffix");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("Cancel before spend");
  });

  it("retains immutable AI-source provenance when run and poll views omit it", () => {
    const current = { ...baseJob, state: "validated" as const };
    const submitted = mergeJobWorkspaceView(current, {
      id: baseJob.id,
      state: "submitted",
      endpoint: baseJob.endpoint,
      generationDigest: baseJob.generationDigest,
      prompt: baseJob.prompt,
      sourceSha256: baseJob.sourceSha256,
      editMaskSha256: baseJob.editMaskSha256,
      requestId: "fal-request-001",
    });
    const generated = mergeJobWorkspaceView(submitted, {
      id: baseJob.id,
      state: "generated",
      endpoint: baseJob.endpoint,
      generationDigest: baseJob.generationDigest,
      prompt: baseJob.prompt,
      sourceSha256: baseJob.sourceSha256,
      editMaskSha256: baseJob.editMaskSha256,
      requestId: "fal-request-001",
    });

    expect(submitted.sourceProvenance).toEqual(baseJob.sourceProvenance);
    expect(generated.sourceProvenance).toEqual(baseJob.sourceProvenance);
    expect(() =>
      mergeJobWorkspaceView(current, {
        ...submitted,
        generationDigest: "ff".repeat(32),
      }),
    ).toThrow("JOB_RESPONSE_IDENTITY_MISMATCH");
  });

  it("shows the exact server-fixed generation parameters in the paid confirmation card", () => {
    const markup = renderToStaticMarkup(
      <RealJobWorkspace initialJob={{ ...baseJob, state: "validated" }} />,
    );

    expect(markup).toContain("Server-fixed paid generation parameters");
    expect(markup).toContain("keep_audio: false");
    expect(markup).toContain("shot_type: customize");
    expect(markup).toContain("Fixed by the shared server contract");
  });

  it("renders every server-issued price fact and its exact evidence bindings", () => {
    const markup = renderToStaticMarkup(
      <PricingReceiptEvidence pricingReceipt={pricingReceipt} />,
    );

    expect(markup).toContain("$0.126 / second");
    expect(markup).toContain("5.041667 second");
    expect(markup).toContain("$0.635250042");
    expect(markup).toContain(pricingReceipt.pricingObservation.pricingSource);
    expect(markup).toContain("2026-07-18T08:30:00.000Z");
    expect(markup).toContain(SHA.pricingObservation);
    expect(markup).toContain(SHA.pricingReceipt);
    expect(markup).toContain(SHA.provenanceFile);
    expect(markup).toContain(SHA.generation);
    expect(markup).toContain("Provenance file binding");
    expect(markup).toContain("Generation binding");
  });

  it("binds both digests and keeps paid submission gated on every consent", () => {
    expect(
      buildPaidRunRequest({
        generationDigest: SHA.generation,
        pricingObservationDigest: SHA.pricingObservation,
      }),
    ).toEqual({
      confirmation:
        "I authorize one paid Kling O3 generation for this exact digest.",
      generationDigest: SHA.generation,
      pricingObservationDigest: SHA.pricingObservation,
    });

    const ready = {
      ownsFootage: true,
      paidConsent: true,
      generationDigest: SHA.generation,
      generationSuffix: SHA.generation.slice(-8),
      jobId: baseJob.id,
      sourceProvenanceFileSha256: SHA.provenanceFile,
      pricingReceipt,
      pricingSuffix: SHA.pricingObservation.slice(-8),
      budget: { used: 2, next: 3, cap: 3 as const },
    };
    expect(isPaidActionReady(ready)).toBe(true);
    expect(isPaidActionReady({ ...ready, ownsFootage: false })).toBe(false);
    expect(isPaidActionReady({ ...ready, paidConsent: false })).toBe(false);
    expect(isPaidActionReady({ ...ready, generationSuffix: "00000000" })).toBe(
      false,
    );
    expect(isPaidActionReady({ ...ready, pricingSuffix: "00000000" })).toBe(
      false,
    );
    expect(isPaidActionReady({ ...ready, pricingReceipt: null })).toBe(false);
  });

  it("uses a bodyless no-store POST for a price refresh", () => {
    expect(buildPricingRefreshRequest()).toEqual({
      method: "POST",
      cache: "no-store",
    });
    expect(buildPricingRefreshRequest()).not.toHaveProperty("body");
  });

  it("rejects cross-job or cross-provenance receipt reuse in the browser", () => {
    expect(
      parseBoundPricingReceipt(pricingReceipt, {
        id: baseJob.id,
        endpoint: baseJob.endpoint,
        generationDigest: SHA.generation,
        sourceProvenanceFileSha256: SHA.provenanceFile,
      }),
    ).toEqual(pricingReceipt);
    expect(() =>
      parseBoundPricingReceipt(
        { ...pricingReceipt, jobId: "another_job" },
        {
          id: baseJob.id,
          endpoint: baseJob.endpoint,
          generationDigest: SHA.generation,
          sourceProvenanceFileSha256: SHA.provenanceFile,
        },
      ),
    ).toThrow("PRICING_RECEIPT_MISMATCH");
    expect(() =>
      parseBoundPricingReceipt(pricingReceipt, {
        id: baseJob.id,
        endpoint: baseJob.endpoint,
        generationDigest: SHA.generation,
        sourceProvenanceFileSha256: "ff".repeat(32),
      }),
    ).toThrow("PRICING_RECEIPT_MISMATCH");
    expect(() =>
      parseBoundPricingReceipt({ receipt: pricingReceipt }, {
        id: baseJob.id,
        endpoint: baseJob.endpoint,
        generationDigest: SHA.generation,
        sourceProvenanceFileSha256: SHA.provenanceFile,
      }),
    ).toThrow("PRICING_RECEIPT_MISMATCH");
  });

  it("clears every prior authorization value on refresh and stale receipt errors", () => {
    const authorized = {
      pricingReceipt,
      paidConsent: true,
      generationSuffix: SHA.generation.slice(-8),
      pricingSuffix: SHA.pricingObservation.slice(-8),
    };
    const empty = {
      pricingReceipt: null,
      paidConsent: false,
      generationSuffix: "",
      pricingSuffix: "",
    };

    expect(paidAuthorizationReducer(authorized, { type: "reset" })).toEqual(
      empty,
    );
    expect(
      paidAuthorizationReducer(authorized, { type: "pricing_refresh_started" }),
    ).toEqual(empty);
    expect(
      paidAuthorizationReducer(authorized, {
        type: "pricing_refresh_succeeded",
        pricingReceipt: {
          ...pricingReceipt,
          pricingObservationDigest: "aa".repeat(32),
        },
      }),
    ).toEqual({
      ...empty,
      pricingReceipt: {
        ...pricingReceipt,
        pricingObservationDigest: "aa".repeat(32),
      },
    });
    expect(
      paidAuthorizationReducer(authorized, {
        type: "submission_error",
        errorCode: "PRICING_OBSERVATION_NOT_CURRENT",
      }),
    ).toEqual(empty);
    expect(
      paidAuthorizationReducer(authorized, {
        type: "submission_error",
        errorCode: "PRICING_CONFIRMATION_MISMATCH",
      }),
    ).toEqual(empty);
  });

  it("renders not-comparable and canonical failure states without a green claim", () => {
    const notComparable = renderToStaticMarkup(
      <RealJobWorkspace
        initialJob={{
          ...baseJob,
          state: "not_comparable",
          failureCode: "GEOMETRY_NOT_COMPARABLE",
        }}
      />,
    );
    const verificationFailed = renderToStaticMarkup(
      <RealJobWorkspace
        initialJob={{
          ...baseJob,
          state: "failed",
          failureCode: "CANONICAL_EVIDENCE_INVALID",
          failureDetail:
            "Committed canonical evidence failed integrity validation; no proof was promoted.",
        }}
      />,
    );

    expect(notComparable).toContain("Not comparable — no proof promoted.");
    expect(notComparable).toContain("GEOMETRY_NOT_COMPARABLE");
    expect(notComparable).not.toContain(PROTECTED_CORE_CLAIM);
    expect(verificationFailed).toContain("Verifier failed — no proof promoted.");
    expect(verificationFailed).toContain("CANONICAL_EVIDENCE_INVALID");
    expect(verificationFailed).toContain(
      "Committed canonical evidence failed integrity validation; no proof was promoted.",
    );
    expect(verificationFailed).not.toContain(PROTECTED_CORE_CLAIM);
    expect(verificationFailed).not.toContain("job-ledger__verified");
  });

  it("does not render synchronized results from verified state without proof evidence", () => {
    const markup = renderToStaticMarkup(
      <RealJobWorkspace
        initialJob={{
          ...baseJob,
          state: "verified",
          verification: {
            claim: PROTECTED_CORE_CLAIM,
            framesAudited: 121,
            changedCoreChannelSamples: 0,
            worstMaxChannelDelta: 0,
            coreHashMatchCount: 121,
          },
        }}
      />,
    );

    expect(markup).not.toContain("data-verified-playback");
    expect(markup).toContain("Verified job record restored read-only");
  });

  it("renders exactly the three fixed review overlays and explicit evidence confirmations", () => {
    const markup = renderToStaticMarkup(
      <RealJobWorkspace
        initialJob={{ ...baseJob, state: "generated" }}
        initialReview={review}
      />,
    );

    expect(markup.match(/data-review-overlay=/g)).toHaveLength(3);
    expect(markup).toContain("Frame 0");
    expect(markup).toContain("Frame 60");
    expect(markup).toContain("Frame 120");
    expect(markup).toContain(SHA.overlay0);
    expect(markup).toContain(SHA.overlay60);
    expect(markup).toContain(SHA.overlay120);
    expect(markup).toContain(SHA.manifest);
    expect(markup).toContain(SHA.manifestDigest);
    expect(markup).toContain(SHA.generation);
    expect(markup).toContain("Reviewer name");
    expect(markup).toContain("Visual review note");
    expect(markup).toContain(APPROVE_REVIEW_PHRASE);
    expect(markup).toContain("Confirm review manifest and generation digest");
    expect(markup).toContain("No protected-core claim exists until approval and verification pass.");
    expect(markup).not.toContain(PROTECTED_CORE_CLAIM);
  });

  it("builds the approval request from the exact reviewed evidence", () => {
    expect(
      buildReviewApprovalPayload({
        review,
        reviewer: "Jin Choi",
        visualNote: "Subject geometry holds at all three fixed frames.",
      }),
    ).toEqual({
      reviewManifestSha256: SHA.manifest,
      overlaySha256s: [SHA.overlay0, SHA.overlay60, SHA.overlay120],
      reviewer: "Jin Choi",
      visualNote: "Subject geometry holds at all three fixed frames.",
      approval: "APPROVE 0 60 120",
    });
  });

  it("shows only the narrow verified claim, canonical metrics and truthful exports", () => {
    const markup = renderToStaticMarkup(
      <RealJobWorkspace
        initialJob={{
          ...baseJob,
          state: "verified",
          verification: {
            claim: PROTECTED_CORE_CLAIM,
            framesAudited: 121,
            changedCoreChannelSamples: 0,
            worstMaxChannelDelta: 0,
            coreHashMatchCount: 121,
          },
        }}
        initialProof={{
          claim: PROTECTED_CORE_CLAIM,
          framesAudited: 121,
          protectedCorePixels: 22_029_381,
          changedCoreChannelSamples: 0,
          worstMaxChannelDelta: 0,
          coreHashMatchCount: 121,
          proofManifestSha256: SHA.proof,
          auditSha256: SHA.audit,
          runManifestSha256: SHA.run,
          previewSha256: SHA.preview,
        }}
      />,
    );

    expect(markup).toContain(PROTECTED_CORE_CLAIM);
    expect(markup).toContain("121 / 121 frames audited");
    expect(markup).toContain("22,029,381 protected core pixels");
    expect(markup).toContain("0 changed core channel samples");
    expect(markup).toContain("0 worst max channel delta");
    expect(markup).toContain("121 / 121 core hash matches");
    expect(markup).toContain("Canonical frames ZIP — 121 authoritative PNGs");
    expect(markup).toContain("Canonical export manifest — frame hash index");
    expect(markup).toContain("Proof manifest JSON — canonical proof");
    expect(markup).toContain("Audit JSON");
    expect(markup).toContain("Run manifest JSON");
    expect(markup).toContain("H.264 preview — non-proof");
    expect(markup).toContain("data-verified-playback");
    expect(markup).toContain(
      "AI-generated source — provenance-bound baseline",
    );
    expect(markup).toContain("Kling environment edit — unverified");
    expect(markup).toContain(
      "H.264 delivery preview — derived from verified canonical frames; not lossless proof",
    );
    expect(markup).toContain("/api/jobs/ai_source_01/media/source");
    expect(markup).toContain("/api/jobs/ai_source_01/media/generated");
    expect(markup).toContain(SHA.proof);
    expect(markup).toContain("AI-source frame 60");
    expect(markup).toContain("Raw model frame 60");
    expect(markup).toContain("Canonical composite frame 60");
    expect(markup).toContain("Protected core — exactness contract");
    expect(markup).toContain("Boundary ring — visual seam, excluded from exactness");
    expect(markup).toContain("Changed-pixel heatmap — visual-only, not verifier output");
    expect(markup).toContain("/api/jobs/ai_source_01/media/source-60");
    expect(markup).toContain("/api/jobs/ai_source_01/media/generated-60");
    expect(markup).toContain("/api/jobs/ai_source_01/media/composite-60");
    expect(markup).toContain("/api/jobs/ai_source_01/media/protected-core-60");
    expect(markup).toContain("/api/jobs/ai_source_01/media/boundary-ring-60");
    expect(markup).toContain("/api/jobs/ai_source_01/media/difference-heatmap-60");
    expect(markup).toContain("/api/jobs/ai_source_01/media/canonical-frames");
    expect(markup).toContain("/api/jobs/ai_source_01/media/canonical-export-manifest");
    expect(markup).toContain("/api/jobs/ai_source_01/media/proof-manifest");
    expect(markup).toContain("/?proof=corrupt&amp;job=ai_source_01");
    expect(markup).toContain("/api/jobs/ai_source_01/media/corruption-manifest");
    expect(markup).toContain("/api/jobs/ai_source_01/media/corruption-audit");
    expect(markup).toContain("/api/jobs/ai_source_01/media/corruption-summary");
    expect(markup).not.toContain("/api/jobs/another_job/media/corruption-audit");
  });
});
