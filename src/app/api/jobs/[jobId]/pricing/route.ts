import { NextResponse } from "next/server";
import { z } from "zod";

import { KlingPricingObservationError } from "@/lib/fal/kling-pricing.server";
import {
  RealKlingRuntimeError,
  refreshRealKlingPricing,
} from "@/lib/fal/real-kling-job.server";
import { JobStoreError } from "@/lib/jobs/local-job-store";
import { PaidAttemptBudgetError } from "@/lib/jobs/paid-attempt-budget";
import { pricingReceiptViewSchema } from "@/lib/jobs/paid-attempt-pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

function noStore(status: number) {
  return {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  };
}

function errorResponse(error: unknown) {
  if (error instanceof RealKlingRuntimeError) {
    const status = [
      "ACTIVE_JOB_MISMATCH",
      "AI_SOURCE_EVIDENCE_MISMATCH",
      "PRICING_RECEIPT_REQUIRED",
    ].includes(error.code)
      ? 409
      : error.code === "FAL_KEY_MISSING"
        ? 503
        : 500;
    return NextResponse.json({ error: error.code }, noStore(status));
  }
  if (error instanceof KlingPricingObservationError) {
    return NextResponse.json({ error: error.code }, noStore(503));
  }
  if (error instanceof PaidAttemptBudgetError) {
    return NextResponse.json(
      {
        error: error.code,
        ...(error.budget ? { budget: error.budget } : {}),
      },
      noStore(error.code === "PAID_ATTEMPT_CAP_REACHED" ? 409 : 500),
    );
  }
  if (error instanceof JobStoreError) {
    const status =
      error.code === "JOB_NOT_FOUND"
        ? 404
        : ["JOB_ALREADY_ACTIVE", "INVALID_JOB_STATE"].includes(error.code)
          ? 409
          : 500;
    return NextResponse.json({ error: error.code }, noStore(status));
  }
  return NextResponse.json({ error: "SERVER_ERROR" }, noStore(500));
}

function invalidRequest() {
  return NextResponse.json({ error: "INVALID_REQUEST" }, noStore(400));
}

async function requestHasNonEmptyBody(request: Request): Promise<boolean> {
  if (request.body === null) {
    return false;
  }

  const reader = request.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return false;
      }
      if (chunk.value.byteLength > 0) {
        await reader.cancel();
        return true;
      }
    }
  } catch {
    return true;
  } finally {
    reader.releaseLock();
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    if (
      [...new URL(request.url).searchParams].length > 0 ||
      (await requestHasNonEmptyBody(request))
    ) {
      return invalidRequest();
    }
    const { jobId: rawJobId } = await context.params;
    const parsedJobId = jobIdSchema.safeParse(rawJobId);
    if (!parsedJobId.success) {
      return invalidRequest();
    }

    const parsedReceipt = pricingReceiptViewSchema.safeParse(
      await refreshRealKlingPricing(parsedJobId.data),
    );
    if (!parsedReceipt.success) {
      return errorResponse(new Error("Invalid pricing receipt view"));
    }
    return NextResponse.json(parsedReceipt.data, noStore(200));
  } catch (error) {
    return errorResponse(error);
  }
}
