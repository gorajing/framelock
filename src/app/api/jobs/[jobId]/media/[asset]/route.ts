import { join } from "node:path";

import { LocalJobStore } from "../../../../../../lib/jobs/local-job-store";
import { createRealJobMediaHandler } from "../../../../../../lib/jobs/real-job-media-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const artifactsRoot = join(process.cwd(), "artifacts");
const jobsRoot = join(artifactsRoot, "jobs");
const runsRoot = join(artifactsRoot, "runs");
const jobs = new LocalJobStore(jobsRoot);

export const GET = createRealJobMediaHandler({ jobs, jobsRoot, runsRoot });
