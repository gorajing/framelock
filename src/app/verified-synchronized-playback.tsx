"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

export const PLAYBACK_DRIFT_TOLERANCE_SECONDS = 0.075;

type SynchronizableMedia = {
  readonly duration: number;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
};

type PlaybackView = Readonly<{
  asset: "source" | "generated" | "preview";
  label: string;
  provenance: string;
}>;

const views: readonly PlaybackView[] = [
  {
    asset: "source",
    label: "AI-generated source — provenance-bound baseline",
    provenance: "Approved AI-source input / comparison baseline",
  },
  {
    asset: "generated",
    label: "Kling environment edit — unverified",
    provenance: "fal output / no protected-core claim",
  },
  {
    asset: "preview",
    label:
      "H.264 delivery preview — derived from verified canonical frames; not lossless proof",
    provenance: "Delivery encoding / canonical PNGs remain authoritative",
  },
] as const;

export function sharedPlaybackDuration(
  players: readonly Pick<SynchronizableMedia, "duration">[],
): number {
  if (players.length === 0) return 0;
  const durations = players.map((player) => player.duration);
  if (
    durations.some(
      (duration) => !Number.isFinite(duration) || duration <= 0,
    )
  ) {
    return 0;
  }
  return Math.min(...durations);
}

export function seekSynchronized(
  players: readonly SynchronizableMedia[],
  requestedTime: number,
): number {
  const duration = sharedPlaybackDuration(players);
  const target = clampTime(requestedTime, duration);
  players.forEach((player) => {
    player.currentTime = target;
  });
  return target;
}

export function synchronizeDrift(
  players: readonly SynchronizableMedia[],
): number {
  const master = players[0];
  if (!master) return 0;
  const duration = sharedPlaybackDuration(players);
  const masterTime = clampTime(master.currentTime, duration);
  players.slice(1).forEach((player) => {
    if (
      Math.abs(player.currentTime - masterTime) >
      PLAYBACK_DRIFT_TOLERANCE_SECONDS
    ) {
      player.currentTime = masterTime;
    }
  });
  return masterTime;
}

export async function playSynchronized(
  players: readonly SynchronizableMedia[],
  requestedTime: number,
): Promise<boolean> {
  if (players.length === 0 || sharedPlaybackDuration(players) <= 0) {
    return false;
  }
  seekSynchronized(players, requestedTime);
  const results = await Promise.allSettled(
    players.map((player) => {
      try {
        return player.play();
      } catch (error) {
        return Promise.reject(error);
      }
    }),
  );
  if (results.some((result) => result.status === "rejected")) {
    players.forEach((player) => player.pause());
    return false;
  }
  return true;
}

export function formatPlaybackTime(time: number): string {
  const safeTime = Number.isFinite(time) && time > 0 ? time : 0;
  const totalMilliseconds = Math.round(safeTime * 1_000);
  const minutes = Math.floor(totalMilliseconds / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0",
  )}.${String(milliseconds).padStart(3, "0")}`;
}

export function VerifiedSynchronizedPlayback({
  jobId,
}: Readonly<{ jobId: string }>) {
  const videoRefs = useRef<Array<HTMLVideoElement | null>>([null, null, null]);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [status, setStatus] = useState(
    "Load all three views to enable synchronized playback.",
  );

  const players = useCallback((): HTMLVideoElement[] => {
    return videoRefs.current.filter(
      (player): player is HTMLVideoElement => player !== null,
    );
  }, []);

  function refreshDuration() {
    const available = players();
    if (available.length !== views.length) return;
    const nextDuration = sharedPlaybackDuration(available);
    if (nextDuration <= 0) return;
    setDuration(nextDuration);
    const nextTime = seekSynchronized(
      available,
      Math.min(currentTime, nextDuration),
    );
    setCurrentTime(nextTime);
    setStatus("Synchronized comparison ready.");
  }

  const pauseAll = useCallback((message: string) => {
    players().forEach((player) => player.pause());
    setPlaying(false);
    setStatus(message);
  }, [players]);

  async function togglePlayback() {
    const available = players();
    if (playing) {
      pauseAll("Synchronized comparison paused.");
      return;
    }
    if (available.length !== views.length || duration <= 0) {
      setStatus("All three views must finish loading before playback.");
      return;
    }
    setTransitioning(true);
    const startTime =
      currentTime >= duration - PLAYBACK_DRIFT_TOLERANCE_SECONDS
        ? 0
        : currentTime;
    const started = await playSynchronized(available, startTime);
    setTransitioning(false);
    if (!started) {
      setPlaying(false);
      setStatus("Playback could not start consistently across all three views.");
      return;
    }
    setCurrentTime(startTime);
    setPlaying(true);
    setStatus("Playing all three views in sync.");
  }

  function scrub(event: ChangeEvent<HTMLInputElement>) {
    const nextTime = seekSynchronized(players(), Number(event.target.value));
    setCurrentTime(nextTime);
    setStatus(`Synchronized at ${formatPlaybackTime(nextTime)}.`);
  }

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const update = () => {
      const available = players();
      if (available.length !== views.length) {
        pauseAll("Playback paused because one view became unavailable.");
        return;
      }
      const nextTime = synchronizeDrift(available);
      setCurrentTime(nextTime);
      if (
        duration > 0 &&
        nextTime >= duration - PLAYBACK_DRIFT_TOLERANCE_SECONDS
      ) {
        pauseAll("Synchronized comparison complete.");
        setCurrentTime(duration);
        return;
      }
      frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [duration, pauseAll, players, playing]);

  useEffect(
    () => () => {
      videoRefs.current.forEach((player) => player?.pause());
    },
    [],
  );

  return (
    <section
      aria-labelledby="verified-playback-title"
      className="verified-playback"
      data-verified-playback
    >
      <header className="verified-playback__header">
        <div>
          <span>Shared transport / three provenance layers</span>
          <h3 id="verified-playback-title">Synchronized result playback</h3>
        </div>
        <p>
          Only the canonical PNG sequence and audit carry the protected-core
          claim. Playback is muted for frame comparison.
        </p>
      </header>

      <div className="verified-playback__views">
        {views.map((view, index) => (
          <figure data-playback-view={view.asset} key={view.asset}>
            <video
              aria-label={view.label}
              disablePictureInPicture
              muted
              onDurationChange={refreshDuration}
              onEnded={() =>
                pauseAll("Synchronized comparison complete.")
              }
              onError={() =>
                pauseAll("Playback paused because one view failed to load.")
              }
              onLoadedMetadata={refreshDuration}
              onStalled={() => {
                if (playing) {
                  pauseAll("Playback paused while one view buffers.");
                }
              }}
              playsInline
              preload="metadata"
              ref={(element) => {
                videoRefs.current[index] = element;
              }}
              src={`/api/jobs/${jobId}/media/${view.asset}`}
              tabIndex={-1}
            />
            <figcaption>
              <strong>{view.label}</strong>
              <span>{view.provenance}</span>
            </figcaption>
          </figure>
        ))}
      </div>

      <div className="verified-playback__transport">
        <button
          aria-label={
            playing
              ? "Pause synchronized comparison"
              : "Play synchronized comparison"
          }
          disabled={duration <= 0 || transitioning}
          onClick={() => void togglePlayback()}
          type="button"
        >
          {transitioning ? "Starting…" : playing ? "Pause" : "Play"}
        </button>
        <label htmlFor="verified-playback-timeline">
          <span>Synchronized comparison timeline</span>
          <input
            aria-valuetext={`${formatPlaybackTime(currentTime)} of ${formatPlaybackTime(duration)}`}
            disabled={duration <= 0}
            id="verified-playback-timeline"
            max={duration > 0 ? duration : 0.001}
            min={0}
            onChange={scrub}
            step={0.001}
            type="range"
            value={Math.min(currentTime, duration > 0 ? duration : 0)}
          />
        </label>
        <time aria-label="Playback position">
          {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
        </time>
      </div>
      <output aria-live="polite" className="verified-playback__status">
        {status}
      </output>
    </section>
  );
}

function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time) || time <= 0 || duration <= 0) return 0;
  return Math.min(time, duration);
}
