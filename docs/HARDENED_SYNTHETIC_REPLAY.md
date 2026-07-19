# Hardened synthetic replay evidence

## Purpose and boundary

This record documents a no-spend replay of FrameLock's already-recorded Kling
O3 synthetic feasibility result through the current hardened Python proof path.
It proves that the current compositor, verifier, transactional finalization,
canonical ZIP exporter, visualization binding and corruption detector can
process the persisted synthetic result coherently.

It does **not** prove a fresh fal submission, admission through the Node job
store, real-camera quality, commercial-finish compositing or the required
twice-completed real hero path. No network request or paid generation was made
for this replay.

The ignored local evidence root is:

```text
artifacts/replays/synthetic-hero-kling-o3-hardened-v6/canonical
```

The directory suffix is an immutable replay label, not a schema declaration.
The bound run manifest is schema **v5**, the visualization-bound form without a
source-audio binding. Run schema v6 is reserved for otherwise equivalent runs
that also bind source-audio evidence. Renaming this directory would invalidate
absolute paths already committed into the evidence, so the manifest is the
authority.

## Provenance

| Field | Value |
| --- | --- |
| Source fixture | Owned synthetic vector diagnostic clip |
| Selected endpoint | `fal-ai/kling-video/o3/standard/video-to-video/edit` |
| Recorded request ID | `019f72e4-5e1e-7143-bf91-e3aac20328da` |
| Source SHA-256 | `abd4cfa2fcd84a376394a1af421d32ba8687e0d4b5bd44a2607a822b6ecdf67d` |
| Static mask SHA-256 | `ee375951c0fe4233ad442d7b18a23d770b63a0f195bb8fac1bae769d03b7b2f3` |
| Recorded model-output SHA-256 | `6338c100b4d0935adfd96698ec1abaf9e3a9306c09099e55358c43cc5a5fe3ef` |
| Review-manifest file SHA-256 | `ba5b05f68ab3da5cd33ebdecbd253af54fa8a56e4fa746daa27a76e0269b6a37` |
| Review-manifest canonical digest | `3c5e44d01dac25a8fd812394d8cb8b5470ef7357ba04d57f002873536f29ea74` |
| Run schema | 5 |

Frames 0, 60 and 120 were visually inspected before approval. The reviewer
accepted source-compatible product position, scale and silhouette. The cyan
beam crossing frame 60 is an intentional generated exterior effect and is not
inside the geometry-acceptance claim.

## Clean verification result

> Protected core verified — canonical pre-encode frame sequence.

| Metric | Result |
| --- | ---: |
| Canonical frames audited | 121 |
| Protected-core hash matches | 121 |
| Total protected-core pixels audited | 22,029,381 |
| Changed protected-core pixels | 0 |
| Changed protected RGB channel samples | 0 |
| Maximum protected-core channel delta | 0 |
| Deterministic recomposition | Passed |
| Persisted artifact integrity | Passed |
| Canonical contract | Passed |

## Bound outputs

The commit-last marker binds nine outputs. Important file hashes are:

| Output | SHA-256 |
| --- | --- |
| Finalization commit marker | `fa805d8de04ad4b451e95d4cbf1e54e6fcac19b9df26eda9e5ca098402cc2a2b` |
| Run manifest | `28114030745c4a470a814f9302055b92861b662e990f17d58a100f5f6c37b7a3` |
| Proof manifest | `6009378a5aa21f010a1438cb2cf32ff4f821ba9f85ed6310f9ab45faa0090072` |
| Audit | `19a170023cf14b36b9dcba7e9a7d79b719735d709ee49887731b69db7d2b2506` |
| H.264 viewing preview | `154178d10072cad6437459bc8a92ccecfc9a847e8af3a07fca682c3774478876` |
| Canonical-frame ZIP | `511212d6e3041c6313e0b9fcca025d318ed4c4c91e1f611ceefbdcac5cdbf627` |
| Canonical export manifest | `9ed4a2a9b94a2418b44d38d62caa75e2aa8f035137aec2f94cd85ee202edaefe` |
| Frame-60 difference heatmap | `64bbd2b35b7ed7580c064ff40ed7bd0a6be066ffbe76c46fa55066bf1124ca23` |

The protected-core image is part of the exactness contract. The boundary-ring
image and difference heatmap are deterministic explanatory visuals and do not
expand the verified region or become verifier outputs.

## Negative control

The replay copies canonical frame 60 into a separate corruption fixture, changes
one protected RGB channel by one integer value and runs the independent verifier
against that fixture. The canonical clean artifacts are not mutated.

| Metric | Result |
| --- | ---: |
| Expected verdict | Failed |
| Changed protected-core pixels | 1 |
| Changed protected RGB channel samples | 1 |
| Worst maximum channel delta | 1 |
| Corrupted frame | 60 |
| Canonical artifacts mutated | No |

## What remains unproven

- A newly shot, owned real-camera hero passing intake and mask approval.
- One freshly authorized real-camera Kling request through the paid Node route.
- Hardened success and corruption evidence admitted from that real job store.
- The complete real-camera application path finishing twice.
- Browser inspection of both hardened real-job success and failure states.
- Public repository publication, deployment, demo upload and hackathon submission.
