from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil

import numpy as np
import pytest
from PIL import Image

from framelock_media.ffmpeg_pipeline import (
    encode_mask_transport,
    materialize_static_mask_sequence,
)
from framelock_media.mask_transport_evidence import (
    MaskTransportEvidenceError,
    seal_mask_transport_evidence,
    verify_mask_transport_evidence,
)
from framelock_media.temporal_matte import ingest_rgba_png_sequence


def _canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")


def _rewrite_receipt_digest(payload: dict[str, object]) -> None:
    payload.pop("digest_sha256", None)
    payload["digest_sha256"] = hashlib.sha256(
        _canonical_bytes(payload)
    ).hexdigest()


@pytest.fixture(scope="session")
def admitted_temporal_matte(
    tmp_path_factory: pytest.TempPathFactory,
) -> Path:
    root = tmp_path_factory.mktemp("mask-transport-admitted-matte")
    source = root / "source"
    source.mkdir()
    paths: list[Path] = []
    for index in range(121):
        rgba = np.zeros((720, 1280, 4), dtype=np.uint8)
        rgba[..., :3] = np.array([44, 90, 130], dtype=np.uint8)
        left = 390 + index
        rgba[110:670, left : left + 230, 3] = np.uint8(255)
        rgba[110:670, left, 3] = np.uint8(96)
        rgba[110:670, left + 1, 3] = np.uint8(160)
        path = source / f"veed_{index:06d}.png"
        Image.fromarray(rgba, mode="RGBA").save(path, format="PNG")
        paths.append(path)
    result = ingest_rgba_png_sequence(tuple(paths), root / "matte")
    return result.manifest_path


@pytest.fixture(scope="session")
def sealed_transport(
    tmp_path_factory: pytest.TempPathFactory,
    admitted_temporal_matte: Path,
) -> Path:
    root = tmp_path_factory.mktemp("sealed-mask-transport")
    result = seal_mask_transport_evidence(
        admitted_temporal_matte,
        root / "sealed",
    )
    return result.receipt_path


@pytest.fixture(scope="session")
def alternate_transport(
    tmp_path_factory: pytest.TempPathFactory,
) -> Path:
    root = tmp_path_factory.mktemp("alternate-mask-transport")
    mask = np.full((720, 1280), 255, dtype=np.uint8)
    mask[180:620, 690:940] = np.uint8(0)
    static = root / "static.png"
    Image.fromarray(mask, mode="L").save(static, format="PNG")
    sequence = materialize_static_mask_sequence(static, root / "masks")
    output = root / "alternate.mp4"
    encode_mask_transport(sequence, output)
    return output


def _clone_sealed(receipt: Path, destination: Path) -> Path:
    shutil.copytree(receipt.parent, destination)
    cloned_receipt = destination / receipt.name
    payload = json.loads(cloned_receipt.read_text(encoding="utf-8"))
    transport = destination / "mask-transport.mp4"
    payload["transport"]["path"] = str(transport.resolve())
    _rewrite_receipt_digest(payload)
    cloned_receipt.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return cloned_receipt


def test_seal_binds_admitted_matte_transport_and_exact_roundtrip(
    sealed_transport: Path,
) -> None:
    result = verify_mask_transport_evidence(sealed_transport)

    assert result.receipt_path == sealed_transport.resolve()
    assert result.transport_path == (
        sealed_transport.parent / "mask-transport.mp4"
    ).resolve()
    assert result.exact_roundtrip is True

    payload = json.loads(sealed_transport.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert payload["kind"] == "framelock_vace_mask_transport_evidence"
    assert payload["temporal_matte"]["manifest_digest_sha256"]
    assert payload["temporal_matte"]["edit_mask_ordered_digest_sha256"]
    assert payload["transport"]["media_facts"]["frame_count"] == 121
    assert payload["transport"]["media_facts"]["frame_rate"] == {
        "denominator": 1,
        "numerator": 24,
    }
    assert payload["roundtrip"]["authoritative_ordered_pixels_sha256"] == (
        payload["roundtrip"]["decoded_ordered_pixels_sha256"]
    )
    assert payload["roundtrip"]["exact_equality"] is True


def test_seal_refuses_existing_output_directory(
    tmp_path: Path,
    admitted_temporal_matte: Path,
) -> None:
    output = tmp_path / "sealed"
    output.mkdir()

    with pytest.raises(MaskTransportEvidenceError, match="already exists"):
        seal_mask_transport_evidence(admitted_temporal_matte, output)


def test_receipt_digest_tamper_fails_closed(
    tmp_path: Path,
    sealed_transport: Path,
) -> None:
    receipt = _clone_sealed(sealed_transport, tmp_path / "sealed")
    payload = json.loads(receipt.read_text(encoding="utf-8"))
    payload["roundtrip"]["exact_equality"] = False
    receipt.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(MaskTransportEvidenceError, match="receipt digest differs"):
        verify_mask_transport_evidence(receipt)


def test_forged_decoded_digest_is_recomputed_and_rejected(
    tmp_path: Path,
    sealed_transport: Path,
) -> None:
    receipt = _clone_sealed(sealed_transport, tmp_path / "sealed")
    payload = json.loads(receipt.read_text(encoding="utf-8"))
    payload["roundtrip"]["decoded_ordered_pixels_sha256"] = "0" * 64
    _rewrite_receipt_digest(payload)
    receipt.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(
        MaskTransportEvidenceError,
        match="fresh decoded ordered digest differs",
    ):
        verify_mask_transport_evidence(receipt)


def test_valid_but_swapped_transport_is_rejected(
    tmp_path: Path,
    sealed_transport: Path,
    alternate_transport: Path,
) -> None:
    receipt = _clone_sealed(sealed_transport, tmp_path / "sealed")
    transport = receipt.parent / "mask-transport.mp4"
    shutil.copyfile(alternate_transport, transport)

    with pytest.raises(
        MaskTransportEvidenceError,
        match="transport byte count differs|transport SHA-256 differs",
    ):
        verify_mask_transport_evidence(receipt)


def test_forged_transport_hash_still_fails_exact_roundtrip(
    tmp_path: Path,
    sealed_transport: Path,
    alternate_transport: Path,
) -> None:
    receipt = _clone_sealed(sealed_transport, tmp_path / "sealed")
    transport = receipt.parent / "mask-transport.mp4"
    shutil.copyfile(alternate_transport, transport)
    payload = json.loads(receipt.read_text(encoding="utf-8"))
    payload["transport"]["bytes"] = transport.stat().st_size
    payload["transport"]["sha256"] = hashlib.sha256(
        transport.read_bytes()
    ).hexdigest()
    _rewrite_receipt_digest(payload)
    receipt.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(MaskTransportEvidenceError, match="media facts differ|roundtrip"):
        verify_mask_transport_evidence(receipt)


def test_reordered_temporal_manifest_is_reverified_and_rejected(
    tmp_path: Path,
    sealed_transport: Path,
    admitted_temporal_matte: Path,
) -> None:
    receipt = _clone_sealed(sealed_transport, tmp_path / "sealed")
    original_manifest = admitted_temporal_matte.read_bytes()
    try:
        manifest = json.loads(original_manifest)
        manifest["frames"][0], manifest["frames"][1] = (
            manifest["frames"][1],
            manifest["frames"][0],
        )
        _rewrite_receipt_digest(manifest)
        admitted_temporal_matte.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        receipt_payload = json.loads(receipt.read_text(encoding="utf-8"))
        receipt_payload["temporal_matte"]["manifest_file_sha256"] = (
            hashlib.sha256(admitted_temporal_matte.read_bytes()).hexdigest()
        )
        receipt_payload["temporal_matte"]["manifest_digest_sha256"] = (
            manifest["digest_sha256"]
        )
        _rewrite_receipt_digest(receipt_payload)
        receipt.write_text(
            json.dumps(receipt_payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        with pytest.raises(
            MaskTransportEvidenceError,
            match="temporal matte verification failed",
        ):
            verify_mask_transport_evidence(receipt)
    finally:
        admitted_temporal_matte.write_bytes(original_manifest)


def test_extra_or_missing_sealed_artifact_fails_closed(
    tmp_path: Path,
    sealed_transport: Path,
) -> None:
    receipt = _clone_sealed(sealed_transport, tmp_path / "sealed")
    (receipt.parent / "unbound.bin").write_bytes(b"unbound")

    with pytest.raises(MaskTransportEvidenceError, match="unbound files"):
        verify_mask_transport_evidence(receipt)
