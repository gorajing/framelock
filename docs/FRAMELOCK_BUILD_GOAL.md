# FrameLock build goal

## Objective

Build **FrameLock — Verified Generative Reshoots** end to end in `/Users/jinchoi/Code/video`. Work autonomously in verified slices until the local submission package is genuinely ready.

Use these files as the authority:

1. `docs/FRAMELOCK_PLAN.md` — product, scope, media and verification contract
2. `docs/FAL_DOCUMENTATION_RESEARCH.md` — fal API and model evidence
3. This goal — execution order, acceptance gates and human-owned boundaries

If live evidence contradicts the plan, preserve the evidence, write a decision trace and choose the narrowest truthful path. Never quietly weaken the verifier or broaden the product claim.

## Product claim

FrameLock lets a creator regenerate the environment around one approved real product, then deterministically restores and verifies the declared protected core.

The only green claim is:

> Protected core verified — canonical pre-encode frame sequence.

Do not imply that:

- fal preserved the object
- the mask is semantically correct
- the feathered seam is exact
- the H.264 preview is lossless
- the camera original has cryptographic provenance

## Current state

- `FAL_KEY` and `FAL_ADMIN_KEY` remain in ignored `.env.local`. Runtime calls use only `FAL_KEY`; `FAL_ADMIN_KEY` is unused.
- The pinned local toolchain is Node 24.18.0, pnpm 10.33.0, Python 3.14 through `uv` and FFmpeg/ffprobe 8.1.
- The deterministic kernel, source-audio policy, corruption gauntlet and crash-safe two-phase proof workflow pass 102 Python tests with fal credentials removed from the test process.
- LTX attempt 1 was honestly rejected as not comparable at 1280×768 and 5:3. Kling O3 Standard attempt 2 was selected at 1280×720, 121 frames and 24/1 FPS. The third attempt was not spent.
- Proof schema v2 binds the exact Kling output, all 121 generated-frame hashes and independent deterministic recomposition. Review evidence separately binds the three fixed overlays and approval. Run schemas v5 and v6 bind the protected-core, boundary-ring and difference-heatmap visualizations; v6 additionally requires source-audio evidence.
- Review preparation publishes atomically. Finalization uses a durable journal and commit-last marker whose exact files and directory trees are independently revalidated before a job may become `verified`.
- The fixed paid controller snapshots attempt index, cap, price, units, estimate, source and timestamps. Pricing evidence older than 24 hours or dated in the future returns HTTP 409 with `PRICING_OBSERVATION_NOT_CURRENT` before credential validation, upload, budget mutation or submission, requiring a newly reviewed and authorized digest. A global lock makes the three-attempt budget atomic across distinct jobs; ambiguous paid submissions never retry automatically.
- The compact workspace includes synchronized source/raw/derived-preview playback, hash-bound streamed media, exact approval binding, deterministic canonical-frame ZIP export, protected-core/boundary/heatmap evidence and a red one-pixel/one-channel corruption result. P0 intentionally exposes no cancel control or paid cancellation route.
- Final closeout passes 241 Node tests, TypeScript, ESLint, the Next.js production build, Python compilation, offline locked dependency checks, source-visible secret scanning and live no-spend HTTP smoke checks. The live budget reports `used: 2`, `next: 3`, `cap: 3`; both legacy paid POSTs return 410 and LTX persists as `not_comparable`.
- The current owned asset is a synthetic diagnostic fixture. Real-camera hero capture, public repository creation, deployment and submission remain human-owned external actions.

A no-spend hardened replay reused the persisted Kling synthetic output through the current Python proof path. Its schema-v5 run manifest, nine-output commit marker and canonical ZIP validated; the audit reopened 121 frames with zero changed core samples across 22,029,381 protected pixels, while the separate one-channel/one-pixel corruption fixture failed. This replay is not a fresh fal call, a Node job-store admission or real-camera completion evidence. Exact hashes and limitations are in `docs/HARDENED_SYNTHETIC_REPLAY.md`.

Browser inspection covered the fresh intake workspace, the read-only legacy synthetic verified projection and its red corruption state at desktop and mobile widths. That does not satisfy the final real-camera requirement. The implemented hardened real-job success and corruption UI remains unexercised by a real-camera transaction and still requires browser inspection with the owned hero asset.

## Frozen P0 scope

- One newly shot, owned, stationary product clip.
- Exact input: MP4, 1280×720, 121 decoded frames, 24/1 CFR, normalized PTS residual no greater than 1 ms and no more than 50 MB.
- One prepared, non-animated 8-bit static grayscale PNG mask repeated across all 121 frames. Animated PNG/APNG input fails closed.
- The completed feasibility sequence tested `fal-ai/ltx-2.3-quality/inpaint` first, rejected its non-comparable result and selected one fixed Kling O3 Standard edit route. Do not add a model selector merely for breadth.
- One active job, one variant and one compact stepper/results page.
- No project CRUD, timeline editor, lasso/brush editor, refresh-recovery UX, cancellation UX, arbitrary formats, public cloud persistence or multi-model selector.
- SAM 3, SA2VA and BiRefNet begin only after the complete static-mask P0 works.
- Deployment is optional. A local runtime and recorded golden run are sufficient.

## Execution loop

1. Inspect current files and state before editing. Maintain a visible plan with one step in progress and a verification check for each step.
2. Establish the minimal reproducible toolchain: isolated Python environment, pinned dependencies, Next.js/TypeScript shell, server-only fal integration and immutable local run directories. Add `.env.example` placeholders without reading secrets into output.
3. Before paid inference, build deterministic synthetic fixtures and tests for media validation, mask polarity, compositing, hash serialization and independent verification.
4. Implement the canonical pipeline:
   - decode accepted source into immutable, zero-indexed RGB24 PNG frames
   - record FFmpeg version and color metadata
   - persist core masks as `uint8 {0,255}`
   - derive in-memory `protectCore` as boolean and `protectAlpha` as float32 `[0,1]`
   - keep the LTX white-regenerate/black-preserve edit mask separate
   - blend only the boundary using declared straight-alpha, linear-light float32
   - overwrite protected-core RGB bytes after blending
   - persist outputs before auditing
   - make a separate verifier reopen source, core-mask and composite files from disk
5. Enforce comparability: 121 output frames, 24/1 CFR, strictly increasing timestamps, at most 1 ms normalized PTS residual, 16:9 geometry and no insertion, deletion, interpolation or reordering. Record timestamp snap and require first/middle/final overlay approval.
6. Complete the hard three-hour primitive before polishing the UI:
   - Gate 0: credentials, isolated toolchain, live schema and authenticated price
   - Gate 1: canonical hero clip, non-empty static mask and proven polarity
   - Gate 2: visibly transformed, same-request LTX output that passes comparability, or one O3 replacement test
   - Gate 3: acceptable persisted composite, audit JSON, zero changed protected-core samples and a one-channel/one-pixel corruption that turns the independent verdict red
7. If the primitive fails after three focused hours, stop expanding the application, preserve exact evidence and request the concept-pivot decision.
8. Only after Gate 3 passes, build the compact product flow: upload/validate, protect preview, prompt, persisted fal request ID/status, synchronized original/raw/composite/mask/difference views, honest audit states and exports.
9. Export canonical RGB24 PNGs as the authoritative verified master, audit JSON and an H.264 file labeled **Preview derived from verified canonical frames**. Source audio is separate and outside the pixel claim.
10. Inspect the rendered application in a browser. Do not claim UI success from types or build output alone.
11. Finish the local package: README, architecture, exact claim boundary, setup, limitations, actual shipped endpoint, tests, asset provenance, request IDs, 100–200 word description and 2:35–2:45 demo storyboard.

## Cost and human-owned boundaries

- Validate locally before every paid call.
- Limit initial feasibility work to three paid generation attempts unless the user authorizes more.
- Record endpoint, request ID, parameters and estimated cost without exposing credentials.
- Do not create a remote repository, commit, push, deploy publicly, upload media or submit to the hackathon without explicit user authorization.
- Do not use third-party brands, copyrighted characters, celebrity likenesses or unlicensed media.
- The user owns real hero-footage capture and final art direction. Continue with clearly labeled synthetic fixtures until those assets are required.

## Required verification

### Unit

- Invalid container, dimensions, frame count, frame rate or timestamps are rejected.
- Mask domains and LTX polarity are tested.
- Empty core fails.
- Erosion never expands the core.
- Canonical row-major RGB byte hashing is deterministic.
- One changed protected channel fails.
- Changes outside the core do not fail the core audit.

### Integration

- Upload/decode produces immutable artifacts.
- fal submit/status/result persists request provenance and downloads the result.
- Budget validation and reservation are atomic across distinct jobs.
- Mask transforms produce separate core, boundary and edit artifacts.
- Generated output passes comparability before composition.
- The verifier reopens persisted artifacts and writes audit JSON.
- A job cannot become `verified` without a valid finalization commit marker, exact output hashes and a structurally valid canonical-frame ZIP.
- Media responses are bound to persisted hashes, reject symlinks and stream from the same validated file descriptor.

### End to end

- One real hero result completes twice through the application path.
- Invalid input fails before spending.
- Deliberate corruption is visibly rejected.
- Typecheck, tests and production build pass.
- The completed result and failure state are inspected in the browser.
- No secret is present in source-visible or tracked files.

## Definition of done

Do not mark this goal complete until direct evidence proves that:

- one real same-request raw generation and FrameLock composite are visually convincing
- every non-empty canonical protected-core frame reports zero changed samples
- the independent corruption fixture fails
- the compact application path works twice
- the browser-rendered success and failure states were inspected
- final documentation names only what shipped
- all human-owned actions, unverified assumptions and external submission steps are handed off explicitly

When blocked, continue independent in-scope work. Never redefine completion around the pieces that happened to succeed.
