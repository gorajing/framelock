import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PLAYBACK_DRIFT_TOLERANCE_SECONDS,
  VerifiedSynchronizedPlayback,
  formatPlaybackTime,
  playSynchronized,
  seekSynchronized,
  sharedPlaybackDuration,
  synchronizeDrift,
} from "./verified-synchronized-playback";

class FakeMedia {
  currentTime = 0;
  pauseCalls = 0;
  playCalls = 0;

  constructor(
    readonly duration: number,
    private readonly rejectPlay = false,
  ) {}

  pause() {
    this.pauseCalls += 1;
  }

  async play() {
    this.playCalls += 1;
    if (this.rejectPlay) throw new Error("play blocked");
  }
}

describe("verified synchronized playback", () => {
  it("renders three truthfully labeled views with one accessible transport", () => {
    const markup = renderToStaticMarkup(
      <VerifiedSynchronizedPlayback jobId="ai_source_01" />,
    );

    expect(markup.match(/data-playback-view=/g)).toHaveLength(3);
    expect(markup).toContain(
      "AI-generated source — provenance-bound baseline",
    );
    expect(markup).toContain("Kling environment edit — unverified");
    expect(markup).toContain(
      "H.264 delivery preview — derived from verified canonical frames; not lossless proof",
    );
    expect(markup).toContain("/api/jobs/ai_source_01/media/source");
    expect(markup).toContain("/api/jobs/ai_source_01/media/generated");
    expect(markup).toContain("/api/jobs/ai_source_01/media/preview");
    expect(markup).not.toContain("Original source");
    expect(markup).not.toContain("reference footage");
    expect(markup).toContain("Play synchronized comparison");
    expect(markup).toContain("Synchronized comparison timeline");
    expect(markup).toContain("Playback is muted for frame comparison.");
  });

  it("uses the shortest finite duration and seeks every view to one clamped time", () => {
    const players = [new FakeMedia(5.04), new FakeMedia(5), new FakeMedia(5.1)];

    expect(sharedPlaybackDuration(players)).toBe(5);
    expect(seekSynchronized(players, 8)).toBe(5);
    expect(players.map((player) => player.currentTime)).toEqual([5, 5, 5]);
  });

  it("corrects meaningful follower drift without jittering a close follower", () => {
    const master = new FakeMedia(5);
    const closeFollower = new FakeMedia(5);
    const driftingFollower = new FakeMedia(5);
    master.currentTime = 2;
    closeFollower.currentTime =
      2 - PLAYBACK_DRIFT_TOLERANCE_SECONDS / 2;
    driftingFollower.currentTime = 1.5;

    expect(
      synchronizeDrift([master, closeFollower, driftingFollower]),
    ).toBe(2);
    expect(closeFollower.currentTime).not.toBe(2);
    expect(driftingFollower.currentTime).toBe(2);
  });

  it("realigns before play and pauses every view if any play request fails", async () => {
    const players = [
      new FakeMedia(5),
      new FakeMedia(5, true),
      new FakeMedia(5),
    ];
    players[0].currentTime = 2;
    players[1].currentTime = 4;

    await expect(playSynchronized(players, 1.25)).resolves.toBe(false);
    expect(players.map((player) => player.currentTime)).toEqual([
      1.25,
      1.25,
      1.25,
    ]);
    expect(players.map((player) => player.pauseCalls)).toEqual([1, 1, 1]);
  });

  it("formats a stable minute-second-millisecond readout", () => {
    expect(formatPlaybackTime(0)).toBe("00:00.000");
    expect(formatPlaybackTime(65.432)).toBe("01:05.432");
    expect(formatPlaybackTime(Number.NaN)).toBe("00:00.000");
  });
});
