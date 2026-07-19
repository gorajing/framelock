# FrameLock AI-source execution goal

## Objective

Build and directly demonstrate **FrameLock — Verified Generative Reshoots** as
an AI-video production guardrail in `/Users/jinchoi/Code/video`.

The product workflow is:

> Approve an AI-generated shot. Regenerate the world around it. Verify the
> locked region stayed exact.

Use the existing hardened repository as the implementation baseline. Replace
the unfulfilled real-camera hero requirement with one clearly labeled,
project-controlled **AI-generated approved source plate**. Preserve the exact
canonical verification contract, server-only fal boundary, paid-call controls
and compact single-job P0.

Work autonomously in small verified slices. Do not mark this goal complete
until every definition-of-done item below has direct evidence.

## Current execution status — July 18, 2026

**Status:** Complete for the local AI-source successor objective. The golden
application job is `verified`; desktop and 390 × 844 mobile browser QA,
portable comparison media, the isolated no-spend replay, cross-document truth
review and every final settled local gate passed. No additional paid generation
is required or authorized.

The executed golden run is:

- job `ai_713a0e7a80b7410bbe6b6d3ef54f74b7`
- request `019f765d-0e8d-7551-afb4-941b02d355e6`
- endpoint `fal-ai/kling-video/o3/standard/video-to-video/edit`
- generation digest
  `d36a953ddf06959932fec2d4c5e0bbd1ea02c90724b193105f79344cdafc5f9e`
- one native paid POST with no automatic retry
- authenticated price `$0.14/seconds`
- estimated usage `5.041666667` seconds
- estimated cost `$0.7058333334`, which is not a confirmed charge
- budget state 3/3 used under the initial cap

The admitted clean proof reports 121/121 non-empty protected cores,
44,049,566 protected pixels, zero changed protected pixels, zero changed RGB
channel samples, maximum channel delta zero and 121/121 core-hash matches.
Deterministic recomposition, artifact integrity and the canonical contract
passed. The deliberate corruption fixture changed one protected pixel in one
channel by one value, produced 120/121 core-hash matches and failed correctly
without mutating the clean evidence.

The separate no-spend replay at
`artifacts/replays/ai-frm-01-kling-o3-no-spend-v1/canonical` reproduced all 121
generated-frame and composite-frame digests. Its canonical ZIP and H.264
preview were byte-identical to the original, its clean proof metrics matched
and its corruption fixture failed correctly. The replay left the active-job
pointer and every job-record hash unchanged. Exactly one job record carried a
`paidAttempt`, so the replay is not a second application transaction or fal
generation.

Independent visual review passed the result for the demonstration with narrow
limitations. FrameLock guarantees core exactness, not photometric relighting.
The four-pixel boundary ring is intentionally outside the claim, the neutral
object does not inherit the scene's cyan-magenta lighting, a minor halo and
contact mismatch remain and motion is restrained. The MP4 is a viewing
derivative, not proof.

## Authority and precedence

Use these files in this order:

1. This goal — the successor product objective, execution order and definition
   of done.
2. `docs/FRAMELOCK_PLAN.md` — authoritative media, compositor and verifier
   specification except where it requires a real-camera hero.
3. `docs/FAL_DOCUMENTATION_RESEARCH.md` — fal API and model evidence.
4. `docs/DECISIONS.md` — existing security, proof and failure-boundary
   decisions.
5. `docs/FRAMELOCK_BUILD_GOAL.md` — historical real-camera goal. Preserve it as
   provenance; do not overwrite or pretend it completed.

Where the old plan says `real-camera`, `newly shot`, `real product` or similar,
this goal replaces only that provenance requirement with `approved
AI-generated source plate`. All exact media, proof, safety and honesty
requirements remain in force.

If live evidence contradicts this goal, preserve the evidence, add a decision
trace and choose the narrowest truthful path. Never weaken the verifier, hide a
failed paid attempt or broaden a claim to rescue the demo.

## Product claim and provenance

The only green verification claim remains:

> Protected core verified — canonical pre-encode frame sequence.

The source-provenance label for this run is:

> AI-generated approved source plate — project-controlled fictional asset.

Do not imply that:

- the source was filmed by a camera
- the image generator or fal preserved the protected object
- the mask is semantically correct merely because it came from alpha or a model
- boundary pixels are exact
- the H.264 preview is lossless proof
- local manifests are externally signed or independently timestamped
- an AI-generated fictional asset establishes trademark or camera-original
  provenance

FrameLock proves equality to the approved canonical source plate, not that the
source itself is real, human-created or camera-original.

## Current verified baseline

Treat the current worktree and persisted evidence as authoritative and re-read
files before changing them. The goal began from a 102-test Python baseline and
a 241-test Node baseline, with LTX attempt 1 rejected, Kling attempt 2 accepted
for synthetic feasibility and one unused initial slot. Those facts remain
historical evidence, not current budget state.

The current state supersedes that starting baseline:

- AI-source attempt 3 completed through the real application state machine and
  job `ai_713a0e7a80b7410bbe6b6d3ef54f74b7` is `verified`.
- The paid budget reports 3/3 used. There is no next initial attempt.
- The golden request used one paid POST and no automatic retry.
- The clean proof and one-pixel negative control both behaved as required.
- The separately bound AI-source replay reproduced the proof without fal,
  `LocalJobStore` or paid-budget mutation.
- Legacy synthetic evidence remains historical regression evidence and is not
  relabeled as the AI-source job.
- Desktop and 390 × 844 mobile inspection covered the verified workspace,
  synchronized playback and red corruption state without horizontal overflow.
- Portable AI-source GIF and 24 FPS MP4 comparison derivatives now show the
  approved source, untrusted raw Kling result and FrameLock viewing preview.
- Final documentation reconciliation and the final settled test, typecheck,
  lint, build, compile, dependency, secret-scan and no-spend HTTP rerun passed.

## Frozen AI-source P0

### Hero concept

Use one fictional hero asset unless the user supplies a replacement before
source generation:

- Product name: **FRM-01**
- Form: rigid matte-black rectangular AI hardware module or product package
- Markings: large `FRM-01` label, small readable serial line and one geometric
  FrameLock symbol
- Framing: centered, three-quarter product view with the full silhouette clear
- Source environment: neutral dark-gray studio plate
- Lighting: soft frontal key with restrained edge light
- Rights boundary: no third-party logo, character, celebrity, brand design or
  recognizable proprietary product

Use this default environment direction:

> Locked camera: transform everything around the centered FRM-01 module into a
> rain-soaked neon greenhouse at night, with blue-magenta illumination,
> reflective wet surfaces and slow drifting mist, while keeping the module's
> position, scale and silhouette compatible with the source.

### Exact media envelope

- One approved source MP4
- 1280×720
- exactly 121 decoded frames
- 24/1 CFR
- strictly increasing timestamps with normalized residual no greater than 1 ms
- source construction intentionally assigns the one approved plate to 121
  distinct canonical time slots; all 121 decoded RGB24 frame samples must be
  byte-identical
- after that construction, no repair or normalization may insert, delete,
  duplicate, interpolate, remap or reorder frames
- no more than 50 MB
- no generated audio; the P0 preview may be silent
- one non-animated 8-bit grayscale PNG mask at 1280×720
- white means declared foreground to protect
- black means editable exterior
- a non-empty protected core must remain after the frozen four-pixel erosion

### Product scope

- One AI-generated approved source plate
- One static mask repeated across all 121 frames
- One fixed generator: `fal-ai/kling-video/o3/standard/video-to-video/edit`
- One active job and one variant
- One compact intake, approval, result and proof workspace
- One completed authorized paid fal generation under the final initial slot
- One separate no-spend reproducibility replay evidence tree derived from the
  persisted new result

Do not add automatic tracking, multiple generator routes, project CRUD, timeline
editing, arbitrary input formats, brush tools, public cloud persistence,
user-facing cancellation or a multi-model selector. BiRefNet, SAM 3 and SA2VA
remain outside P0.

## Execution plan — preserved procedure and status

Phases 0 through 8 are complete. The procedure below is
retained as provenance for how the run was authorized and executed; it does not
reopen paid generation or authorize another fal request.

### Phase 0 — re-establish current truth — completed

1. Inspect the worktree, ignored artifacts, active job store and current test
   results.
2. Re-read every file that will be changed.
3. Confirm `.env.local` remains ignored and never print any credential value.
4. Confirm the two historical paid attempts and remaining cap from persisted
   records.
5. Confirm the fixed Kling endpoint and schema-check procedure. Defer the
   authenticated pricing observation until Phase 4 so its freshness window
   begins immediately before the paid confirmation is prepared.

**Gate:** No source generation begins from stale repository or budget
assumptions. Pricing is not a prerequisite for local source construction; no
paid work begins from stale pricing evidence.

### Phase 1 — generate and approve the AI hero — completed

1. Use the available image-generation capability to create the fictional FRM-01
   hero as an isolated product image. Request transparent background when
   supported; otherwise use a flat, high-contrast neutral background.
2. Generate directly without calling fal. Preserve the original generated file
   unchanged.
3. Record a source-generation manifest containing:
   - exact image prompt
   - generator/tool identity to the extent exposed
   - creation timestamp
   - original filename, dimensions, content type, byte size and SHA-256
   - explicit `ai_generated_source` provenance label
4. Inspect the image visually at original resolution. Reject malformed text,
   cropped silhouette, unwanted brands, extra objects, transparency artifacts
   or geometry that cannot support a stable static mask.
5. If the first result fails, generate at most two additional image candidates,
   select one and preserve the rejected-candidate record without presenting it
   as the approved source.
6. The executor may make and record this local visual-approval decision against
   the frozen criteria without pausing for a separate user choice. Show the
   exact selected plate again at the paid-boundary confirmation; the user's
   digest-bound paid authorization then ratifies that exact source for upload.

**Gate:** One visually coherent, project-controlled fictional product is
explicitly approved and hash-bound as the source plate. A user rejection before
paid submission returns the work to local source generation and does not
authorize spend. Image generation success alone is not approval.

### Phase 2 — derive the canonical source and mask — completed

1. Preserve the approved generated image as immutable source provenance.
2. Deterministically composite or normalize it into a 1280×720 neutral studio
   plate without stretching the product.
3. Prefer a verified alpha channel to derive the initial foreground mask. If
   alpha is absent or unreliable, create a local deterministic mask and inspect
   it; do not add a fal masking call merely for breadth.
4. Persist the unmodified alpha or mask candidate separately from the confirmed
   binary foreground mask.
5. Create the non-animated grayscale PNG mask with exact white-foreground and
   black-exterior semantics.
6. Derive the frozen protected core, boundary ring and any generator-specific
   mask artifacts using the existing mask algebra. Fail if the core is empty.
7. Encode the approved plate into an exact silent 121-frame, 24/1 CFR source
   MP4. This construction intentionally places the same approved plate sample
   at 121 distinct canonical timestamps, so the decoded RGB24 frames must be
   byte-identical. Do not later duplicate frames to repair timing or frame-count
   drift.
8. Run the full local intake and source-proof pipeline. Record source, mask,
   canonical-frame and manifest hashes.
9. Produce a contact sheet or comparison view containing the approved generated
   image, normalized plate, foreground mask, protected core and boundary ring.

**Gate:** The exact source MP4 and static mask pass the existing application
contract before any fal upload. The mask is visually approved and its polarity
is proven.

### Phase 3 — reconcile product copy and contracts — completed

1. Add a decision trace documenting the AI-source pivot and why it better serves
   iterative AI-video production.
2. Update user-facing copy from `real-camera hero` or `real product` to
   `approved AI-generated source plate` where the shipped AI-source path is
   being described.
3. Keep historical real-camera documents and synthetic evidence intact. Label
   superseded requirements rather than rewriting history.
4. Update the submission description and storyboard around approval drift:
   - approved AI source
   - untrusted generative reshoot
   - deterministic restoration
   - exact canonical proof
   - deliberate corruption failure
5. Add or update tests that fail if the UI calls the source camera-made, real or
   model-preserved.

**Gate:** Product copy is truthful before the new paid result exists and cannot
misrepresent AI provenance.

### Phase 4 — prepare the paid boundary — completed

1. Run all local media and application checks before querying fal.
2. Recheck the current official Kling O3 Standard Edit schema without making an
   inference request.
3. Freeze the approved source, confirmed mask, prompt, endpoint and fixed
   parameters, then build their exact generation identity.
4. Immediately before preparing the paid confirmation, use the explicit
   no-generation pricing action to query the authenticated current price. Issue
   and persist a strict receipt bound to the job ID, generation digest, exact
   provenance-file SHA-256, fixed endpoint and canonical pricing observation.
   Do not reuse the recorded July 17 price, its digest or an observation
   collected during an earlier phase. The run action must never refresh price
   implicitly.
5. Present one compact confirmation containing:
   - source and mask previews
   - source, mask, provenance-file and generation SHA-256 values
   - exact prompt
   - fixed endpoint
   - current attempt index and cap
   - current billing unit, estimated units, estimated cost, observation time and
     pricing digest and receipt digest
6. Do not upload or submit until the user explicitly authorizes the exact
   generation and pricing digests with the required confirmation phrase.

**Gate:** Authorization must bind the current source, mask, provenance-file
bytes, prompt, endpoint, parameters and non-stale pricing evidence. General
approval such as `go ahead` does not authorize a different digest. Any change
to the frozen generation identity, provenance file or pricing observation
invalidates the prepared confirmation and requires a new receipt before upload.

### Phase 5 — execute one new fal reshoot — completed

After exact paid authorization only:

1. Use `FAL_KEY` server-side. Do not read, log, return or propagate
   `FAL_ADMIN_KEY`.
2. Upload the approved source through the server. Kling O3 Edit has no static
   protection-mask input, so do not imply the mask was sent to or obeyed by the
   model.
3. Submit exactly one native paid POST with no automatic retry and fal fallback
   disabled.
4. Persist the request ID and immutable paid-attempt snapshot before returning
   success.
5. Poll only the persisted request ID and download its completed output once.
6. Treat a definite rejection as failed and an ambiguous transport outcome as
   terminal `submission_unknown`. Never resubmit automatically.
7. Record actual request provenance and the final estimated or reported cost
   without exposing credentials or temporary URLs in client-visible output.

**Executed build-stop boundary:** The third and final initial attempt was
comparable and visually usable, so it advanced to verification. The cap is now
exhausted. Do not crop, stretch, resample, weaken comparability or spend a
fourth attempt without new explicit authorization.

### Phase 6 — review, restore and verify — completed

1. Decode the raw Kling result and enforce the exact frame, timing, dimension,
   aspect-ratio and timestamp contract.
2. Reject the job as `not_comparable` if it requires crop, stretch, frame
   insertion, deletion, duplication, interpolation or reordering.
3. Prepare and inspect source/raw overlays for frames 0, 60 and 120.
4. Require explicit geometry approval bound to the review-manifest hash and all
   three overlay hashes.
5. Persist all generated frames and hashes before composition.
6. Composite in linear light, blend only the boundary and overwrite protected
   core RGB24 bytes from the canonical source after blending.
7. Make the independent verifier reopen persisted source, generated, mask and
   composite artifacts from disk.
8. Require 121 non-empty core frames, zero changed protected samples, maximum
   delta zero, 121 core-hash matches and deterministic recomposition.
9. Publish proof evidence transactionally with the durable journal and
   commit-last marker.
10. Export the canonical 121-frame PNG ZIP, manifest, audit, protected-core
    image, boundary ring, deterministic heatmap and H.264 viewing preview.
11. Run the separate one-channel/one-pixel corruption fixture and require a red
    verdict without mutating the clean canonical artifacts.

**Gate:** No verified state or green claim exists until the Node service
independently admits the committed evidence.

### Phase 7 — prove application repeatability without extra spend — completed

1. Complete the new AI-source job once through the real application state
   machine from validated intake to admitted `verified` evidence.
2. Create a separate, explicitly labeled no-spend replay evidence tree outside
   `artifacts/jobs` from the same persisted source and raw model result. Treat
   the original job artifacts as read-only inputs.
3. Never create or clone a `LocalJobRecord`, copy the request ID into another job
   record, reserve an attempt or transition the application state machine for
   the replay. Those actions would misstate provenance and distort the global
   paid-attempt ledger.
4. Re-run review preparation, approval binding, finalization, exports and
   corruption evidence into the new immutable replay tree. Generate new
   manifests for its new absolute paths; do not copy or rename the original
   committed canonical directory.
5. Independently validate the replay's commit marker and all bound evidence in
   read-only mode without admitting a second application job.
6. Require deterministic canonical metrics and validate every new commit output.
7. Do not call the replay a second fal generation or a second paid application
   transaction.

**Gate:** One fresh paid application run and one separately hash-bound no-spend
replay evidence tree pass. The replay must leave `LocalJobStore`, the active-job
pointer and the paid-attempt budget unchanged. A literal second fresh generation
remains outside the initial cap and requires expanded authorization.

### Phase 8 — inspect the product and finish the package — completed

1. **Completed for the terminal evidence surfaces:** inspect at desktop and
   mobile widths:
   - verified success workspace
   - protected-core, boundary and heatmap views
   - canonical exports
   - deliberate corruption failure

   Fresh intake, exact paid confirmation and generated/review transitions are
   covered by the automated state-machine suite and preserved records, not
   claimed as new terminal-job browser captures. Do not reconstruct them by
   mutating or resubmitting the verified job.
2. **Completed:** check browser console errors, media playback, synchronized
   frame selection, overflow and misleading copy.
3. Capture portable source/raw/composite comparison media from the new AI-source
   golden run. **Completed:** the local GIF and 24 FPS MP4 are viewing
   derivatives and are not proof.
4. Update README, architecture, submission description, demo storyboard, exact
   request ID, cost, hashes, limitations and human handoff.
5. Keep the H.264 artifact labeled as a lossy viewing derivative.
6. Run the full settled verification suite after every implementation change:
   - Python tests with all fal credential variables removed
   - Node tests
   - TypeScript
   - ESLint
   - production build
   - Python compilation
   - locked offline dependency checks
   - source-visible secret scan
   - no-spend HTTP smoke checks
7. Re-read the final diff against this goal and remove unrelated changes.

## Required evidence

### AI-source provenance

- Original generated hero image and SHA-256
- Exact image-generation prompt and available tool metadata
- Explicit AI-generated provenance label
- Normalized 1280×720 plate and SHA-256
- Exact 121-frame source MP4 and source-proof manifest
- Confirmed foreground mask, protected core and boundary visualizations
- Visual approval record for the source and mask

### fal provenance

- Exact endpoint and request ID
- Exact video prompt and fixed parameters
- Source upload binding without exposing temporary URL to the client
- Fresh pricing observation, digest, attempt index, cap and estimated cost
- One explicit paid authorization bound to the generation digest
- Raw downloaded model output and SHA-256
- Definite failure or `submission_unknown` behavior if applicable

### Canonical proof

- Review manifest and overlays for frames 0, 60 and 120
- Geometry approval bound to exact overlay hashes
- Proof manifest and independent audit
- 121/121 non-empty protected-core frames
- zero changed protected pixels and channel samples
- maximum protected-core channel delta zero
- 121/121 core hash matches
- deterministic recomposition passed
- valid commit-last marker and all bound outputs
- structurally valid canonical-frame ZIP
- failed one-channel/one-pixel corruption audit
- one separately bound no-spend replay evidence tree outside `LocalJobStore`

### Product evidence

- Browser-inspected success and corruption states
- Portable AI-source/raw/composite visual
- Truthful AI-source copy throughout the product and docs
- Final tests, build and security checks
- Exact limitations and all remaining external actions

## Cost, secret and external-action boundaries

- Validate locally before every external call.
- The one authorized AI-source Kling request is complete. Do not make another
  paid fal request under this goal.
- The initial paid cap is exhausted at 3/3. A fourth attempt requires a new,
  explicit authorization and expanded cap.
- Do not use a BiRefNet, SAM 3, SA2VA or additional image/video fal call without
  separate user authorization.
- Never print or expose `FAL_KEY` or `FAL_ADMIN_KEY`.
- Use `FAL_KEY` only in server-only runtime modules. Leave `FAL_ADMIN_KEY`
  unused unless a specific admin-only operation is justified and separately
  authorized.
- Do not create a remote repository, commit, push, deploy, upload demo media or
  submit to the hackathon without explicit user authorization.
- Do not use third-party IP, brands, characters, celebrity likenesses or
  unlicensed source media.

## Definition of done

Current evidence resolves the definition of done as follows:

- [x] One project-controlled fictional AI hero has source-generation
  provenance and visual approval.
- [x] Its canonical 1280 × 720, 121-frame, 24/1 source and static mask pass the
  frozen intake contract.
- [x] One authorized Kling O3 Standard Edit result is visibly transformed and
  passes the exact comparability contract.
- [x] The raw result, restored canonical composite and mask bind to the same
  request and generation digest.
- [x] All 121 non-empty canonical protected cores report zero changed samples,
  maximum delta zero and matching hashes.
- [x] Deterministic recomposition and committed-evidence admission pass.
- [x] The independent one-channel/one-pixel corruption fixture fails visibly.
- [x] A separately hash-bound no-spend replay reproduces the proof without a
  fal request, cloned `LocalJobRecord` or paid-budget mutation.
- [x] The AI-source success, proof, synchronized playback and corruption states
  have desktop browser evidence.
- [x] Inspect the verified and corruption states at mobile width and complete
  the remaining responsive browser checks.
- [x] Runtime product copy says `AI-generated approved source plate` and does
  not imply camera provenance or model-native preservation.
- [x] Finish cross-document reconciliation so the README, description, demo
  storyboard, request and cost evidence, limitations and handoff match the
  executed run.
- [x] Rerun every final test, typecheck, lint, build, compile, dependency,
  secret-scan and no-spend HTTP gate from the settled worktree.
- [x] Every unperformed external publication or submission action remains
  explicit and unauthorized.

The local AI-to-AI approval-drift demonstration and its closeout are complete
and verified. Creating a commit, pushing, deploying, publishing media,
uploading a demo or submitting to the hackathon remains a separate
human-authorized action.
