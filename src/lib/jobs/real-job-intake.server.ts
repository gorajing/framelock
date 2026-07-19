import "server-only";

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { frameLockCli } from "../media/framelock-cli.server";
import { ActiveJobRegistry } from "./active-job-registry";
import { createRealJobService } from "./create-real-job";
import { LocalJobStore } from "./local-job-store";
import { inspectPaidAttemptBudget } from "./paid-attempt-budget";
import { createRealJobArtifactsPort } from "./real-job-artifacts";
import type { RealJobIntake } from "./real-job-intake";
import { buildRealJobView } from "./real-job-view";
import {
  createAiJobId,
  parseRealJobWorkspaceView,
  resumableRealJobWorkspaceView,
} from "./real-job-workspace-view";

const artifactsRoot = join(process.cwd(), "artifacts");
const jobsRoot = join(artifactsRoot, "jobs");
const jobs = new LocalJobStore(jobsRoot);
const activeJobs = new ActiveJobRegistry(
  jobsRoot,
  async (jobId) => (await jobs.readJob(jobId)).state,
);
const service = createRealJobService({
  createId: () => createAiJobId(randomUUID()),
  artifacts: createRealJobArtifactsPort({
    stagingRoot: join(artifactsRoot, "intake"),
    runsRoot: join(artifactsRoot, "runs"),
    cli: frameLockCli,
  }),
  jobs,
  activeJobs,
});

export async function createRealJob(input: RealJobIntake) {
  return service.create(input);
}

export async function readRealJob(jobId: string) {
  return buildRealJobView(await jobs.readJob(jobId));
}

export async function readWorkspaceRealJob(jobId: string) {
  return parseRealJobWorkspaceView(await readRealJob(jobId));
}

export async function readActiveRealJob() {
  const active = await activeJobs.read();
  if (!active) return null;
  return resumableRealJobWorkspaceView(
    buildRealJobView(await jobs.readJob(active.jobId)),
  );
}

export async function cancelRealJob(jobId: string) {
  return buildRealJobView(await jobs.cancelValidatedJob(jobId));
}

export async function readPaidAttemptBudget() {
  return inspectPaidAttemptBudget(jobs);
}
