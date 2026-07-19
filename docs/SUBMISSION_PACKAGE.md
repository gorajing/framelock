# FrameLock submission package

## One-sentence pitch

> Generate an AI character performance once. Reshoot its world without rerolling the approved performance.

**Public repository:** [github.com/gorajing/framelock](https://github.com/gorajing/framelock)

## CV submission description (100–200 words)

FrameLock is a verified generative-video reshoot workflow for filmmakers who already have an approved character performance but need to change the world around it. Instead of asking a video model to regenerate the entire shot and hoping the character remains consistent, FrameLock assigns fal's Kling O3 to generate the replacement environment, then restores the approved performance from canonical source frames.

For Motion v1, a temporal matte defines the character on each of 121 frames. FrameLock freezes that mask sequence, erodes each mask by four pixels to define an exact protected core, composites the new world and audits the persisted pre-encode result with a separate verifier pass. The admitted proof covers 8,390,666 protected-core pixels with zero changed pixels, zero changed RGB channel samples and maximum delta zero.

A bound negative control alters one protected channel sample at frame 60. The verifier catches it and returns `FAIL`. FrameLock does not claim perfect tracking, relighting or lossless MP4 delivery; it proves a narrower contract: the declared protected core did not change.

## Description

FrameLock turns a generative reshoot into an auditable media pipeline. Motion v1 begins with an approved moving FRM-01 character performance at 1280 × 720, 121 frames and 24 FPS. A temporal matte proposes the character region on every frame. FrameLock freezes the bound mask sequence, erodes each mask by four pixels to define the exact protected core, places the approved performance over a fal-generated moving world and verifies the persisted canonical composite with a separate pass before encode.

The selected replacement world came from `fal-ai/kling-video/o3/standard/image-to-video`, request `019f7806-2b52-7062-89b0-98eb664401e6`. The model was responsible for the world, not for preserving the approved character. FrameLock restores the protected source core deterministically and audits what it accepts.

The admitted proof covers all 121 canonical pre-encode frames and 8,390,666 total protected-core pixels. It reports zero changed protected pixels, zero changed protected RGB channel samples and maximum channel delta zero. A bound negative control changes one protected channel sample by one value at frame 60. The verifier catches it, returns `FAIL` and leaves the clean canonical evidence unchanged.

The exact claim is:

> Protected core verified — canonical pre-encode frame sequence.

The claim stops at the four-pixel-eroded core. The moving mask must still be judged by a human. The soft character boundary is blended rather than exact, the restored character is not physically relit and the MP4 is a lossy viewing preview. FrameLock is not claiming seamless commercial-finish VFX, arbitrary occlusion handling, camera-original provenance or model-native identity preservation.

## Original 2:40 demo storyboard

The recorded silent submission cut is 2:18.83. Its exact picture timings and narration are in [the timed demo voiceover](./DEMO_VOICEOVER.md); the longer storyboard below remains the planning reference.

| Time | Screen | Narration and proof point |
| --- | --- | --- |
| 0:00–0:12 | Title and approved moving performance | “Generate a character performance once. Reshoot its world without rerolling the approved performance.” |
| 0:12–0:35 | Approved source beside moving mask | Establish the 1280 × 720, 121-frame, 24 FPS contract. Explain that the tracker proposes a mask, FrameLock binds the declared sequence and four-pixel erosion defines the exact protected core. |
| 0:35–1:05 | Four synchronized views | Play approved source, generated world, moving mask and verified reshoot together. State that Kling generated the world and FrameLock restored the approved performance. |
| 1:05–1:30 | Generated world and verified result | Show the scale of the world change while character timing and motion remain anchored to the source. Do not imply the model preserved the character. |
| 1:30–1:55 | Canonical audit | Show 121/121 frames, 8,390,666 protected-core pixels, zero changed pixels, zero changed RGB channel samples and maximum delta zero. Label the MP4 as a lossy preview. |
| 1:55–2:15 | Frame-60 corruption challenge | Flip one protected channel sample by one value. Show the verifier catch it and the interface turn red. |
| 2:15–2:30 | Spend and provenance | Show endpoint, request ID and the separate Motion ledger: $7.66575 reserved estimate, $92.33425 estimated remaining. Say the figures are not invoice-confirmed. |
| 2:30–2:40 | Final split screen and limitation | Repeat the exact claim. Close with: “The world may change. The locked protected core does not.” Name mask, boundary and relighting limits. |

## Evidence to show

- Local route: `/motion-demo`.
- Four synchronized views: approved source, generated world, moving mask and verified reshoot.
- Source contract: 1280 × 720, 121 frames, 24 FPS.
- Selected fal endpoint: `fal-ai/kling-video/o3/standard/image-to-video`.
- Selected fal request: `019f7806-2b52-7062-89b0-98eb664401e6`.
- Canonical source SHA-256: `9882dceb76ad0b8954c92f8c8e8b9f00ea4e7812ea96a4f0307c1fa916611dc6`.
- Temporal-matte manifest digest: `f39d99ff9462cf730ef1cee1c28c7dc7ec250ac5d376c3d35f308fa584817d18`.
- Canonical generated-world SHA-256: `9a48ef083d205d9be00051a80cfa6a8bb2eb923e62bd692e8a7bf7ff58d18610`.
- Motion admission digest: `8b4965dd822d1149fc31433ed5aac55749ad97dc2a2d591229ed910544111c93`.
- Clean proof: 121/121 frames, 8,390,666 protected-core pixels, zero changed pixels, zero changed RGB channel samples, maximum delta zero and deterministic recomposition passed.
- Negative control: frame 60, one protected pixel, one RGB channel and delta 1; observed verdict `FAIL`.
- Admitted viewing-preview SHA-256: `8f4cdf46a57898ea2d3bfa60605346efb1b2a3ad1cece8217fbf8bd1ac7f9850`.
- Preview label: `Lossy MP4 preview — canonical frames carry the proof`.
- Motion spend: `$7.66575` reserved estimated cost and `$92.33425` estimated remaining from the $100 Motion budget; neither is invoice-confirmed.
- Historical fallback: the previous static job and its exhausted `3/3` ledger remain immutable and separate from the Motion ledger.

## Demo language

Use:

> FrameLock verifies exact protected-core equality in the canonical pre-encode 121-frame sequence.

> The temporal model proposes what to protect. FrameLock binds that declared sequence, then proves the declared contract was honored. Semantic correctness still requires human review.

> The boundary is blended for appearance and intentionally excluded from the exactness claim.

Avoid:

- “The entire character is unchanged.”
- “Kling preserved the performance.”
- “The tracking is proven correct.”
- “The preview is pixel-perfect.”
- “FrameLock relights the character.”
- “This solves every moving subject or occlusion.”

## Local evidence and QA boundary

The local Motion route has been inspected at desktop and mobile widths. All four videos loaded as 1280 × 720, 5.041667-second assets, the clean evidence rendered as admitted, the frame-60 corruption challenge rendered as caught and the browser reported no console errors or bad responses.

Final local gates passed: Python proof/media `204 passed`, Vitest `61 files / 475 tests`, TypeScript, ESLint, optimized Next.js build, trace hygiene and production HTTP/browser smoke.

Those observations establish the local demo behavior. They do not establish a public deployment. Re-run the current repository tests, typecheck, lint, production build and rendered route after any later evidence-binding change. Do not reuse the older static-release test totals as if they described the final Motion tree.

## Submission boundaries

The public repository and its bundled Motion viewing media are published at [github.com/gorajing/framelock](https://github.com/gorajing/framelock). The demo application has not been publicly deployed, and no demo video has been uploaded or submitted through the event platform. Local recording, external video upload and final submission remain separate release actions.

The historical static AI-source job `ai_713a0e7a80b7410bbe6b6d3ef54f74b7` remains a complete fallback. Its artifacts, active-job record, one-channel negative control and original `3/3` paid-attempt ledger are immutable history. Motion v1 does not spend from, reset or relabel that ledger.
