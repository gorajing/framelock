# FrameLock

**Generate one AI character performance. Reshoot its world without rerolling the approved performance.**

FrameLock lets AI filmmakers answer environment notes without losing approved character work. fal Kling O3 generates the replacement world; FrameLock restores a declared protected core from the source performance, then a separate persisted-frame verifier decides whether the reshoot can be admitted.

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

## How it works

1. Bind the approved source performance and one temporal mask per frame.
2. Erode every mask by four pixels to define the exact protected core.
3. Generate a replacement world with `fal-ai/kling-video/o3/standard/image-to-video`.
4. Blend the mask boundary for appearance and restore source pixels exactly inside each protected core.
5. Reopen the persisted canonical frames and admit the result only after the separate verifier passes.

Kling generated the world; it did not preserve the character. FrameLock restored the declared core and verified the accepted composite before video encoding.

## Run locally

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000/motion-demo](http://localhost:3000/motion-demo).

## Honest boundaries

- The current evidence binds the temporal matte and automated QA, but not a human reviewer attestation. Mask semantics still require human judgment.
- Exact equality stops at the four-pixel-eroded core. The blended edge can artifact, and restored source pixels are not physically relit.
- MP4s are lossy previews. The canonical frames carry the proof.

## Technical evidence

- [Tracked Motion admission](./demo-evidence/motion/root/artifacts/motion-v1/admissions/kling-background-01/motion_reshoot_admission.json)
- [Canonical Motion audit](./demo-evidence/motion/root/artifacts/motion-v1/admissions/kling-background-01/proof/motion_audit.json)
- [fal documentation research](./docs/FAL_DOCUMENTATION_RESEARCH.md)
