import {
  CorruptProofFixture,
  isCorruptProofMode,
} from "./corrupt-proof-fixture";
import { DemoComparison } from "./demo-comparison";
import { RealJobWorkspace } from "./real-job-workspace";
import { readDemoSummary } from "@/lib/demo/demo-summary.server";
import {
  DEFAULT_CORRUPTION_JOB_ID,
  readCorruptionEvidence,
} from "@/lib/jobs/corruption-evidence.server";
import {
  readActiveRealJob,
  readWorkspaceRealJob,
} from "@/lib/jobs/real-job-intake.server";
import { readVerifiedRealJobProof } from "@/lib/review/real-job-review.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function WorkspacePage({
  initialJob,
  initialProof,
  summary,
}: {
  initialJob?: Awaited<ReturnType<typeof readWorkspaceRealJob>> | null;
  initialProof?: Awaited<ReturnType<typeof readVerifiedRealJobProof>>;
  summary?: Awaited<ReturnType<typeof readDemoSummary>>;
}) {
  return (
    <main className="framelock-app">
      <RealJobWorkspace
        initialJob={initialJob ?? undefined}
        initialProof={initialProof}
      />
      {summary ? <DemoComparison summary={summary} /> : null}
    </main>
  );
}

function ProofReadFailure() {
  return (
    <main className="proof-error">
      <p>FrameLock / evidence read boundary</p>
      <h1>Proof unavailable.</h1>
      <p>
        Persisted evidence could not be reopened safely. No intake, result or
        verification claim is shown in its place.
      </p>
    </main>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  if (isCorruptProofMode(parameters)) {
    const requestedJob = parameters.job;
    const jobId =
      typeof requestedJob === "string"
        ? requestedJob
        : DEFAULT_CORRUPTION_JOB_ID;
    let evidence: Awaited<ReturnType<typeof readCorruptionEvidence>>;
    try {
      evidence = await readCorruptionEvidence(jobId);
    } catch {
      return <ProofReadFailure />;
    }
    return <CorruptProofFixture evidence={evidence} />;
  }

  const requestedJob = parameters.job;
  let initialJob: Awaited<ReturnType<typeof readWorkspaceRealJob>> | null;
  let initialProof:
    | Awaited<ReturnType<typeof readVerifiedRealJobProof>>
    | undefined;
  try {
    initialJob =
      typeof requestedJob === "string"
        ? await readWorkspaceRealJob(requestedJob)
        : await readActiveRealJob();
    if (initialJob?.state === "verified") {
      initialProof = await readVerifiedRealJobProof(initialJob.id);
    }
  } catch {
    return <ProofReadFailure />;
  }
  const summary = await readDemoSummary().catch(() => null);
  return (
    <WorkspacePage
      initialJob={initialJob}
      initialProof={initialProof}
      summary={summary ?? undefined}
    />
  );
}
