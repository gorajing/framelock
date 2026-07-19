import { NextResponse } from "next/server";
import { z } from "zod";

import { ActiveJobRegistryError } from "@/lib/jobs/active-job-registry";
import { JobStoreError } from "@/lib/jobs/local-job-store";
import { FrameLockCliError } from "@/lib/media/framelock-cli-core";
import {
  realJobApprovalSchema,
  RealJobReviewError,
} from "@/lib/review/real-job-review";
import { approveRealJob } from "@/lib/review/real-job-review.server";

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
  if (error instanceof RealJobReviewError) {
    const status = [
      "ACTIVE_JOB_MISMATCH",
      "INVALID_JOB_STATE",
      "STALE_REVIEW_HASHES",
    ].includes(error.code)
      ? 409
      : 500;
    return NextResponse.json({ error: error.code }, noStore(status));
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
  if (
    error instanceof ActiveJobRegistryError ||
    error instanceof FrameLockCliError
  ) {
    return NextResponse.json({ error: error.code }, noStore(500));
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
          message: "The approval action accepts no query parameters",
        },
      ]);
    }
    const { jobId: rawJobId } = await context.params;
    const jobId = jobIdSchema.parse(rawJobId);
    const approval = realJobApprovalSchema.parse(await request.json());
    return NextResponse.json(
      await approveRealJob(jobId, approval),
      noStore(200),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
