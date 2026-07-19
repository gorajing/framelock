from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import zipfile

import numpy as np
import pytest

from framelock_media.artifacts import save_rgb_png, sha256_file
from framelock_media.exports import export_canonical_frame_archive
from framelock_media.verify import (
    MaskParameters,
    ProofFrame,
    ProofManifest,
    calculate_proof_manifest_digest,
)


def _frames(root: Path, count: int = 121) -> tuple[Path, ...]:
    root.mkdir(parents=True)
    paths: list[Path] = []
    for index in range(count):
        path = root / f"composite_{index:06d}.png"
        frame = np.full((720, 1280, 3), index % 256, dtype=np.uint8)
        save_rgb_png(path, frame)
        paths.append(path)
    return tuple(paths)


def _manifest(paths: tuple[Path, ...]) -> ProofManifest:
    frames = tuple(
        ProofFrame(
            index=index,
            source_path=str((path.parent / f"source_{index:06d}.png").resolve()),
            core_mask_path=str((path.parent / f"core_{index:06d}.png").resolve()),
            composite_path=str(path.resolve()),
            source_file_sha256="11" * 32,
            source_rgb_sha256="22" * 32,
            core_mask_file_sha256="33" * 32,
            composite_file_sha256=sha256_file(path),
        )
        for index, path in enumerate(paths)
    )
    provisional = ProofManifest(
        frames=frames,
        mask_parameters=MaskParameters(),
        expected_width=1280,
        expected_height=720,
        expected_frame_count=len(paths),
        media_provenance=None,
        ingest_digest_sha256="44" * 32,
        digest_sha256="",
    )
    return replace(
        provisional,
        digest_sha256=calculate_proof_manifest_digest(provisional),
    )


def test_canonical_archive_is_deterministic_and_self_indexed(tmp_path: Path) -> None:
    frames = _frames(tmp_path / "frames")
    proof_manifest = _manifest(frames)
    first = export_canonical_frame_archive(
        proof_manifest,
        frames,
        tmp_path / "first.zip",
        tmp_path / "first.json",
    )
    second = export_canonical_frame_archive(
        proof_manifest,
        frames,
        tmp_path / "second.zip",
        tmp_path / "second.json",
    )

    assert sha256_file(first.archive_path) == sha256_file(second.archive_path)
    assert first.archive_sha256 == sha256_file(first.archive_path)
    assert first.manifest_sha256 == sha256_file(first.manifest_path)
    assert first.frame_count == 121
    assert first.total_uncompressed_bytes > 0
    assert first.manifest_path.read_bytes() == second.manifest_path.read_bytes()

    manifest = json.loads(first.manifest_path.read_text(encoding="utf-8"))
    assert manifest["schema_version"] == 1
    assert manifest["artifact"] == "canonical_rgb24_png_sequence"
    assert manifest["claim_scope"] == (
        "Packaging of proof-bound canonical pre-encode RGB24 PNG frames; "
        "the proof manifest remains authoritative."
    )
    assert manifest["archive"]["sha256"] == first.archive_sha256
    assert manifest["proof_manifest_digest_sha256"] == (
        proof_manifest.digest_sha256
    )
    assert manifest["frames"][60] == {
        "archive_path": "canonical_frames/frame_000060.png",
        "file_sha256": sha256_file(frames[60]),
        "source_index": 60,
    }

    with zipfile.ZipFile(first.archive_path) as archive:
        names = archive.namelist()
        assert len(names) == 121
        assert names[0] == "canonical_frames/frame_000000.png"
        assert names[-1] == "canonical_frames/frame_000120.png"
        info = archive.getinfo(names[60])
        assert info.date_time == (1980, 1, 1, 0, 0, 0)
        assert info.compress_type == zipfile.ZIP_STORED
        assert archive.read(names[60]) == frames[60].read_bytes()


def test_canonical_archive_requires_exactly_121_frames_and_new_outputs(
    tmp_path: Path,
) -> None:
    frames = _frames(tmp_path / "short", count=120)
    with pytest.raises(ValueError, match="exact 1280x720"):
        export_canonical_frame_archive(
            _manifest(frames),
            frames,
            tmp_path / "short.zip",
            tmp_path / "short.json",
        )

    complete = _frames(tmp_path / "complete")
    complete_manifest = _manifest(complete)
    archive = tmp_path / "existing.zip"
    archive.write_bytes(b"do not replace")
    with pytest.raises(FileExistsError):
        export_canonical_frame_archive(
            complete_manifest,
            complete,
            archive,
            tmp_path / "existing.json",
        )
    assert archive.read_bytes() == b"do not replace"


def test_canonical_archive_rejects_reordering_and_post_manifest_mutation(
    tmp_path: Path,
) -> None:
    frames = _frames(tmp_path / "frames")
    proof_manifest = _manifest(frames)
    reordered = list(frames)
    reordered[0], reordered[1] = reordered[1], reordered[0]
    with pytest.raises(ValueError, match="paths differ"):
        export_canonical_frame_archive(
            proof_manifest,
            tuple(reordered),
            tmp_path / "reordered.zip",
            tmp_path / "reordered.json",
        )

    changed = np.full((720, 1280, 3), 255, dtype=np.uint8)
    frames[60].unlink()
    save_rgb_png(frames[60], changed)
    archive = tmp_path / "tampered.zip"
    manifest = tmp_path / "tampered.json"
    with pytest.raises(ValueError, match="bytes differ"):
        export_canonical_frame_archive(
            proof_manifest,
            frames,
            archive,
            manifest,
        )
    assert not archive.exists()
    assert not manifest.exists()
