import { NextResponse } from "next/server";

import {
  parseDemoByteRange,
  resolveDemoMediaAsset,
  type DemoMediaId,
} from "@/lib/demo/demo-media";
import { readVerifiedDemoMediaAsset } from "@/lib/demo/demo-summary.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicHeaders(contentType: string, contentLength: number) {
  return {
    "Accept-Ranges": contentType === "video/mp4" ? "bytes" : "none",
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Length": String(contentLength),
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  };
}

function unavailable(statusCode = 404) {
  return NextResponse.json(
    { error: "DEMO_MEDIA_NOT_AVAILABLE" },
    {
      status: statusCode,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    },
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ asset: string }> },
) {
  const { asset: requestedAsset } = await context.params;
  const asset = resolveDemoMediaAsset(requestedAsset);
  if (!asset || [...new URL(request.url).searchParams].length > 0) {
    return unavailable();
  }

  let verifiedAsset: Awaited<ReturnType<typeof readVerifiedDemoMediaAsset>>;
  try {
    verifiedAsset = await readVerifiedDemoMediaAsset(
      requestedAsset as DemoMediaId,
    );
  } catch {
    return unavailable();
  }
  if (!verifiedAsset) return unavailable();
  const bytes = verifiedAsset.bytes;
  const fileSize = bytes.byteLength;

  const requestedRange = request.headers.get("range");
  if (requestedRange && asset.contentType === "video/mp4") {
    const range = parseDemoByteRange(requestedRange, fileSize);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "Content-Range": `bytes */${fileSize}`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const body = bytes.subarray(range.start, range.end + 1);
    return new Response(new Uint8Array(body), {
      status: 206,
      headers: {
        ...publicHeaders(asset.contentType, body.byteLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${fileSize}`,
      },
    });
  }

  return new Response(new Uint8Array(bytes), {
    headers: publicHeaders(asset.contentType, bytes.byteLength),
  });
}
