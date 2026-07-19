#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

import { createMotionPaidAttemptController } from "../src/lib/fal/motion-paid-attempt.ts";
import {
  captureMotionFalReadEvidence,
  uploadMotionCanonicalMp4,
} from "../src/lib/fal/motion-fal-io.ts";

function usage() {
  return [
    "Usage:",
    "  node --env-file=.env.local --experimental-transform-types scripts/motion-fal-io.mjs upload \\",
    "    --source <canonical.mp4> --receipt <upload-receipt.json>",
    "",
    "  node --env-file=.env.local --experimental-transform-types scripts/motion-fal-io.mjs capture \\",
    "    --attempt-id <motion-attempt-id> --output-dir <new-directory> \\",
    "    --allow-endpoint <fal-endpoint> [--allow-endpoint <fal-endpoint>] \\",
    "    [--download-plan <downloads.json>] [--ledger <spend-ledger.json>]",
    "",
    "downloads.json is an array of:",
    "  { jsonPointer, fileName, expectedMime, maxBytes? }",
    "",
    "Both commands require FAL_KEY in the environment. Upload calls fal storage only.",
    "Capture calls submitted-attempt GET reads only and never submits inference.",
  ].join("\n");
}

function takeValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { command: "help" };
  }
  const [command, ...rest] = argv;
  if (command !== "upload" && command !== "capture") {
    throw new Error("The first argument must be upload or capture");
  }
  const values = new Map();
  const allowedEndpoints = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }
    const value = takeValue(rest, index, argument);
    if (argument === "--allow-endpoint") {
      allowedEndpoints.push(value);
    } else if (
      argument === "--source" ||
      argument === "--receipt" ||
      argument === "--attempt-id" ||
      argument === "--output-dir" ||
      argument === "--download-plan" ||
      argument === "--ledger"
    ) {
      if (values.has(argument)) {
        throw new Error(`${argument} may only be provided once`);
      }
      values.set(argument, value);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
    index += 1;
  }

  if (command === "upload") {
    const sourcePath = values.get("--source");
    const receiptPath = values.get("--receipt");
    if (!sourcePath || !receiptPath) {
      throw new Error("upload requires --source and --receipt");
    }
    if (allowedEndpoints.length > 0 || values.size !== 2) {
      throw new Error("upload received capture-only arguments");
    }
    return { command, sourcePath, receiptPath };
  }

  const attemptId = values.get("--attempt-id");
  const outputDirectory = values.get("--output-dir");
  if (!attemptId || !outputDirectory || allowedEndpoints.length === 0) {
    throw new Error(
      "capture requires --attempt-id, --output-dir and --allow-endpoint",
    );
  }
  if (values.has("--source") || values.has("--receipt")) {
    throw new Error("capture received upload-only arguments");
  }
  return {
    command,
    attemptId,
    outputDirectory,
    allowedEndpoints,
    downloadPlanPath: values.get("--download-plan"),
    ledgerPath: values.get("--ledger"),
  };
}

function credentialsFromEnvironment() {
  const credentials = process.env.FAL_KEY?.trim();
  if (!credentials) {
    throw new Error("FAL_KEY is required in the environment");
  }
  return credentials;
}

async function readDownloadPlan(path) {
  if (!path) {
    return [];
  }
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Download plan must be a JSON array");
  }
  return parsed;
}

async function runUpload(arguments_) {
  const credentials = credentialsFromEnvironment();
  const { fal } = await import("@fal-ai/client");
  fal.config({ credentials });
  const receipt = await uploadMotionCanonicalMp4({
    sourcePath: arguments_.sourcePath,
    receiptPath: arguments_.receiptPath,
    upload: (file) => fal.storage.upload(file),
  });
  console.log(JSON.stringify(receipt, null, 2));
}

async function runCapture(arguments_) {
  const credentials = credentialsFromEnvironment();
  const downloads = await readDownloadPlan(arguments_.downloadPlanPath);
  const controller = createMotionPaidAttemptController({
    allowedEndpoints: arguments_.allowedEndpoints,
    ...(arguments_.ledgerPath ? { ledgerPath: arguments_.ledgerPath } : {}),
  });
  const capture = await captureMotionFalReadEvidence({
    controller,
    attemptId: arguments_.attemptId,
    credentials,
    allowedEndpoints: arguments_.allowedEndpoints,
    outputDirectory: arguments_.outputDirectory,
    downloads,
  });
  console.log(JSON.stringify(capture, null, 2));
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.command === "help") {
    console.log(usage());
    return;
  }
  if (arguments_.command === "upload") {
    await runUpload(arguments_);
    return;
  }
  await runCapture(arguments_);
}

main().catch((error) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "MOTION_FAL_IO_FAILED";
  const message =
    error instanceof Error ? error.message : "Motion v1 fal I/O failed";
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
});
