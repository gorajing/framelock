import { z } from "zod";

export const DEMO_MEDIA_IDS = [
  "source-video",
  "raw-video",
  "canonical-preview",
  "source-frame-0",
  "source-frame-60",
  "source-frame-120",
  "raw-frame-0",
  "raw-frame-60",
  "raw-frame-120",
  "composite-frame-0",
  "composite-frame-60",
  "composite-frame-120",
  "overlay-frame-0",
  "overlay-frame-60",
  "overlay-frame-120",
] as const;

export type DemoMediaId = (typeof DEMO_MEDIA_IDS)[number];

type DemoMediaAsset = Readonly<{
  contentType: "video/mp4" | "image/png";
  maxBytes: number;
  relativePath: string;
}>;

const demoMediaIdSchema = z.enum(DEMO_MEDIA_IDS);
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const SOURCE_ROOT =
  "artifacts/runs/synthetic-hero-offline-hardening-v2/inputs";
const SOURCE_FRAME_ROOT =
  "artifacts/runs/synthetic-hero-offline-hardening-v2/proof/source_frames";
const CANONICAL_ROOT =
  "artifacts/jobs/synthetic-hero-kling-o3-001/canonical";

const mediaCatalog: Readonly<Record<DemoMediaId, DemoMediaAsset>> = {
  "source-video": {
    contentType: "video/mp4",
    maxBytes: VIDEO_MAX_BYTES,
    relativePath: `${SOURCE_ROOT}/framelock-hero.mp4`,
  },
  "raw-video": {
    contentType: "video/mp4",
    maxBytes: VIDEO_MAX_BYTES,
    relativePath:
      "artifacts/jobs/synthetic-hero-kling-o3-001/model-output.mp4",
  },
  "canonical-preview": {
    contentType: "video/mp4",
    maxBytes: VIDEO_MAX_BYTES,
    relativePath: `${CANONICAL_ROOT}/preview.mp4`,
  },
  "source-frame-0": frameAsset(`${SOURCE_FRAME_ROOT}/frame_000000.png`),
  "source-frame-60": frameAsset(`${SOURCE_FRAME_ROOT}/frame_000060.png`),
  "source-frame-120": frameAsset(`${SOURCE_FRAME_ROOT}/frame_000120.png`),
  "raw-frame-0": frameAsset(`${CANONICAL_ROOT}/generated_frames/frame_000000.png`),
  "raw-frame-60": frameAsset(`${CANONICAL_ROOT}/generated_frames/frame_000060.png`),
  "raw-frame-120": frameAsset(`${CANONICAL_ROOT}/generated_frames/frame_000120.png`),
  "composite-frame-0": frameAsset(
    `${CANONICAL_ROOT}/composite_frames/composite_000000.png`,
  ),
  "composite-frame-60": frameAsset(
    `${CANONICAL_ROOT}/composite_frames/composite_000060.png`,
  ),
  "composite-frame-120": frameAsset(
    `${CANONICAL_ROOT}/composite_frames/composite_000120.png`,
  ),
  "overlay-frame-0": frameAsset(
    `${CANONICAL_ROOT}/geometry_overlays/overlay_000000.png`,
  ),
  "overlay-frame-60": frameAsset(
    `${CANONICAL_ROOT}/geometry_overlays/overlay_000060.png`,
  ),
  "overlay-frame-120": frameAsset(
    `${CANONICAL_ROOT}/geometry_overlays/overlay_000120.png`,
  ),
};

function frameAsset(relativePath: string): DemoMediaAsset {
  return {
    contentType: "image/png",
    maxBytes: IMAGE_MAX_BYTES,
    relativePath,
  };
}

export function resolveDemoMediaAsset(value: string): DemoMediaAsset | null {
  const parsed = demoMediaIdSchema.safeParse(value);
  return parsed.success ? mediaCatalog[parsed.data] : null;
}

export type DemoByteRange = Readonly<{ start: number; end: number }>;

export function parseDemoByteRange(
  header: string,
  totalBytes: number,
): DemoByteRange | null {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) {
    return null;
  }

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    return {
      start: Math.max(totalBytes - suffixLength, 0),
      end: totalBytes - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= totalBytes ||
    requestedEnd < start
  ) {
    return null;
  }

  return { start, end: Math.min(requestedEnd, totalBytes - 1) };
}
