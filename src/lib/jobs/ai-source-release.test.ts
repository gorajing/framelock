import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertAiSourceProvenanceMediaBindings,
  parseAiSourceProvenanceBytes,
} from "./ai-source-provenance";

const ORIGINAL_SHA256 =
  "131b1ec6720808a1b4b67f5ab29c5c504d2d10c933485f13be9eabd986c68a11";
const RELEASE_ROOT = join(
  process.cwd(),
  "artifacts",
  "ai-source",
  "frm-01-v3",
  "sha256",
  ORIGINAL_SHA256,
);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("FRM-01 v3 application provenance", () => {
  it("parses the exact release manifest and binds its source and mask bytes", async () => {
    const [source, mask, provenanceBytes] = await Promise.all([
      readFile(join(RELEASE_ROOT, "source.mp4")),
      readFile(join(RELEASE_ROOT, "foreground.png")),
      readFile(join(RELEASE_ROOT, "source-provenance.json")),
    ]);
    const provenance = parseAiSourceProvenanceBytes(provenanceBytes);

    expect(
      assertAiSourceProvenanceMediaBindings(provenance, {
        canonicalSourceMp4Sha256: sha256(source),
        foregroundMaskSha256: sha256(mask),
      }),
    ).toBe(provenance);
    expect(provenance).toMatchObject({
      provenanceLabel: "ai_generated_source",
      originalImageSha256: ORIGINAL_SHA256,
      approval: {
        reviewer: "Codex FrameLock executor",
      },
    });
  });
});
