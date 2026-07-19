import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiSourceProvenanceError } from "../../../lib/jobs/ai-source-provenance";
import { OWNERSHIP_CONFIRMATION } from "../../../lib/jobs/real-job-intake";

const mocks = vi.hoisted(() => ({
  createRealJob: vi.fn(),
  readActiveRealJob: vi.fn(),
}));

vi.mock("@/lib/media/framelock-cli-core", () => ({
  FrameLockCliError: class FrameLockCliError extends Error {},
}));
vi.mock("@/lib/jobs/active-job-registry", () => ({
  ActiveJobRegistryError: class ActiveJobRegistryError extends Error {},
}));
vi.mock("@/lib/jobs/ai-source-provenance", async () =>
  import("../../../lib/jobs/ai-source-provenance"),
);
vi.mock("@/lib/jobs/local-job-store", () => ({
  JobStoreError: class JobStoreError extends Error {},
}));
vi.mock("@/lib/jobs/real-job-intake", async () =>
  import("../../../lib/jobs/real-job-intake"),
);
vi.mock("@/lib/jobs/real-job-intake.server", () => ({
  createRealJob: mocks.createRealJob,
  readActiveRealJob: mocks.readActiveRealJob,
}));

import { GET, POST } from "./route";

function validForm(provenanceBytes = new Uint8Array([123, 125])): FormData {
  const form = new FormData();
  form.set(
    "source",
    new File([new Uint8Array([1])], "source.mp4", { type: "video/mp4" }),
  );
  form.set(
    "foregroundMask",
    new File([new Uint8Array([2])], "foreground.png", {
      type: "image/png",
    }),
  );
  form.set(
    "sourceProvenance",
    new File([provenanceBytes], "source-provenance.json", {
      type: "application/json",
    }),
  );
  form.set("prompt", "Move the AI product into a moonlit gallery.");
  form.set("ownershipConfirmation", OWNERSHIP_CONFIRMATION);
  return form;
}

function postRequest(form = validForm()): Request {
  return new Request("http://localhost/api/jobs", {
    method: "POST",
    body: form,
  });
}

describe("AI-source jobs collection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the active job through a read-only no-store GET", async () => {
    const job = { id: "ai_source_01", state: "generated" };
    mocks.readActiveRealJob.mockResolvedValue(job);

    const response = await GET(new Request("http://localhost/api/jobs"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual(job);
    expect(mocks.readActiveRealJob).toHaveBeenCalledOnce();
    expect(mocks.createRealJob).not.toHaveBeenCalled();
  });

  it("returns null when no persisted job is resumable", async () => {
    mocks.readActiveRealJob.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/jobs"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it.each([
    ["INVALID_PROVENANCE_JSON", 400],
    ["INVALID_PROVENANCE_SCHEMA", 400],
    ["PROVENANCE_SOURCE_MISMATCH", 400],
    ["PROVENANCE_MASK_MISMATCH", 400],
    ["PROVENANCE_ALREADY_EXISTS", 409],
    ["PREPARED_INPUT_PATH_MISMATCH", 500],
    ["PROVENANCE_TOO_LARGE", 413],
  ] as const)("maps %s to a stable %i response", async (code, status) => {
    mocks.createRealJob.mockRejectedValue(
      new AiSourceProvenanceError(code),
    );

    const response = await POST(postRequest());

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual({ error: code });
  });

  it("rejects an oversized provenance part with 413 before job creation", async () => {
    const response = await POST(
      postRequest(validForm(new Uint8Array(256 * 1024 + 1))),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "PROVENANCE_TOO_LARGE",
    });
    expect(mocks.createRealJob).not.toHaveBeenCalled();
  });
});
