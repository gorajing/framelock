# FrameLock Motion v1 build goal

## Objective

Build one polished, project-controlled moving-character demonstration for
**FrameLock — Verified Generative Reshoots** before the hackathon submission
deadline.

The user-visible promise is:

> Generate an AI character performance once. Reshoot its world without
> rerolling the approved performance.

The demo must make FrameLock's temporal proof visible. A selected original
character moves for five seconds while fal regenerates the surrounding world.
FrameLock restores the approved character inside a separately approved core for
every canonical frame and proves that every protected RGB sample stayed exact.

## Authority and boundaries

- This goal extends the locally complete AI-source successor in
  `docs/FRAMELOCK_AI_SOURCE_BUILD_GOAL.md`.
- The verified static job, its artifacts and its initial `3/3` paid-attempt
  ledger are immutable fallback evidence. Motion v1 must not edit or relabel
  them.
- The user authorized up to **$100 of fal credits** for Motion v1 and explicitly
  asked that visual quality take priority over minimizing cost.
- Cost freedom does not authorize uncontrolled retries. Every paid request must
  use a single non-retrying POST, persist its request identity and price
  evidence and reconcile ambiguous submissions before another request.
- `FAL_KEY` is the runtime credential. `FAL_ADMIN_KEY` remains unused unless a
  separately justified admin-only operation becomes essential.
- No public repository, deployment, public media upload or hackathon submission
  is authorized by this goal. Those remain explicit external gates.

## Product and demo claim

The only green verification claim remains:

> Protected core verified — canonical pre-encode frame sequence.

Motion v1 may additionally say:

> 121 frame-specific protected cores audited; zero protected RGB samples
> changed.

Motion v1 must not claim:

- that every visible character boundary pixel is exact
- that tracking output is semantically correct without human approval
- that the H.264 preview is lossless proof
- that FrameLock relights the protected character
- that a newly invented pose is pixel-identical to a different source pose
- that the model itself preserved the character

## Golden motion shot

Use one original AI-generated character unless a better project-controlled
asset is already available before generation:

- one adult fictional character with a clear full-body silhouette
- distinctive red outerwear and an original readable `FRM-01` badge
- a simple lateral walk, turn and look toward camera
- locked camera, one continuous shot and no scene cut
- no other person, no full occlusion and no foreground object crossing the body
- cyan-magenta studio lighting compatible with the target environment
- no celebrity, copyrighted character, third-party logo or unlicensed footage

Default reshoot direction:

> Locked camera. Reshoot the approved performance on a stormy rooftop above a
> neon megacity at night, with rain, distant traffic, cyan-magenta light and
> atmospheric depth. Preserve the character's timing, placement and silhouette
> closely enough for deterministic FrameLock restoration.

The recorded demo should show the approved source, raw fal reshoot, moving mask
overlay and FrameLock result in synchronized playback. It must end with a clean
121-frame audit and a deliberate one-channel, one-value protected-core
corruption that fails.

## Exact media envelope

- 1280 x 720
- exactly 121 canonical frames
- 24/1 CFR
- one approved project-controlled source MP4
- one ordered 8-bit grayscale foreground mask per frame
- white means declared foreground to protect
- black means editable exterior
- one non-empty protected core after four-pixel erosion on every frame
- one generated frame and one canonical composite per source frame
- no crop, stretch, interpolation, frame insertion, deletion, duplication or
  reordering to make an incompatible output pass
- canonical RGB24 PNG frames remain the trust root
- H.264 video remains a labeled viewing derivative

The tracker or alpha model proposes masks. Motion v1 normalizes them into the
canonical 121-frame sequence, shows the full moving overlay for human approval
and freezes every mask hash plus one ordered sequence digest before proof.

## Motion v1 scope

Build only:

1. one isolated temporal-mask proof adapter that reuses the current compositor
   and verifier
2. one deterministic no-spend moving-shape regression fixture
3. one real original AI-character golden motion run
4. one fal-derived temporal matte or alpha candidate, with a deterministic
   controlled-mask fallback
5. a small set of bounded reshoot candidates from which one golden result is
   admitted
6. one isolated motion demo route with synchronized playback, moving overlay,
   audit counter and corruption challenge
7. one motion-specific provenance manifest and spend ledger

Do not build:

- generic upload-to-tracking product UX
- multiple characters or identity switching
- occlusion or depth-layer handling
- a brush editor or timeline editor
- arbitrary resolutions, durations or frame rates
- model selectors or workflow canvases
- live generation during the recorded demo
- a migration of the existing static proof schema or job store
- production relighting

## Spend contract

Motion v1 has a separate hard ceiling of **$100 estimated fal cost**. The cost
ceiling is cumulative across source creation, animation, segmentation and
reshoot candidates.

Before every paid request:

1. bind the exact endpoint, input digests, current price evidence, estimated
   units and estimated cost
2. confirm the cumulative estimate remains at or below $100
3. reserve one motion request identity durably
4. submit with retry disabled
5. persist the returned request ID or terminal `submission_unknown` evidence

An ambiguous paid response is not a free slot. It must be reconciled before the
same stage can be attempted again. Visual quality, not minimum cost, selects the
golden result, but unused candidates remain honestly labeled attempt evidence.

## Execution order and gates

### Phase 0 — freeze the fallback

Reconfirm the static golden job, active-job pointer, artifacts and initial
attempt ledger before Motion v1 writes anything.

**Gate:** Motion work has a new root and cannot mutate existing job or replay
hashes.

### Phase 1 — prove temporal exactness without fal

Write a regression fixture with a moving protected shape, distinct mask per
frame, deterministic generated exterior and a deliberately corrupted middle
frame.

**Gate:** Clean proof passes every frame. A one-channel change and a swapped
mask frame both fail.

### Phase 2 — acquire and approve the character track

Create or select the original source performance. Run one documented fal alpha
or tracking route, normalize its output to 121 masks and inspect a complete
overlay video rather than only three thumbnails.

**Gate:** Every frame has a non-empty core, no identity switch and acceptable
coverage around the face, badge, hands and clothing. If a clean fal matte is not
available within 90 minutes, use the controlled-mask fallback and preserve the
failed candidate as evidence.

### Phase 3 — generate candidate reshoots

Run bounded fal candidates against the exact approved source. Reject geometry
or timing failures rather than repairing them. Select the strongest result by
visible world transformation, character-aligned geometry and boundary quality.

**Gate:** A credible canonical motion composite exists within four build hours.
Otherwise stop Motion v1 and retain the static submission.

### Phase 4 — publish local proof and demo

Freeze source, masks, raw generation, composite frames, visual overlays,
corruption evidence and spend receipts. Bind the golden media into the isolated
motion demo route.

**Gate:** Focused tests, the full Python and Node suites, typecheck, lint and
production build pass. The source/raw/mask/verified playback is visually
inspected at desktop width and the corruption state is visibly red.

### Phase 5 — truth review and handoff

Reconcile every README and submission claim to the admitted motion evidence.
Reserve at least five hours before the deadline for recording, public-repo
authorization, upload and submission.

## Definition of done

Motion v1 is locally complete only when all of the following are directly
observed:

- one original moving AI-character source satisfies the exact media envelope
- 121 ordered, approved foreground masks and derived cores are hash-bound
- one visually strong fal reshoot is bound to its request and spend evidence
- the canonical composite passes 121/121 frame-specific core audits
- zero protected pixels and zero protected RGB channel samples changed
- deterministic recomposition and artifact integrity pass
- a one-channel, one-value middle-frame corruption fails
- a swapped or shifted temporal mask fails admission
- the isolated motion demo renders and synchronized media playback works
- the existing static golden artifacts and initial `3/3` ledger are unchanged
- all final claims name boundary, relighting, tracking and preview limitations
- remaining public actions are handed off rather than implied complete
