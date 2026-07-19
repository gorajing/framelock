import { NextResponse } from "next/server";
import { z } from "zod";

import {
  RealKlingRuntimeError,
  submitRealKlingJob,
} from "@/lib/fal/real-kling-job.server";
import { RealKlingJobError } from "@/lib/fal/real-kling-job-core";
import { realKlingSubmitSchema } from "@/lib/fal/real-kling-request";
import { JobStoreError } from "@/lib/jobs/local-job-store";
import { PaidAttemptBudgetError } from "@/lib/jobs/paid-attempt-budget";

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
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, noStore(400));
  }
  if (error instanceof RealKlingJobError) {
    return NextResponse.json({ error: error.code }, noStore(409));
  }
  if (error instanceof RealKlingRuntimeError) {
    const status = [
      "ACTIVE_JOB_MISMATCH",
      "AI_SOURCE_EVIDENCE_MISMATCH",
      "PRICING_RECEIPT_REQUIRED",
    ].includes(error.code)
      ? 409
      : 503;
    return NextResponse.json(
      { error: error.code },
      noStore(status),
    );
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

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    if ([...new URL(request.url).searchParams].length > 0) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["query"],
          message: "The run action accepts no query parameters",
        },
      ]);
    }
    const { jobId: rawJobId } = await context.params;
    const jobId = jobIdSchema.parse(rawJobId);
    const input = realKlingSubmitSchema.parse(await request.json());
    return NextResponse.json(
      await submitRealKlingJob({
        jobId,
        generationDigest: input.generationDigest,
        authorization: input.confirmation,
        pricingObservationDigest: input.pricingObservationDigest,
      }),
      noStore(202),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
