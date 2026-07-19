# FrameLock documentation

This folder is the working specification and research package for **FrameLock — Verified Generative Reshoots**, a local Developer Track package for the fal x Sequoia Video Hackathon.

## Documents

- [FRAMELOCK_PLAN.md](./FRAMELOCK_PLAN.md) — historical original-plan baseline for the product thesis, UX, architecture, media pipeline and real-camera path. The AI-source successor governs where the two differ.
- [FAL_DOCUMENTATION_RESEARCH.md](./FAL_DOCUMENTATION_RESEARCH.md) — exhaustive synthesis of fal's complete indexed documentation corpus and its implications for FrameLock.
- [FRAMELOCK_BUILD_GOAL.md](./FRAMELOCK_BUILD_GOAL.md) — historical original build objective. Its completed technical evidence remains valid, but its unfulfilled real-camera requirement is superseded.
- [FRAMELOCK_AI_SOURCE_BUILD_GOAL.md](./FRAMELOCK_AI_SOURCE_BUILD_GOAL.md) — active successor objective for the approved AI-generated source-plate workflow; preserves the verifier while replacing the unfulfilled real-camera hero requirement.
- [DECISIONS.md](./DECISIONS.md) — implementation decisions and the evidence required to keep each claim honest.
- [HARDENED_SYNTHETIC_REPLAY.md](./HARDENED_SYNTHETIC_REPLAY.md) — exact hash ledger, clean audit, negative control and limitations for the no-spend replay of the recorded Kling result.
- [LOCAL_DOD_AUDIT.md](./LOCAL_DOD_AUDIT.md) — completed requirement-by-requirement local audit for the frozen AI-source release.
- [SUBMISSION_PACKAGE.md](./SUBMISSION_PACKAGE.md) — local submission draft reconciled to the verified AI-source job; publication remains a separate human gate.
- [HUMAN_HANDOFF.md](./HUMAN_HANDOFF.md) — current operator path for inspecting the verified job and separately authorizing publication.

## Decision status

Active AI-source job `ai_713a0e7a80b7410bbe6b6d3ef54f74b7` is `verified`. It used endpoint `fal-ai/kling-video/o3/standard/video-to-video/edit`, request ID `019f765d-0e8d-7551-afb4-941b02d355e6` and generation digest `d36a953ddf06959932fec2d4c5e0bbd1ea02c90724b193105f79344cdafc5f9e`.

The clean proof passed an independent audit: 121/121 frames had non-empty protected cores, all 44,049,566 protected-core pixels were evaluated, no protected pixel or RGB channel sample changed, the worst channel delta was zero and all 121 core hashes matched. The canonical ZIP contains exactly 121 entries and all archive and on-disk composite hashes matched the export manifest. A same-job negative control changed one protected pixel in one channel by one value at frame 60, failed admission and left the clean evidence unchanged.

Desktop and 390 × 844 mobile browser QA passed. Synchronized playback measured a maximum drift of `0.000203s`; fixed frames 0, 60 and 120 loaded and the source, raw, canonical, mask, boundary-ring and heatmap views loaded at 1280 × 720. The mobile verified and corruption views had no horizontal overflow. The final settled local verification suite passed: 117 Python tests, 413 Node tests, typecheck, lint, build, compile, offline locks, exact-value secret scan and no-spend HTTP/security smoke. Publication, deployment and hackathon submission remain unperformed and unauthorized.

The earlier LTX and synthetic Kling attempts remain historical feasibility evidence. The attempt-3 AI-source run exhausted the ledger at `3/3`; no more fal calls are needed or authorized for this release. The frozen release's `source_release.json` still says `paidRunAuthorized: false`. Preserve that value as immutable pre-run metadata rather than interpreting it as the current verified job state.

## Active verified-job evidence

The active evidence ledger is:

| Field | Verified value |
| --- | --- |
| Active job | `ai_713a0e7a80b7410bbe6b6d3ef54f74b7` |
| State | `verified` |
| fal request ID | `019f765d-0e8d-7551-afb4-941b02d355e6` |
| Endpoint | `fal-ai/kling-video/o3/standard/video-to-video/edit` |
| Authenticated account price | `$0.14/seconds` |
| Estimated units | `5.041666667` |
| Estimated cost | `$0.7058333334` |
| Pricing-observation digest | `5edd96d046ec978a45589166b06613c5cf0ddd2dc36b8aa3d0f4aa0734b42798` |
| Receipt digest | `f6531b0bf89451cce00ab258367b9c87f69f655eac984d89dbf0a8bacb441c04` |
| Paid-attempt digest | `a86acc227e33f8788fa95af5e017431e358fb63deafa45da1203b47020b2e775` |
| Generation digest | `d36a953ddf06959932fec2d4c5e0bbd1ea02c90724b193105f79344cdafc5f9e` |
| Source SHA-256 | `8c3ec81f8c12250654a8fca7b689331cf5bd25b64a28112cd17c1994dee373ea` |
| Restoration-mask SHA-256 | `add6a60da1bcf3e01c9f9237e8db88d28b288cd62e9fb2a38f92718eb31a0d7e` |
| Raw model-output SHA-256 | `f5b49df01dcc2e5d88f26138a62e84ebba833e9421ed635e8f3487c6504335f6` |
| Canonical audit SHA-256 | `a0e7454afed3e67311744fe0d9a0db19fd5116514e710f015ec7d6202883cd38` |
| Proof-manifest SHA-256 | `c91a176a8c82c3a57cc56fe2a502a509d541be6c162d60c91661419919a12540` |
| Canonical ZIP SHA-256 | `ce0dc9b1fe8e5b3498f2f7a814e3155541d0101b0f97e8c81f99769406b8aca8` |
| Budget | `used: 3`, `cap: 3` |

The cost is the authenticated pre-submit estimate captured for attempt 3, not a confirmed charge. The paid boundary is closed: no price refresh, upload or generation is needed or authorized.

## Local evidence

The frozen release directory is keyed by original-image SHA-256 `131b1ec6720808a1b4b67f5ab29c5c504d2d10c933485f13be9eabd986c68a11`. Its provenance-file SHA-256 is `8d7fc6b0816bd52b968b974c3b45c31cb84371b89159e040f396c1200ea3647d`. The source and mask bindings above now belong to the verified job evidence chain, while the release record remains the preserved pre-run history.

The official documentation mirror, its 418-URL manifest and the raw July 17 live-model schema snapshot live under `../.firecrawl/`. That directory is intentionally ignored because it is a reproducible research cache, not authored project source. Integrity hashes and reconstruction commands are recorded in the research dossier.
