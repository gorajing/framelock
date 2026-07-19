import "server-only";

import { join } from "node:path";

import { frameLockCli } from "../media/framelock-cli.server";
import { ActiveJobRegistry } from "../jobs/active-job-registry";
import { LocalJobStore } from "../jobs/local-job-store";
import {
  createRealJobReviewService,
  type RealJobApproval,
} from "./real-job-review";

const artifactsRoot = join(process.cwd(), "artifacts");
const jobsRoot = join(artifactsRoot, "jobs");
const runsRoot = join(artifactsRoot, "runs");
const jobs = new LocalJobStore(jobsRoot);
const activeJobs = new ActiveJobRegistry(
  jobsRoot,
  async (jobId) => (await jobs.readJob(jobId)).state,
);
const service = createRealJobReviewService({
  jobs,
  activeJobs,
  cli: frameLockCli,
  jobsRoot,
  runsRoot,
});

export function reviewRealJob(jobId: string) {
  return service.review(jobId);
}

export function approveRealJob(jobId: string, approval: RealJobApproval) {
  return service.approve(jobId, approval);
}

export function resumeRealJobVerification(jobId: string) {
  return service.resumeVerification(jobId);
}

export async function readVerifiedRealJobProof(jobId: string) {
  return (await service.readVerified(jobId)).proof;
}
