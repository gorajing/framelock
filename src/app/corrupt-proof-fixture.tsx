import Link from "next/link";

import type { ValidatedCorruptionEvidence } from "../lib/jobs/corruption-evidence";

type ProofSearchParams = Readonly<
  Record<string, string | string[] | undefined>
>;

export function isCorruptProofMode(searchParams: ProofSearchParams): boolean {
  return searchParams.proof === "corrupt";
}

export function CorruptProofFixture({
  evidence,
}: {
  evidence: ValidatedCorruptionEvidence;
}) {
  const workspaceHref = `/?job=${encodeURIComponent(evidence.jobId)}`;
  return (
    <main className="corrupt-fixture">
      <nav className="topbar topbar--failed" aria-label="FrameLock test result">
        <Link href={workspaceHref} className="wordmark">
          FrameLock<span aria-hidden="true">.</span>
        </Link>
        <span className="run-id">Evidence test / {evidence.jobId}</span>
        <span className="status-chip status-chip--failed">
          <i aria-hidden="true" /> Verification failed
        </span>
      </nav>

      <section className="corrupt-fixture__body">
        <div>
          <p className="corrupt-fixture__kicker">
            Persisted verifier test / canonical artifacts unchanged
          </p>
          <h1>Verification failed.</h1>
          <p className="corrupt-fixture__lede">
            This result comes from the independent verifier reopening a copied
            frame with one protected RGB channel changed by exactly one. The
            canonical evidence was never edited or replaced.
          </p>
          <Link className="corrupt-fixture__return" href={workspaceHref}>
            Return to verified job <span aria-hidden="true">→</span>
          </Link>
        </div>

        <aside className="failure-verdict" aria-label="Failed verification verdict">
          <span>Independent audit result</span>
          <strong>FAIL</strong>
          <p>{evidence.changedCoreChannelSamples} changed protected channel sample</p>
          <dl>
            <div>
              <dt>Expected</dt>
              <dd>0</dd>
            </div>
            <div>
              <dt>Observed</dt>
              <dd>{evidence.changedCoreChannelSamples}</dd>
            </div>
            <div>
              <dt>Promotion</dt>
              <dd>Blocked</dd>
            </div>
          </dl>
          <small className="failure-verdict__hash">
            Audit SHA-256 {evidence.auditSha256}
          </small>
        </aside>
      </section>

      <section className="corrupt-fixture__gate" aria-label="Failure behavior">
        <article>
          <span>01 / Detect</span>
          <h2>Exact equality is false.</h2>
          <p>
            The persisted audit observed {evidence.changedCorePixels} changed
            core pixel and a maximum channel delta of {evidence.worstMaximumAbsoluteChannelDelta}.
          </p>
        </article>
        <article>
          <span>02 / Stop</span>
          <h2>No result is promoted.</h2>
          <p>The failed state does not render videos, canonical frames or a green badge.</p>
        </article>
        <article>
          <span>03 / Preserve</span>
          <h2>Evidence stays untouched.</h2>
          <p>
            {evidence.runBound
              ? "The run manifest binds this negative audit, manifest and summary by SHA-256."
              : "This legacy golden fixture is structurally bound to its verified proof manifest."}
          </p>
        </article>
      </section>
    </main>
  );
}
