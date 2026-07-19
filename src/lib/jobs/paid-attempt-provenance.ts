import { createHash } from "node:crypto";

import { z } from "zod";

import {
  paidAttemptPricingObservationSchema,
  type PaidAttemptPricingObservation,
} from "./paid-attempt-pricing";

export { paidAttemptPricingObservationSchema };
export type { PaidAttemptPricingObservation };

const pricingShape = paidAttemptPricingObservationSchema.shape;

const basisShape = {
  attemptIndex: z.number().int().positive().safe(),
  attemptCap: z.number().int().positive().safe(),
  ...pricingShape,
} as const;

export const paidAttemptBasisSchema = z
  .object(basisShape)
  .strict()
  .superRefine((basis, context) => {
    if (basis.attemptIndex > basis.attemptCap) {
      context.addIssue({
        code: "custom",
        path: ["attemptIndex"],
        message: "paid attempt index exceeds its authorized cap",
      });
    }
  });

export const paidAttemptSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    ...basisShape,
    capturedAt: z.string().datetime(),
    digestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.attemptIndex > snapshot.attemptCap) {
      context.addIssue({
        code: "custom",
        path: ["attemptIndex"],
        message: "paid attempt index exceeds its authorized cap",
      });
    }
    if (Date.parse(snapshot.priceObservedAt) > Date.parse(snapshot.capturedAt)) {
      context.addIssue({
        code: "custom",
        path: ["priceObservedAt"],
        message: "pricing observation cannot occur after snapshot capture",
      });
    }
  });

export type PaidAttemptBasis = z.infer<typeof paidAttemptBasisSchema>;
export type PaidAttemptSnapshot = z.infer<typeof paidAttemptSnapshotSchema>;

/**
 * Hashes only the immutable pricing facts shown before paid authorization.
 * Attempt index and capture time belong to the later, server-owned snapshot.
 */
export function paidAttemptPricingObservationDigest(
  rawPricing: PaidAttemptPricingObservation,
): string {
  const pricing = paidAttemptPricingObservationSchema.parse({
    unitPriceUsd: rawPricing.unitPriceUsd,
    billingUnit: rawPricing.billingUnit,
    estimatedUnits: rawPricing.estimatedUnits,
    estimatedCostUsd: rawPricing.estimatedCostUsd,
    pricingSource: rawPricing.pricingSource,
    priceObservedAt: rawPricing.priceObservedAt,
  });
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, ...pricing }))
    .digest("hex");
}

export function createPaidAttemptSnapshot(
  rawBasis: PaidAttemptBasis,
  capturedAt: string,
): PaidAttemptSnapshot {
  const basis = paidAttemptBasisSchema.parse(rawBasis);
  const unsigned = {
    schemaVersion: 1 as const,
    ...basis,
    capturedAt: z.string().datetime().parse(capturedAt),
  };
  const snapshot = paidAttemptSnapshotSchema.parse({
    ...unsigned,
    digestSha256: paidAttemptDigest(unsigned),
  });
  if (!paidAttemptSnapshotHasValidDigest(snapshot)) {
    throw new TypeError("paid attempt snapshot digest could not be established");
  }
  return snapshot;
}

export function paidAttemptSnapshotsMatch(
  expected: PaidAttemptSnapshot,
  candidate: unknown,
): boolean {
  const parsedExpected = paidAttemptSnapshotSchema.safeParse(expected);
  const parsedCandidate = paidAttemptSnapshotSchema.safeParse(candidate);
  return (
    parsedExpected.success &&
    parsedCandidate.success &&
    paidAttemptSnapshotHasValidDigest(parsedExpected.data) &&
    paidAttemptSnapshotHasValidDigest(parsedCandidate.data) &&
    JSON.stringify(parsedExpected.data) === JSON.stringify(parsedCandidate.data)
  );
}

export function paidAttemptSnapshotHasValidDigest(
  snapshot: PaidAttemptSnapshot,
): boolean {
  return paidAttemptDigest(snapshot) === snapshot.digestSha256;
}

function paidAttemptDigest(
  snapshot: Omit<PaidAttemptSnapshot, "digestSha256">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: snapshot.schemaVersion,
        attemptIndex: snapshot.attemptIndex,
        attemptCap: snapshot.attemptCap,
        unitPriceUsd: snapshot.unitPriceUsd,
        billingUnit: snapshot.billingUnit,
        estimatedUnits: snapshot.estimatedUnits,
        estimatedCostUsd: snapshot.estimatedCostUsd,
        pricingSource: snapshot.pricingSource,
        priceObservedAt: snapshot.priceObservedAt,
        capturedAt: snapshot.capturedAt,
      }),
    )
    .digest("hex");
}
