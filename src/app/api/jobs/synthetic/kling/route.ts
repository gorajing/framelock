import { NextResponse } from "next/server";
import { z } from "zod";

import { pollKlingFallback } from "@/lib/fal/synthetic-kling-job.server";
import { JobStoreError } from "@/lib/jobs/local-job-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      error: "LEGACY_SYNTHETIC_SUBMISSION_CLOSED",
      reason:
        "Paid generation is available only through the hash-bound real-job run action.",
    },
    {
      status: 410,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    },
  );
}

export async function GET(request: Request) {
  try {
    if ([...new URL(request.url).searchParams].length > 0) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["query"],
          message: "The fixed Kling fallback accepts no query parameters",
        },
      ]);
    }
    const job = await pollKlingFallback();
    return NextResponse.json(job, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
