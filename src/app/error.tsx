"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="proof-error">
      <p>FrameLock / verification gate</p>
      <h1>Proof unavailable.</h1>
      <p>
        A persisted artifact did not satisfy the verified demo contract. No
        result is shown when evidence cannot be reopened and validated.
      </p>
      <button onClick={reset} type="button">
        Reopen evidence
      </button>
    </main>
  );
}
