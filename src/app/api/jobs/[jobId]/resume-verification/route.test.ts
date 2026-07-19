import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CodedError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    resumeRealJobVerification: vi.fn(),
    ActiveJobRegistryError: class ActiveJobRegistryError extends CodedError {},
    JobStoreError: class JobStoreError extends CodedError {},
    FrameLockCliError: class FrameLockCliError extends CodedError {},
    RealJobReviewError: class RealJobReviewError extends CodedError {},
  };
});

vi.mock("@/lib/jobs/active-job-registry", () => ({
  ActiveJobRegistryError: mocks.ActiveJobRegistryError,
}));
vi.mock("@/lib/jobs/local-job-store", () => ({
  JobStoreError: mocks.JobStoreError,
}));
vi.mock("@/lib/media/framelock-cli-core", () => ({
  FrameLockCliError: mocks.FrameLockCliError,
}));
vi.mock("@/lib/review/real-job-review", () => ({
  RealJobReviewError: mocks.RealJobReviewError,
}));
vi.mock("@/lib/review/real-job-review.server", () => ({
  resumeRealJobVerification: mocks.resumeRealJobVerification,
}));

import { POST } from "./route";

const JOB_ID = "ai_source_01";
const RESULT = {
  job: { id: JOB_ID, state: "verified" },
  proof: { framesAudited: 121 },
};

function request(suffix = "", body?: string) {
  return new Request(
    `http://localhost/api/jobs/${JOB_ID}/resume-verification${suffix}`,
    { method: "POST", body },
  );
}

function context(jobId = JOB_ID) {
  return { params: Promise.resolve({ jobId }) };
}

describe("canonical verification resume route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resumeRealJobVerification.mockResolvedValue(RESULT);
  });

  it("reconciles committed evidence through a strict bodyless no-store POST", async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual(RESULT);
    expect(mocks.resumeRealJobVerification).toHaveBeenCalledOnce();
    expect(mocks.resumeRealJobVerification).toHaveBeenCalledWith(JOB_ID);
  });

  it.each([
    ["query parameters", request("?retry=1")],
    ["a request body", request("", "{}")],
  ])("rejects %s before touching persisted evidence", async (_label, input) => {
    const response = await POST(input, context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "INVALID_REQUEST",
    });
    expect(mocks.resumeRealJobVerification).not.toHaveBeenCalled();
  });

  it("rejects an invalid job ID before touching persisted evidence", async () => {
    const response = await POST(request(), context("../escape"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "INVALID_REQUEST",
    });
    expect(mocks.resumeRealJobVerification).not.toHaveBeenCalled();
  });

  it("returns a stable conflict for a job outside the recovery state", async () => {
    mocks.resumeRealJobVerification.mockRejectedValue(
      new mocks.RealJobReviewError("INVALID_JOB_STATE"),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "INVALID_JOB_STATE",
    });
  });
});
