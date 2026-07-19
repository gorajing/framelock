# FrameLock decision trace

## Supported JavaScript runtime

**Decision:** Pin Node.js 24.18.0 LTS and pnpm 10.33.0 for the application toolchain.

**Reason:** The machine's pre-existing Node 25 runtime is end-of-life. A passing build on an unsupported runtime is weak evidence for a reproducible hackathon repository.

**Evidence:** Node's official release schedule, Next.js 16's Node requirements and `.node-version`.

**Rejected:** Continuing on Node 25 because the initial scaffold happened to compile.

**Gate:** Run lint, typecheck, tests and the production build with `/opt/homebrew/opt/node@24/bin` first on `PATH`.

## Offline proof before product UI

**Decision:** Prove deterministic media validation, compositing and independent verification with synthetic fixtures before paid inference or product-flow UI.

**Reason:** FrameLock's differentiator is the guarantee, not the upload form or the model wrapper. Building the verifier first makes the most important failure observable before external model behavior enters the pipeline.

**Evidence:** `docs/FRAMELOCK_BUILD_GOAL.md`, sections “Execution loop” and “Required verification.”

**Rejected:** Building a polished multi-step interface first.

**Gate:** Passed by the 102-test Python suite with fal credentials removed. Proof schema v2 binds all generated frames and deterministic recomposition; review evidence binds pre-approval overlays, while source audio is bound only by review schema v2 and run schema v6. The independent verifier rejects a one-channel, one-pixel protected-core corruption.

## Canonical color and quantization

**Decision:** Treat canonical RGB24 samples as full-range nonlinear R'G'B' using the BT.709 transfer curve. Decode to linear light for boundary blending, encode through the BT.709 forward curve, clamp and quantize with `floor(value * 255 + 0.5)`.

**Reason:** “Linear-light blending” and “specified rounding” are not executable until both the transfer function and byte quantization are frozen. Explicit rules keep Python, future TypeScript code and audit fixtures byte-consistent.

**Evidence:** `docs/FRAMELOCK_PLAN.md`, Stage E; independent specification audit on July 17, 2026.

**Rejected:** OpenCV's implicit BGR arithmetic, gamma-space blending and implementation-defined rounding.

**Gate:** Asymmetric RGB sentinel tests must detect BGR/RGB swaps, and threshold fixtures must prove the chosen BT.709 branches and half-up quantization.

## Manifest-bound independent verification

**Decision:** The verifier reopens persisted source, core-mask and composite artifacts in manifest order and validates their frozen hashes before comparing protected bytes.

**Reason:** Comparing only the current source and output can false-pass if both are changed. Glob ordering can also silently omit, add or reorder frames.

**Evidence:** `docs/FRAMELOCK_PLAN.md`, Stage F; independent specification audit on July 17, 2026.

**Rejected:** Auditing the compositor's in-memory arrays or discovering frames with an unordered filesystem glob.

**Gate:** Missing, extra, reordered, mutated-source, mutated-mask and protected-output corruption fixtures must all fail loudly.

## P0 mask algebra

**Decision:** Threshold grayscale values `>= 128` into foreground `F`; derive protected core `C` with one 9×9 elliptical erosion (radius 4, constant-zero border); define boundary `E = F AND NOT C`; derive LTX edit mask `M = 255 - F`; and set straight alpha to zero outside `F`, one inside `C` and `clip(distanceTransform(F, L2, 5) / 4, 0, 1)` inside `E`.

**Reason:** The full foreground, protected core, seam and generator edit region have different meanings. Freezing their relationship prevents a polarity or erosion change from silently moving the guarantee boundary.

**Evidence:** `docs/FRAMELOCK_PLAN.md`, mask types and Stage B; independent specification audit on July 17, 2026.

**Rejected:** Reusing the eroded core as the LTX preserve mask, accepting arbitrary nonzero mask bytes or leaving morphology parameters implicit.

**Gate:** Tests cover the 127/128 threshold, `C ⊆ F`, `C ∩ E = ∅`, `C ∪ E = F`, white-regenerate/black-preserve polarity, empty eroded core and a full-frame foreground with no editable exterior.

## Narrow server-only fal boundary

**Decision:** Keep all fal access in modules guarded by `import "server-only"` and expose narrow job Route Handlers. Use `@fal-ai/client` for server-side storage and read-only queue operations, not for the paid submission POST. Do not install the generic browser proxy.

**Reason:** The browser must not select arbitrary endpoints, supply request IDs or gain a general paid fal tunnel. P0 has one selected endpoint and one local job.

**Evidence:** Current fal client/proxy documentation and `docs/FAL_DOCUMENTATION_RESEARCH.md`.

**Rejected:** `@fal-ai/server-proxy` with its backward-compatible all-endpoint, unauthenticated defaults.

**Gate:** Client-visible code contains no `FAL_KEY`, `FAL_ADMIN_KEY`, fal upload URL or caller-supplied endpoint; the build rejects server-only imports from the client graph. The legacy synthetic Kling module exposes historical polling only and exports no paid submission capability.

## Live generator selection

**Decision:** Reject LTX 2.3 Quality Inpaint attempt 1 and select Kling O3 Standard Edit attempt 2 for the historical synthetic feasibility run.

**Reason:** The LTX result contained 121 frames at 24/1 FPS but rendered at 1280 × 768 with a 5:3 display aspect ratio. Cropping or stretching it would change geometry and invalidate the P0 comparison contract. Kling returned 1280 × 720, 121 frames at 24/1 FPS and passed the automatic comparability gate plus visual geometry review at frames 0, 60 and 120.

**Evidence:** LTX estimated cost `$0.268468992`; Kling estimated cost `$0.705833`; selected Kling request ID `019f72e4-5e1e-7143-bf91-e3aac20328da`.

**Rejected:** Normalizing the LTX result with crop or stretch, or presenting it as comparable because its frame count and rate happened to match.

**Gate:** A model result must meet the frozen geometry and timing contract without prohibited normalization before it can reach composition.

## Stop after the second paid attempt

**Decision:** Do not spend the third approved feasibility attempt.

**Reason:** Kling attempt 2 met the contract and produced an unmistakable environment change while keeping the subject geometry stable enough for the proof demo. A third generation might improve aesthetics, but it would not materially strengthen the byte-equality claim.

**Rejected:** Spending the remaining attempt to chase a more seamless beauty shot.

**Gate:** Reopen paid inference only if a concrete acceptance failure cannot be resolved locally and explicit authorization still permits the spend.

**Successor note:** This remains the correct historical decision for the synthetic feasibility run. The accepted AI-source successor below does not itself authorize spend; it conditionally supersedes this stop only at the exact paid boundary it defines.

## Accepted AI-source successor for the final initial slot

**Status:** Accepted and executed on July 18, 2026.

**Decision:** Preserve the stop-after-attempt-2 decision as historical truth for synthetic feasibility, but conditionally reopen attempt 3 solely for the AI-source golden run defined by `docs/FRAMELOCK_AI_SOURCE_BUILD_GOAL.md`. The older stop was superseded only after the approved source, restoration mask, prompt, endpoint and fixed parameters were frozen, all local gates passed, a fresh authenticated pricing observation and canonical digest were captured immediately before confirmation and the user explicitly authorized those exact generation and pricing digests with the required phrase. At that decision point, acceptance itself was not paid authorization; attempt 3 remained closed until every condition passed.

**Reason:** The earlier stop correctly rejected spending for aesthetic iteration after the synthetic primitive passed. At acceptance, the successor product had a different, concrete unmet requirement: directly demonstrating the AI-to-AI approval-drift workflow with one project-controlled AI-generated source plate. That evidence could not be created by relabeling the historical synthetic result or by local replay alone.

**Evidence:** `docs/FRAMELOCK_AI_SOURCE_BUILD_GOAL.md`; the historical LTX and Kling outcomes remain unchanged. The exact AI-source generation identity was `d36a953ddf06959932fec2d4c5e0bbd1ea02c90724b193105f79344cdafc5f9e`, the fresh pricing digest was `5edd96d046ec978a45589166b06613c5cf0ddd2dc36b8aa3d0f4aa0734b42798` and the receipt digest was `f6531b0bf89451cce00ab258367b9c87f69f655eac984d89dbf0a8bacb441c04`.

**Rejected:** Treating this decision, a general `go ahead`, a stale price digest or remaining budget capacity as authorization; using attempt 3 for beauty-shot iteration; automatically retrying an ambiguous submission; or making a fourth paid request without separately expanded authorization.

**Execution gate:** Before upload, the budget reported `used: 2`, `next: 3`, `cap: 3`; current pricing and every displayed digest matched the server-bound values; and the user supplied the required digest-bound confirmation. Submission then used one native POST with no automatic retry and fal fallback disabled. The run consumed attempt 3 and closed the initial cap at 3/3.

## Attempt 3 AI-source golden run and closed budget

**Decision:** Admit job `ai_713a0e7a80b7410bbe6b6d3ef54f74b7` as the AI-source golden run and close paid generation under the initial three-attempt cap.

**Reason:** The single Kling result visibly transformed the environment, met the frozen 1280 × 720, 121-frame, 24 FPS contract without prohibited normalization and passed the independent canonical verifier after explicit geometry approval at frames 0, 60 and 120.

**Evidence:** Endpoint `fal-ai/kling-video/o3/standard/video-to-video/edit`; request ID `019f765d-0e8d-7551-afb4-941b02d355e6`; one paid POST with no automatic retry; paid-attempt digest `a86acc227e33f8788fa95af5e017431e358fb63deafa45da1203b47020b2e775`. Authenticated pricing was `$0.14/seconds`, with estimated usage of `5.041666667` seconds and estimated cost of `$0.7058333334`. This is an estimate, not a confirmed charge.

**Proof:** All 121 frames had non-empty protected cores. Across 44,049,566 protected pixels, the audit found zero changed protected pixels, zero changed protected RGB channel samples, maximum channel delta zero and 121/121 core-hash matches. Deterministic recomposition, artifact integrity and the canonical contract passed. A separate fixture changed one protected pixel in one channel by one value, produced 120/121 core-hash matches and correctly failed without mutating clean evidence.

**Rejected:** Treating an estimate as a confirmed fal charge, calling the H.264 preview proof, weakening the comparability gate, silently retrying the paid POST or making another paid generation under the exhausted initial cap.

**Gate:** Passed. The application independently admitted the committed evidence and persisted the job as `verified`. No additional paid fal generation is needed or authorized under the initial cap.

## AI-source no-spend reproducibility replay

**Decision:** Reproduce finalization in `artifacts/replays/ai-frm-01-kling-o3-no-spend-v1/canonical` from the persisted source and raw Kling output while leaving `LocalJobStore` and the paid-attempt ledger untouched.

**Reason:** Repeatability evidence is useful only if it does not fabricate another paid request, clone an application job or distort the global attempt budget.

**Evidence:** All 121 generated-frame digests and all 121 composite-frame digests matched the golden run. The canonical ZIP and H.264 preview were byte-identical, clean proof metrics were identical and the separate corruption fixture failed correctly. Before and after replay, the active-job pointer and every job-record hash were unchanged and exactly one job record carried a `paidAttempt`.

**Rejected:** Copying the committed canonical directory, creating a second `LocalJobRecord`, reserving another attempt, calling fal or presenting the replay as a second application transaction.

**Gate:** Passed. The replay produced independently bound manifests for its own paths and reproduced the verifier result without network spend or job-store mutation.

## Visual acceptance remains narrower than exactness proof

**Decision:** Accept the AI-source golden result as a visual PASS for the FrameLock demonstration while keeping aesthetic and photometric quality outside the protected-core guarantee.

**Reason:** The greenhouse transformation is clear and the restored FRM-01 identity is stable, but the restoration intentionally preserves the neutral approved plate rather than inventing scene-consistent light inside the protected core.

**Evidence:** Independent visual review found a noticeable neutral-object versus cyan-magenta-environment relighting mismatch, a minor thin halo or hard transition in the excluded four-pixel boundary ring, an imperfect pedestal/contact match and restrained motion. The MP4 remains a lossy viewing derivative.

**Rejected:** Calling the result seamless, commercially finished, physically relit, model-preserved or camera-original.

**Gate:** Product and submission copy must say that FrameLock guarantees protected-core identity pixels, not photometric relighting, and that the narrow boundary ring is intentionally outside the exactness contract.

## Immutable paid-attempt provenance and global budget

**Decision:** Issue an immutable server-side pricing receipt that binds the job ID, generation digest, provenance-file SHA-256, fixed endpoint and canonical current-price observation before asking for paid consent. At submission, capture attempt index, cap, current unit price, billing unit, estimated units, estimated cost, pricing source and observation/capture timestamps in one immutable paid-attempt digest. Reserve the attempt under a single store-root lock that covers a fresh global budget scan plus the job transition to `submitting`.

**Reason:** A per-job lock cannot enforce a global spend cap. Two jobs could otherwise observe the same remaining slot and both submit. Reconstructing price evidence later would also make the audit depend on mutable market data.

**Rejected:** A read-then-write budget check outside the submission transition, an in-memory counter, hardcoded attempt/price values in final evidence, a client-authored price or a receipt that omits the final provenance-file bytes.

**Gate:** With two attempts already consumed, two distinct jobs racing for attempt 3 produce exactly one reservation and one fake submission; the loser receives `PAID_ATTEMPT_CAP_REACHED` before upload.

## At-most-once paid submission boundary

**Decision:** Perform the paid queue submission with exactly one native `fetch` POST, send `X-Fal-No-Retry: 1`, disable fal fallback and never automatically retry an ambiguous submission.

**Reason:** The fal SDK's submit helper can retry transport and selected server failures, while fal provides no documented idempotency key for this call. If fal accepts a request but the response is lost, retrying can create a second paid job.

**Evidence:** The local job transitions to `submitting` before the network call. A definite 4xx rejection becomes `failed`; a transport error, retryable HTTP status, malformed success response or otherwise uncertain outcome becomes terminal `submission_unknown`.

**Rejected:** Treating a lost response as a safe retry, or relying on an in-process lock as proof of remote idempotency.

**Gate:** Tests assert one network invocation on success, rejection, HTTP uncertainty, transport failure and malformed response. An operator must reconcile `submission_unknown` out of band rather than resubmit it.

## Current pricing evidence before spend

**Decision:** Refresh pricing only through the explicit no-generation pricing action, persist the strict server-issued receipt locally and reject observations older than 24 hours or dated later than the server's current time before checking generation credentials, uploading media, reserving an attempt or calling fal. The run action never refreshes or substitutes a price implicitly.

**Reason:** Binding a digest proves which price was confirmed, not that the observation was current when the user authorized spend. A stale but correctly hashed price could otherwise cross the paid boundary.

**Rejected:** Treating a matching pricing digest as sufficient forever or refreshing price after an attempt has already been reserved.

**Gate:** Stale and future-dated observations return HTTP 409 with `PRICING_OBSERVATION_NOT_CURRENT`, make zero fal generation-adapter calls and leave the global budget unchanged. A missing, tampered or cross-generation receipt fails before credential validation, upload or reservation. A new human confirmation must bind the newly issued pricing digest.

## Owned synthetic diagnostic fixture

**Decision:** Use the current synthetic vector clip as a diagnostic fixture and label it as such everywhere.

**Reason:** The fixture is owned, deterministic and visually exposes geometry, mask polarity, boundary behavior and protected-core corruption. It is strong evidence for the invariant but weak evidence for commercial realism.

**Rejected:** Calling the fixture a real-camera hero, customer asset or production reshoot.

**Gate:** Submission copy must separate technical proof from aesthetic quality and must not imply deployment, public release or real-camera validation.

## Read-only compatibility evidence

**Decision:** A fresh clone opens on real-job intake. Historical synthetic evidence appears only when a persisted verified legacy record and its bound artifacts already exist; rendering the home page does not reconcile or mutate that evidence.

**Reason:** Startup should not fabricate a completed run, trigger background state changes or imply that ignored local artifacts ship with the repository.

**Rejected:** Auto-seeding a demo job, reconciling proof during a read-only page render or treating the legacy projection as a hardened real-job success.

**Gate:** Fresh-store, matching-legacy, missing-evidence and corrupt-evidence tests fail closed, while browser copy labels the projection as legacy synthetic proof.

## Canonical frames are the trust root

**Decision:** Make the persisted pre-encode RGB24 sequence the verified artifact. Label the H.264 output `H.264 preview — not lossless proof`.

**Reason:** Lossy video encoding can alter reconstructed pixels. The current audit proves exact equality before encode; the preview is only a convenient viewing derivative.

**Rejected:** Showing the encoded preview with an unqualified “pixel-perfect” or “verified video” claim.

**Gate:** The UI and submission materials use the exact narrow claim and state that the preview, seam, relighting, mask correctness and downstream transcodes are outside it.

## Transactional final evidence publication

**Decision:** Prepare review evidence in a hidden sibling directory and publish it with an atomic rename. Finalization writes a durable journal, records exact file and directory-tree digests and publishes `.finalization-committed.json` last. The Node service independently revalidates the committed evidence before changing job state to `verified`.

**Reason:** A process can die after writing only part of the proof. File existence alone cannot distinguish a complete proof from a partial or foreign directory.

**Rejected:** Writing directly into the visible canonical directory, promoting from Python's success exit code alone or retrying over unowned files.

**Gate:** Process-death tests cover partial composite, archive/corruption, run-manifest and post-marker states. Malformed journals, foreign paths, marker tampering and output drift fail closed.

## Durable canonical-verification failure

**Decision:** After human approval, a typed canonical finalization or evidence-integrity rejection becomes the terminal `failed` state with one allowlisted canonical failure code. Ambiguous child-process crashes and timeouts remain generated and unverified rather than being misclassified.

**Reason:** A proof failure must survive reload and be visible without persisting raw paths, exceptions or stderr. Ambiguous execution failure is not evidence that the canonical contract itself failed.

**Rejected:** An unreachable UI-only `verification_failed` state, swallowing proof errors or downgrading an already verified job.

**Gate:** Provenance-bound transitions accept only `CANONICAL_FINALIZATION_REJECTED`, `CANONICAL_EVIDENCE_INVALID` or `CANONICAL_EVIDENCE_INCOMPLETE`; safe views expose no raw exception data.

## Source audio is delivery-only evidence

**Decision:** Disable and discard model audio. Bind the exact source-audio manifest and normalized PCM hash into review and run evidence, then use only that source-derived audio in the H.264 preview.

**Reason:** Generated audio is not part of the protected-pixel proof and could silently change the meaning of the approved source. Keeping one deterministic local policy prevents the video claim from expanding into an audio claim.

**Rejected:** Preserving Kling audio, silently substituting generated audio or describing a preview with unbound audio as verified.

**Gate:** Review schema v2 and run schema v6 require exact audio bindings. Run schema v5 is the no-audio visualization-bound form; both v5 and v6 bind the protected-core, boundary-ring and deterministic frame-60 heatmap assets. Legacy schemas remain read-only compatibility evidence.

## Hash-bound artifact delivery

**Decision:** Serve only fixed asset names whose SHA-256 is bound to the job or an anchored manifest. Reject symlinks and non-regular files, validate from an opened descriptor and stream ranges from that same descriptor. Validate the canonical ZIP structure, ordered entries, timestamps, CRCs and hashes before exposing it.

**Reason:** A safe-looking path is not enough if a file or ancestor can be replaced between validation and delivery, and an archive hash alone does not prove its contents are the canonical 121-frame set.

**Rejected:** Arbitrary path parameters, whole-file buffering, path-only validation or trusting ZIP filenames without parsing local and central records.

**Gate:** Media, range, symlink, root-containment, archive-tamper and cross-language Python-to-Node ZIP tests pass.

## Motion v1 replaces the static asset as the submission hero

**Decision:** Preserve the verified static FRM-01 job as immutable fallback
evidence and build one isolated moving-character golden proof as the intended
hackathon hero. Do not generalize the existing static job workflow before the
deadline.

**Reason:** The static result proves FrameLock's invariant but visually resembles
a basic background composite. One moving approved performance makes temporal
tracking, generative identity drift, frame-specific restoration and exact audit
visible in the demo. The current verifier already binds and audits a distinct
core mask for every frame, so an isolated motion adapter can reuse the trusted
kernel without migrating the static schema.

**Evidence:** `docs/FRAMELOCK_MOTION_BUILD_GOAL.md`; the Developer Track rewards
creativity, user value, technical execution and demo quality; the existing
`freeze_ingest_manifest()` and persisted-frame audit accept per-frame core-mask
paths.

**Rejected:** Submitting the stationary box as the only hero, attempting a
general arbitrary-character platform, or rewriting the existing static job
store and proof contracts under the submission deadline.

**Gate:** Motion v1 must produce one 1280 x 720, 121-frame, 24 FPS character
reshoot with 121 approved temporal masks, zero changed protected samples and a
failing one-value corruption control while every frozen static artifact remains
unchanged.

## Separate user-authorized Motion v1 fal budget

**Decision:** Keep the initial static `3/3` ledger immutable and establish a
separate Motion v1 ceiling of $100 estimated fal cost. Optimize candidate
selection for visual quality rather than minimum spend while preserving live
price evidence, durable request identities and at-most-once paid submission.

**Reason:** The user explicitly authorized the available $100 credit balance for
the moving-character hero. Reopening or editing the historical ledger would
weaken existing evidence, while removing retry and provenance controls would
risk duplicate remote charges without improving quality.

**Rejected:** Treating the initial attempt cap as the Motion v1 budget, silently
retrying an ambiguous fal request, spending without cumulative evidence or
minimizing generation attempts at the expense of the hero result.

**Gate:** Every Motion v1 paid request records endpoint, input identity, current
price evidence, estimated units, estimated cost and remote request ID or
`submission_unknown`; cumulative estimated cost never exceeds $100.
