import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CorruptProofFixture, isCorruptProofMode } from "./corrupt-proof-fixture";

describe("deliberate corruption fixture", () => {
  const evidence = {
    jobId: "ai_source_01",
    frameIndex: 60,
    channel: 1,
    changedCorePixels: 1,
    changedCoreChannelSamples: 1,
    worstMaximumAbsoluteChannelDelta: 1,
    coreHashMatchCount: 120,
    auditSha256: "aa".repeat(32),
    manifestSha256: "bb".repeat(32),
    summarySha256: "cc".repeat(32),
    runBound: true,
    artifactBound: true,
    summarySchemaVersion: 2,
  } as const;

  it("is enabled only by the exact local proof query", () => {
    expect(isCorruptProofMode({ proof: "corrupt" })).toBe(true);
    expect(isCorruptProofMode({ proof: "verified" })).toBe(false);
    expect(isCorruptProofMode({ proof: ["corrupt"] })).toBe(false);
    expect(isCorruptProofMode({})).toBe(false);
  });

  it("renders a failed state without the verified badge or verified claim", () => {
    const markup = renderToStaticMarkup(
      <CorruptProofFixture evidence={evidence} />,
    );

    expect(markup).toContain("Verification failed");
    expect(markup).toContain("Persisted verifier test");
    expect(markup).toContain("1 changed protected channel sample");
    expect(markup).toContain(evidence.auditSha256);
    expect(markup).toContain('class="failure-verdict__hash"');
    expect(markup).toContain("run manifest binds this negative audit");
    expect(markup.match(/\?job=ai_source_01/g)).toHaveLength(2);
    expect(markup).toContain("Return to verified job");
    expect(markup).not.toContain("presentation-only");
    expect(markup).not.toContain("simulates");
    expect(markup).not.toContain("Canonical verified");
    expect(markup).not.toContain(
      "Protected core verified — canonical pre-encode frame sequence.",
    );
  });
});
