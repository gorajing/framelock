import { createHash } from "node:crypto";
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureMotionFalReadEvidence,
  uploadMotionCanonicalMp4,
  type MotionFalReadPort,
} from "./motion-fal-io";

const NOW = new Date("2026-07-18T22:00:00.000Z");
const ENDPOINT = "fal-ai/veed/video-background-removal";
const ATTEMPT_ID = "motion-attempt-veed-01";
const REQUEST_ID = "request-veed-01";
const CREDENTIALS = "fal-secret-that-must-never-be-persisted";

function mp4Fixture(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x69, 0x73, 0x6f, 0x32,
  ]);
}

function submittedAttempt() {
  return {
    attemptId: ATTEMPT_ID,
    reservedAt: "2026-07-18T21:50:00.000Z",
    completedAt: "2026-07-18T21:50:01.000Z",
    state: "submitted" as const,
    endpoint: ENDPOINT,
    inputDigest: "a".repeat(64),
    pricing: {
      unitPriceUsd: "0.00125",
      billingUnit: "compute-second",
      estimatedUnits: "18",
      estimatedCostUsd: "0.0225",
      pricingSource: "fal model pricing",
      priceObservedAt: "2026-07-18T21:00:00.000Z",
      priceValidUntil: "2026-07-19T21:00:00.000Z",
    },
    httpStatus: 200,
    requestId: REQUEST_ID,
    remoteStatus: "IN_QUEUE",
    statusUrl:
      `https://queue.fal.run/fal-ai/veed/requests/${REQUEST_ID}/status`,
    responseUrl:
      `https://queue.fal.run/fal-ai/veed/requests/${REQUEST_ID}`,
  };
}

describe("Motion v1 fal no-spend I/O", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-motion-fal-io-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uploads the exact local MP4 bytes and atomically binds them to a validated fal CDN URL", async () => {
    const source = join(root, "canonical-source.mp4");
    const receiptPath = join(root, "evidence", "upload-receipt.json");
    const bytes = mp4Fixture();
    await writeFile(source, bytes, { mode: 0o600 });
    const upload = vi.fn(async (file: Blob) => {
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe("canonical-source.mp4");
      expect(file.type).toBe("video/mp4");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
      return "https://v3b.fal.media/files/b/0aa2/source.mp4";
    });

    const receipt = await uploadMotionCanonicalMp4({
      sourcePath: source,
      receiptPath,
      upload,
      now: () => new Date(NOW),
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(receipt).toEqual({
      schemaVersion: 1,
      kind: "motion-v1-fal-upload",
      uploadedAt: NOW.toISOString(),
      localFile: {
        path: source,
        name: "canonical-source.mp4",
        mime: "video/mp4",
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      falUrl: "https://v3b.fal.media/files/b/0aa2/source.mp4",
    });
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(receipt);
  });

  it("refuses an existing upload receipt before uploading and rejects hostile returned URLs", async () => {
    const source = join(root, "canonical-source.mp4");
    const receiptPath = join(root, "upload-receipt.json");
    await writeFile(source, mp4Fixture());
    await writeFile(receiptPath, "do-not-overwrite", { mode: 0o600 });
    const upload = vi.fn(async () => "https://v3b.fal.media/files/source.mp4");

    await expect(
      uploadMotionCanonicalMp4({ sourcePath: source, receiptPath, upload }),
    ).rejects.toMatchObject({ code: "EVIDENCE_EXISTS" });
    expect(upload).not.toHaveBeenCalled();
    expect(await readFile(receiptPath, "utf8")).toBe("do-not-overwrite");

    const secondReceipt = join(root, "hostile-upload.json");
    await expect(
      uploadMotionCanonicalMp4({
        sourcePath: source,
        receiptPath: secondReceipt,
        upload: async () => "https://fal.media.attacker.example/files/source.mp4",
      }),
    ).rejects.toMatchObject({ code: "INVALID_FAL_MEDIA_URL" });
    await expect(readFile(secondReceipt, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a mislabeled local file before invoking fal storage", async () => {
    const source = join(root, "not-an-mp4.mp4");
    await writeFile(source, "plain text", { mode: 0o600 });
    const upload = vi.fn();

    await expect(
      uploadMotionCanonicalMp4({
        sourcePath: source,
        receiptPath: join(root, "invalid-upload.json"),
        upload,
      }),
    ).rejects.toMatchObject({ code: "INVALID_LOCAL_MP4" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("captures submitted-attempt status and result with read methods only, then downloads explicit result declarations", async () => {
    const outputDirectory = join(root, "capture-01");
    const status = { status: "COMPLETED", logs: [] };
    const result = {
      request_id: REQUEST_ID,
      video: {
        url: "https://v3b.fal.media/files/b/0aa2/matte.mp4",
        content_type: "video/mp4",
      },
    };
    const submit = vi.fn();
    const readAttempt = vi.fn(async () => submittedAttempt());
    const readStatus = vi.fn(async () => status);
    const readResult = vi.fn(async () => result);
    const controller = {
      submit,
      readAttempt,
      readStatus,
      readResult,
    } as unknown as MotionFalReadPort;
    const downloadBytes = Buffer.from("matte-video-output");
    const fetchImpl = vi.fn(async () =>
      new Response(downloadBytes, {
        status: 200,
        headers: {
          "content-length": String(downloadBytes.byteLength),
          "content-type": "video/mp4",
        },
      }),
    );

    const capture = await captureMotionFalReadEvidence({
      controller,
      attemptId: ATTEMPT_ID,
      credentials: CREDENTIALS,
      allowedEndpoints: [ENDPOINT],
      outputDirectory,
      downloads: [
        {
          jsonPointer: "/video/url",
          fileName: "matte.mp4",
          expectedMime: "video/mp4",
          maxBytes: 1_000,
        },
      ],
      fetchImpl,
      now: () => new Date(NOW),
    });

    expect(submit).not.toHaveBeenCalled();
    expect(readAttempt).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(readStatus).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      credentials: CREDENTIALS,
    });
    expect(readResult).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      credentials: CREDENTIALS,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      result.video.url,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    expect(JSON.parse(await readFile(join(outputDirectory, "remote-status.json"), "utf8"))).toEqual(status);
    expect(JSON.parse(await readFile(join(outputDirectory, "remote-result.json"), "utf8"))).toEqual(result);
    expect(await readFile(join(outputDirectory, "matte.mp4"))).toEqual(downloadBytes);
    expect(capture).toMatchObject({
      schemaVersion: 1,
      kind: "motion-v1-fal-read-capture",
      capturedAt: NOW.toISOString(),
      attempt: {
        attemptId: ATTEMPT_ID,
        endpoint: ENDPOINT,
        requestId: REQUEST_ID,
        inputDigest: "a".repeat(64),
      },
      downloads: [
        {
          jsonPointer: "/video/url",
          falUrl: result.video.url,
          fileName: "matte.mp4",
          mime: "video/mp4",
          bytes: downloadBytes.byteLength,
          sha256: createHash("sha256").update(downloadBytes).digest("hex"),
        },
      ],
    });
    expect(
      JSON.parse(await readFile(join(outputDirectory, "capture-receipt.json"), "utf8")),
    ).toEqual(capture);
    const persisted = await Promise.all(
      (await readdir(outputDirectory)).map((name) =>
        readFile(join(outputDirectory, name), "utf8"),
      ),
    );
    expect(persisted.join("\n")).not.toContain(CREDENTIALS);
  });

  it("refuses to overwrite any prior capture before making remote reads", async () => {
    const outputDirectory = join(root, "capture-existing");
    await mkdir(outputDirectory);
    await writeFile(join(outputDirectory, "marker"), "owned evidence");
    const controller: MotionFalReadPort = {
      readAttempt: vi.fn(),
      readStatus: vi.fn(),
      readResult: vi.fn(),
    };

    await expect(
      captureMotionFalReadEvidence({
        controller,
        attemptId: ATTEMPT_ID,
        credentials: CREDENTIALS,
        allowedEndpoints: [ENDPOINT],
        outputDirectory,
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_EXISTS" });
    expect(controller.readAttempt).not.toHaveBeenCalled();
    expect(await readFile(join(outputDirectory, "marker"), "utf8")).toBe(
      "owned evidence",
    );
  });

  it("rejects undeclared hosts, unsafe output names and MIME mismatches without a persisted download", async () => {
    const result = {
      video: { url: "https://attacker.example/matte.mp4" },
    };
    const controller: MotionFalReadPort = {
      readAttempt: vi.fn(async () => submittedAttempt()),
      readStatus: vi.fn(async () => ({ status: "COMPLETED" })),
      readResult: vi.fn(async () => result),
    };
    const fetchImpl = vi.fn();

    await expect(
      captureMotionFalReadEvidence({
        controller,
        attemptId: ATTEMPT_ID,
        credentials: CREDENTIALS,
        allowedEndpoints: [ENDPOINT],
        outputDirectory: join(root, "hostile-capture"),
        downloads: [
          {
            jsonPointer: "/video/url",
            fileName: "../escape.mp4",
            expectedMime: "video/mp4",
          },
        ],
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOWNLOAD_DECLARATION" });
    expect(fetchImpl).not.toHaveBeenCalled();

    const hostileUrlController: MotionFalReadPort = {
      readAttempt: vi.fn(async () => submittedAttempt()),
      readStatus: vi.fn(async () => ({ status: "COMPLETED" })),
      readResult: vi.fn(async () => result),
    };
    await expect(
      captureMotionFalReadEvidence({
        controller: hostileUrlController,
        attemptId: ATTEMPT_ID,
        credentials: CREDENTIALS,
        allowedEndpoints: [ENDPOINT],
        outputDirectory: join(root, "hostile-url-capture"),
        downloads: [
          {
            jsonPointer: "/video/url",
            fileName: "matte.mp4",
            expectedMime: "video/mp4",
          },
        ],
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "INVALID_FAL_MEDIA_URL" });
    expect(fetchImpl).not.toHaveBeenCalled();

    const safeResult = {
      video: { url: "https://v3b.fal.media/files/b/0aa2/matte.mp4" },
    };
    const mimeController: MotionFalReadPort = {
      readAttempt: vi.fn(async () => submittedAttempt()),
      readStatus: vi.fn(async () => ({ status: "COMPLETED" })),
      readResult: vi.fn(async () => safeResult),
    };
    const mimeOutput = join(root, "mime-capture");
    await expect(
      captureMotionFalReadEvidence({
        controller: mimeController,
        attemptId: ATTEMPT_ID,
        credentials: CREDENTIALS,
        allowedEndpoints: [ENDPOINT],
        outputDirectory: mimeOutput,
        downloads: [
          {
            jsonPointer: "/video/url",
            fileName: "matte.mp4",
            expectedMime: "video/mp4",
          },
        ],
        fetchImpl: async () =>
          new Response("not a video", {
            headers: { "content-type": "text/plain" },
          }),
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_MIME_MISMATCH" });
    await expect(readFile(join(mimeOutput, "matte.mp4"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(mimeOutput, "capture-receipt.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed if a remote JSON payload contains the credential string", async () => {
    const outputDirectory = join(root, "secret-echo");
    const controller: MotionFalReadPort = {
      readAttempt: vi.fn(async () => submittedAttempt()),
      readStatus: vi.fn(async () => ({ status: "COMPLETED" })),
      readResult: vi.fn(async () => ({ diagnostic: CREDENTIALS })),
    };

    await expect(
      captureMotionFalReadEvidence({
        controller,
        attemptId: ATTEMPT_ID,
        credentials: CREDENTIALS,
        allowedEndpoints: [ENDPOINT],
        outputDirectory,
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_ECHO_REFUSED" });
    await expect(lstat(outputDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects non-submitted and non-allowlisted attempts before any queue read", async () => {
    const readStatus = vi.fn();
    const readResult = vi.fn();
    const rejectedController = {
      readAttempt: vi.fn(async () => ({
        ...submittedAttempt(),
        state: "rejected" as const,
        httpStatus: 422,
      })),
      readStatus,
      readResult,
    } as unknown as MotionFalReadPort;

    await expect(
      captureMotionFalReadEvidence({
        controller: rejectedController,
        attemptId: ATTEMPT_ID,
        credentials: CREDENTIALS,
        allowedEndpoints: [ENDPOINT],
        outputDirectory: join(root, "rejected-attempt"),
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_NOT_SUBMITTED" });
    expect(readStatus).not.toHaveBeenCalled();
    expect(readResult).not.toHaveBeenCalled();

    const submittedController: MotionFalReadPort = {
      readAttempt: vi.fn(async () => submittedAttempt()),
      readStatus,
      readResult,
    };
    await expect(
      captureMotionFalReadEvidence({
        controller: submittedController,
        attemptId: ATTEMPT_ID,
        credentials: CREDENTIALS,
        allowedEndpoints: ["fal-ai/wan-vace-14b"],
        outputDirectory: join(root, "wrong-endpoint"),
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_ENDPOINT_NOT_ALLOWED" });
    expect(readStatus).not.toHaveBeenCalled();
    expect(readResult).not.toHaveBeenCalled();
  });
});
