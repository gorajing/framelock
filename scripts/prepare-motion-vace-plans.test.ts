import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(process.cwd(), "scripts/prepare-motion-vace-plans.mjs");
const MASK_URL =
  "https://v3b.fal.media/files/b/0aa2d000/framelock-mask-transport.mp4";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonical(value)), "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("offline Motion v1 VACE plan preparation CLI", () => {
  let root: string;
  let transportPath: string;
  let transportReceiptPath: string;
  let uploadReceiptPath: string;
  let pricingPath: string;
  let outputDirectory: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-vace-plans-"));
    const evidenceDirectory = join(root, "evidence");
    await mkdir(evidenceDirectory, { recursive: true });
    transportPath = join(evidenceDirectory, "mask-transport.mp4");
    transportReceiptPath = join(
      evidenceDirectory,
      "mask-transport-receipt.json",
    );
    uploadReceiptPath = join(evidenceDirectory, "mask-upload-receipt.json");
    pricingPath = join(evidenceDirectory, "pricing.json");
    outputDirectory = join(root, "plans", "wan-vace-candidates-v1");

    const transportBytes = Buffer.from("test-only-mask-transport");
    const transportSha256 = sha256(transportBytes);
    await writeFile(transportPath, transportBytes);

    const repeatedDigest = "a".repeat(64);
    const transportReceipt: Record<string, unknown> = {
      kind: "framelock_vace_mask_transport_evidence",
      roundtrip: {
        authoritative_ordered_pixels_sha256: repeatedDigest,
        decoded_ordered_pixels_sha256: repeatedDigest,
        decoder: "framelock_media.ffmpeg_pipeline.decode_mask_transport",
        exact_equality: true,
        frame_count: 121,
        validator:
          "framelock_media.ffmpeg_pipeline.validate_mask_transport_round_trip",
      },
      schema_version: 1,
      temporal_matte: {
        authoritative_ordered_pixels_sha256: repeatedDigest,
        edit_mask_ordered_digest_sha256: "b".repeat(64),
        manifest_digest_sha256: "c".repeat(64),
        manifest_file_sha256: "d".repeat(64),
        manifest_path: join(evidenceDirectory, "temporal-matte-manifest.json"),
      },
      transport: {
        bytes: transportBytes.byteLength,
        media_facts: { frame_count: 121, frame_rate: { numerator: 24, denominator: 1 } },
        path: transportPath,
        sha256: transportSha256,
      },
    };
    transportReceipt.digest_sha256 = sha256(canonicalBytes(transportReceipt));
    await writeFile(
      transportReceiptPath,
      `${JSON.stringify(transportReceipt, null, 2)}\n`,
    );

    await writeFile(
      uploadReceiptPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: "motion-v1-fal-upload",
          uploadedAt: new Date().toISOString(),
          localFile: {
            path: transportPath,
            name: "mask-transport.mp4",
            mime: "video/mp4",
            bytes: transportBytes.byteLength,
            sha256: transportSha256,
          },
          falUrl: MASK_URL,
        },
        null,
        2,
      )}\n`,
    );
    await writePricing();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writePricing(input?: { stale?: boolean; cost?: string }) {
    const now = Date.now();
    const stale = input?.stale ?? false;
    await writeFile(
      pricingPath,
      `${JSON.stringify(
        {
          unitPriceUsd: "0.08",
          billingUnit: "video-second at 16 frames per second",
          estimatedUnits: "7.5625",
          estimatedCostUsd: input?.cost ?? "0.605",
          pricingSource: "test fixture for the fal public 720p price",
          priceObservedAt: new Date(now - 60_000).toISOString(),
          priceValidUntil: new Date(
            stale ? now - 1_000 : now + 3_600_000,
          ).toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }

  function run(extraArguments: string[] = []) {
    return spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        SCRIPT,
        "--mask-upload-receipt",
        relative(root, uploadReceiptPath),
        "--mask-transport-receipt",
        relative(root, transportReceiptPath),
        "--pricing",
        relative(root, pricingPath),
        "--output-dir",
        relative(root, outputDirectory),
        ...extraArguments,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );
  }

  it("writes exactly three exclusive ready plans bound to both mask receipts", async () => {
    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(await readdir(outputDirectory)).toEqual([
      "motion-wan-vace-candidate-01.json",
      "motion-wan-vace-candidate-02.json",
      "motion-wan-vace-candidate-03.json",
    ]);
    const plans = await Promise.all(
      [1, 2, 3].map(async (index) => {
        const path = join(
          outputDirectory,
          `motion-wan-vace-candidate-0${index}.json`,
        );
        expect((await stat(path)).mode & 0o777).toBe(0o400);
        return JSON.parse(await readFile(path, "utf8"));
      }),
    );

    expect(plans.map((plan) => plan.falInput.seed)).toEqual([
      480_197, 731_029, 921_847,
    ]);
    for (const plan of plans) {
      expect(plan).toMatchObject({
        schemaVersion: 1,
        state: "approved_for_submission",
        endpoint: "fal-ai/wan-vace-14b",
        falInput: { mask_video_url: MASK_URL, task: "inpainting" },
        pricing: { estimatedCostUsd: "0.605" },
        maskTransportEvidence: {
          transportPathJsonPointer: "/transport/path",
          transportSha256JsonPointer: "/transport/sha256",
          transportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          falUrl: MASK_URL,
        },
        candidateEvidence: {
          planVersion: "motion-v1-wan-vace.v1",
          seedOnlySetDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        digestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    }
  });

  it("fails closed when the upload receipt does not bind the sealed transport", async () => {
    const receipt = JSON.parse(await readFile(uploadReceiptPath, "utf8"));
    receipt.localFile.sha256 = "0".repeat(64);
    await writeFile(uploadReceiptPath, `${JSON.stringify(receipt)}\n`);

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MASK_EVIDENCE_MISMATCH");
    await expect(stat(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects stale or mathematically mismatched pricing before writing", async () => {
    await writePricing({ stale: true });
    let result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PRICING_NOT_CURRENT");

    await writePricing({ cost: "0.604" });
    result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PRICING_MISMATCH");
    await expect(stat(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites a pre-existing output directory", async () => {
    await mkdir(outputDirectory, { recursive: true });
    const sentinel = join(outputDirectory, "belongs-to-user.txt");
    await writeFile(sentinel, "preserve me");

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OUTPUT_EXISTS");
    expect(await readFile(sentinel, "utf8")).toBe("preserve me");
  });
});
