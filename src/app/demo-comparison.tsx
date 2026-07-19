"use client";

import Image from "next/image";
import { useState } from "react";

import type { DemoMediaId } from "@/lib/demo/demo-media";
import type { DemoSummary } from "@/lib/demo/demo-summary";

const INSPECTION_FRAMES = [0, 60, 120] as const;
type InspectionFrame = (typeof INSPECTION_FRAMES)[number];

const FRAME_MEDIA = {
  0: {
    source: "source-frame-0",
    raw: "raw-frame-0",
    composite: "composite-frame-0",
    overlay: "overlay-frame-0",
  },
  60: {
    source: "source-frame-60",
    raw: "raw-frame-60",
    composite: "composite-frame-60",
    overlay: "overlay-frame-60",
  },
  120: {
    source: "source-frame-120",
    raw: "raw-frame-120",
    composite: "composite-frame-120",
    overlay: "overlay-frame-120",
  },
} as const satisfies Record<
  InspectionFrame,
  Record<"source" | "raw" | "composite" | "overlay", DemoMediaId>
>;

const FRAME_LABELS: Record<InspectionFrame, string> = {
  0: "Start",
  60: "Midpoint",
  120: "Final",
};

function mediaUrl(asset: DemoMediaId): string {
  return `/api/demo/media/${asset}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

type FramePanelProps = Readonly<{
  asset: DemoMediaId;
  eyebrow: string;
  title: string;
  detail: string;
  frame: InspectionFrame;
  tone?: "source" | "raw" | "verified" | "overlay";
}>;

function FramePanel({
  asset,
  eyebrow,
  title,
  detail,
  frame,
  tone = "source",
}: FramePanelProps) {
  return (
    <figure className={`frame-panel frame-panel--${tone}`}>
      <div className="frame-panel__image">
        <Image
          alt={`${title} at source frame ${frame}`}
          height={720}
          key={asset}
          loading="eager"
          src={mediaUrl(asset)}
          unoptimized
          width={1280}
        />
        <span className="frame-panel__index">F{String(frame).padStart(3, "0")}</span>
      </div>
      <figcaption>
        <span className="frame-panel__eyebrow">{eyebrow}</span>
        <strong>{title}</strong>
        <span>{detail}</span>
      </figcaption>
    </figure>
  );
}

type VideoPanelProps = Readonly<{
  asset: DemoMediaId;
  step: string;
  title: string;
  detail: string;
  preview?: boolean;
}>;

function VideoPanel({
  asset,
  step,
  title,
  detail,
  preview = false,
}: VideoPanelProps) {
  return (
    <article className="video-panel">
      <header>
        <span>{step}</span>
        {preview ? (
          <b className="video-panel__preview-label">H.264 preview</b>
        ) : null}
      </header>
      <video
        aria-label={title}
        controls
        loop
        muted
        playsInline
        preload="metadata"
        src={mediaUrl(asset)}
      />
      <div className="video-panel__copy">
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
    </article>
  );
}

export function DemoComparison({ summary }: { summary: DemoSummary }) {
  const [frame, setFrame] = useState<InspectionFrame>(60);
  const media = FRAME_MEDIA[frame];

  return (
    <div className="demo-evidence" id="synthetic-evidence">
      <nav className="topbar" aria-label="FrameLock result">
        <a href="#top" className="wordmark">
          FrameLock<span aria-hidden="true">.</span>
        </a>
        <span className="run-id">Evidence run / KLING–001</span>
        <span className="status-chip">
          <i aria-hidden="true" /> Canonical verified
        </span>
      </nav>

      <section className="hero" id="top">
        <div className="hero__copy">
          <p className="kicker">{summary.projectionLabel}</p>
          <h1>
            Reshoot the world.
            <br />
            <em>Lock the product.</em>
          </h1>
          <p className="hero__lede">
            Let a generative model rebuild everything outside the protected
            subject, then restore and independently verify the canonical frame
            sequence before encode.
          </p>
          <div className="fixture-notice">
            <span>Fixture</span>
            <strong>{summary.fixture}</strong>
            <p>
              Owned 1280 × 720 vector diagnostic media. Useful for proving the
              invariant, not a commercial-finish claim.
            </p>
          </div>
        </div>

        <aside className="verdict" aria-label="Verification verdict">
          <span className="verdict__label">Independent audit result</span>
          <strong className="verdict__zero">0</strong>
          <span className="verdict__unit">changed protected pixels</span>
          <div className="verdict__rule" />
          <p>{summary.claim}</p>
          <dl>
            <div>
              <dt>Frames</dt>
              <dd>{summary.proof.framesAudited} / 121</dd>
            </div>
            <div>
              <dt>Max Δ</dt>
              <dd>{summary.proof.maximumChannelDelta}</dd>
            </div>
            <div>
              <dt>Core hashes</dt>
              <dd>{summary.proof.coreHashMatches} / 121</dd>
            </div>
          </dl>
        </aside>
      </section>

      <section className="section video-proof" aria-labelledby="motion-title">
        <header className="section-heading">
          <p>01 / Motion proof</p>
          <h2 id="motion-title">Source → raw model → canonical</h2>
          <span>Same 121-frame, 24 fps contract</span>
        </header>

        <div className="video-grid">
          <VideoPanel
            asset="source-video"
            detail="The original owned synthetic fixture and the source of protected pixels."
            step="01 / Source"
            title="Protected source"
          />
          <VideoPanel
            asset="raw-video"
            detail="The untrusted Kling generation before FrameLock restores the protected core."
            step="02 / Generate"
            title="Raw model result"
          />
          <VideoPanel
            asset="canonical-preview"
            detail={summary.previewLabel}
            preview
            step="03 / Restore + audit"
            title="Canonical result preview"
          />
        </div>
      </section>

      <section className="inspection section" aria-labelledby="inspection-title">
        <header className="section-heading section-heading--inspection">
          <div>
            <p>02 / Frame inspection</p>
            <h2 id="inspection-title">See exactly what changed</h2>
          </div>
          <div
            className="frame-selector"
            aria-label="Inspection frame"
            role="group"
          >
            {INSPECTION_FRAMES.map((index) => (
              <button
                aria-pressed={frame === index}
                key={index}
                onClick={() => setFrame(index)}
                type="button"
              >
                <span>{FRAME_LABELS[index]}</span>
                F{String(index).padStart(3, "0")}
              </button>
            ))}
          </div>
        </header>

        <div className="frame-grid">
          <FramePanel
            asset={media.source}
            detail="Canonical source RGB24"
            eyebrow="01 / Input"
            frame={frame}
            title="Protected source"
          />
          <FramePanel
            asset={media.raw}
            detail="Untrusted generative output"
            eyebrow="02 / Generate"
            frame={frame}
            title="Raw model result"
            tone="raw"
          />
          <FramePanel
            asset={media.composite}
            detail="Protected core restored byte-for-byte"
            eyebrow="03 / Canonical"
            frame={frame}
            title="Canonical verified frame"
            tone="verified"
          />
          <FramePanel
            asset={media.overlay}
            detail="Cyan foreground / magenta protected core"
            eyebrow="04 / Inspect"
            frame={frame}
            title="Geometry overlay"
            tone="overlay"
          />
        </div>

        <p className="inspection-note">
          Frame 060 is the hardest proof frame: the raw cyan beam crosses the
          package, while the canonical frame removes it from the protected core.
          Boundary blending is visible; seamless physical relighting is not claimed.
        </p>
      </section>

      <section className="audit section" aria-labelledby="audit-title">
        <header className="section-heading">
          <p>03 / Canonical audit</p>
          <h2 id="audit-title">The invariant, counted</h2>
          <span>Trust root: persisted pre-encode RGB24 frames</span>
        </header>

        <div className="metric-ledger">
          <article className="metric metric--lead">
            <span>Frames audited</span>
            <strong>{summary.proof.framesAudited} / 121</strong>
            <small>Every canonical frame reopened</small>
          </article>
          <article className="metric">
            <span>Frames with core</span>
            <strong>{summary.proof.framesWithProtectedCore}</strong>
            <small>No empty-mask passes</small>
          </article>
          <article className="metric">
            <span>Protected pixels</span>
            <strong>{formatInteger(summary.proof.totalProtectedCorePixels)}</strong>
            <small>Across the full sequence</small>
          </article>
          <article className="metric metric--zero">
            <span>Changed pixels</span>
            <strong>{summary.proof.changedCorePixels}</strong>
            <small>Exact equality required</small>
          </article>
          <article className="metric metric--zero">
            <span>Changed channel samples</span>
            <strong>{summary.proof.changedCoreChannelSamples}</strong>
            <small>R, G and B comparisons</small>
          </article>
          <article className="metric">
            <span>Core hash matches</span>
            <strong>{summary.proof.coreHashMatches} / 121</strong>
            <small>Source equals output</small>
          </article>
        </div>
      </section>

      <section className="selection section" aria-labelledby="selection-title">
        <header className="section-heading">
          <p>04 / Generator selection</p>
          <h2 id="selection-title">Comparable beats convenient</h2>
          <span>Two paid attempts / third attempt not spent</span>
        </header>

        <div className="selection-grid">
          <article className="generator generator--selected">
            <header>
              <span>Selected / Attempt {summary.selectedGenerator.attempt}</span>
              <b>Comparable</b>
            </header>
            <h3>{summary.selectedGenerator.name}</h3>
            <p className="endpoint">{summary.selectedGenerator.endpoint}</p>
            <dl>
              <div>
                <dt>Request ID</dt>
                <dd>{summary.selectedGenerator.requestId}</dd>
              </div>
              <div>
                <dt>Media contract</dt>
                <dd>
                  {summary.selectedGenerator.media.width} × {summary.selectedGenerator.media.height}
                  {" / "}{summary.selectedGenerator.media.frameCount} frames
                  {" / "}{summary.selectedGenerator.media.frameRate} fps
                </dd>
              </div>
            </dl>
          </article>

          <article className="generator generator--rejected">
            <header>
              <span>Rejected / Attempt {summary.rejectedAttempt.attempt}</span>
              <b>Not comparable</b>
            </header>
            <h3>{summary.rejectedAttempt.name}</h3>
            <p className="endpoint">{summary.rejectedAttempt.endpoint}</p>
            <dl>
              <div>
                <dt>Failed check</dt>
                <dd>{summary.rejectedAttempt.failedCheck}</dd>
              </div>
              <div>
                <dt>Actual / required</dt>
                <dd>
                  {summary.rejectedAttempt.actual} / {summary.rejectedAttempt.required}
                </dd>
              </div>
            </dl>
            <p className="rejection-note">{summary.rejectedAttempt.reason}</p>
          </article>
        </div>
      </section>

      <section className="scope section" aria-label="Claim scope">
        <div>
          <p>What this proves</p>
          <h2>The protected core in every persisted canonical RGB24 frame is identical to source.</h2>
        </div>
        <div>
          <p>What this does not claim</p>
          <ul>
            <li>The H.264 preview is lossless proof</li>
            <li>The boundary is seamlessly or physically relit</li>
            <li>The synthetic fixture is commercial-ready footage</li>
            <li>The local manifest is externally signed attestation</li>
          </ul>
        </div>
      </section>

      <footer>
        <span>FrameLock / Verified generative reshoots</span>
        <strong>{summary.claim}</strong>
      </footer>
    </div>
  );
}
