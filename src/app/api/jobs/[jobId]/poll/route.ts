import { NextResponse } from "next/server";
import { z } from "zod";

import {
  RealKlingRuntimeError,
  pollRealKlingJob,
} from "@/lib/fal/real-kling-job.server";
import { RealKlingJobError } from "@/lib/fal/real-kling-job-core";
import { JobStoreError } from "@/lib/jobs/local-job-store";

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
  if (error instanceof RealKlingRuntimeError) {
    return NextResponse.json(
      { error: error.code },
      noStore(error.code === "ACTIVE_JOB_MISMATCH" ? 409 : 503),
    );
  }
  if (error instanceof RealKlingJobError) {
    return NextResponse.json({ error: error.code }, noStore(409));
  }
  if (error instanceof JobStoreError) {
    const status = error.code === "JOB_NOT_FOUND" ? 404 : 409;
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
          message: "The poll action accepts no query parameters",
        },
      ]);
    }
    const { jobId: rawJobId } = await context.params;
    return NextResponse.json(
      await pollRealKlingJob(jobIdSchema.parse(rawJobId)),
      noStore(200),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
