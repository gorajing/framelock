import { NextResponse } from "next/server";

import { PaidAttemptBudgetError } from "@/lib/jobs/paid-attempt-budget";
import { readPaidAttemptBudget } from "@/lib/jobs/real-job-intake.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store, max-age=0" };
  if ([...new URL(request.url).searchParams].length > 0) {
    return NextResponse.json(
      { error: "INVALID_REQUEST" },
      { status: 400, headers },
    );
  }
  try {
    return NextResponse.json(await readPaidAttemptBudget(), { headers });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof PaidAttemptBudgetError
            ? error.code
            : "SERVER_ERROR",
      },
      { status: 500, headers },
    );
  }
}
