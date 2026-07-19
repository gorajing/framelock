import { JobStoreError, type LocalJobRecord } from "./local-job-store";
import {
  parseRealJobMediaJobId,
  resolveRealJobAsset,
} from "./real-job-media";
import {
  createHashBoundMediaResponse,
  RealJobMediaError,
} from "./real-job-media-stream";

type JobReader = Readonly<{
  readJob(id: string): Promise<LocalJobRecord>;
}>;

type RouteOptions = Readonly<{
  jobs: JobReader;
  jobsRoot: string;
  runsRoot: string;
}>;

type RouteContext = {
  params: Promise<{ jobId: string; asset: string }>;
};

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
} as const;

export function createRealJobMediaHandler(options: RouteOptions) {
  return async function GET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    try {
      const params = await context.params;
      const jobId = parseRealJobMediaJobId(params.jobId);
      const record = await options.jobs.readJob(jobId);
      const asset = await resolveRealJobAsset({
        jobsRoot: options.jobsRoot,
        runsRoot: options.runsRoot,
        record,
        asset: params.asset,
      });
      return await createHashBoundMediaResponse(
        asset,
        request.headers.get("range") ?? undefined,
      );
    } catch (error) {
      return errorResponse(error);
    }
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof RealJobMediaError) {
    if (error.code === "INVALID_RANGE") {
      const headers = new Headers(privateHeaders);
      headers.set("Accept-Ranges", "bytes");
      headers.set("Content-Range", `bytes */${error.fileSize ?? 0}`);
      return Response.json({ error: error.code }, { status: 416, headers });
    }
    if (error.code === "ASSET_NOT_AVAILABLE") {
      return Response.json(
        { error: error.code },
        { status: 409, headers: privateHeaders },
      );
    }
    if (
      error.code === "ASSET_INTEGRITY_FAILED" ||
      error.code === "ASSET_CHANGED" ||
      error.code === "ASSET_TOO_LARGE"
    ) {
      return Response.json(
        { error: "ASSET_INTEGRITY_FAILED" },
        { status: 409, headers: privateHeaders },
      );
    }
    return Response.json(
      { error: "ASSET_NOT_FOUND" },
      { status: 404, headers: privateHeaders },
    );
  }
  if (error instanceof JobStoreError && error.code === "JOB_NOT_FOUND") {
    return Response.json(
      { error: "JOB_NOT_FOUND" },
      { status: 404, headers: privateHeaders },
    );
  }
  return Response.json(
    { error: "MEDIA_READ_FAILED" },
    { status: 500, headers: privateHeaders },
  );
}
