import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "app/page": ["./demo-evidence/static/root/**/*"],
    "/api/demo/media/\\[asset\\]": [
      "./demo-evidence/static/root/**/*",
    ],
    "/motion-demo": [
      "./demo-evidence/motion/root/**/*",
      "./public/demo/motion/source.mp4",
      "./public/demo/motion/generated-world.mp4",
      "./public/demo/motion/mask.mp4",
      "./public/demo/motion/verified.mp4",
    ],
  },
  outputFileTracingExcludes: {
    // Next matches this key against every server route (`contains: true`).
    // That is intentional for exclusions: ignored mutable workspace state is
    // never part of a deployable route, while the immutable nested mirrors
    // under demo-evidence remain eligible for tracing.
    "/": [
      "./artifacts/**/*",
      "./runs/**/*",
      "./tmp/**/*",
      "./.env",
      "./.env.*",
      "./src/**/__pycache__/**/*",
      "./scripts/**/__pycache__/**/*",
      "./src/**/*.test.*",
      "./scripts/**/*.test.*",
      "./tests/**/*",
    ],
  },
  experimental: {
    // The intake route rejects a declared body above 62 MiB and caps accepted
    // file fields at 60.25 MiB total. The proxy needs a small envelope above
    // those limits so it can inspect chunked requests without truncating an
    // otherwise valid source upload.
    proxyClientMaxBodySize: "64mb",
  },
};

export default nextConfig;
