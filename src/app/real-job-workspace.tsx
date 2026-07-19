"use client";

import Image from "next/image";
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { z } from "zod";

import {
  REAL_KLING_PAID_CONFIRMATION,
} from "../lib/fal/real-kling-request";
import { KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS } from "../lib/fal/kling-contract";
import { AI_SOURCE_PROVENANCE_LABEL } from "../lib/jobs/ai-source-provenance";
import {
  pricingReceiptViewSchema,
  type PricingReceiptView,
} from "../lib/jobs/paid-attempt-pricing";
import { OWNERSHIP_CONFIRMATION } from "../lib/jobs/real-job-intake";
import {
  PROTECTED_CORE_CLAIM,
  realJobWorkspaceViewSchema as jobViewSchema,
  type RealJobWorkspaceView,
} from "../lib/jobs/real-job-workspace-view";
import { VerifiedSynchronizedPlayback } from "./verified-synchronized-playback";

export { PROTECTED_CORE_CLAIM };
export const APPROVE_REVIEW_PHRASE = "APPROVE 0 60 120" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalFailureCodes = [
  "CANONICAL_FINALIZATION_REJECTED",
  "CANONICAL_EVIDENCE_INVALID",
  "CANONICAL_EVIDENCE_INCOMPLETE",
] as const;
const artifactUrlSchema = z
  .string()
  .regex(/^\/api\/jobs\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/media\/[a-z0-9-]+$/);

type RealMediaAsset =
  | "source"
  | "generated"
  | "source-60"
  | "generated-60"
  | "composite-60"
  | "protected-core-60"
  | "boundary-ring-60"
  | "difference-heatmap-60"
  | "mask"
  | "canonical-frames"
  | "canonical-export-manifest"
  | "proof-manifest"
  | "audit"
  | "run-manifest"
  | "corruption-manifest"
  | "corruption-audit"
  | "corruption-summary"
  | "preview";

function realMediaUrl(jobId: string, asset: RealMediaAsset): string {
  return `/api/jobs/${jobId}/media/${asset}`;
}

const budgetSchema = z.object({
  used: z.number().int().nonnegative(),
  next: z.number().int().positive(),
  cap: z.literal(3),
});

const reviewSchema = z
  .object({
    state: z.string().min(1),
    reviewManifestSha256: sha256Schema,
    reviewManifestDigestSha256: sha256Schema,
    overlaySha256s: z.tuple([sha256Schema, sha256Schema, sha256Schema]),
    overlays: z.tuple([
      z.object({ frame: z.literal(0), url: artifactUrlSchema, sha256: sha256Schema }),
      z.object({ frame: z.literal(60), url: artifactUrlSchema, sha256: sha256Schema }),
      z.object({ frame: z.literal(120), url: artifactUrlSchema, sha256: sha256Schema }),
    ]),
  })
  .superRefine((review, context) => {
    review.overlays.forEach((overlay, index) => {
      if (overlay.sha256 !== review.overlaySha256s[index]) {
        context.addIssue({
          code: "custom",
          path: ["overlaySha256s", index],
          message: "Overlay hashes must match the fixed review frames",
        });
      }
    });
  });

const proofSchema = z.object({
  claim: z.literal(PROTECTED_CORE_CLAIM),
  framesAudited: z.literal(121),
  protectedCorePixels: z.number().int().positive(),
  changedCoreChannelSamples: z.literal(0),
  worstMaxChannelDelta: z.literal(0),
  coreHashMatchCount: z.literal(121),
  proofManifestSha256: sha256Schema,
  auditSha256: sha256Schema,
  runManifestSha256: sha256Schema,
  previewSha256: sha256Schema,
});

const reviewResponseSchema = z
  .object({
    job: jobViewSchema,
    review: reviewSchema.optional(),
  })
  .superRefine((payload, context) => {
    if (payload.job.state === "generated" && !payload.review) {
      context.addIssue({
        code: "custom",
        path: ["review"],
        message: "Generated review responses require fixed-frame evidence",
      });
    }
    if (payload.review && payload.job.state !== "generated") {
      context.addIssue({
        code: "custom",
        path: ["job", "state"],
        message: "Fixed-frame review evidence requires a generated job",
      });
    }
    payload.review?.overlays.forEach((overlay) => {
      const expected = `/api/jobs/${payload.job.id}/media/overlay-${overlay.frame}`;
      if (overlay.url !== expected) {
        context.addIssue({
          code: "custom",
          path: ["review", "overlays", overlay.frame],
          message: "Review overlay URL does not belong to the returned job",
        });
      }
    });
  });

const approvalResponseSchema = z.object({
  job: jobViewSchema,
  proof: proofSchema.optional(),
}).superRefine((payload, context) => {
  if (payload.job.state === "verified" && !payload.proof) {
    context.addIssue({
      code: "custom",
      path: ["proof"],
      message: "Verified responses require canonical proof evidence",
    });
  }
  if (payload.proof && payload.job.state !== "verified") {
    context.addIssue({
      code: "custom",
      path: ["job", "state"],
      message: "Canonical proof evidence requires a verified job",
    });
  }
  if (
    payload.proof &&
    payload.job.verification &&
    (payload.proof.claim !== payload.job.verification.claim ||
      payload.proof.framesAudited !== payload.job.verification.framesAudited ||
      payload.proof.changedCoreChannelSamples !==
        payload.job.verification.changedCoreChannelSamples ||
      payload.proof.worstMaxChannelDelta !==
        payload.job.verification.worstMaxChannelDelta ||
      payload.proof.coreHashMatchCount !==
        payload.job.verification.coreHashMatchCount)
  ) {
    context.addIssue({
      code: "custom",
      path: ["proof"],
      message: "Proof metrics do not match the verified job record",
    });
  }
});

type Budget = z.infer<typeof budgetSchema>;
type JobView = RealJobWorkspaceView;
export type GenerationReviewEvidence = z.infer<typeof reviewSchema>;
export type CanonicalProofEvidence = z.infer<typeof proofSchema>;

export type PaidAuthorizationState = Readonly<{
  pricingReceipt: PricingReceiptView | null;
  paidConsent: boolean;
  generationSuffix: string;
  pricingSuffix: string;
}>;

type PaidAuthorizationAction =
  | { type: "reset" | "pricing_refresh_started" }
  | { type: "pricing_refresh_succeeded"; pricingReceipt: PricingReceiptView }
  | { type: "paid_consent_changed"; checked: boolean }
  | { type: "generation_suffix_changed"; value: string }
  | { type: "pricing_suffix_changed"; value: string }
  | { type: "submission_error"; errorCode: string };

const emptyPaidAuthorizationState: PaidAuthorizationState = {
  pricingReceipt: null,
  paidConsent: false,
  generationSuffix: "",
  pricingSuffix: "",
};

const invalidatingPricingErrors = new Set([
  "ACTIVE_JOB_MISMATCH",
  "AI_SOURCE_EVIDENCE_MISMATCH",
  "GENERATION_IDENTITY_MISMATCH",
  "PRICING_CONFIRMATION_MISMATCH",
  "PRICING_OBSERVATION_NOT_CURRENT",
  "PRICING_RECEIPT_MISMATCH",
  "PRICING_RECEIPT_REQUIRED",
]);

export function paidAuthorizationReducer(
  state: PaidAuthorizationState,
  action: PaidAuthorizationAction,
): PaidAuthorizationState {
  switch (action.type) {
    case "reset":
    case "pricing_refresh_started":
      return emptyPaidAuthorizationState;
    case "pricing_refresh_succeeded":
      return {
        ...emptyPaidAuthorizationState,
        pricingReceipt: action.pricingReceipt,
      };
    case "paid_consent_changed":
      return { ...state, paidConsent: action.checked };
    case "generation_suffix_changed":
      return { ...state, generationSuffix: action.value };
    case "pricing_suffix_changed":
      return { ...state, pricingSuffix: action.value };
    case "submission_error":
      return invalidatingPricingErrors.has(action.errorCode)
        ? emptyPaidAuthorizationState
        : state;
  }
}

type PricingReceiptBinding = Readonly<{
  id: string;
  endpoint: JobView["endpoint"];
  generationDigest: string;
  sourceProvenanceFileSha256: string;
}>;

export function parseBoundPricingReceipt(
  payload: unknown,
  binding: PricingReceiptBinding,
): PricingReceiptView {
  const parsed = pricingReceiptViewSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("PRICING_RECEIPT_MISMATCH");
  }
  const receipt = parsed.data;
  if (
    receipt.jobId !== binding.id ||
    receipt.endpoint !== binding.endpoint ||
    receipt.generationDigest !== binding.generationDigest ||
    receipt.sourceProvenanceFileSha256 !==
      binding.sourceProvenanceFileSha256
  ) {
    throw new Error("PRICING_RECEIPT_MISMATCH");
  }
  return receipt;
}

export function buildPricingRefreshRequest(): RequestInit {
  return { method: "POST", cache: "no-store" };
}

type WorkspaceProps = Readonly<{
  initialJob?: JobView;
  initialReview?: GenerationReviewEvidence;
  initialProof?: CanonicalProofEvidence;
}>;

export function buildPaidRunRequest(input: {
  generationDigest: string;
  pricingObservationDigest: string;
}) {
  return {
    confirmation: REAL_KLING_PAID_CONFIRMATION,
    generationDigest: sha256Schema.parse(input.generationDigest),
    pricingObservationDigest: sha256Schema.parse(
      input.pricingObservationDigest,
    ),
  };
}

export function isPaidActionReady(input: {
  ownsFootage: boolean;
  paidConsent: boolean;
  jobId: string;
  generationDigest: string;
  generationSuffix: string;
  sourceProvenanceFileSha256: string;
  pricingReceipt: PricingReceiptView | null;
  pricingSuffix: string;
  budget: Budget | null;
}): boolean {
  const receipt = input.pricingReceipt;
  return Boolean(
    input.ownsFootage &&
      input.paidConsent &&
      receipt &&
      receipt.jobId === input.jobId &&
      receipt.generationDigest === input.generationDigest &&
      receipt.sourceProvenanceFileSha256 ===
        input.sourceProvenanceFileSha256 &&
      input.generationSuffix === input.generationDigest.slice(-8) &&
      input.pricingSuffix === receipt.pricingObservationDigest.slice(-8) &&
      input.budget &&
      input.budget.used < input.budget.cap &&
      input.budget.next <= input.budget.cap,
  );
}

export function buildReviewApprovalPayload(input: {
  review: GenerationReviewEvidence;
  reviewer: string;
  visualNote: string;
}) {
  return {
    reviewManifestSha256: input.review.reviewManifestSha256,
    overlaySha256s: input.review.overlaySha256s,
    reviewer: input.reviewer,
    visualNote: input.visualNote,
    approval: APPROVE_REVIEW_PHRASE,
  };
}

export function buildRealJobIntakeForm(input: Readonly<{
  source: File;
  foregroundMask: File;
  sourceProvenance: File;
  prompt: string;
}>): FormData {
  const form = new FormData();
  form.set("source", input.source);
  form.set("foregroundMask", input.foregroundMask);
  form.set("sourceProvenance", input.sourceProvenance);
  form.set("prompt", input.prompt);
  form.set("ownershipConfirmation", OWNERSHIP_CONFIRMATION);
  return form;
}

async function responseJson(response: Response): Promise<unknown> {
  const payload: unknown = await response.json().catch(() => ({
    error: "INVALID_SERVER_RESPONSE",
  }));
  if (!response.ok) {
    const code =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `HTTP_${response.status}`;
    throw new Error(code);
  }
  return payload;
}

export function mergeJobWorkspaceView(
  current: JobView | null,
  value: unknown,
): JobView {
  const next = jobViewSchema.parse(value);
  if (!current) return next;

  if (
    next.id !== current.id ||
    next.endpoint !== current.endpoint ||
    next.generationDigest !== current.generationDigest ||
    next.prompt !== current.prompt ||
    next.sourceSha256 !== current.sourceSha256 ||
    next.editMaskSha256 !== current.editMaskSha256 ||
    (current.sourceProvenance &&
      next.sourceProvenance &&
      next.sourceProvenance.fileSha256 !==
        current.sourceProvenance.fileSha256)
  ) {
    throw new Error("JOB_RESPONSE_IDENTITY_MISMATCH");
  }

  return current.sourceProvenance
    ? { ...next, sourceProvenance: current.sourceProvenance }
    : next;
}

export function PricingReceiptEvidence({
  pricingReceipt,
}: Readonly<{ pricingReceipt: PricingReceiptView }>) {
  return (
    <dl className="pricing-observation">
      <div>
        <dt>Current unit price</dt>
        <dd>
          ${pricingReceipt.pricingObservation.unitPriceUsd} /{" "}
          {pricingReceipt.pricingObservation.billingUnit}
        </dd>
      </div>
      <div>
        <dt>Estimated units</dt>
        <dd>
          {pricingReceipt.pricingObservation.estimatedUnits}{" "}
          {pricingReceipt.pricingObservation.billingUnit}
        </dd>
      </div>
      <div>
        <dt>Estimated cost</dt>
        <dd>${pricingReceipt.pricingObservation.estimatedCostUsd}</dd>
      </div>
      <div>
        <dt>Pricing source</dt>
        <dd>{pricingReceipt.pricingObservation.pricingSource}</dd>
      </div>
      <div>
        <dt>Observed at</dt>
        <dd>{pricingReceipt.pricingObservation.priceObservedAt}</dd>
      </div>
      <div>
        <dt>Pricing observation digest</dt>
        <dd>{pricingReceipt.pricingObservationDigest}</dd>
      </div>
      <div>
        <dt>Receipt digest</dt>
        <dd>{pricingReceipt.receiptDigestSha256}</dd>
      </div>
      <div>
        <dt>Generation binding</dt>
        <dd>{pricingReceipt.generationDigest}</dd>
      </div>
      <div>
        <dt>Provenance file binding</dt>
        <dd>{pricingReceipt.sourceProvenanceFileSha256}</dd>
      </div>
    </dl>
  );
}

export function RealJobWorkspace({
  initialJob,
  initialReview,
  initialProof,
}: WorkspaceProps = {}) {
  const [source, setSource] = useState<File | null>(null);
  const [foregroundMask, setForegroundMask] = useState<File | null>(null);
  const [sourceProvenance, setSourceProvenance] = useState<File | null>(null);
  const [prompt, setPrompt] = useState("");
  const [ownsFootage, setOwnsFootage] = useState(false);
  const [paidAuthorization, dispatchPaidAuthorization] = useReducer(
    paidAuthorizationReducer,
    emptyPaidAuthorizationState,
  );
  const [showMask, setShowMask] = useState(true);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [job, setJob] = useState<JobView | null>(initialJob ?? null);
  const [review, setReview] = useState<GenerationReviewEvidence | null>(
    initialReview ?? null,
  );
  const [proof, setProof] = useState<CanonicalProofEvidence | null>(
    initialProof ?? null,
  );
  const [reviewer, setReviewer] = useState("");
  const [visualNote, setVisualNote] = useState("");
  const [manifestConfirmed, setManifestConfirmed] = useState(false);
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const [busy, setBusy] = useState<
    | "intake"
    | "pricing"
    | "run"
    | "poll"
    | "review"
    | "approve"
    | "resume"
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const maskUrlRef = useRef<string | null>(null);

  async function refreshBudget() {
    const response = await fetch("/api/jobs/budget", { cache: "no-store" });
    setBudget(budgetSchema.parse(await responseJson(response)));
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/jobs/budget", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(responseJson)
      .then((payload) => setBudget(budgetSchema.parse(payload)))
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setError("PAID_ATTEMPT_SCAN_FAILED");
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(
    () => () => {
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      if (maskUrlRef.current) URL.revokeObjectURL(maskUrlRef.current);
    },
    [],
  );

  function selectSource(file: File | null) {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    const nextUrl = file ? URL.createObjectURL(file) : null;
    sourceUrlRef.current = nextUrl;
    setSource(file);
    setSourceUrl(nextUrl);
  }

  function selectMask(file: File | null) {
    if (maskUrlRef.current) URL.revokeObjectURL(maskUrlRef.current);
    const nextUrl = file ? URL.createObjectURL(file) : null;
    maskUrlRef.current = nextUrl;
    setForegroundMask(file);
    setMaskUrl(nextUrl);
  }

  function startAnotherSource() {
    setJob(null);
    setReview(null);
    setProof(null);
    setReviewer("");
    setVisualNote("");
    setManifestConfirmed(false);
    setApprovalConfirmed(false);
    dispatchPaidAuthorization({ type: "reset" });
    setOwnsFootage(false);
    setSourceProvenance(null);
    setError(null);
  }

  async function createJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!source || !foregroundMask || !sourceProvenance || !ownsFootage) {
      setError("SOURCE_MASK_PROVENANCE_AND_OWNERSHIP_REQUIRED");
      return;
    }
    dispatchPaidAuthorization({ type: "reset" });
    setBusy("intake");
    setError(null);
    try {
      const form = buildRealJobIntakeForm({
        source,
        foregroundMask,
        sourceProvenance,
        prompt,
      });
      const response = await fetch("/api/jobs", { method: "POST", body: form });
      setJob(jobViewSchema.parse(await responseJson(response)));
      setReview(null);
      setProof(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "INTAKE_FAILED");
    } finally {
      setBusy(null);
    }
  }

  async function refreshPricing() {
    if (!job?.sourceProvenance || job.state !== "validated") {
      setError("PRICING_RECEIPT_MISMATCH");
      return;
    }
    dispatchPaidAuthorization({ type: "pricing_refresh_started" });
    setBusy("pricing");
    setError(null);
    try {
      const response = await fetch(
        `/api/jobs/${job.id}/pricing`,
        buildPricingRefreshRequest(),
      );
      const pricingReceipt = parseBoundPricingReceipt(
        await responseJson(response),
        {
          id: job.id,
          endpoint: job.endpoint,
          generationDigest: job.generationDigest,
          sourceProvenanceFileSha256: job.sourceProvenance.fileSha256,
        },
      );
      dispatchPaidAuthorization({
        type: "pricing_refresh_succeeded",
        pricingReceipt,
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "PRICING_REFRESH_FAILED",
      );
    } finally {
      setBusy(null);
    }
  }

  async function runJob() {
    if (
      !job ||
      !job.sourceProvenance ||
      !isPaidActionReady({
        ownsFootage,
        paidConsent: paidAuthorization.paidConsent,
        jobId: job.id,
        generationDigest: job.generationDigest,
        generationSuffix: paidAuthorization.generationSuffix,
        sourceProvenanceFileSha256: job.sourceProvenance.fileSha256,
        pricingReceipt: paidAuthorization.pricingReceipt,
        pricingSuffix: paidAuthorization.pricingSuffix,
        budget,
      })
    ) {
      setError("PAID_CONFIRMATION_REQUIRED");
      return;
    }
    setBusy("run");
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildPaidRunRequest({
            generationDigest: job.generationDigest,
            pricingObservationDigest:
              paidAuthorization.pricingReceipt!.pricingObservationDigest,
          }),
        ),
      });
      setJob(mergeJobWorkspaceView(job, await responseJson(response)));
      dispatchPaidAuthorization({ type: "reset" });
      await refreshBudget();
    } catch (caught) {
      const errorCode = caught instanceof Error ? caught.message : "RUN_FAILED";
      dispatchPaidAuthorization({ type: "submission_error", errorCode });
      setError(errorCode);
    } finally {
      setBusy(null);
    }
  }

  async function pollJob() {
    if (!job) return;
    setBusy("poll");
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}/poll`, {
        method: "POST",
      });
      setJob(mergeJobWorkspaceView(job, await responseJson(response)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "POLL_FAILED");
    } finally {
      setBusy(null);
    }
  }

  async function prepareReview() {
    if (!job || job.state !== "generated") return;
    setBusy("review");
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}/review`, {
        method: "POST",
      });
      const payload = reviewResponseSchema.parse(await responseJson(response));
      setJob(payload.job);
      setReview(payload.review ?? null);
      setProof(null);
      setReviewer("");
      setVisualNote("");
      setManifestConfirmed(false);
      setApprovalConfirmed(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "REVIEW_PREPARATION_FAILED");
    } finally {
      setBusy(null);
    }
  }

  async function approveReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!job || !review || !manifestConfirmed || !approvalConfirmed) {
      setError("EXACT_REVIEW_APPROVAL_REQUIRED");
      return;
    }
    setBusy("approve");
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildReviewApprovalPayload({ review, reviewer, visualNote }),
        ),
      });
      const payload = approvalResponseSchema.parse(await responseJson(response));
      setJob(payload.job);
      setProof(payload.proof ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "VERIFICATION_FAILED");
    } finally {
      setBusy(null);
    }
  }

  async function resumeVerification() {
    if (!job || job.state !== "composited") return;
    setBusy("resume");
    setError(null);
    try {
      const response = await fetch(
        `/api/jobs/${job.id}/resume-verification`,
        { method: "POST" },
      );
      const payload = approvalResponseSchema.parse(await responseJson(response));
      setJob(payload.job);
      setProof(payload.proof ?? null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "VERIFICATION_RESUME_FAILED",
      );
    } finally {
      setBusy(null);
    }
  }

  const requiredSuffix = job?.generationDigest.slice(-8) ?? "";
  const pricingReceipt = paidAuthorization.pricingReceipt;
  const requiredPricingSuffix =
    pricingReceipt?.pricingObservationDigest.slice(-8) ?? "";
  const paidActionReady = Boolean(job?.sourceProvenance) && isPaidActionReady({
    ownsFootage,
    paidConsent: paidAuthorization.paidConsent,
    jobId: job?.id ?? "",
    generationDigest: job?.generationDigest ?? "",
    generationSuffix: paidAuthorization.generationSuffix,
    sourceProvenanceFileSha256: job?.sourceProvenance?.fileSha256 ?? "",
    pricingReceipt,
    pricingSuffix: paidAuthorization.pricingSuffix,
    budget,
  });
  const approvalReady =
    Boolean(review) &&
    reviewer.trim().length > 0 &&
    visualNote.trim().length > 0 &&
    manifestConfirmed &&
    approvalConfirmed;
  const jobIsTerminal =
    job &&
    [
      "failed",
      "not_comparable",
      "submission_unknown",
      "verified",
    ].includes(job.state);
  const jobIsVerified = job?.state === "verified" && Boolean(job.verification);
  const jobHasCanonicalFailure =
    job?.state === "failed" &&
    canonicalFailureCodes.includes(
      job.failureCode as (typeof canonicalFailureCodes)[number],
    );

  return (
    <section className="workspace" id="top" aria-labelledby="workspace-title">
      <header className="workspace__header">
        <div>
          <p>AI-generated source workflow</p>
          <h1 id="workspace-title">Create a verified reshoot.</h1>
        </div>
        <div className="workspace__budget" aria-live="polite">
          <span>Paid attempt boundary</span>
          <strong>
            {budget
              ? `${budget.used} used / ${budget.cap} cap`
              : "Attempt budget loading"}
          </strong>
          <small>
            {pricingReceipt
              ? `Current receipt estimate: $${pricingReceipt.pricingObservation.estimatedCostUsd}. Actual billing may differ.`
              : "Price not refreshed. No estimate is shown."}
          </small>
        </div>
      </header>

      <ol className="workspace__steps" aria-label="FrameLock workflow">
        <li className={!job ? "is-active" : "is-complete"}>
          <span>01</span><strong>Source</strong><small>Validate AI media</small>
        </li>
        <li className={job?.state === "validated" ? "is-active" : job ? "is-complete" : ""}>
          <span>02</span><strong>Protect</strong><small>Freeze core evidence</small>
        </li>
        <li className={job && job.state !== "validated" ? "is-active" : ""}>
          <span>03</span><strong>Reshoot</strong><small>Generate, review, verify</small>
        </li>
      </ol>

      {!job ? (
        <form className="workspace__grid" onSubmit={createJob}>
          <div className="workspace__inputs">
            <label className="upload-field">
              <span>Canonical AI-source MP4</span>
              <strong>{source?.name ?? "Choose the approved AI-generated source"}</strong>
              <small>1280 × 720 / 121 frames / 24 fps / MP4 / ≤ 50 MB</small>
              <input
                accept="video/mp4"
                onChange={(event) => selectSource(event.target.files?.[0] ?? null)}
                required
                type="file"
              />
            </label>
            <label className="upload-field">
              <span>Local restoration mask</span>
              <strong>{foregroundMask?.name ?? "Choose one grayscale PNG"}</strong>
              <small>
                White = protected foreground / black = editable exterior.
                Kling receives source MP4 + prompt, not this mask.
              </small>
              <input
                accept="image/png"
                onChange={(event) =>
                  selectMask(event.target.files?.[0] ?? null)
                }
                required
                type="file"
              />
            </label>
            <label className="upload-field">
              <span>AI-source provenance JSON</span>
              <strong>
                {sourceProvenance?.name ?? "Choose the approved provenance manifest"}
              </strong>
              <small>
                Required label: {AI_SOURCE_PROVENANCE_LABEL} / JSON / ≤ 256 KB
              </small>
              <input
                accept="application/json"
                onChange={(event) =>
                  setSourceProvenance(event.target.files?.[0] ?? null)
                }
                required
                type="file"
              />
            </label>
            <label className="prompt-field">
              <span>Environment art direction</span>
              <textarea
                maxLength={2_000}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe the new world, lighting and atmosphere. Keep the framing fixed and the protected product in place."
                required
                rows={5}
                value={prompt}
              />
              <small>{prompt.length} / 2,000</small>
            </label>
            <label className="check-field">
              <input
                checked={ownsFootage}
                onChange={(event) => setOwnsFootage(event.target.checked)}
                type="checkbox"
              />
              <span>{OWNERSHIP_CONFIRMATION}</span>
            </label>
            <button className="workspace__primary" disabled={busy !== null} type="submit">
              {busy === "intake" ? "Validating 121 frames…" : "Validate source — no fal call"}
            </button>
          </div>

          <aside className="protect-preview" aria-label="Protection preview">
            {sourceUrl ? (
              <div className="protect-preview__media">
                <video controls muted playsInline src={sourceUrl} />
                {showMask && maskUrl ? (
                  <Image
                    alt="Uploaded local restoration mask"
                    fill
                    src={maskUrl}
                    unoptimized
                  />
                ) : null}
              </div>
            ) : (
              <div className="protect-preview__empty">
                <span>16:9 preview</span>
                <strong>Your AI source and local mask appear here.</strong>
              </div>
            )}
            <button
              disabled={!maskUrl}
              onClick={() => setShowMask((current) => !current)}
              type="button"
            >
              {showMask ? "Hide mask overlay" : "Show mask overlay"}
            </button>
            <p>No verification claim exists at intake.</p>
          </aside>
        </form>
      ) : (
        <div className="workspace__job">
          <article className="job-ledger">
            <span>Active evidence run</span>
            <h2>{job.id}</h2>
            <dl>
              <div><dt>State</dt><dd>{job.state}</dd></div>
              <div><dt>Endpoint</dt><dd>{job.endpoint}</dd></div>
              <div><dt>Prompt</dt><dd>{job.prompt}</dd></div>
              <div><dt>Source SHA-256</dt><dd>{job.sourceSha256}</dd></div>
              <div><dt>Local restoration mask SHA-256</dt><dd>{job.editMaskSha256}</dd></div>
              <div><dt>Generation digest</dt><dd>{job.generationDigest}</dd></div>
              {job.protectedCorePixelsPerFrame ? (
                <div><dt>Core pixels / frame</dt><dd>{job.protectedCorePixelsPerFrame.toLocaleString()}</dd></div>
              ) : null}
              {job.requestId ? <div><dt>fal request</dt><dd>{job.requestId}</dd></div> : null}
            </dl>
            {job.sourceProvenance ? (
              <section
                aria-label="Declared, hash-bound AI-source provenance"
                className="source-provenance"
              >
                <header>
                  <span>Declared, hash-bound AI-source provenance</span>
                  <strong>{job.sourceProvenance.provenanceLabel}</strong>
                </header>
                <p>
                  <strong>Independently checked bytes:</strong> the source MP4,
                  local restoration mask and provenance JSON are reopened and
                  matched to their SHA-256 bindings.
                </p>
                <p>
                  <strong>Declared provenance fields:</strong> the remaining
                  hashes, review details and approval details below are parsed
                  from that bound JSON; this app does not independently
                  regenerate them.
                </p>
                <dl>
                  <div><dt>Provenance file SHA-256 (checked)</dt><dd>{job.sourceProvenance.fileSha256}</dd></div>
                  <div><dt>Original image SHA-256 (declared)</dt><dd>{job.sourceProvenance.originalImageSha256}</dd></div>
                  <div><dt>Source bundle manifest SHA-256 (declared)</dt><dd>{job.sourceProvenance.sourceBundleManifestSha256}</dd></div>
                  <div><dt>Normalized plate SHA-256 (declared)</dt><dd>{job.sourceProvenance.normalizedPlateSha256}</dd></div>
                  <div><dt>Canonical AI-source MP4 SHA-256 (declared and checked)</dt><dd>{job.sourceProvenance.canonicalSourceMp4Sha256}</dd></div>
                  <div><dt>Local restoration mask SHA-256 (declared and checked)</dt><dd>{job.sourceProvenance.foregroundMaskSha256}</dd></div>
                  <div><dt>Contact sheet SHA-256 (declared)</dt><dd>{job.sourceProvenance.contactSheetSha256}</dd></div>
                  <div><dt>Approval record SHA-256 (declared)</dt><dd>{job.sourceProvenance.approval.recordSha256}</dd></div>
                  <div><dt>Approved at (declared)</dt><dd>{job.sourceProvenance.approval.approvedAt}</dd></div>
                  <div><dt>Reviewer (declared)</dt><dd>{job.sourceProvenance.approval.reviewer}</dd></div>
                  <div><dt>Approval note (declared)</dt><dd>{job.sourceProvenance.approval.note}</dd></div>
                </dl>
              </section>
            ) : null}
            {job.state === "validated" ? (
              <section
                aria-label="Persisted AI source and local restoration mask identity preview"
                className="protect-preview protect-preview--persisted"
              >
                <div className="protect-preview__media">
                  <video
                    controls
                    muted
                    playsInline
                    src={realMediaUrl(job.id, "source")}
                  />
                  {showMask ? (
                    <Image
                      alt="Persisted local restoration mask"
                      fill
                      src={realMediaUrl(job.id, "mask")}
                      unoptimized
                    />
                  ) : null}
                </div>
                <button
                  onClick={() => setShowMask((current) => !current)}
                  type="button"
                >
                  {showMask ? "Hide mask overlay" : "Show mask overlay"}
                </button>
                <p>
                  Hash-bound AI source and local restoration mask. White
                  denotes the protected foreground. Kling receives source MP4
                  + prompt, not this mask.
                </p>
              </section>
            ) : null}
            {jobIsVerified && job.verification ? (
              <div className="job-ledger__verified">
                <strong>{job.verification.claim}</strong>
                <span>0 changed core channel samples / 121 core hash matches</span>
              </div>
            ) : (
              <p>No protected-core claim is available for this job state.</p>
            )}
          </article>

          <aside className="job-action">
            {job.state === "validated" ? (
              <>
                <span>Paid transition / irreversible</span>
                <h2>Authorize Kling O3.</h2>
                <p>
                  Attempt {budget?.next ?? "—"} of {budget?.cap ?? 3}. Review
                  the persisted AI source, prompt and local mask evidence, then
                  refresh a current server-issued price before authorizing one
                  request. Kling receives source MP4 + prompt, not this mask.
                </p>
                <section
                  aria-label="Server-fixed paid generation parameters"
                  className="paid-fixed-contract"
                >
                  <strong>Server-fixed paid generation parameters</strong>
                  <dl className="pricing-observation">
                    <div>
                      <dt>Audio</dt>
                      <dd>
                        <code>{`keep_audio: ${String(KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS.keep_audio)}`}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Shot mode</dt>
                      <dd>
                        <code>{`shot_type: ${KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS.shot_type}`}</code>
                      </dd>
                    </div>
                  </dl>
                  <small>Fixed by the shared server contract and not editable.</small>
                </section>
                <button
                  disabled={busy !== null}
                  onClick={refreshPricing}
                  type="button"
                >
                  {busy === "pricing"
                    ? "Refreshing price — no generation…"
                    : "Refresh current price — no generation"}
                </button>
                {pricingReceipt ? (
                  <>
                    <PricingReceiptEvidence pricingReceipt={pricingReceipt} />
                    <p>
                      Refreshing again clears both typed suffixes and paid
                      consent. Actual billing may differ from this estimate.
                    </p>
                    <label className="check-field">
                      <input
                        checked={ownsFootage}
                        onChange={(event) =>
                          setOwnsFootage(event.target.checked)
                        }
                        type="checkbox"
                      />
                      <span>{OWNERSHIP_CONFIRMATION}</span>
                    </label>
                    <label className="check-field">
                      <input
                        checked={paidAuthorization.paidConsent}
                        onChange={(event) =>
                          dispatchPaidAuthorization({
                            type: "paid_consent_changed",
                            checked: event.target.checked,
                          })
                        }
                        type="checkbox"
                      />
                      <span>{REAL_KLING_PAID_CONFIRMATION}</span>
                    </label>
                    <label className="digest-field">
                      <span>Type digest suffix <b>{requiredSuffix}</b></span>
                      <input
                        autoComplete="off"
                        maxLength={8}
                        onChange={(event) =>
                          dispatchPaidAuthorization({
                            type: "generation_suffix_changed",
                            value: event.target.value,
                          })
                        }
                        value={paidAuthorization.generationSuffix}
                      />
                    </label>
                    <label className="digest-field">
                      <span>
                        Type pricing suffix <b>{requiredPricingSuffix}</b>
                      </span>
                      <input
                        autoComplete="off"
                        maxLength={8}
                        onChange={(event) =>
                          dispatchPaidAuthorization({
                            type: "pricing_suffix_changed",
                            value: event.target.value,
                          })
                        }
                        value={paidAuthorization.pricingSuffix}
                      />
                    </label>
                  </>
                ) : (
                  <p role="status">
                    Price not refreshed. No estimate or paid authorization is
                    available until the server issues a receipt bound to this
                    job, generation digest and provenance file.
                  </p>
                )}
                <div className="job-action__buttons">
                  <button
                    className="workspace__primary"
                    disabled={!paidActionReady || busy !== null}
                    onClick={runJob}
                    type="button"
                  >
                    {busy === "run" ? "Submitting once…" : "Run one paid generation"}
                  </button>
                </div>
              </>
            ) : ["submitting", "submitted"].includes(job.state) ? (
              <>
                <span>fal queue / explicit refresh</span>
                <h2>Generation in progress.</h2>
                <p>Polling is manual. Page reads never mutate the job or submit again.</p>
                <button
                  className="workspace__primary"
                  disabled={busy !== null}
                  onClick={pollJob}
                  type="button"
                >
                  {busy === "poll" ? "Checking persisted request…" : "Check generation"}
                </button>
              </>
            ) : job.state === "generated" ? (
              <>
                <span>Model output / untrusted</span>
                <h2>{review ? "Three-frame review prepared." : "Ready for comparability review."}</h2>
                <p>
                  No protected-core claim exists yet. The generated MP4 must pass
                  comparability, explicit visual approval and canonical verification.
                </p>
                {!review ? (
                  <button
                    className="workspace__primary"
                    disabled={busy !== null}
                    onClick={prepareReview}
                    type="button"
                  >
                    {busy === "review" ? "Preparing fixed review frames…" : "Prepare review"}
                  </button>
                ) : (
                  <p>Review frames 0, 60 and 120 below before approving.</p>
                )}
              </>
            ) : job.state === "composited" ? (
              <>
                <span>Committed canonical evidence / recovery</span>
                <h2>Canonical finalization interrupted.</h2>
                <p>
                  The approved composite is persisted, but its canonical proof
                  record was not promoted. Resume reopens the committed evidence
                  and performs no fal call.
                </p>
                <button
                  className="workspace__primary"
                  disabled={busy !== null}
                  onClick={resumeVerification}
                  type="button"
                >
                  {busy === "resume"
                    ? "Reopening committed evidence…"
                    : "Resume canonical verification — no fal call"}
                </button>
              </>
            ) : job.state === "not_comparable" ? (
              <div className="job-terminal job-terminal--warning">
                <span>Terminal comparability result</span>
                <h2>Not comparable — no proof promoted.</h2>
                <p>{job.failureCode ?? "Generated geometry cannot support canonical comparison."}</p>
                <button onClick={startAnotherSource} type="button">Start another source</button>
              </div>
            ) : jobHasCanonicalFailure ? (
              <div className="job-terminal job-terminal--failure">
                <span>Terminal verifier result</span>
                <h2>Verifier failed — no proof promoted.</h2>
                <p>{job.failureCode}</p>
                <p>
                  {job.failureDetail ??
                    "Canonical protected-core verification did not pass."}
                </p>
                <button onClick={startAnotherSource} type="button">Start another source</button>
              </div>
            ) : (
              <>
                <span>Terminal job</span>
                <h2>{jobIsVerified ? "Canonical proof passed." : "No result was promoted."}</h2>
                <p>{job.failureCode ?? "The evidence record is preserved for inspection."}</p>
                {jobIsTerminal ? (
                  <button onClick={startAnotherSource} type="button">Start another source</button>
                ) : null}
              </>
            )}
          </aside>
        </div>
      )}

      {jobIsVerified && !proof ? (
        <aside className="workspace-resume-note" role="status">
          <strong>Verified job record restored read-only.</strong>
          <span>
            Canonical playback is not reconstructed from ledger fields during
            a page read; a validated proof payload is still required.
          </span>
        </aside>
      ) : null}

      {job && review && job.state === "generated" ? (
        <section className="review-workspace" aria-labelledby="review-title">
          <header className="review-workspace__header">
            <div>
              <span>Visual approval gate / no proof yet</span>
              <h2 id="review-title">Inspect the fixed geometry frames.</h2>
            </div>
            <p>
              These overlays support a visual comparability decision only. No
              protected-core claim exists until approval and verification pass.
            </p>
          </header>

          <div className="review-overlays">
            {review.overlays.map((overlay) => (
              <figure data-review-overlay={overlay.frame} key={overlay.frame}>
                <Image
                  alt={`Geometry review overlay for frame ${overlay.frame}`}
                  height={720}
                  src={overlay.url}
                  unoptimized
                  width={1280}
                />
                <figcaption>
                  <strong>Frame {overlay.frame}</strong>
                  <span>Geometry overlay / visual evidence</span>
                  <code>{overlay.sha256}</code>
                </figcaption>
              </figure>
            ))}
          </div>

          <div className="review-evidence">
            <dl>
              <div>
                <dt>Review manifest SHA-256</dt>
                <dd>{review.reviewManifestSha256}</dd>
              </div>
              <div>
                <dt>Review manifest digest SHA-256</dt>
                <dd>{review.reviewManifestDigestSha256}</dd>
              </div>
              <div>
                <dt>Generation digest</dt>
                <dd>{job.generationDigest}</dd>
              </div>
            </dl>

            <form className="review-approval" onSubmit={approveReview}>
              <label>
                <span>Reviewer name</span>
                <input
                  maxLength={120}
                  onChange={(event) => setReviewer(event.target.value)}
                  required
                  value={reviewer}
                />
              </label>
              <label>
                <span>Visual review note</span>
                <textarea
                  maxLength={2_000}
                  onChange={(event) => setVisualNote(event.target.value)}
                  required
                  rows={4}
                  value={visualNote}
                />
              </label>
              <label className="check-field">
                <input
                  checked={manifestConfirmed}
                  onChange={(event) => setManifestConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  Confirm review manifest and generation digest: manifest {review.reviewManifestSha256} / manifest digest {review.reviewManifestDigestSha256} / generation {job.generationDigest}
                </span>
              </label>
              <label className="check-field review-approval__phrase">
                <input
                  checked={approvalConfirmed}
                  onChange={(event) => setApprovalConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>{APPROVE_REVIEW_PHRASE}</span>
              </label>
              <button
                className="workspace__primary"
                disabled={!approvalReady || busy !== null}
                type="submit"
              >
                {busy === "approve" ? "Composing and verifying 121 frames…" : "Approve and run canonical verifier"}
              </button>
            </form>
          </div>
        </section>
      ) : null}

      {jobIsVerified && proof ? (
        <section className="canonical-proof" aria-labelledby="canonical-proof-title">
          <header>
            <span>Verified canonical evidence</span>
            <h2 id="canonical-proof-title">{proof.claim}</h2>
            <p>H.264 output remains a viewing preview and is not the lossless proof sequence.</p>
          </header>
          <VerifiedSynchronizedPlayback jobId={job.id} />
          <div className="canonical-compare" aria-label="Frame 60 visual comparison">
            <figure>
              <Image
                alt="AI-generated source at frame 60"
                height={720}
                src={realMediaUrl(job.id, "source-60")}
                unoptimized
                width={1280}
              />
              <figcaption>AI-source frame 60</figcaption>
            </figure>
            <figure>
              <Image
                alt="Raw model output at frame 60"
                height={720}
                src={realMediaUrl(job.id, "generated-60")}
                unoptimized
                width={1280}
              />
              <figcaption>Raw model frame 60</figcaption>
            </figure>
            <figure>
              <Image
                alt="Canonical composite at frame 60"
                height={720}
                src={realMediaUrl(job.id, "composite-60")}
                unoptimized
                width={1280}
              />
              <figcaption>Canonical composite frame 60</figcaption>
            </figure>
            <figure>
              <Image
                alt="Binary protected-core mask at frame 60"
                height={720}
                src={realMediaUrl(job.id, "protected-core-60")}
                unoptimized
                width={1280}
              />
              <figcaption>Protected core — exactness contract</figcaption>
            </figure>
            <figure>
              <Image
                alt="Feather boundary ring at frame 60"
                height={720}
                src={realMediaUrl(job.id, "boundary-ring-60")}
                unoptimized
                width={1280}
              />
              <figcaption>Boundary ring — visual seam, excluded from exactness</figcaption>
            </figure>
            <figure>
              <Image
                alt="Changed-pixel heatmap at frame 60"
                height={720}
                src={realMediaUrl(job.id, "difference-heatmap-60")}
                unoptimized
                width={1280}
              />
              <figcaption>Changed-pixel heatmap — visual-only, not verifier output</figcaption>
            </figure>
          </div>
          <p className="canonical-compare__notice">
            The protected core is the exactness contract. The boundary ring and
            changed-pixel heatmap are visual aids; canonical frame hashes and the
            audit JSON are the proof.
          </p>
          <div className="canonical-proof__metrics">
            <div aria-label={`${proof.framesAudited} / 121 frames audited`}><strong>{proof.framesAudited} / 121</strong><span>frames audited</span></div>
            <div aria-label={`${proof.protectedCorePixels.toLocaleString()} protected core pixels`}><strong>{proof.protectedCorePixels.toLocaleString()}</strong><span>protected core pixels</span></div>
            <div aria-label={`${proof.changedCoreChannelSamples} changed core channel samples`}><strong>{proof.changedCoreChannelSamples}</strong><span>changed core channel samples</span></div>
            <div aria-label={`${proof.worstMaxChannelDelta} worst max channel delta`}><strong>{proof.worstMaxChannelDelta}</strong><span>worst max channel delta</span></div>
            <div aria-label={`${proof.coreHashMatchCount} / 121 core hash matches`}><strong>{proof.coreHashMatchCount} / 121</strong><span>core hash matches</span></div>
          </div>
          <dl className="canonical-proof__hashes">
            <div><dt>Proof manifest SHA-256</dt><dd>{proof.proofManifestSha256}</dd></div>
            <div><dt>Audit SHA-256</dt><dd>{proof.auditSha256}</dd></div>
            <div><dt>Run manifest SHA-256</dt><dd>{proof.runManifestSha256}</dd></div>
            <div><dt>Preview SHA-256</dt><dd>{proof.previewSha256}</dd></div>
          </dl>
          <nav className="canonical-proof__exports" aria-label="Canonical proof exports">
            <a href={realMediaUrl(job.id, "canonical-frames")}>Canonical frames ZIP — 121 authoritative PNGs</a>
            <a href={realMediaUrl(job.id, "canonical-export-manifest")}>Canonical export manifest — frame hash index</a>
            <a href={realMediaUrl(job.id, "proof-manifest")}>Proof manifest JSON — canonical proof</a>
            <a href={realMediaUrl(job.id, "audit")}>Audit JSON</a>
            <a href={realMediaUrl(job.id, "run-manifest")}>Run manifest JSON</a>
            <a href={`/?proof=corrupt&job=${encodeURIComponent(job.id)}`}>Deliberate-corruption result — same verified job</a>
            <a href={realMediaUrl(job.id, "corruption-manifest")}>Corruption manifest JSON</a>
            <a href={realMediaUrl(job.id, "corruption-audit")}>Corruption audit JSON</a>
            <a href={realMediaUrl(job.id, "corruption-summary")}>Corruption summary JSON</a>
            <a href={realMediaUrl(job.id, "preview")}>H.264 preview — non-proof</a>
          </nav>
        </section>
      ) : null}

      {error ? <p className="workspace__error" role="alert">{error}</p> : null}
    </section>
  );
}
