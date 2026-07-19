# FrameLock human handoff

## Deadline and current boundary

The fal x Sequoia submission is due **Sunday, July 19, 2026 at 9:00 AM PT**. FrameLock is being prepared for the Developer Track.

The current hero is Motion v1:

> Generate an AI character performance once. Reshoot its world without rerolling the approved performance.

The local hero route, canonical proof and deliberate negative control exist. The previous static AI-source job remains an immutable fallback. The public repository and bundled Motion viewing media are published at [github.com/gorajing/framelock](https://github.com/gorajing/framelock). A public deployment, demo upload and hackathon submission have not been performed.

## 1. Reopen the Motion v1 hero

Use the pinned Node 24.18.0 environment:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
pnpm dev
```

Open:

> `http://localhost:3000/motion-demo`

The page should fail closed if its compact evidence mirror under `demo-evidence/motion/root` is missing or invalid. That mirror is a portable projection of the already-admitted proof; the ignored canonical PNG tree remains the local trust root. Do not repair an evidence failure by editing a digest, bypassing the reader or replacing a bound file.

Confirm these identities:

| Field | Expected value |
| --- | --- |
| Source contract | 1280 × 720, 121 frames, 24 FPS |
| fal endpoint | `fal-ai/kling-video/o3/standard/image-to-video` |
| fal request ID | `019f7806-2b52-7062-89b0-98eb664401e6` |
| Canonical source SHA-256 | `9882dceb76ad0b8954c92f8c8e8b9f00ea4e7812ea96a4f0307c1fa916611dc6` |
| Temporal-matte manifest digest | `f39d99ff9462cf730ef1cee1c28c7dc7ec250ac5d376c3d35f308fa584817d18` |
| Canonical generated-world SHA-256 | `9a48ef083d205d9be00051a80cfa6a8bb2eb923e62bd692e8a7bf7ff58d18610` |
| Motion admission digest | `8b4965dd822d1149fc31433ed5aac55749ad97dc2a2d591229ed910544111c93` |
| Admitted preview SHA-256 | `8f4cdf46a57898ea2d3bfa60605346efb1b2a3ad1cece8217fbf8bd1ac7f9850` |

The selected replacement environment is a moving neon underground transit world with mist, cyan-magenta light, headlights and reflections. The approved red-coated FRM-01 character performance remains the motion source of truth.

## 2. Inspect the admitted proof

The only green exactness claim is:

> Protected core verified — canonical pre-encode frame sequence.

The clean evidence must show:

| Metric | Expected result |
| --- | ---: |
| Frames audited | 121/121 |
| Total protected-core pixels | 8,390,666 |
| Changed protected pixels | 0 |
| Changed protected RGB channel samples | 0 |
| Maximum protected-core channel delta | 0 |
| Deterministic recomposition | Passed |

The protected core is derived separately on every frame by eroding the bound character mask by four pixels. The exact claim does not extend to the soft boundary.

The canonical admission is:

> `artifacts/motion-v1/admissions/kling-background-01/motion_reshoot_admission.json`

The H.264 MP4 is a lossy viewing derivative. Do not use visual inspection of the MP4 as a substitute for the canonical-frame audit.

## 3. Verify all four synchronized views

The demo must visibly show:

1. approved source performance
2. generated world
3. moving mask
4. verified FrameLock reshoot

Press play and let the full 121-frame sequence complete. Confirm that all four views advance, the page reports synchronized completion and no player remains stuck in a seek loop. Scrubbing should keep the views aligned closely enough for comparison.

The generated-world view is deliberately character-free. That is the product distinction: fal generates the world, while FrameLock restores and verifies the approved performance. Never narrate this as model-native character preservation.

## 4. Run the corruption challenge

Trigger the bound negative control. It must show:

- frame 60
- one protected pixel
- one RGB channel
- delta 1
- verdict `FAIL` or `CAUGHT`
- clean canonical evidence unchanged

This challenge demonstrates that the verifier rejects the smallest represented protected-core change. It does not validate the semantic quality of the mask.

## 5. State the limitations on camera

Use:

> FrameLock guarantees exact equality inside the declared four-pixel-eroded core. The tracker proposes the mask, the boundary is blended and the restored character is not physically relit.

Also state that:

- mask and tracking correctness require human review
- the feathered boundary is outside the equality contract
- the shot avoids full occlusion and complex foreground crossings
- MP4 previews are lossy
- the canonical pre-encode frame sequence and audit carry the proof

Do not claim seamless commercial-finish VFX, perfect tracking, physical relighting, arbitrary moving-subject support, camera-original provenance or exactness across the entire visible silhouette.

## 6. Preserve the Motion spend record

The separate Motion budget currently records:

| Field | Value |
| --- | ---: |
| Budget ceiling | $100.00 |
| Reserved estimated cost | $7.66575 |
| Estimated remaining | $92.33425 |
| Invoice confirmation | Not confirmed |

Treat both cost figures as ledger estimates, not final billed charges. The remaining estimate means the authorized Motion envelope was not exhausted. It does not authorize uncontrolled retries, unrecorded requests or public actions. Do not make a paid fal call while recording or repairing proof evidence.

## 7. Preserve the static fallback

The previous static AI-source release remains immutable:

| Field | Historical fallback value |
| --- | --- |
| Job | `ai_713a0e7a80b7410bbe6b6d3ef54f74b7` |
| State | `verified` |
| Endpoint | `fal-ai/kling-video/o3/standard/video-to-video/edit` |
| fal request ID | `019f765d-0e8d-7551-afb4-941b02d355e6` |
| Static proof | 121 frames, 44,049,566 protected-core pixels, zero changed pixels/channels and maximum delta zero |
| Historical ledger | exhausted at `3/3` |
| Attempt-3 estimate | `$0.7058333334`, not confirmed charge |

Motion v1 has a separate artifact root and spend ledger. Do not edit, reset or relabel the old job, its proof, its negative control or its `3/3` history. If a last-minute Motion presentation issue cannot be repaired without weakening the claim, use the static job as the fallback rather than changing proof artifacts.

## 8. Final local gate before recording

Current final-tree local gates passed:

| Gate | Result |
| --- | --- |
| Python proof/media suite | `204 passed in 1523.75s` |
| Vitest | `61 files`, `475 tests` passed |
| TypeScript | passed |
| ESLint | passed |
| Production build | passed |
| Production browser smoke | `/motion-demo` admitted the clean proof, loaded all four videos, caught the frame-60 corruption challenge and reported no console errors or bad responses |

After any later evidence-binding, packaging or source-code change, rerun:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
uv run pytest
```

Then reopen `/motion-demo` and repeat full synchronized playback plus the frame-60 corruption challenge at desktop and mobile widths. Record replacement counts only from that changed tree. Older static-release counts and earlier Motion integration counts are historical checkpoints, not a substitute for the current final run.

## 9. Local submission cut

The silent submission cut has been recorded locally at:

> `tmp/submission/framelock-demo-silent.mp4`

It is 2:18.83, 1280 × 720, 30 FPS H.264 with a silent 48 kHz AAC stereo track. Its SHA-256 is `9ec7e85b20017af35f662ec812ee75024fc96796a04156dd8970778bdd09f21c`. The full file decodes without error, its synchronized playback window contains real motion and frame review confirmed the admitted proof plus red corruption state are legible at 720p.

The local MP4 is ignored by Git and has not been uploaded. Record the narration from [the timed demo voiceover](./DEMO_VOICEOVER.md), replace the silent track and watch the final voiced export from beginning to end before upload.

## 10. Publish and submit only with explicit authorization

Before any external action:

- confirm `.env.local`, local artifact roots, source media and cached provider URLs remain excluded
- decide which character, generated-world, mask and result media may be public
- reconcile every spoken and written claim to the exact Motion metrics above
- create and push a repository only after explicit authorization
- deploy only after an explicit deployment decision and a production packaging review
- record, upload and submit only after explicit authorization

The localhost service is not a production deployment. The GitHub repository and bundled Motion viewing media are public. A public demo URL, uploaded video and hackathon submission remain human-owned release actions.
