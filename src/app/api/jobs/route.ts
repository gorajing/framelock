import { NextResponse } from "next/server";
import { z } from "zod";

import { FrameLockCliError } from "@/lib/media/framelock-cli-core";
import {
  ActiveJobRegistryError,
} from "@/lib/jobs/active-job-registry";
import { AiSourceProvenanceError } from "@/lib/jobs/ai-source-provenance";
import { JobStoreError } from "@/lib/jobs/local-job-store";
import {
  RealJobIntakeError,
  parseRealJobIntake,
} from "@/lib/jobs/real-job-intake";
import {
  createRealJob,
  readActiveRealJob,
} from "@/lib/jobs/real-job-intake.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MULTIPART_BYTES = 62 * 1024 * 1024;

function noStore(status: number) {
  return {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  };
}

function errorResponse(error: unknown) {
  if (error instanceof RealJobIntakeError) {
    const tooLarge = [
      "SOURCE_TOO_LARGE",
      "MASK_TOO_LARGE",
      "PROVENANCE_TOO_LARGE",
    ].includes(error.code);
    return NextResponse.json(
      { error: error.code },
      noStore(tooLarge ? 413 : 400),
    );
  }
  if (error instanceof AiSourceProvenanceError) {
    const status =
      error.code === "PROVENANCE_TOO_LARGE"
        ? 413
        : error.code === "PROVENANCE_ALREADY_EXISTS"
          ? 409
          : error.code === "PREPARED_INPUT_PATH_MISMATCH"
            ? 500
            : 400;
    return NextResponse.json({ error: error.code }, noStore(status));
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, noStore(400));
  }
  if (error instanceof FrameLockCliError) {
    const status = error.code === "INVALID_CLI_OUTPUT" ? 500 : 422;
    return NextResponse.json(
      {
        error:
          error.code === "INVALID_CLI_OUTPUT"
            ? "MEDIA_EVIDENCE_INVALID"
            : "MEDIA_VALIDATION_FAILED",
      },
      noStore(status),
    );
  }
  if (error instanceof ActiveJobRegistryError) {
    const conflict = ["ACTIVE_JOB_BUSY", "ACTIVE_JOB_NONTERMINAL"].includes(
      error.code,
    );
    return NextResponse.json(
      { error: error.code },
      noStore(conflict ? 409 : 500),
    );
  }
  if (error instanceof JobStoreError) {
    const status = error.code === "JOB_ALREADY_EXISTS" ? 409 : 500;
    return NextResponse.json({ error: error.code }, noStore(status));
  }
  return NextResponse.json({ error: "SERVER_ERROR" }, noStore(500));
}

export async function GET(request: Request) {
  try {
    if ([...new URL(request.url).searchParams].length > 0) {
      return NextResponse.json(
        { error: "UNEXPECTED_QUERY" },
        noStore(400),
      );
    }
    return NextResponse.json(await readActiveRealJob(), noStore(200));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!request.headers.get("content-type")?.startsWith("multipart/form-data;")) {
      return NextResponse.json(
        { error: "MULTIPART_REQUIRED" },
        noStore(415),
      );
    }
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null) {
      const parsedLength = Number(contentLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
        return NextResponse.json(
          { error: "INVALID_CONTENT_LENGTH" },
          noStore(400),
        );
      }
      if (parsedLength > MAX_MULTIPART_BYTES) {
        return NextResponse.json(
          { error: "REQUEST_TOO_LARGE" },
          noStore(413),
        );
      }
    }

    const intake = parseRealJobIntake(await request.formData());
    return NextResponse.json(await createRealJob(intake), noStore(201));
  } catch (error) {
    return errorResponse(error);
  }
}
