# FrameLock local definition-of-done audit

## Verdict

**Motion v1 moving-character hero: locally complete.**

**Canonical 121-frame protected-core proof: passed.**

**Bound frame-60 one-channel negative control: caught.**

**Four-view desktop and mobile browser behavior: observed working.**

**Public release, deployment and hackathon submission: not performed.**

The current FrameLock hero is no longer the static object demonstration. Motion v1 preserves an approved moving FRM-01 character performance while reshooting its world:

> Generate an AI character performance once. Reshoot its world without rerolling the approved performance.

The historical static AI-source job remains an immutable fallback. Its proof, job records and original `3/3` paid-attempt ledger are not part of the Motion ledger and were not reset.

## Definition-of-done matrix

| Requirement | Status | Direct evidence | Remaining boundary |
| --- | --- | --- | --- |
| One approved moving source under the exact media contract | **Passed** | Canonical source is 1280 × 720, 121 frames and 24 FPS. | The source is project-controlled AI media, not camera-original footage. |
| One ordered moving mask sequence | **Passed** | The temporal matte binds 121 ordered soft masks and edit masks. Every frame yields a non-empty four-pixel-eroded core. | The tracker proposes the mask. Semantic correctness still requires human review; no reviewer attestation is bound. |
| One visually strong fal-generated replacement world | **Passed** | Kling O3 Standard image-to-video request `019f7806-2b52-7062-89b0-98eb664401e6` produced the selected neon transit world. | The generated world is admitted as background evidence, not proof that the model preserved the character. |
| Exact protected-core equality on every canonical frame | **Passed** | 121/121 frames and 8,390,666 protected-core pixels audited; zero changed pixels, zero changed RGB channel samples and maximum delta zero. | The boundary ring and MP4 preview are outside the exactness claim. |
| Deterministic composition and artifact admission | **Passed** | The admission reopens its bound evidence and reports deterministic recomposition passed. | Local manifests are not externally signed or timestamped. |
| Independent corruption fixture fails | **Passed** | Frame 60 changes one protected pixel in one RGB channel by one value. The verifier catches it without mutating the clean evidence. | This validates the represented protected-core invariant, not mask semantics. |
| Isolated Motion demo works | **Passed for local demo** | `/motion-demo` renders approved source, generated world, moving mask and verified reshoot. Final production-browser smoke loaded all four 1280 × 720 videos at 5.041667s, observed desktop and mobile layout without horizontal overflow and caught the frame-60 corruption challenge. | Re-run rendered QA after any future evidence-binding or packaging change. |
| Portable demo evidence package | **Passed** | A 1.7 MB secret-free mirror binds the admission, clean proof, temporal matte, mask-preview provenance and negative-control chain without bundling the ignored canonical frame tree. | The mirror projects an already-admitted proof; it does not replace the full local trust root. |
| Static fallback remains immutable | **Passed** | The prior verified job, static proof and `3/3` attempt ledger remain historical fallback evidence. | Never relabel the static ledger as Motion spend. |
| External publication is explicit | **Passed for the current boundary** | No public-repository, deployment, public-media, upload or submission claim is made. | A human separately authorizes every external action. |

## Motion v1 identity

| Evidence | Value |
| --- | --- |
| Demo route | `/motion-demo` |
| Source contract | 1280 × 720, 121 frames, 24 FPS |
| Selected fal endpoint | `fal-ai/kling-video/o3/standard/image-to-video` |
| fal request ID | `019f7806-2b52-7062-89b0-98eb664401e6` |
| Canonical source SHA-256 | `9882dceb76ad0b8954c92f8c8e8b9f00ea4e7812ea96a4f0307c1fa916611dc6` |
| Canonical source-decode digest | `8380bc32f44097c560c588ca2ba4f74d57c16a9495e8f407b527640ed7c4f781` |
| Temporal-matte manifest digest | `f39d99ff9462cf730ef1cee1c28c7dc7ec250ac5d376c3d35f308fa584817d18` |
| Raw selected-world SHA-256 | `7fbd1b3fab9777f62fd4ce44cdbda7da0aea4d4e9eff413e14a8e3d65ad3cd88` |
| Canonical generated-world SHA-256 | `9a48ef083d205d9be00051a80cfa6a8bb2eb923e62bd692e8a7bf7ff58d18610` |
| Motion admission digest | `8b4965dd822d1149fc31433ed5aac55749ad97dc2a2d591229ed910544111c93` |
| Motion admission file SHA-256 | `16ec56b5a187b5c91b473c0be9697858828f492b78dbb3b50f0a22f3d459d8e8` |
| Admitted viewing-preview SHA-256 | `8f4cdf46a57898ea2d3bfa60605346efb1b2a3ad1cece8217fbf8bd1ac7f9850` |

The selected raw background window uses source frames 1 through 121 inclusive and was normalized to the canonical contract without temporal interpolation. The selected world contains no second character or foreground occluder crossing the approved performance.

## Clean canonical proof

The frozen claim is:

> Protected core verified — canonical pre-encode frame sequence.

| Metric | Result |
| --- | ---: |
| Frames audited | 121/121 |
| Total protected-core pixels | 8,390,666 |
| Changed protected pixels | 0 |
| Changed protected RGB channel samples | 0 |
| Maximum protected-core channel delta | 0 |
| Deterministic recomposition | Passed |

The protected region varies with the moving character. Each frame's bound mask is eroded by four pixels before the exact equality check. Soft alpha blending is used outside that core, so a visually blended boundary can coexist with a mathematically exact protected interior.

The MP4 preview independently represents the accepted sequence for viewing, but lossy encode prevents it from serving as byte-equality proof. The canonical pre-encode frames and audit carry the claim.

## Bound negative control

| Evidence | Value |
| --- | --- |
| Fixture | frame 60, one protected pixel, one RGB channel, delta 1 |
| Observed result | `FAIL` / `CAUGHT` |
| Clean evidence mutated | `false` |
| Corrupted-frame SHA-256 | `a70b5deb2adfbb4e54a38e2b063dabf017bbe7540109388619d551015093b826` |
| Corrupted-frame RGB SHA-256 | `711df5deb5c0796d855a2fa7691e046e5f54aa9833704707abc1d4120e42a89e` |
| Corrupted protected-core SHA-256 | `aaa19593c670ff9c9df516271549198d3d151c917de488bef86f97c007d451df` |
| Corruption-manifest SHA-256 | `a98a6bd6876456cd784127f61367449cc904c269d41d313113f8bed5efc5a3f6` |
| Corruption-audit SHA-256 | `d77c6cb1a4c2cd6b34931254d479ce8d7156974f83ba300e7abc110182be369a` |
| Corruption-summary SHA-256 | `0f0369863fc1d4336cf63efebd93190f9bcd5815d1b0c29914add80dd56f66ad` |

The schema-2 summary joins the shipped corrupted PNG's file and decoded RGB identities to the frame-60 output-core hash measured by the audit. This control proves that the evidence path rejects the smallest represented protected-core corruption. It does not prove the tracker's semantic judgment or boundary quality.

## Browser QA

The final local production `/motion-demo` route was inspected at desktop and mobile widths:

- approved source, generated world, moving mask and verified reshoot all loaded
- all four videos loaded as 1280 × 720, 5.041667-second assets
- the clean evidence rendered as admitted
- the frame-60 corruption challenge rendered as caught with one changed protected channel sample
- main page and ranged media requests returned successful responses
- no browser console errors or warnings were observed
- desktop and mobile layouts had no horizontal overflow

These observations apply to the local route. They are not evidence of a remote deployment or public availability.

## Motion spend boundary

| Field | Value |
| --- | ---: |
| Separate Motion budget ceiling | $100.00 |
| Reserved estimated cost | $7.66575 |
| Estimated remaining | $92.33425 |
| Confirmed invoice total | Not available |

The ledger is an estimate and must not be presented as a confirmed bill. The remaining credit estimate does not weaken the selected result and does not require more generation.

## Verification boundary

Final-tree verification passed on the local machine:

| Gate | Final result |
| --- | --- |
| Python proof/media suite | `204 passed in 1523.75s` |
| Vitest | `61 passed`, `475 passed` |
| TypeScript | `tsc --noEmit` passed |
| ESLint | `eslint .` passed |
| Optimized Next.js build | `next build` passed |
| Trace hygiene | 18 trace files inspected; `/motion-demo` bundles 10 Motion evidence files and 4 public Motion videos; no root artifacts, runs, tmp, env, test or bytecode-cache leakage outside the intentional evidence mirrors |
| Production HTTP smoke | `/`, `/motion-demo` and `/icon.svg` returned 200; four Motion videos and static demo media ranged at 206 |
| Production browser smoke | `/motion-demo` returned 200, all four videos were ready, admitted proof rendered, frame-60 challenge showed `FAIL / CAUGHT`, desktop/mobile overflow checks passed and console/bad-response lists were empty |

Before recording, publishing or handing off a later tree, rerun:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
uv run pytest
```

Record exact counts only from the final tree. The build must continue to fail closed when required Motion evidence is absent or tampered with. Rendered playback and the corruption challenge must be repeated after any evidence-path change.

## Honest product boundary

- Human review should define what the temporal mask means; the current portable evidence does not bind a reviewer attestation.
- Exactness stops at the four-pixel-eroded core.
- Boundary blending can produce a halo, matte chatter or imperfect ground contact.
- Exact source restoration does not physically relight the protected character.
- Motion v1 avoids full occlusion, multi-character interaction, complex depth ordering and arbitrary camera motion.
- MP4 files are lossy viewing derivatives.
- Local evidence is not externally signed or independently timestamped.

## Historical static fallback

The prior static AI-source job remains useful and immutable:

| Evidence | Historical value |
| --- | --- |
| Job | `ai_713a0e7a80b7410bbe6b6d3ef54f74b7` |
| State | `verified` |
| Endpoint | `fal-ai/kling-video/o3/standard/video-to-video/edit` |
| fal request ID | `019f765d-0e8d-7551-afb4-941b02d355e6` |
| Static protected-core pixels | 44,049,566 across 121 frames |
| Static changed pixels/channels | 0 / 0 |
| Static maximum delta | 0 |
| Historical attempt ledger | exhausted at `3/3` |
| Attempt-3 estimated cost | `$0.7058333334`, not confirmed charge |

This is fallback and regression evidence, not the Motion v1 hero. No Motion claim depends on changing the old job or reopening its ledger.

## Remaining human-owned external actions

1. Decide whether to authorize a commit, repository publication and push.
2. Decide which source, generated-world, mask and result media may be public.
3. Decide whether to authorize a production deployment.
4. Record and upload the demo only after the final current-tree gate.
5. Submit through the event platform only after explicit authorization.

No repository creation, commit, push, deployment, media upload, demo upload or hackathon submission is claimed by this audit.
