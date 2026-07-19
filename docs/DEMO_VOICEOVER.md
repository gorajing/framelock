# FrameLock demo voiceover

## Recording direction

Use your own voice. Aim for a calm technical-founder delivery: confident, conversational and slightly slower on the proof numbers. Do not use a dramatic trailer voice or rush to sound excited. The credibility comes from treating the result as something the viewer can inspect.

- Target pace: 125–130 words per minute.
- Recording format: mono or stereo WAV at 48 kHz if available; a clean phone recording is acceptable.
- Level: speak 6–8 inches from the microphone and avoid clipping; leave noise reduction and compression for the final edit.
- Timing: begin each paragraph at its timestamp and leave the remaining beat silent if you finish early.
- Emphasis: stress “approved,” “canonical,” “zero,” “one” and “falsifiable.”
- Pronunciation: say “fal” like “fall,” “Kling O three,” “R G B” and “one-twenty-one frames.”
- Music: optional, low ambient texture only. Keep it far below the narration and remove it entirely during the corruption reveal if it competes with the words.

## Timed script for the 2:18.83 silent cut

### 0:00–0:08 — Title

FrameLock: verified generative reshoots. Generate one character performance, then reshoot its world without rerolling the approved performance.

### 0:08–0:27 — The problem and the contract

For AI filmmakers, changing one environment usually means regenerating the whole shot. The character's face, clothing, timing or body motion can drift. FrameLock treats an approved performance as a locked asset, so creative teams can iterate on the world without losing approved work.

### 0:27–0:44 — Source and fal-generated world

Here is the source performance beside the replacement world generated with fal's Kling O3. The model is responsible for the world. We neither ask nor claim that it preserved the character.

### 0:44–1:00 — Moving protection mask

A temporal model proposes one character mask for every source frame. FrameLock binds that sequence as the declared contract, then erodes each mask by four pixels to define the exact protected core.

### 1:00–1:15 — Four synchronized views

These four views share one 121-frame timeline: approved source, generated world, moving mask and verified reshoot. FrameLock blends the boundary for appearance, then restores the approved source pixels inside every protected core.

### 1:15–1:38 — Canonical audit

After compositing, a separate verifier reopens the persisted canonical frames. It audits all 121 frames, 8,390,666 protected-core pixels and every protected-core RGB channel sample before encoding. The admitted result is zero changed protected pixels, zero changed channel samples and maximum delta zero.

### 1:38–1:50 — Exact claim boundary

That green result is deliberately narrow. It covers canonical pre-encode frames, not the lossy MP4, and does not claim the proposed mask is semantically correct.

### 1:50–2:07 — Bound corruption challenge

More importantly, the claim is falsifiable. This bound negative control changes one protected RGB channel sample by a value of one at frame 60. FrameLock rejects it immediately, turns the evidence red and leaves the clean canonical result untouched.

### 2:07–2:19 — Close

FrameLock lets AI filmmakers answer environment notes without rerolling an approved performance. Generate outside the lock. The world may change. The locked protected core does not.

## Final export

After recording, replace the silent track in `tmp/submission/framelock-demo-silent.mp4`, export H.264 at 1280 × 720 and keep the final duration under three minutes. Watch the exported file from beginning to end before upload. Confirm that the voice says “protected core,” never “entire character,” and that the final repository URL remains visible.
