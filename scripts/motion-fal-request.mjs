#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { createMotionPaidAttemptController } from "../src/lib/fal/motion-paid-attempt.ts";

const CONFIRMATION = "--confirm-paid-motion-v1";

function usage() {
  return [
    "Usage:",
    "  node --experimental-transform-types scripts/motion-fal-request.mjs \\",
    "    --allow-endpoint <fal-endpoint> [--allow-endpoint <fal-endpoint>] \\",
    `    ${CONFIRMATION} <request.json>`,
    "",
    "request.json must contain: endpoint, falInput and pricing.",
    "The command reads FAL_KEY from the environment or local .env file.",
  ].join("\n");
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true, allowedEndpoints: [] };
  }
  const allowedEndpoints = [];
  let confirmed = false;
  let requestPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-endpoint") {
      const endpoint = argv[index + 1];
      if (!endpoint || endpoint.startsWith("--")) {
        throw new Error("--allow-endpoint requires a value");
      }
      allowedEndpoints.push(endpoint);
      index += 1;
    } else if (argument === CONFIRMATION) {
      confirmed = true;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    } else if (requestPath) {
      throw new Error("Exactly one request JSON path is required");
    } else {
      requestPath = argument;
    }
  }
  if (!confirmed) {
    throw new Error(`Explicit ${CONFIRMATION} authorization is required`);
  }
  if (allowedEndpoints.length === 0) {
    throw new Error("At least one --allow-endpoint value is required");
  }
  if (!requestPath) {
    throw new Error("A request JSON path is required");
  }
  return { help: false, allowedEndpoints, requestPath };
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.help) {
    console.log(usage());
    return;
  }
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  const credentials = process.env.FAL_KEY;
  if (!credentials?.trim()) {
    throw new Error("FAL_KEY is required in the environment or local .env");
  }
  const rawRequest = JSON.parse(await readFile(arguments_.requestPath, "utf8"));
  if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) {
    throw new Error("Request JSON must be an object");
  }
  const motion = createMotionPaidAttemptController({
    allowedEndpoints: arguments_.allowedEndpoints,
  });
  const attempt = await motion.submit({
    endpoint: rawRequest.endpoint,
    falInput: rawRequest.falInput,
    pricing: rawRequest.pricing,
    credentials,
  });
  const ledger = await motion.readLedger();
  console.log(
    JSON.stringify(
      {
        attempt,
        budget: {
          ceilingUsd: ledger.ceilingUsd,
          reservedCostUsd: ledger.reservedCostUsd,
          remainingCostUsd: ledger.remainingCostUsd,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "MOTION_REQUEST_FAILED";
  const message = error instanceof Error ? error.message : "Motion request failed";
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
});
