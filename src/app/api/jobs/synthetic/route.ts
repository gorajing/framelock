import { NextResponse } from "next/server";
import { z } from "zod";

import { JobStoreError } from "@/lib/jobs/local-job-store";
import {
  pollSyntheticAttempt,
  type SyntheticAttempt,
} from "@/lib/fal/synthetic-job.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const attemptSchema = z.literal(1);
function errorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: "INVALID_REQUEST", details: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof JobStoreError) {
    const status =
      error.code === "JOB_ALREADY_EXISTS" || error.code === "JOB_ALREADY_ACTIVE"
        ? 409
        : error.code === "JOB_NOT_FOUND"
          ? 404
          : 422;
    return NextResponse.json({ error: error.code }, { status });
  }
  return NextResponse.json({ error: "SERVER_ERROR" }, { status: 500 });
}

export async function POST() {
  return NextResponse.json(
    {
      error: "LTX_ATTEMPT_CLOSED",
      reason: "The fixed LTX feasibility attempt failed the 16:9 hard gate.",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  try {
    const value = new URL(request.url).searchParams.get("attempt");
    const attempt = attemptSchema.parse(Number(value)) as SyntheticAttempt;
    const job = await pollSyntheticAttempt(attempt);
    return NextResponse.json(job, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
