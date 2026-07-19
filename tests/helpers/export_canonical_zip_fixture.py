from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import shutil
import sys

import numpy as np

from framelock_media.artifacts import save_rgb_png, sha256_file
from framelock_media.exports import export_canonical_frame_archive
from framelock_media.verify import (
    MaskParameters,
    ProofFrame,
    ProofManifest,
    calculate_proof_manifest_digest,
)


def main(output_root: Path) -> None:
    output_root.mkdir(parents=True, exist_ok=True)
    frame_root = output_root / "frames"
    frame_root.mkdir()
    template = frame_root / "composite_000000.png"
    save_rgb_png(
        template,
        np.full((720, 1280, 3), (17, 31, 47), dtype=np.uint8),
    )
    frame_paths = [template]
    for index in range(1, 121):
        path = frame_root / f"composite_{index:06d}.png"
        shutil.copyfile(template, path)
        frame_paths.append(path)
    frames = tuple(
        ProofFrame(
            index=index,
            source_path=str((frame_root / f"source_{index:06d}.png").resolve()),
            core_mask_path=str((frame_root / f"core_{index:06d}.png").resolve()),
            composite_path=str(path.resolve()),
            source_file_sha256="11" * 32,
            source_rgb_sha256="22" * 32,
            core_mask_file_sha256="33" * 32,
            composite_file_sha256=sha256_file(path),
        )
        for index, path in enumerate(frame_paths)
    )
    provisional = ProofManifest(
        frames=frames,
        mask_parameters=MaskParameters(),
        expected_width=1280,
        expected_height=720,
        expected_frame_count=121,
        media_provenance=None,
        ingest_digest_sha256="44" * 32,
        digest_sha256="",
    )
    proof = replace(
        provisional,
        digest_sha256=calculate_proof_manifest_digest(provisional),
    )
    archive = export_canonical_frame_archive(
        proof,
        tuple(frame_paths),
        output_root / "canonical_frames.zip",
        output_root / "canonical_frames_manifest.json",
    )
    manifest = json.loads(archive.manifest_path.read_text(encoding="utf-8"))
    fixture = {
        "archivePath": str(archive.archive_path.resolve()),
        "frames": [
            {
                "archivePath": frame["archive_path"],
                "fileSha256": frame["file_sha256"],
            }
            for frame in manifest["frames"]
        ],
        "totalUncompressedBytes": manifest["total_uncompressed_bytes"],
    }
    (output_root / "fixture.json").write_text(
        json.dumps(fixture, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: export_canonical_zip_fixture.py OUTPUT_ROOT")
    main(Path(sys.argv[1]).resolve())
