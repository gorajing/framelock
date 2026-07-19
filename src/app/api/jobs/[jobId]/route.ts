import { NextResponse } from "next/server";
import { z } from "zod";

import { JobStoreError } from "@/lib/jobs/local-job-store";
import { readRealJob } from "@/lib/jobs/real-job-intake.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

function responseOptions(status = 200) {
  return {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  };
}

function errorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "INVALID_JOB_ID" }, responseOptions(400));
  }
  if (error instanceof JobStoreError) {
    const status =
      error.code === "JOB_NOT_FOUND"
        ? 404
        : error.code === "INVALID_JOB_STATE"
          ? 409
          : 500;
    return NextResponse.json({ error: error.code }, responseOptions(status));
  }
  return NextResponse.json({ error: "SERVER_ERROR" }, responseOptions(500));
}

function parseRequest(
  request: Request,
  rawJobId: string,
): string {
  if ([...new URL(request.url).searchParams].length > 0) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["query"],
        message: "Job routes accept no query parameters",
      },
    ]);
  }
  return jobIdSchema.parse(rawJobId);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    return NextResponse.json(
      await readRealJob(parseRequest(request, jobId)),
      responseOptions(),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
