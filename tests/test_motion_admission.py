from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
from PIL import Image
import pytest

from framelock_media.artifacts import load_rgb_png
from framelock_media.masks import load_core_mask
from framelock_media.motion_admission import (
    MotionAdmissionError,
    _verify_capture_receipt,
    _verify_generated_normalization,
    admit_motion_reshoot,
    seal_canonical_source_decode_bundle,
    verify_motion_reshoot_admission,
)
from framelock_media.motion_source import (
    MotionSourceConstruction,
    SCALE_CENTER_CROP_MODE,
    construct_motion_source,
)
from framelock_media.temporal_matte import ingest_rgba_png_sequence


FAL_RESULT_URL = (
    "https://v3b.fal.media/files/b/test/motion-admission-generated.mp4"
)


def _ffmpeg(*arguments: str) -> None:
    executable = shutil.which("ffmpeg")
    assert executable is not None, "motion-admission tests require FFmpeg"
    subprocess.run(
        [
            executable,
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            *arguments,
        ],
        check=True,
        capture_output=True,
        timeout=180,
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _json_evidence(path: Path) -> dict[str, object]:
    return {
        "bytes": path.stat().st_size,
        "fileName": path.name,
        "mime": "application/json",
        "sha256": _sha256(path),
    }


def _source_approval(
    root: Path,
    source_path: Path,
    construction_manifest: Path,
    construction_digest: str,
) -> Path:
    approval = root / "source-approval.json"
    _write_json(
        approval,
        {
            "schemaVersion": 1,
            "decision": "approved_for_motion_v1_generation",
            "approvedCanonical": {
                "path": str(source_path.relative_to(root)),
                "sha256": _sha256(source_path),
                "constructionManifest": str(
                    construction_manifest.relative_to(root)
                ),
                "constructionManifestDigestSha256": construction_digest,
                "geometryMode": SCALE_CENTER_CROP_MODE,
                "width": 1280,
                "height": 720,
                "frameCount": 121,
                "frameRate": "24/1",
            },
            "review": {
                "verdict": "approve",
                "allFullBodyFramesPassed": True,
                "allFaceFramesPassed": True,
                "allBadgeFramesPassed": True,
                "exactTransformOutputFramehashEquality": True,
            },
        },
    )
    return approval


def _capture_generated(root: Path) -> tuple[Path, Path]:
    capture = root / "capture"
    capture.mkdir()
    generated = capture / "generated.mp4"
    _ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=0x164A73:s=1280x720:r=24",
        "-frames:v",
        "121",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "10",
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "24000",
        str(generated),
    )
    status = capture / "remote-status.json"
    result = capture / "remote-result.json"
    _write_json(status, {"status": "COMPLETED"})
    _write_json(result, {"video": {"url": FAL_RESULT_URL}})
    receipt = capture / "capture-receipt.json"
    _write_json(
        receipt,
        {
            "schemaVersion": 1,
            "kind": "motion-v1-fal-read-capture",
            "capturedAt": "2026-07-19T01:00:00.000Z",
            "attempt": {
                "attemptId": "test-motion-attempt",
                "endpoint": "fal-ai/wan-vace-14b",
                "requestId": "test-motion-request",
                "inputDigest": "1" * 64,
            },
            "status": _json_evidence(status),
            "result": _json_evidence(result),
            "downloads": [
                {
                    "jsonPointer": "/video/url",
                    "falUrl": FAL_RESULT_URL,
                    "fileName": generated.name,
                    "mime": "video/mp4",
                    "bytes": generated.stat().st_size,
                    "sha256": _sha256(generated),
                }
            ],
        },
    )
    return generated, receipt


def _capture_raw(
    root: Path,
    *,
    directory_name: str,
    color: str,
) -> tuple[Path, Path]:
    capture = root / directory_name
    capture.mkdir()
    raw = capture / "generated-raw.mp4"
    _ffmpeg(
        "-f",
        "lavfi",
        "-i",
        f"color=c={color}:s=1284x716:r=24",
        "-frames:v",
        "145",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "10",
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "24000",
        str(raw),
    )
    status = capture / "remote-status.json"
    result = capture / "remote-result.json"
    fal_url = FAL_RESULT_URL.replace("generated.mp4", f"{directory_name}.mp4")
    _write_json(status, {"status": "COMPLETED"})
    _write_json(result, {"video": {"url": fal_url}})
    receipt = capture / "capture-receipt.json"
    _write_json(
        receipt,
        {
            "schemaVersion": 1,
            "kind": "motion-v1-fal-read-capture",
            "capturedAt": "2026-07-19T01:00:00.000Z",
            "attempt": {
                "attemptId": f"test-{directory_name}",
                "endpoint": "fal-ai/wan-vace-14b",
                "requestId": f"request-{directory_name}",
                "inputDigest": "2" * 64,
            },
            "status": _json_evidence(status),
            "result": _json_evidence(result),
            "downloads": [
                {
                    "jsonPointer": "/video/url",
                    "falUrl": fal_url,
                    "fileName": raw.name,
                    "mime": "video/mp4",
                    "bytes": raw.stat().st_size,
                    "sha256": _sha256(raw),
                }
            ],
        },
    )
    return raw, receipt


@pytest.fixture(scope="module")
def normalized_capture_evidence(
    tmp_path_factory: pytest.TempPathFactory,
) -> tuple[Path, Path, Path, MotionSourceConstruction]:
    root = tmp_path_factory.mktemp("normalized-capture")
    raw, receipt = _capture_raw(
        root,
        directory_name="capture-primary",
        color="0x19567A",
    )
    construction = construct_motion_source(
        raw,
        root / "generated-normalization",
        geometry_mode=SCALE_CENTER_CROP_MODE,
    )
    return root, raw, receipt, construction


def test_generated_normalization_rejects_capture_raw_source_mismatch(
    normalized_capture_evidence: tuple[
        Path,
        Path,
        Path,
        MotionSourceConstruction,
    ],
) -> None:
    root, _, _, construction = normalized_capture_evidence
    other_raw, other_receipt = _capture_raw(
        root,
        directory_name="capture-other",
        color="0x7A5619",
    )
    capture = _verify_capture_receipt(
        other_receipt,
        other_raw,
        project_root=root,
    )

    with pytest.raises(
        MotionAdmissionError,
        match="normalization raw source differs from fal capture",
    ):
        _verify_generated_normalization(
            project_root=root,
            capture=capture,
            generated_media_path=construction.output_path,
            normalization_manifest_path=construction.manifest_path,
        )


def test_generated_normalization_rejects_canonical_output_mismatch(
    normalized_capture_evidence: tuple[
        Path,
        Path,
        Path,
        MotionSourceConstruction,
    ],
) -> None:
    root, raw, receipt, construction = normalized_capture_evidence
    capture = _verify_capture_receipt(receipt, raw, project_root=root)
    unrelated_output = root / "unrelated-canonical-output.mp4"
    shutil.copyfile(construction.output_path, unrelated_output)

    with pytest.raises(
        MotionAdmissionError,
        match="normalization canonical output differs from generated media",
    ):
        _verify_generated_normalization(
            project_root=root,
            capture=capture,
            generated_media_path=unrelated_output,
            normalization_manifest_path=construction.manifest_path,
        )


def _temporal_matte(root: Path) -> Path:
    rgba_root = root / "rgba"
    rgba_root.mkdir()
    paths: list[Path] = []
    for index in range(121):
        rgba = np.zeros((720, 1280, 4), dtype=np.uint8)
        rgba[..., :3] = np.array([86, 92, 98], dtype=np.uint8)
        left = 220 + index * 2
        rgba[130:650, left : left + 220, 3] = np.uint8(255)
        rgba[130:650, left, 3] = np.uint8(96)
        rgba[130:650, left + 1, 3] = np.uint8(160)
        path = rgba_root / f"frame_{index:06d}.png"
        Image.fromarray(rgba, mode="RGBA").save(
            path,
            format="PNG",
            compress_level=4,
        )
        paths.append(path)
    return ingest_rgba_png_sequence(paths, root / "matte").manifest_path


def test_admission_restores_source_core_and_negative_control_fails(
    tmp_path: Path,
) -> None:
    raw = tmp_path / "raw.mp4"
    _ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=0x565C62:s=1284x716:r=24",
        "-frames:v",
        "145",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "10",
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "24000",
        str(raw),
    )
    construction = construct_motion_source(
        raw,
        tmp_path / "source-construction",
        geometry_mode=SCALE_CENTER_CROP_MODE,
    )
    approval = _source_approval(
        tmp_path,
        construction.output_path,
        construction.manifest_path,
        construction.manifest_digest_sha256,
    )
    bundle = seal_canonical_source_decode_bundle(
        project_root=tmp_path,
        approved_source_path=construction.output_path,
        source_approval_path=approval,
        output_directory=tmp_path / "source-decode-bundle",
    )
    matte_manifest = _temporal_matte(tmp_path)
    generated, capture_receipt = _capture_generated(tmp_path)

    admitted = admit_motion_reshoot(
        project_root=tmp_path,
        approved_source_path=construction.output_path,
        source_approval_path=approval,
        source_decode_bundle_manifest_path=bundle.manifest_path,
        temporal_matte_manifest_path=matte_manifest,
        generated_media_path=generated,
        generated_capture_receipt_path=capture_receipt,
        output_directory=tmp_path / "admission",
    )

    assert admitted.proof.audit.passed is True
    assert admitted.normalization_operation == "none"
    assert admitted.generated_normalization_manifest_path is None
    assert json.loads(
        admitted.manifest_path.read_text(encoding="utf-8")
    )["schema_version"] == 1
    assert admitted.preview_path.is_file()

    normalized_raw, normalized_receipt = _capture_raw(
        tmp_path,
        directory_name="capture-normalized",
        color="0x274F78",
    )
    normalized_construction = construct_motion_source(
        normalized_raw,
        tmp_path / "generated-normalization",
        geometry_mode=SCALE_CENTER_CROP_MODE,
    )
    normalized_admitted = admit_motion_reshoot(
        project_root=tmp_path,
        approved_source_path=construction.output_path,
        source_approval_path=approval,
        source_decode_bundle_manifest_path=bundle.manifest_path,
        temporal_matte_manifest_path=matte_manifest,
        generated_media_path=normalized_construction.output_path,
        generated_capture_receipt_path=normalized_receipt,
        generated_normalization_manifest_path=(
            normalized_construction.manifest_path
        ),
        output_directory=tmp_path / "normalized-admission",
    )
    assert normalized_admitted.proof.audit.passed is True
    assert normalized_admitted.generated_snapshot_path.name == (
        "generated-canonical.mp4"
    )
    assert normalized_admitted.generated_normalization_manifest_path == (
        normalized_construction.manifest_path
    )
    assert json.loads(
        normalized_admitted.manifest_path.read_text(encoding="utf-8")
    )["schema_version"] == 2

    frame_index = 73
    source = load_rgb_png(admitted.proof.source_paths[frame_index])
    composite = load_rgb_png(admitted.proof.composite_paths[frame_index])
    core = load_core_mask(admitted.proof.core_mask_paths[frame_index])
    np.testing.assert_array_equal(composite[core], source[core])

    # Required negative control: one source-authoritative core sample changes.
    y, x = np.argwhere(core)[0]
    composite[y, x, 1] ^= np.uint8(1)
    Image.fromarray(composite, mode="RGB").save(
        admitted.proof.composite_paths[frame_index],
        format="PNG",
    )
    with pytest.raises(MotionAdmissionError, match="motion proof no longer passes"):
        verify_motion_reshoot_admission(admitted.manifest_path)
