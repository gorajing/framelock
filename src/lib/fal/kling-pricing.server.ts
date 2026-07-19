import "server-only";

import { z } from "zod";

import {
  paidAttemptPricingObservationSchema,
  type PaidAttemptPricingObservation,
} from "../jobs/paid-attempt-pricing";
import { KLING_O3_STANDARD_EDIT_ENDPOINT } from "./kling-contract";

const FAL_PLATFORM_PRICING_URL = "https://api.fal.ai/v1/models/pricing";
const FAL_PRICING_TIMEOUT_MS = 10_000;
const ESTIMATED_UNITS = "5.041666667";
const ESTIMATE_FRACTION_DIGITS = 10;
const PRICING_SOURCE =
  "authenticated_fal_platform_pricing_api_v1_models_pricing";

const upstreamPricingResponseSchema = z
  .object({
    prices: z.array(
      z
        .object({
          endpoint_id: z.string(),
          unit_price: z.number().finite().nonnegative(),
          unit: z.string(),
          currency: z.string(),
        })
        .passthrough(),
    ),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  })
  .passthrough();

export type KlingPricingObservationErrorCode =
  | "FAL_KEY_MISSING"
  | "FAL_PRICING_AUTHORIZATION_FAILED"
  | "FAL_PRICING_RATE_LIMITED"
  | "FAL_PRICING_UNAVAILABLE"
  | "FAL_PRICING_RESPONSE_INVALID";

export class KlingPricingObservationError extends Error {
  constructor(readonly code: KlingPricingObservationErrorCode) {
    super(code);
    this.name = "KlingPricingObservationError";
  }
}

type PricingObservationOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

function invalidResponse(): never {
  throw new KlingPricingObservationError("FAL_PRICING_RESPONSE_INVALID");
}

function httpFailure(status: number): never {
  if (status === 401 || status === 403) {
    throw new KlingPricingObservationError(
      "FAL_PRICING_AUTHORIZATION_FAILED",
    );
  }
  if (status === 429) {
    throw new KlingPricingObservationError("FAL_PRICING_RATE_LIMITED");
  }
  throw new KlingPricingObservationError("FAL_PRICING_UNAVAILABLE");
}

function plainDecimal(value: number): string {
  const serialized = String(value);
  if (!/[eE]/.test(serialized)) {
    return serialized;
  }

  const [coefficient, exponentText] = serialized.toLowerCase().split("e");
  const exponent = Number(exponentText);
  if (!coefficient || !Number.isSafeInteger(exponent)) {
    invalidResponse();
  }
  const [integerPart, fractionPart = ""] = coefficient.split(".");
  const digits = `${integerPart}${fractionPart}`;
  const decimalPosition = integerPart.length + exponent;
  if (decimalPosition <= 0) {
    return `0.${"0".repeat(-decimalPosition)}${digits}`;
  }
  if (decimalPosition >= digits.length) {
    return `${digits}${"0".repeat(decimalPosition - digits.length)}`;
  }
  return `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

function parseDecimal(value: string): { coefficient: bigint; scale: number } {
  const [integerPart, fractionPart = ""] = value.split(".");
  return {
    coefficient: BigInt(`${integerPart}${fractionPart}`),
    scale: fractionPart.length,
  };
}

function powerOfTen(exponent: number): bigint {
  let result = BigInt(1);
  for (let index = 0; index < exponent; index += 1) {
    result *= BigInt(10);
  }
  return result;
}

function formatDecimal(coefficient: bigint, scale: number): string {
  if (scale === 0) {
    return coefficient.toString();
  }
  const digits = coefficient.toString().padStart(scale + 1, "0");
  const integerPart = digits.slice(0, -scale);
  const fractionPart = digits.slice(-scale).replace(/0+$/, "");
  return fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
}

function multiplyDecimalRounded(
  left: string,
  right: string,
  fractionDigits: number,
): string {
  const leftDecimal = parseDecimal(left);
  const rightDecimal = parseDecimal(right);
  let coefficient = leftDecimal.coefficient * rightDecimal.coefficient;
  const productScale = leftDecimal.scale + rightDecimal.scale;

  if (productScale > fractionDigits) {
    const divisor = powerOfTen(productScale - fractionDigits);
    const remainder = coefficient % divisor;
    coefficient /= divisor;
    if (remainder * BigInt(2) >= divisor) {
      coefficient += BigInt(1);
    }
  } else if (productScale < fractionDigits) {
    coefficient *= powerOfTen(fractionDigits - productScale);
  }

  return formatDecimal(coefficient, fractionDigits);
}

/**
 * Reads the authenticated account price without submitting, uploading or
 * calling a model endpoint. Native fetch is intentionally invoked once.
 */
export async function observeKlingO3StandardEditPricing(
  options: PricingObservationOptions = {},
): Promise<PaidAttemptPricingObservation> {
  const apiKey = (options.env ?? process.env).FAL_KEY?.trim();
  if (!apiKey) {
    throw new KlingPricingObservationError("FAL_KEY_MISSING");
  }

  const url = new URL(FAL_PLATFORM_PRICING_URL);
  url.searchParams.set("endpoint_id", KLING_O3_STANDARD_EDIT_ENDPOINT);

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Key ${apiKey}`,
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(FAL_PRICING_TIMEOUT_MS),
    });
  } catch {
    throw new KlingPricingObservationError("FAL_PRICING_UNAVAILABLE");
  }
  if (!response.ok) {
    httpFailure(response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    invalidResponse();
  }
  const parsed = upstreamPricingResponseSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.prices.length !== 1 ||
    parsed.data.has_more ||
    parsed.data.next_cursor !== null
  ) {
    invalidResponse();
  }

  const price = parsed.data.prices[0];
  if (
    price.endpoint_id !== KLING_O3_STANDARD_EDIT_ENDPOINT ||
    price.currency !== "USD" ||
    !["second", "seconds"].includes(price.unit)
  ) {
    invalidResponse();
  }

  let observedAt: Date;
  try {
    observedAt = (options.now ?? (() => new Date()))();
  } catch {
    invalidResponse();
  }
  if (
    !(observedAt instanceof Date) ||
    !Number.isFinite(observedAt.getTime())
  ) {
    invalidResponse();
  }
  const unitPriceUsd = plainDecimal(price.unit_price);
  const observation = paidAttemptPricingObservationSchema.safeParse({
    unitPriceUsd,
    billingUnit: "seconds",
    estimatedUnits: ESTIMATED_UNITS,
    estimatedCostUsd: multiplyDecimalRounded(
      unitPriceUsd,
      ESTIMATED_UNITS,
      ESTIMATE_FRACTION_DIGITS,
    ),
    pricingSource: PRICING_SOURCE,
    priceObservedAt: observedAt.toISOString(),
  });
  if (!observation.success) {
    invalidResponse();
  }
  return observation.data;
}
