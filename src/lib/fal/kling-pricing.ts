import type { PaidAttemptPricingObservation } from "../jobs/paid-attempt-pricing";

/**
 * Hackathon-local price evidence expires after 24 hours. A paid run must stop
 * until a human obtains and explicitly re-authorizes a new authenticated
 * observation; FrameLock never refreshes pricing implicitly at this boundary.
 */
export const KLING_O3_STANDARD_EDIT_PRICING_MAX_AGE_MS =
  24 * 60 * 60 * 1_000;

export function isKlingO3StandardEditPricingObservationCurrent(
  pricing: Pick<PaidAttemptPricingObservation, "priceObservedAt">,
  now: Date,
): boolean {
  const observedAtMs = Date.parse(pricing.priceObservedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  if (observedAtMs > nowMs) {
    return false;
  }
  return (
    nowMs - observedAtMs <= KLING_O3_STANDARD_EDIT_PRICING_MAX_AGE_MS
  );
}
