import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MOTION_DRIFT_TOLERANCE_SECONDS,
  MOTION_FRAME_RATE,
  MotionDemo,
  formatMotionTime,
  motionFrameAtTime,
  playMotionPlayers,
  seekMotionPlayers,
  sharedMotionDuration,
  synchronizeMotionDrift,
  type MotionDemoEvidence,
} from "./motion-demo";

const admittedEvidence = {
  admission: "admitted",
  audit: {
    claimScope: "canonical_pre_encode_frames",
    framesAudited: 121,
    framesExpected: 121,
    changedProtectedPixels: 0,
    temporalMasksBound: 121,
  },
  negativeControl: {
    status: "bound",
    frameIndex: 60,
    changedProtectedChannelSamples: 1,
    verifierRejected: true,
  },
} satisfies MotionDemoEvidence;

class FakeMotionMedia {
  private time = 0;
  pauseCalls = 0;
  playCalls = 0;
  seekAssignments = 0;
  seeking = false;

  constructor(
    readonly duration: number,
    private readonly rejectPlay = false,
  ) {}

  get currentTime() {
    return this.time;
  }

  set currentTime(value: number) {
    this.seekAssignments += 1;
    this.time = value;
  }

  pause() {
    this.pauseCalls += 1;
  }

  async play() {
    this.playCalls += 1;
    if (this.rejectPlay) throw new Error("play blocked");
  }
}

describe("FrameLock Motion presentation shell", () => {
  const boundMedia = {
    source: "/fixtures/source.mp4",
    raw: "/fixtures/raw.mp4",
    mask: "/fixtures/mask.mp4",
    verified: "/fixtures/verified.mp4",
  } as const;

  it("renders only pending proof language when no audit is admitted", () => {
    const markup = renderToStaticMarkup(<MotionDemo media={boundMedia} />);

    expect(markup.match(/data-motion-media=/g)).toHaveLength(4);
    expect(markup.match(/preload="auto"/g)).toHaveLength(4);
    expect(markup).toContain("Original performance");
    expect(markup).toContain("Generated world");
    expect(markup).toContain("Moving protection");
    expect(markup).toContain("Canonical result preview");
    expect(markup).toContain("PROOF PENDING");
    expect(markup).toContain('data-proof-admission="pending"');
    expect(markup).toContain('data-audit-result="pending"');
    expect(markup).toContain('data-corruption-challenge="unavailable"');
    expect(markup).toContain("Evidence required");
    expect(markup).not.toContain("SEALED");
    expect(markup).not.toContain("VERIFIED");
    expect(markup).not.toContain("121 / 121");
    expect(markup).not.toContain("changed protected pixels");
    expect(markup).not.toContain("FAIL / CAUGHT");
    expect(markup).not.toContain("AI reshot the world");
  });

  it("renders admitted audit claims and a bound negative control only from typed evidence", () => {
    const markup = renderToStaticMarkup(
      <MotionDemo evidence={admittedEvidence} media={boundMedia} />,
    );

    expect(markup).toContain("Audit admitted");
    expect(markup).toContain("SEALED");
    expect(markup).toContain("121 / 121");
    expect(markup).toContain("changed protected pixels");
    expect(markup).toContain("VERIFIED");
    expect(markup).toContain('data-corruption-challenge="bound"');
    expect(markup).toContain("Persisted negative control bound");
    expect(markup).toContain("Reveal caught corruption");
    expect(markup).toContain("AI reshot the world");
    expect(markup).not.toContain("PROOF PENDING");
  });

  it("keeps corruption presentation unavailable when an audit has no bound negative control", () => {
    const auditOnlyEvidence = {
      admission: "admitted",
      audit: admittedEvidence.audit,
    } satisfies MotionDemoEvidence;
    const markup = renderToStaticMarkup(
      <MotionDemo evidence={auditOnlyEvidence} media={boundMedia} />,
    );

    expect(markup).toContain("VERIFIED");
    expect(markup).toContain('data-corruption-challenge="unavailable"');
    expect(markup).toContain("Evidence required");
    expect(markup).not.toContain("Reveal caught corruption");
    expect(markup).not.toContain("FAIL / CAUGHT");
  });

  it("keeps absent media bindings as intentional asset slots", () => {
    const markup = renderToStaticMarkup(
      <MotionDemo
        media={{ source: null, raw: null, mask: null, verified: null }}
      />,
    );

    expect(markup.match(/data-motion-media-status="missing"/g)).toHaveLength(4);
    expect(markup.match(/Asset pending/g)).toHaveLength(4);
    expect(markup).toContain("0 / 4 media assets ready");
    expect(markup).toContain("Waiting for all four motion assets");
  });

  it("synchronizes all four views to their shortest finite duration", () => {
    const players = [
      new FakeMotionMedia(5.05),
      new FakeMotionMedia(5.04),
      new FakeMotionMedia(5.1),
      new FakeMotionMedia(5),
    ];

    expect(sharedMotionDuration(players)).toBe(5);
    expect(seekMotionPlayers(players, 8)).toBe(5);
    expect(players.map((player) => player.currentTime)).toEqual([5, 5, 5, 5]);
    players.forEach((player) => {
      player.seekAssignments = 0;
    });
    expect(seekMotionPlayers(players, 5)).toBe(5);
    expect(players.map((player) => player.seekAssignments)).toEqual([
      0, 0, 0, 0,
    ]);
    expect(sharedMotionDuration(players.slice(0, 3))).toBe(0);
  });

  it("corrects meaningful temporal drift without jittering close followers", () => {
    const players = Array.from({ length: 4 }, () => new FakeMotionMedia(5));
    players[0].currentTime = 2;
    players[1].currentTime = 2 - MOTION_DRIFT_TOLERANCE_SECONDS / 2;
    players[2].currentTime = 1.5;
    players[3].currentTime = 2.3;

    expect(synchronizeMotionDrift(players)).toBe(2);
    expect(players[1].currentTime).not.toBe(2);
    expect(players[2].currentTime).toBe(2);
    expect(players[3].currentTime).toBe(2);
    expect(MOTION_DRIFT_TOLERANCE_SECONDS).toBeLessThanOrEqual(
      1 / MOTION_FRAME_RATE,
    );
  });

  it("does not restart a follower seek while its prior seek is unresolved", () => {
    const players = Array.from({ length: 4 }, () => new FakeMotionMedia(5));
    players[0].currentTime = 2;
    players[1].currentTime = 1;
    players[1].seeking = true;
    players[1].seekAssignments = 0;

    expect(synchronizeMotionDrift(players)).toBe(2);
    expect(players[1].currentTime).toBe(1);
    expect(players[1].seekAssignments).toBe(0);
  });

  it("fails closed and pauses every view when one play request rejects", async () => {
    const players = [
      new FakeMotionMedia(5),
      new FakeMotionMedia(5),
      new FakeMotionMedia(5, true),
      new FakeMotionMedia(5),
    ];

    await expect(playMotionPlayers(players, 1.25)).resolves.toBe(false);
    expect(players.map((player) => player.currentTime)).toEqual([
      1.25,
      1.25,
      1.25,
      1.25,
    ]);
    expect(players.map((player) => player.pauseCalls)).toEqual([1, 1, 1, 1]);
  });

  it("maps transport time into the bounded 121-frame contract", () => {
    expect(motionFrameAtTime(0)).toBe(0);
    expect(motionFrameAtTime(2.5)).toBe(60);
    expect(motionFrameAtTime(99)).toBe(120);
    expect(formatMotionTime(5.041)).toBe("05.041");
  });
});
