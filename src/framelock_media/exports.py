from __future__ import annotations

from dataclasses import dataclass
import hashlib
from io import BytesIO
import json
from pathlib import Path
import zipfile

from PIL import Image

from .artifacts import sha256_file
from .contract import CANONICAL_CONTRACT
from .verify import ProofManifest, calculate_proof_manifest_digest


@dataclass(frozen=True)
class CanonicalFrameArchive:
    archive_path: Path
    archive_sha256: str
    manifest_path: Path
    manifest_sha256: str
    frame_count: int
    total_uncompressed_bytes: int


def _zip_entry(index: int) -> zipfile.ZipInfo:
    entry = zipfile.ZipInfo(
        filename=f"canonical_frames/frame_{index:06d}.png",
        date_time=(1980, 1, 1, 0, 0, 0),
    )
    entry.compress_type = zipfile.ZIP_STORED
    entry.create_system = 3
    entry.external_attr = 0o100644 << 16
    return entry


def export_canonical_frame_archive(
    proof_manifest: ProofManifest,
    frame_paths: tuple[Path, ...],
    archive_path: Path,
    manifest_path: Path,
) -> CanonicalFrameArchive:
    """Package proof-bound frames reproducibly without replacing proof trust."""
    if (
        len(frame_paths) != CANONICAL_CONTRACT.frame_count
        or proof_manifest.expected_frame_count != CANONICAL_CONTRACT.frame_count
        or proof_manifest.expected_width != CANONICAL_CONTRACT.width
        or proof_manifest.expected_height != CANONICAL_CONTRACT.height
    ):
        raise ValueError(
            "canonical frame export requires the exact 1280x720, "
            f"{CANONICAL_CONTRACT.frame_count}-frame contract"
        )
    if calculate_proof_manifest_digest(proof_manifest) != (
        proof_manifest.digest_sha256
    ):
        raise ValueError("canonical frame export proof manifest digest differs")
    expected_paths = tuple(
        str(Path(frame.composite_path).resolve())
        for frame in proof_manifest.frames
    )
    observed_paths = tuple(str(path.resolve()) for path in frame_paths)
    if observed_paths != expected_paths or len(set(observed_paths)) != len(
        observed_paths
    ):
        raise ValueError(
            "canonical frame export paths differ from the proof manifest"
        )
    if archive_path.exists() or manifest_path.exists():
        raise FileExistsError("canonical export artifact already exists")
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    frame_entries: list[dict[str, object]] = []
    total_uncompressed_bytes = 0
    created_archive = False
    created_manifest = False
    try:
        with zipfile.ZipFile(
            archive_path,
            mode="x",
            compression=zipfile.ZIP_STORED,
            allowZip64=True,
            strict_timestamps=True,
        ) as archive:
            created_archive = True
            for index, (frame_path, proof_frame) in enumerate(
                zip(frame_paths, proof_manifest.frames, strict=True)
            ):
                if not frame_path.is_file():
                    raise FileNotFoundError(
                        f"canonical frame does not exist: {frame_path}"
                    )
                frame_bytes = frame_path.read_bytes()
                frame_sha256 = hashlib.sha256(frame_bytes).hexdigest()
                if frame_sha256 != proof_frame.composite_file_sha256:
                    raise ValueError(
                        "canonical frame bytes differ from the proof manifest"
                    )
                with Image.open(BytesIO(frame_bytes)) as image:
                    if (
                        image.format != "PNG"
                        or image.mode != "RGB"
                        or image.size
                        != (
                            CANONICAL_CONTRACT.width,
                            CANONICAL_CONTRACT.height,
                        )
                    ):
                        raise ValueError(
                            "canonical export frame must be a 1280x720 RGB PNG"
                        )
                    image.verify()
                archive_entry = _zip_entry(index)
                archive.writestr(archive_entry, frame_bytes)
                total_uncompressed_bytes += len(frame_bytes)
                frame_entries.append(
                    {
                        "source_index": index,
                        "archive_path": archive_entry.filename,
                        "file_sha256": frame_sha256,
                    }
                )
        archive_path.chmod(0o600)
        archive_sha256 = sha256_file(archive_path)
        manifest = {
            "schema_version": 1,
            "artifact": "canonical_rgb24_png_sequence",
            "claim_scope": (
                "Packaging of proof-bound canonical pre-encode RGB24 PNG frames; "
                "the proof manifest remains authoritative."
            ),
            "frame_count": len(frame_entries),
            "proof_manifest_digest_sha256": proof_manifest.digest_sha256,
            "total_uncompressed_bytes": total_uncompressed_bytes,
            "archive": {
                "format": "zip",
                "compression": "stored",
                "sha256": archive_sha256,
            },
            "frames": frame_entries,
        }
        with manifest_path.open("x", encoding="utf-8") as handle:
            created_manifest = True
            json.dump(manifest, handle, indent=2, sort_keys=True)
            handle.write("\n")
        manifest_path.chmod(0o600)
    except Exception:
        if created_manifest:
            manifest_path.unlink(missing_ok=True)
        if created_archive:
            archive_path.unlink(missing_ok=True)
        raise
    return CanonicalFrameArchive(
        archive_path=archive_path,
        archive_sha256=archive_sha256,
        manifest_path=manifest_path,
        manifest_sha256=sha256_file(manifest_path),
        frame_count=len(frame_entries),
        total_uncompressed_bytes=total_uncompressed_bytes,
    )
