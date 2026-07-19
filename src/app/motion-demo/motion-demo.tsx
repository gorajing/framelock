"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

import styles from "./motion-demo.module.css";

export const MOTION_FRAME_COUNT = 121;
export const MOTION_FRAME_RATE = 24;
export const MOTION_DRIFT_TOLERANCE_SECONDS = 0.02;

type MotionMediaKind = "source" | "raw" | "mask" | "verified";
type MediaStatus = "loading" | "ready" | "missing";

export type MotionDemoMedia = Readonly<
  Record<MotionMediaKind, string | null>
>;

type AdmittedMotionAudit = Readonly<{
  claimScope: "canonical_pre_encode_frames";
  framesAudited: 121;
  framesExpected: 121;
  changedProtectedPixels: 0;
  temporalMasksBound: 121;
}>;

type BoundNegativeControl = Readonly<{
  status: "bound";
  frameIndex: number;
  changedProtectedChannelSamples: number;
  verifierRejected: true;
}>;

export type MotionDemoEvidence =
  | Readonly<{ admission: "pending" }>
  | Readonly<{
      admission: "admitted";
      audit: AdmittedMotionAudit;
      negativeControl?: BoundNegativeControl;
    }>;

type SynchronizableMotionMedia = {
  readonly duration: number;
  readonly seeking?: boolean;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
};

type MotionView = Readonly<{
  kind: MotionMediaKind;
  step: string;
  title: string;
  detail: string;
  placeholder: string;
}>;

const motionViews: readonly MotionView[] = [
  {
    kind: "source",
    step: "01 / Approve",
    title: "Original performance",
    detail: "The provenance-bound character performance we refuse to reroll.",
    placeholder: "Bind the source performance here",
  },
  {
    kind: "raw",
    step: "02 / Generate",
    title: "Generated world",
    detail:
      "The fal-generated environment before the approved performance is restored.",
    placeholder: "Bind the generated environment here",
  },
  {
    kind: "mask",
    step: "03 / Track",
    title: "Moving protection",
    detail: "One bound protection mask aligned to each source frame.",
    placeholder: "Bind the temporal mask preview here",
  },
  {
    kind: "verified",
    step: "04 / Restore + audit",
    title: "Canonical result preview",
    detail: "Delivery preview slot for an admitted canonical frame sequence.",
    placeholder: "Bind the canonical delivery preview here",
  },
] as const;

export const DEFAULT_MOTION_MEDIA: MotionDemoMedia = {
  source: null,
  raw: null,
  mask: null,
  verified: null,
};

export const PENDING_MOTION_EVIDENCE: MotionDemoEvidence = {
  admission: "pending",
};

const initialMediaStatus: Record<MotionMediaKind, MediaStatus> = {
  source: "loading",
  raw: "loading",
  mask: "loading",
  verified: "loading",
};

export function sharedMotionDuration(
  players: readonly Pick<SynchronizableMotionMedia, "duration">[],
): number {
  if (players.length !== motionViews.length) return 0;
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

export function seekMotionPlayers(
  players: readonly SynchronizableMotionMedia[],
  requestedTime: number,
): number {
  const duration = sharedMotionDuration(players);
  const target = clampMotionTime(requestedTime, duration);
  players.forEach((player) => {
    if (Math.abs(player.currentTime - target) > Number.EPSILON) {
      player.currentTime = target;
    }
  });
  return target;
}

export function synchronizeMotionDrift(
  players: readonly SynchronizableMotionMedia[],
): number {
  const master = players[0];
  if (!master) return 0;
  const duration = sharedMotionDuration(players);
  const masterTime = clampMotionTime(master.currentTime, duration);
  players.slice(1).forEach((player) => {
    if (
      !player.seeking &&
      Math.abs(player.currentTime - masterTime) >
        MOTION_DRIFT_TOLERANCE_SECONDS
    ) {
      player.currentTime = masterTime;
    }
  });
  return masterTime;
}

export async function playMotionPlayers(
  players: readonly SynchronizableMotionMedia[],
  requestedTime: number,
): Promise<boolean> {
  if (sharedMotionDuration(players) <= 0) return false;
  seekMotionPlayers(players, requestedTime);
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

export function motionFrameAtTime(time: number): number {
  if (!Number.isFinite(time) || time <= 0) return 0;
  return Math.min(
    MOTION_FRAME_COUNT - 1,
    Math.floor(time * MOTION_FRAME_RATE),
  );
}

export function formatMotionTime(time: number): string {
  const safeTime = Number.isFinite(time) && time > 0 ? time : 0;
  const totalMilliseconds = Math.round(safeTime * 1_000);
  const seconds = Math.floor(totalMilliseconds / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  return `${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(
    3,
    "0",
  )}`;
}

function MotionMediaCard({
  index,
  onMissing,
  onReady,
  register,
  src,
  status,
  view,
}: Readonly<{
  index: number;
  onMissing: (kind: MotionMediaKind) => void;
  onReady: (kind: MotionMediaKind) => void;
  register: (index: number, player: HTMLVideoElement | null) => void;
  src: string | null;
  status: MediaStatus;
  view: MotionView;
}>) {
  const unavailable = status !== "ready";

  return (
    <figure
      className={`${styles.mediaCard} ${styles[`mediaCard_${view.kind}`]}`}
      data-motion-media={view.kind}
      data-motion-media-status={status}
    >
      <div className={styles.mediaViewport}>
        {src ? (
          <video
            aria-label={view.title}
            className={unavailable ? styles.mediaPending : undefined}
            disablePictureInPicture
            muted
            onCanPlay={() => onReady(view.kind)}
            onError={() => onMissing(view.kind)}
            playsInline
            preload="auto"
            ref={(player) => register(index, player)}
            src={src}
            tabIndex={-1}
          />
        ) : null}
        {unavailable ? (
          <div className={styles.assetPlaceholder}>
            <span>{status === "missing" ? "Asset pending" : "Loading asset"}</span>
            <strong>{view.placeholder}</strong>
            <small>1280 × 720 · 121 frames · 24 fps</small>
          </div>
        ) : null}
        <span className={styles.frameCorner}>F000—F120</span>
      </div>
      <figcaption>
        <span>{view.step}</span>
        <strong>{view.title}</strong>
        <p>{view.detail}</p>
      </figcaption>
    </figure>
  );
}

export function MotionDemo({
  evidence = PENDING_MOTION_EVIDENCE,
  media,
}: Readonly<{
  evidence?: MotionDemoEvidence;
  media?: Partial<MotionDemoMedia>;
}>) {
  const resolvedMedia = useMemo(
    () => ({ ...DEFAULT_MOTION_MEDIA, ...media }),
    [media],
  );
  const playersRef = useRef<Array<HTMLVideoElement | null>>([
    null,
    null,
    null,
    null,
  ]);
  const [mediaStatus, setMediaStatus] = useState(() => ({
    ...initialMediaStatus,
    ...Object.fromEntries(
      motionViews
        .filter((view) => !resolvedMedia[view.kind])
        .map((view) => [view.kind, "missing"] as const),
    ),
  }));
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [starting, setStarting] = useState(false);
  const [transportStatus, setTransportStatus] = useState(
    "Waiting for all four motion assets.",
  );
  const [challengeActive, setChallengeActive] = useState(false);

  const players = useCallback(
    () =>
      playersRef.current.filter(
        (player): player is HTMLVideoElement => player !== null,
      ),
    [],
  );

  const pauseAll = useCallback(
    (message: string) => {
      players().forEach((player) => player.pause());
      setPlaying(false);
      setTransportStatus(message);
    },
    [players],
  );

  function register(index: number, player: HTMLVideoElement | null) {
    playersRef.current[index] = player;
  }

  function markReady(kind: MotionMediaKind) {
    setMediaStatus((current) => ({ ...current, [kind]: "ready" }));
    const nextDuration = sharedMotionDuration(players());
    if (nextDuration <= 0) return;
    setDuration(nextDuration);
    setTransportStatus("Four-view synchronized comparison ready.");
  }

  function markMissing(kind: MotionMediaKind) {
    setMediaStatus((current) => ({ ...current, [kind]: "missing" }));
    setDuration(0);
    pauseAll("A motion asset is pending. The proof presentation remains safe.");
  }

  async function togglePlayback() {
    if (playing) {
      pauseAll("Synchronized motion comparison paused.");
      return;
    }
    const available = players();
    if (available.length !== motionViews.length || duration <= 0) {
      setTransportStatus("Bind all four motion assets to enable playback.");
      return;
    }
    setStarting(true);
    const startTime =
      currentTime >= duration - MOTION_DRIFT_TOLERANCE_SECONDS
        ? 0
        : currentTime;
    const started = await playMotionPlayers(available, startTime);
    setStarting(false);
    if (!started) {
      pauseAll("Playback could not start consistently across all four views.");
      return;
    }
    setCurrentTime(startTime);
    setPlaying(true);
    setTransportStatus(
      "Playing the source, generated world, mask and result in sync.",
    );
  }

  function scrub(event: ChangeEvent<HTMLInputElement>) {
    const nextTime = seekMotionPlayers(players(), Number(event.target.value));
    setCurrentTime(nextTime);
    setTransportStatus(
      `Locked to frame ${String(motionFrameAtTime(nextTime)).padStart(3, "0")}.`,
    );
  }

  useEffect(() => {
    if (!playing) return;
    let animationFrame = 0;
    const update = () => {
      const available = players();
      if (available.length !== motionViews.length) {
        pauseAll("Playback paused because one motion view became unavailable.");
        return;
      }
      const nextTime = synchronizeMotionDrift(available);
      setCurrentTime(nextTime);
      if (
        duration > 0 &&
        nextTime >= duration - MOTION_DRIFT_TOLERANCE_SECONDS
      ) {
        pauseAll("Synchronized motion comparison complete.");
        setCurrentTime(duration);
        return;
      }
      animationFrame = window.requestAnimationFrame(update);
    };
    animationFrame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [duration, pauseAll, players, playing]);

  useEffect(
    () => () => {
      playersRef.current.forEach((player) => player?.pause());
    },
    [],
  );

  const currentFrame = motionFrameAtTime(currentTime);
  const readyCount = motionViews.filter(
    (view) => mediaStatus[view.kind] === "ready",
  ).length;
  const admittedEvidence =
    evidence.admission === "admitted" ? evidence : null;
  const negativeControl = admittedEvidence?.negativeControl;

  return (
    <main className={styles.motionDemo}>
      <nav className={styles.topbar} aria-label="FrameLock Motion demo">
        <a href="#motion-top" className={styles.wordmark}>
          FrameLock<span aria-hidden="true">.</span>
        </a>
        <span className={styles.routeLabel}>Motion proof / golden route</span>
        <Link className={styles.staticLink} href="/">
          Static fallback ↗
        </Link>
      </nav>

      <section className={styles.hero} id="motion-top">
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>
            {admittedEvidence
              ? "Admitted generative character reshoot proof"
              : "Generative character reshoot proof"}
          </p>
          <h1>
            {admittedEvidence ? (
              <>
                AI reshot the world.
                <br />
                <em>It was not allowed to reshoot her.</em>
              </>
            ) : (
              <>
                Reshoot the world.
                <br />
                <em>Proof comes after the audit.</em>
              </>
            )}
          </h1>
          <p className={styles.lede}>
            Approve one performance. FrameLock is designed to track its
            protected pixels through every frame, restore them after generation
            and admit an exactness claim only after the canonical audit passes.
          </p>
        </div>

        <aside className={styles.heroProof} aria-label="Motion proof summary">
          {admittedEvidence ? (
            <>
              <div className={styles.liveFlag}>
                <i aria-hidden="true" /> Audit admitted
              </div>
              <dl>
                <div>
                  <dt>Frames audited</dt>
                  <dd>
                    {admittedEvidence.audit.framesAudited} /{" "}
                    {admittedEvidence.audit.framesExpected}
                  </dd>
                </div>
                <div>
                  <dt>Changed protected pixels</dt>
                  <dd>{admittedEvidence.audit.changedProtectedPixels}</dd>
                </div>
                <div>
                  <dt>Temporal masks bound</dt>
                  <dd>{admittedEvidence.audit.temporalMasksBound}</dd>
                </div>
              </dl>
              <p>
                Claim applies to the canonical pre-encode frame sequence. The
                MP4 below is a synchronized delivery preview.
              </p>
            </>
          ) : (
            <div className={styles.pendingSummary} data-proof-admission="pending">
              <span>PROOF PENDING</span>
              <strong>No validated motion audit is bound.</strong>
              <p>
                Media can be staged independently, but exactness claims remain
                unavailable until canonical evidence is admitted.
              </p>
            </div>
          )}
        </aside>
      </section>

      <section className={styles.stage} aria-labelledby="motion-stage-title">
        <header className={styles.sectionHeading}>
          <div>
            <p>01 / The reshoot</p>
            <h2 id="motion-stage-title">One performance. Four truth layers.</h2>
          </div>
          <span>{readyCount} / 4 media assets ready</span>
        </header>

        <div className={styles.mediaGrid}>
          {motionViews.map((view, index) => (
            <MotionMediaCard
              index={index}
              key={view.kind}
              onMissing={markMissing}
              onReady={markReady}
              register={register}
              src={resolvedMedia[view.kind]}
              status={mediaStatus[view.kind]}
              view={view}
            />
          ))}
        </div>

        <div className={styles.transport}>
          <button
            disabled={duration <= 0 || starting}
            onClick={() => void togglePlayback()}
            type="button"
          >
            {starting
              ? "Starting all four…"
              : playing
                ? "Pause all four"
                : "Play all four"}
          </button>
          <label htmlFor="motion-demo-timeline">
            <span>Synchronized 121-frame timeline</span>
            <input
              aria-valuetext={`Frame ${currentFrame} of 120`}
              disabled={duration <= 0}
              id="motion-demo-timeline"
              max={duration > 0 ? duration : 0.001}
              min={0}
              onChange={scrub}
              step={1 / MOTION_FRAME_RATE}
              type="range"
              value={Math.min(currentTime, duration > 0 ? duration : 0)}
            />
          </label>
          <div className={styles.playhead}>
            <span>F{String(currentFrame).padStart(3, "0")}</span>
            <time>{formatMotionTime(currentTime)}s</time>
          </div>
        </div>
        <output className={styles.transportStatus} aria-live="polite">
          {transportStatus}
        </output>
      </section>

      <section className={styles.proofSection} aria-labelledby="proof-title">
        <header className={styles.sectionHeading}>
          <div>
            <p>02 / Observable proof</p>
            <h2 id="proof-title">
              {admittedEvidence
                ? "The claim is visible—and falsifiable."
                : "Proof pending."}
            </h2>
          </div>
          <span>
            {admittedEvidence
              ? "Pixel equality · per frame · protected core"
              : "No motion audit admitted"}
          </span>
        </header>

        <div className={styles.proofGrid}>
          <article className={styles.temporalProof}>
            <div className={styles.proofTopline}>
              <span>Temporal protection manifest</span>
              <b>{admittedEvidence ? "SEALED" : "PENDING"}</b>
            </div>
            <h3>
              {admittedEvidence
                ? `${admittedEvidence.audit.temporalMasksBound} masks follow one approved character.`
                : "Temporal mask evidence awaits admission."}
            </h3>
            <div
              aria-label={
                admittedEvidence
                  ? `${admittedEvidence.audit.temporalMasksBound} temporal masks admitted`
                  : "Temporal mask evidence pending"
              }
              className={`${styles.maskTrack} ${
                admittedEvidence ? "" : styles.maskTrack_pending
              }`}
              role="img"
            >
              {Array.from({ length: 11 }, (_, index) => (
                <i key={index} />
              ))}
            </div>
            <dl>
              <div>
                <dt>Sequence</dt>
                <dd>F000 → F120</dd>
              </div>
              <div>
                <dt>Geometry</dt>
                <dd>1280 × 720</dd>
              </div>
              <div>
                <dt>Cadence</dt>
                <dd>24 fps</dd>
              </div>
            </dl>
          </article>

          {admittedEvidence ? (
            <article className={styles.verdictCard}>
              <span>Separate persisted-frame audit</span>
              <strong>{admittedEvidence.audit.changedProtectedPixels}</strong>
              <h3>changed protected pixels</h3>
              <p>
                Every pixel inside every declared moving core equals its
                corresponding source pixel.
              </p>
              <div className={styles.passStamp}>
                {admittedEvidence.audit.framesAudited} /{" "}
                {admittedEvidence.audit.framesExpected} · VERIFIED
              </div>
            </article>
          ) : (
            <article className={styles.pendingVerdict} data-audit-result="pending">
              <span>Separate persisted-frame audit</span>
              <strong>PROOF PENDING</strong>
              <h3>No exactness result is admitted.</h3>
              <p>
                Bind validated canonical audit evidence before displaying any
                pass count or pixel-equality claim.
              </p>
            </article>
          )}

          <article
            className={`${styles.challengeCard} ${
              negativeControl && challengeActive
                ? styles.challengeCard_failed
                : ""
            } ${
              negativeControl ? "" : styles.challengeCard_unavailable
            }`}
            data-corruption-challenge={
              negativeControl
                ? challengeActive
                  ? "rejected"
                  : "bound"
                : "unavailable"
            }
          >
            <span>03 / Corruption challenge</span>
            <h3>
              {negativeControl
                ? challengeActive
                  ? `${negativeControl.changedProtectedChannelSamples} changed protected channel sample caught.`
                  : "Persisted negative control bound."
                : "Corruption proof unavailable."}
            </h3>
            <p aria-live="polite">
              {negativeControl
                ? challengeActive
                  ? `The bound negative control was rejected at F${String(
                      negativeControl.frameIndex,
                    ).padStart(3, "0")}. The canonical result remains untouched.`
                  : "Reveal the bound disposable-copy failure without modifying the canonical result."
                : "Bind negative-control evidence before presenting a falsification result."}
            </p>
            <button
              aria-pressed={negativeControl ? challengeActive : undefined}
              disabled={!negativeControl}
              onClick={() => {
                if (negativeControl) {
                  setChallengeActive((active) => !active);
                }
              }}
              type="button"
            >
              {negativeControl
                ? challengeActive
                  ? "Reset challenge"
                  : "Reveal caught corruption →"
                : "Evidence required"}
            </button>
            <div className={styles.challengeReadout}>
              <span>
                {negativeControl
                  ? `F${String(negativeControl.frameIndex).padStart(3, "0")} · protected core`
                  : "No negative control bound"}
              </span>
              <b>
                {negativeControl
                  ? challengeActive
                    ? "FAIL / CAUGHT"
                    : "BOUND"
                  : "UNAVAILABLE"}
              </b>
            </div>
          </article>
        </div>
      </section>

      <footer className={styles.footer}>
        <strong>Generate anything outside the lock.</strong>
        <span>FrameLock Motion / presentation route</span>
      </footer>
    </main>
  );
}

function clampMotionTime(time: number, duration: number): number {
  if (!Number.isFinite(time) || time <= 0 || duration <= 0) return 0;
  return Math.min(time, duration);
}
