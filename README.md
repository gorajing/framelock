# FrameLock

**Generate one AI character performance. Reshoot its world without rerolling the approved performance.**

FrameLock lets AI filmmakers change a video's environment without rerolling an approved character performance. It validates and hashes the original sequence, uses fal VEED to extract a moving foreground mask, Nano Banana Pro to create replacement environment plates and Kling O3 to animate the selected world. FrameLock then restores the approved character locally and independently verifies that its protected pixels remain unchanged.

> Protected core verified — canonical pre-encode frame sequence.

## Demo

The `/motion-demo` route presents four synchronized views:

- [approved source performance](./public/demo/motion/source.mp4)
- [fal-generated world](./public/demo/motion/generated-world.mp4)
- [moving protection mask](./public/demo/motion/mask.mp4)
- [verified reshoot](./public/demo/motion/verified.mp4)

All four share one 1280 × 720, 121-frame, 24 FPS timeline. The route reads tracked, bound evidence and fails closed if a proof artifact or viewing asset drifts. No API key is required to inspect the shipped demo.

## Verified result

| Metric | Result |
| --- | ---: |
| Frames audited | 121 / 121 |
| Protected-core pixels audited | 8,390,666 |
| Changed protected pixels | 0 |
| Changed protected RGB channel samples | 0 |
| Maximum protected-core channel delta | 0 |
| Deterministic recomposition | Passed |

The verifier is falsifiable, not a green badge. A bound negative control changes one protected RGB channel sample by a value of one at frame 60. FrameLock returns `FAIL` and leaves the clean canonical evidence unchanged.

## How it works technically

1. **Canonicalize the performance.** FrameLock accepts an owned, locked-camera MP4 at exactly 1280 × 720, 121 frames and 24 FPS. It decodes the video into canonical RGB frames, hashes the source and binds every later decision to that digest.
2. **Extract the moving character.** The filmmaker confirms one foreground subject. `veed/video-background-removal` returns an alpha-bearing video, which FrameLock converts into 121 soft masks. Automated temporal checks and a full-timeline human review gate the mask before it can be used.
3. **Create the new world.** `fal-ai/nano-banana-pro` generates four empty 16:9 environment plates from one sentence. The filmmaker selects a plate, then `fal-ai/kling-video/o3/standard/image-to-video` animates it with audio disabled and locked-camera constraints.
4. **Normalize and composite locally.** FrameLock admits only a comparable Kling result, using a declared scale-and-center-crop plus frames 0–120 when normalization is required. It blends the soft mask boundary while restoring source RGB values exactly inside a four-pixel-eroded protected core.
5. **Verify independently.** A separate verifier reopens the persisted source, mask, generated world and composite. Approval requires 121 nonempty protected cores, zero changed protected RGB channel samples, zero maximum channel delta and 121 matching protected-core hashes.
6. **Export the evidence.** The product writes the delivery MP4 and a canonical proof bundle. The exact claim applies to the persisted pre-encode frame sequence; the lossy MP4, blended boundary, mask correctness and physical relighting remain outside that claim.

Every paid fal action is server-owned, explicitly authorized and persisted before submission. FrameLock polls only a saved request identity and never silently retries an ambiguous paid request. API keys, provider URLs, request IDs and local filesystem paths stay outside browser payloads.

## Run locally

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) for the product workflow. The prebuilt proof remains available at [http://localhost:3000/motion-demo](http://localhost:3000/motion-demo).

## Honest boundaries

- The product requires full-timeline human mask review. The bundled Motion demo predates that product-level attestation, so mask semantics still require human judgment.
- Exact equality stops at the four-pixel-eroded core. The blended edge can artifact, and restored source pixels are not physically relit.
- MP4s are lossy previews. The canonical frames carry the proof.

## Technical evidence

- [Tracked Motion admission](./demo-evidence/motion/root/artifacts/motion-v1/admissions/kling-background-01/motion_reshoot_admission.json)
- [Canonical Motion audit](./demo-evidence/motion/root/artifacts/motion-v1/admissions/kling-background-01/proof/motion_audit.json)
- [fal documentation research](./docs/FAL_DOCUMENTATION_RESEARCH.md)
