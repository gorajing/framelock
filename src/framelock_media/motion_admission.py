from __future__ import annotations

from dataclasses import asdict, dataclass, fields
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

import numpy as np

from .artifacts import load_rgb_png, sha256_file
from .contract import CANONICAL_CONTRACT, DecodeProvenance
from .fal_lineage import (
    VerifiedFalArtifactAdoption,
    verify_fal_artifact_adoption,
)
from .ffmpeg_pipeline import (
    decode_comparable_rgb24_frames_with_provenance,
    decode_rgb24_frames_with_provenance,
    encode_preview,
    probe_media_evidence,
)
from .generation_gate import evaluate_comparability
from .motion_proof import (
    MotionInputFrame,
    MotionInputManifest,
    MotionProofResult,
    run_canonical_motion_proof,
    verify_motion_proof,
)
from .motion_source import (
    MotionSourceConstruction,
    load_motion_source_construction,
)
from .temporal_matte import TemporalMatteResult, verify_temporal_matte
from .verify import (
    VERIFIED_CORE_CLAIM,
    FrameAudit,
    GenerationBinding,
    MaskParameters,
    ProofFrame,
    ProofManifest,
    SequenceAudit,
)


SOURCE_BUNDLE_MANIFEST_NAME = "canonical_source_decode_manifest.json"
ADMISSION_MANIFEST_NAME = "motion_reshoot_admission.json"
SOURCE_BUNDLE_KIND = "framelock_canonical_source_decode_bundle"
ADMISSION_KIND = "framelock_motion_reshoot_admission"


class MotionAdmissionError(RuntimeError):
    """Raised when a generated reshoot cannot enter the verified artifact set."""


@dataclass(frozen=True)
class CanonicalSourceDecodeBundle:
    directory: Path
    manifest_path: Path
    manifest_digest_sha256: str
    approved_source_path: Path
    source_approval_path: Path
    snapshot_path: Path
    frame_paths: tuple[Path, ...]
    provenance: DecodeProvenance


@dataclass(frozen=True)
class MotionReshootAdmission:
    directory: Path
    manifest_path: Path
    manifest_digest_sha256: str
    preview_path: Path
    generated_snapshot_path: Path
    generated_frame_paths: tuple[Path, ...]
    generated_provenance: DecodeProvenance
    normalization_operation: str
    proof: MotionProofResult
    generated_normalization_manifest_path: Path | None = None


@dataclass(frozen=True)
class _CaptureBinding:
    receipt_path: Path
    receipt_sha256: str
    attempt_id: str
    endpoint: str
    request_id: str
    download_path: Path
    download_sha256: str
    download_bytes: int
    fal_url: str
    json_pointer: str


@dataclass(frozen=True)
class _GeneratedNormalization:
    manifest_path: Path
    manifest_digest_sha256: str
    raw_source_path: Path
    raw_source_sha256: str
    canonical_output_path: Path
    canonical_output_sha256: str
    geometry_mode: str
    construction: MotionSourceConstruction


def _canonical_json_bytes(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise MotionAdmissionError(
            "admission evidence contains noncanonical JSON"
        ) from error


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _require_sha256(value: object, *, role: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise MotionAdmissionError(f"{role} SHA-256 is malformed")
    return value


def _load_json(path: Path, *, role: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MotionAdmissionError(f"{role} is unreadable") from error
    if not isinstance(value, dict):
        raise MotionAdmissionError(f"{role} must be a JSON object")
    return value


def _resolved_file(path: Path, *, role: str) -> Path:
    try:
        resolved = Path(path).resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise MotionAdmissionError(f"{role} is missing: {path}") from error
    if not resolved.is_file():
        raise MotionAdmissionError(f"{role} is not a file: {path}")
    return resolved


def _resolved_directory(path: Path, *, role: str) -> Path:
    try:
        resolved = Path(path).resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise MotionAdmissionError(f"{role} is missing: {path}") from error
    if not resolved.is_dir():
        raise MotionAdmissionError(f"{role} is not a directory: {path}")
    return resolved


def _project_root(path: Path) -> Path:
    return _resolved_directory(path, role="project root")


def _under_root(path: Path, root: Path, *, role: str) -> Path:
    resolved = _resolved_file(path, role=role)
    if not resolved.is_relative_to(root):
        raise MotionAdmissionError(f"{role} escapes the project root")
    return resolved


def _resolve_project_reference(
    value: object,
    root: Path,
    *,
    role: str,
) -> Path:
    if not isinstance(value, str) or not value:
        raise MotionAdmissionError(f"{role} path is malformed")
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = root / candidate
    return _under_root(candidate, root, role=role)


def _file_record(path: Path) -> dict[str, object]:
    resolved = _resolved_file(path, role="artifact")
    return {
        "bytes": resolved.stat().st_size,
        "path": str(resolved),
        "sha256": sha256_file(resolved),
    }


def _verify_file_record(value: object, *, role: str) -> Path:
    if not isinstance(value, dict) or set(value) != {"bytes", "path", "sha256"}:
        raise MotionAdmissionError(f"{role} file record is malformed")
    path_value = value.get("path")
    size = value.get("bytes")
    if not isinstance(path_value, str) or not isinstance(size, int) or size < 0:
        raise MotionAdmissionError(f"{role} file record is malformed")
    path = _resolved_file(Path(path_value), role=role)
    if path_value != str(path) or path.stat().st_size != size:
        raise MotionAdmissionError(f"{role} file identity differs")
    if sha256_file(path) != _require_sha256(value.get("sha256"), role=role):
        raise MotionAdmissionError(f"{role} file hash differs")
    return path


def _write_exclusive_json(path: Path, payload: Mapping[str, object]) -> None:
    encoded = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    try:
        with path.open("x", encoding="utf-8") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError as error:
        raise MotionAdmissionError(f"immutable artifact exists: {path}") from error


def _snapshot_file(source: Path, target: Path, *, expected_sha256: str) -> Path:
    if target.exists():
        raise MotionAdmissionError(f"immutable snapshot exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    try:
        with source.open("rb") as reader, target.open("xb") as writer:
            for chunk in iter(lambda: reader.read(1024 * 1024), b""):
                digest.update(chunk)
                writer.write(chunk)
            writer.flush()
            os.fsync(writer.fileno())
    except Exception:
        target.unlink(missing_ok=True)
        raise
    if digest.hexdigest() != expected_sha256:
        target.unlink(missing_ok=True)
        raise MotionAdmissionError("input changed while its snapshot was created")
    return target.resolve()


def _ordered_frame_digest(paths: Sequence[Path]) -> str:
    if len(paths) != CANONICAL_CONTRACT.frame_count:
        raise MotionAdmissionError("decoded sequence must contain exactly 121 frames")
    records: list[dict[str, object]] = []
    for index, path in enumerate(paths):
        expected_name = f"frame_{index:06d}.png"
        if path.name != expected_name:
            raise MotionAdmissionError("decoded frame order or names are noncanonical")
        rgb = load_rgb_png(path)
        if rgb.shape != (
            CANONICAL_CONTRACT.height,
            CANONICAL_CONTRACT.width,
            3,
        ):
            raise MotionAdmissionError("decoded frame geometry is noncanonical")
        records.append(
            {
                "file_sha256": sha256_file(path),
                "index": index,
                "pixels_sha256": _sha256_bytes(
                    np.ascontiguousarray(rgb).tobytes(order="C")
                ),
            }
        )
    return _sha256_bytes(_canonical_json_bytes(records))


def _decode_provenance(value: object, *, role: str) -> DecodeProvenance:
    if not isinstance(value, dict):
        raise MotionAdmissionError(f"{role} decode provenance is malformed")
    expected = {field.name for field in fields(DecodeProvenance)}
    if set(value) != expected:
        raise MotionAdmissionError(f"{role} decode provenance schema differs")
    prepared = dict(value)
    for key in ("probe_argv", "decode_argv"):
        raw = prepared.get(key)
        if not isinstance(raw, list) or not all(
            isinstance(item, str) for item in raw
        ):
            raise MotionAdmissionError(f"{role} {key} is malformed")
        prepared[key] = tuple(raw)
    try:
        return DecodeProvenance(**prepared)
    except TypeError as error:
        raise MotionAdmissionError(
            f"{role} decode provenance fields are malformed"
        ) from error


def _validate_source_approval(
    *,
    project_root: Path,
    approved_source_path: Path,
    source_approval_path: Path,
) -> tuple[Path, Path, Path, str, str]:
    source = _under_root(approved_source_path, project_root, role="approved source")
    approval_path = _under_root(
        source_approval_path,
        project_root,
        role="source approval",
    )
    approval = _load_json(approval_path, role="source approval")
    canonical = approval.get("approvedCanonical")
    review = approval.get("review")
    if (
        approval.get("schemaVersion") != 1
        or approval.get("decision") != "approved_for_motion_v1_generation"
        or not isinstance(canonical, dict)
        or not isinstance(review, dict)
    ):
        raise MotionAdmissionError("source approval decision is invalid")
    declared_source = _resolve_project_reference(
        canonical.get("path"),
        project_root,
        role="approved canonical source",
    )
    source_sha256 = _require_sha256(
        canonical.get("sha256"),
        role="approved source",
    )
    if declared_source != source or sha256_file(source) != source_sha256:
        raise MotionAdmissionError("approved source differs from source approval")
    if (
        canonical.get("width") != CANONICAL_CONTRACT.width
        or canonical.get("height") != CANONICAL_CONTRACT.height
        or canonical.get("frameCount") != CANONICAL_CONTRACT.frame_count
        or canonical.get("frameRate") != "24/1"
    ):
        raise MotionAdmissionError("approved source contract is noncanonical")
    if (
        review.get("verdict") != "approve"
        or review.get("allFullBodyFramesPassed") is not True
        or review.get("allFaceFramesPassed") is not True
        or review.get("allBadgeFramesPassed") is not True
        or review.get("exactTransformOutputFramehashEquality") is not True
    ):
        raise MotionAdmissionError("source approval review gates did not pass")

    construction_path = _resolve_project_reference(
        canonical.get("constructionManifest"),
        project_root,
        role="source construction manifest",
    )
    construction = load_motion_source_construction(construction_path)
    construction_digest = _require_sha256(
        canonical.get("constructionManifestDigestSha256"),
        role="source construction manifest",
    )
    if (
        construction.output_path != source
        or construction.output_sha256 != source_sha256
        or construction.manifest_digest_sha256 != construction_digest
        or construction.geometry_mode != canonical.get("geometryMode")
    ):
        raise MotionAdmissionError("source construction differs from approval")
    return (
        source,
        approval_path,
        construction_path,
        source_sha256,
        construction_digest,
    )


def _json_pointer(value: object, pointer: str) -> object:
    if pointer == "":
        return value
    if not pointer.startswith("/"):
        raise MotionAdmissionError("capture JSON pointer is malformed")
    current = value
    for encoded in pointer[1:].split("/"):
        token = encoded.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            if token not in current:
                raise MotionAdmissionError("capture JSON pointer is unresolved")
            current = current[token]
        elif isinstance(current, list):
            if not token.isdigit():
                raise MotionAdmissionError("capture JSON pointer is unresolved")
            index = int(token)
            if index >= len(current):
                raise MotionAdmissionError("capture JSON pointer is unresolved")
            current = current[index]
        else:
            raise MotionAdmissionError("capture JSON pointer is unresolved")
    return current


def _validate_fal_media_url(value: object) -> str:
    if not isinstance(value, str):
        raise MotionAdmissionError("capture fal media URL is malformed")
    parsed = urlsplit(value)
    host = parsed.hostname
    if (
        parsed.scheme != "https"
        or host is None
        or not (host == "fal.media" or host.endswith(".fal.media"))
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise MotionAdmissionError("capture fal media URL is not trusted")
    return value


def _verify_capture_receipt(
    receipt_path: Path,
    generated_media_path: Path,
    *,
    project_root: Path,
) -> _CaptureBinding:
    receipt = _under_root(receipt_path, project_root, role="capture receipt")
    generated = _under_root(
        generated_media_path,
        project_root,
        role="captured generated media",
    )
    payload = _load_json(receipt, role="capture receipt")
    if set(payload) != {
        "attempt",
        "capturedAt",
        "downloads",
        "kind",
        "result",
        "schemaVersion",
        "status",
    } or payload.get("schemaVersion") != 1 or payload.get("kind") != (
        "motion-v1-fal-read-capture"
    ):
        raise MotionAdmissionError("capture receipt schema is invalid")
    attempt = payload.get("attempt")
    downloads = payload.get("downloads")
    if not isinstance(attempt, dict) or not isinstance(downloads, list):
        raise MotionAdmissionError("capture receipt records are malformed")
    required_attempt = {"attemptId", "endpoint", "inputDigest", "requestId"}
    if not required_attempt.issubset(attempt):
        raise MotionAdmissionError("capture attempt record is incomplete")
    attempt_id = attempt.get("attemptId")
    endpoint = attempt.get("endpoint")
    request_id = attempt.get("requestId")
    if not all(
        isinstance(value, str) and value
        for value in (attempt_id, endpoint, request_id)
    ):
        raise MotionAdmissionError("capture attempt identity is malformed")
    _require_sha256(attempt.get("inputDigest"), role="capture input digest")

    for key, name in (
        ("status", "remote-status.json"),
        ("result", "remote-result.json"),
    ):
        record = payload.get(key)
        if not isinstance(record, dict) or set(record) != {
            "bytes",
            "fileName",
            "mime",
            "sha256",
        }:
            raise MotionAdmissionError(f"capture {key} record is malformed")
        if record.get("fileName") != name or record.get("mime") != "application/json":
            raise MotionAdmissionError(f"capture {key} identity differs")
        path = _resolved_file(receipt.parent / name, role=f"capture {key}")
        if (
            not isinstance(record.get("bytes"), int)
            or path.stat().st_size != record["bytes"]
            or sha256_file(path)
            != _require_sha256(record.get("sha256"), role=f"capture {key}")
        ):
            raise MotionAdmissionError(f"capture {key} file differs")
    remote_result = _load_json(
        receipt.parent / "remote-result.json",
        role="remote result",
    )

    matches: list[dict[str, Any]] = []
    for raw in downloads:
        if not isinstance(raw, dict) or set(raw) != {
            "bytes",
            "falUrl",
            "fileName",
            "jsonPointer",
            "mime",
            "sha256",
        }:
            raise MotionAdmissionError("capture download record is malformed")
        file_name = raw.get("fileName")
        if not isinstance(file_name, str) or Path(file_name).name != file_name:
            raise MotionAdmissionError("capture download file name is unsafe")
        if (receipt.parent / file_name).resolve() == generated:
            matches.append(raw)
    if len(matches) != 1:
        raise MotionAdmissionError(
            "captured generated media must match exactly one receipt download"
        )
    download = matches[0]
    download_sha256 = _require_sha256(
        download.get("sha256"),
        role="capture download",
    )
    download_bytes = download.get("bytes")
    if (
        not isinstance(download_bytes, int)
        or download_bytes <= 0
        or generated.stat().st_size != download_bytes
        or sha256_file(generated) != download_sha256
    ):
        raise MotionAdmissionError("captured generated media file differs")
    json_pointer = download.get("jsonPointer")
    if not isinstance(json_pointer, str):
        raise MotionAdmissionError("capture download JSON pointer is malformed")
    fal_url = _validate_fal_media_url(download.get("falUrl"))
    if _json_pointer(remote_result, json_pointer) != fal_url:
        raise MotionAdmissionError("capture remote result URL differs")
    return _CaptureBinding(
        receipt_path=receipt,
        receipt_sha256=sha256_file(receipt),
        attempt_id=attempt_id,
        endpoint=endpoint,
        request_id=request_id,
        download_path=generated,
        download_sha256=download_sha256,
        download_bytes=download_bytes,
        fal_url=fal_url,
        json_pointer=json_pointer,
    )


def _verify_generated_normalization(
    *,
    project_root: Path,
    capture: _CaptureBinding,
    generated_media_path: Path,
    normalization_manifest_path: Path,
) -> _GeneratedNormalization:
    """Bind a captured raw fal result to one verified canonical derivative."""
    root = _project_root(project_root)
    manifest = _under_root(
        normalization_manifest_path,
        root,
        role="generated normalization manifest",
    )
    generated = _under_root(
        generated_media_path,
        root,
        role="normalized generated media",
    )
    construction = load_motion_source_construction(manifest)
    if construction.manifest_path != manifest:
        raise MotionAdmissionError("generated normalization manifest path differs")
    if (
        construction.source_path != capture.download_path
        or construction.source_sha256 != capture.download_sha256
    ):
        raise MotionAdmissionError(
            "normalization raw source differs from fal capture"
        )
    if (
        construction.output_path != generated
        or construction.output_sha256 != sha256_file(generated)
    ):
        raise MotionAdmissionError(
            "normalization canonical output differs from generated media"
        )
    return _GeneratedNormalization(
        manifest_path=manifest,
        manifest_digest_sha256=construction.manifest_digest_sha256,
        raw_source_path=construction.source_path,
        raw_source_sha256=construction.source_sha256,
        canonical_output_path=construction.output_path,
        canonical_output_sha256=construction.output_sha256,
        geometry_mode=construction.geometry_mode,
        construction=construction,
    )


def _optional_adoption(
    adoption_path: Path | None,
    *,
    expected_download_sha256: str | None,
) -> tuple[dict[str, object], VerifiedFalArtifactAdoption | None]:
    if adoption_path is None:
        return ({"status": "not_provided"}, None)
    if expected_download_sha256 is None:
        raise MotionAdmissionError(
            "fal adoption cannot be bound without a source download hash"
        )
    verified = verify_fal_artifact_adoption(adoption_path)
    if verified.download_sha256 != expected_download_sha256:
        raise MotionAdmissionError("fal adoption download differs from artifact")
    return (
        {
            "digest_sha256": verified.digest_sha256,
            "path": str(verified.path),
            "sha256": sha256_file(verified.path),
            "status": "verified",
        },
        verified,
    )


def _verify_optional_adoption(
    value: object,
    *,
    expected_download_sha256: str | None,
) -> None:
    if value == {"status": "not_provided"}:
        return
    if expected_download_sha256 is None:
        raise MotionAdmissionError(
            "fal adoption cannot be bound without a source download hash"
        )
    if not isinstance(value, dict) or set(value) != {
        "digest_sha256",
        "path",
        "sha256",
        "status",
    } or value.get("status") != "verified":
        raise MotionAdmissionError("fal adoption record is malformed")
    path_value = value.get("path")
    if not isinstance(path_value, str):
        raise MotionAdmissionError("fal adoption path is malformed")
    verified = verify_fal_artifact_adoption(Path(path_value))
    if (
        str(verified.path) != path_value
        or verified.digest_sha256
        != _require_sha256(value.get("digest_sha256"), role="fal adoption")
        or sha256_file(verified.path)
        != _require_sha256(value.get("sha256"), role="fal adoption file")
        or verified.download_sha256 != expected_download_sha256
    ):
        raise MotionAdmissionError("fal adoption identity differs")


def _bundle_frame_records(paths: Sequence[Path]) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for index, path in enumerate(paths):
        rgb = load_rgb_png(path)
        records.append(
            {
                "file_sha256": sha256_file(path),
                "index": index,
                "path": str(path.resolve()),
                "pixels_sha256": _sha256_bytes(
                    np.ascontiguousarray(rgb).tobytes(order="C")
                ),
            }
        )
    return records


def seal_canonical_source_decode_bundle(
    *,
    project_root: Path,
    approved_source_path: Path,
    source_approval_path: Path,
    output_directory: Path,
) -> CanonicalSourceDecodeBundle:
    """Decode the approved source once into an immutable reusable frame bundle."""
    root = _project_root(project_root)
    target = Path(output_directory).resolve()
    if target.exists():
        raise MotionAdmissionError("canonical source decode bundle already exists")
    if not target.is_relative_to(root) or target == root:
        raise MotionAdmissionError(
            "canonical source decode bundle escapes project root"
        )
    (
        approved_source,
        approval,
        construction_manifest,
        source_sha256,
        construction_digest,
    ) = _validate_source_approval(
        project_root=root,
        approved_source_path=approved_source_path,
        source_approval_path=source_approval_path,
    )
    target.mkdir(parents=True)
    try:
        snapshot = _snapshot_file(
            approved_source,
            target / "approved-source.mp4",
            expected_sha256=source_sha256,
        )
        decoded = decode_rgb24_frames_with_provenance(
            snapshot,
            target / "source_frames",
        )
        if decoded.provenance.source_file_sha256 != source_sha256:
            raise MotionAdmissionError("source snapshot decode hash differs")
        frame_records = _bundle_frame_records(decoded.paths)
        ordered_digest = _ordered_frame_digest(decoded.paths)
        payload: dict[str, object] = {
            "contract": {
                "frame_count": CANONICAL_CONTRACT.frame_count,
                "frame_rate": "24/1",
                "height": CANONICAL_CONTRACT.height,
                "width": CANONICAL_CONTRACT.width,
            },
            "decode_provenance": asdict(decoded.provenance),
            "frames": frame_records,
            "kind": SOURCE_BUNDLE_KIND,
            "ordered_frame_digest_sha256": ordered_digest,
            "project_root": str(root),
            "schema_version": 1,
            "source": {
                "approval": _file_record(approval),
                "construction_manifest": {
                    **_file_record(construction_manifest),
                    "manifest_digest_sha256": construction_digest,
                },
                "original": _file_record(approved_source),
                "snapshot": _file_record(snapshot),
            },
        }
        payload["digest_sha256"] = _sha256_bytes(_canonical_json_bytes(payload))
        _write_exclusive_json(target / SOURCE_BUNDLE_MANIFEST_NAME, payload)
        return verify_canonical_source_decode_bundle(
            target / SOURCE_BUNDLE_MANIFEST_NAME
        )
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise


def verify_canonical_source_decode_bundle(
    manifest_path: Path,
) -> CanonicalSourceDecodeBundle:
    """Reopen the sealed approved-source decode and verify every bound frame."""
    manifest = _resolved_file(manifest_path, role="source decode manifest")
    if manifest.name != SOURCE_BUNDLE_MANIFEST_NAME:
        raise MotionAdmissionError("source decode manifest name is noncanonical")
    payload = _load_json(manifest, role="source decode manifest")
    if set(payload) != {
        "contract",
        "decode_provenance",
        "digest_sha256",
        "frames",
        "kind",
        "ordered_frame_digest_sha256",
        "project_root",
        "schema_version",
        "source",
    } or payload.get("kind") != SOURCE_BUNDLE_KIND or payload.get(
        "schema_version"
    ) != 1:
        raise MotionAdmissionError("source decode manifest schema is invalid")
    declared = _require_sha256(payload.get("digest_sha256"), role="source bundle")
    unsigned = dict(payload)
    unsigned.pop("digest_sha256")
    if _sha256_bytes(_canonical_json_bytes(unsigned)) != declared:
        raise MotionAdmissionError("source decode manifest digest differs")
    contract = payload.get("contract")
    if contract != {
        "frame_count": CANONICAL_CONTRACT.frame_count,
        "frame_rate": "24/1",
        "height": CANONICAL_CONTRACT.height,
        "width": CANONICAL_CONTRACT.width,
    }:
        raise MotionAdmissionError("source decode contract differs")
    project_value = payload.get("project_root")
    if not isinstance(project_value, str):
        raise MotionAdmissionError("source decode project root is malformed")
    project = _project_root(Path(project_value))
    if project_value != str(project) or not manifest.is_relative_to(project):
        raise MotionAdmissionError("source decode project root differs")
    source = payload.get("source")
    if not isinstance(source, dict) or set(source) != {
        "approval",
        "construction_manifest",
        "original",
        "snapshot",
    }:
        raise MotionAdmissionError("source decode source record is malformed")
    original = _verify_file_record(source["original"], role="approved source")
    approval = _verify_file_record(source["approval"], role="source approval")
    snapshot = _verify_file_record(source["snapshot"], role="source snapshot")
    construction_record = source["construction_manifest"]
    if not isinstance(construction_record, dict) or set(construction_record) != {
        "bytes",
        "manifest_digest_sha256",
        "path",
        "sha256",
    }:
        raise MotionAdmissionError("source construction record is malformed")
    construction_file_record = dict(construction_record)
    construction_digest = construction_file_record.pop(
        "manifest_digest_sha256"
    )
    construction = _verify_file_record(
        construction_file_record,
        role="source construction manifest",
    )
    validated = _validate_source_approval(
        project_root=project,
        approved_source_path=original,
        source_approval_path=approval,
    )
    if validated[2] != construction or validated[4] != _require_sha256(
        construction_digest,
        role="source construction manifest",
    ):
        raise MotionAdmissionError("source decode construction binding differs")
    if sha256_file(snapshot) != validated[3]:
        raise MotionAdmissionError("source snapshot differs from approved source")

    raw_frames = payload.get("frames")
    if not isinstance(raw_frames, list) or len(raw_frames) != (
        CANONICAL_CONTRACT.frame_count
    ):
        raise MotionAdmissionError("source decode frame records are malformed")
    frame_paths: list[Path] = []
    for index, record in enumerate(raw_frames):
        if not isinstance(record, dict) or set(record) != {
            "file_sha256",
            "index",
            "path",
            "pixels_sha256",
        } or record.get("index") != index:
            raise MotionAdmissionError("source decode frame order differs")
        path_value = record.get("path")
        if not isinstance(path_value, str):
            raise MotionAdmissionError("source decode frame path is malformed")
        path = _resolved_file(Path(path_value), role="source decoded frame")
        if (
            path_value != str(path)
            or path.parent != manifest.parent / "source_frames"
            or path.name != f"frame_{index:06d}.png"
            or sha256_file(path)
            != _require_sha256(record.get("file_sha256"), role="source frame")
        ):
            raise MotionAdmissionError("source decoded frame identity differs")
        rgb = load_rgb_png(path)
        pixels = _sha256_bytes(np.ascontiguousarray(rgb).tobytes(order="C"))
        if pixels != _require_sha256(
            record.get("pixels_sha256"),
            role="source frame pixels",
        ):
            raise MotionAdmissionError("source decoded frame pixels differ")
        frame_paths.append(path)
    paths = tuple(frame_paths)
    ordered = _ordered_frame_digest(paths)
    if ordered != _require_sha256(
        payload.get("ordered_frame_digest_sha256"),
        role="source ordered frames",
    ):
        raise MotionAdmissionError("source ordered frame digest differs")
    provenance = _decode_provenance(
        payload.get("decode_provenance"),
        role="source",
    )
    if (
        provenance.source_media_path != str(snapshot)
        or provenance.source_file_sha256 != sha256_file(snapshot)
        or provenance.decoded_frame_count != CANONICAL_CONTRACT.frame_count
        or provenance.width != CANONICAL_CONTRACT.width
        or provenance.height != CANONICAL_CONTRACT.height
        or provenance.frame_rate_numerator != 24
        or provenance.frame_rate_denominator != 1
    ):
        raise MotionAdmissionError("source decode provenance differs")
    return CanonicalSourceDecodeBundle(
        directory=manifest.parent,
        manifest_path=manifest,
        manifest_digest_sha256=declared,
        approved_source_path=original,
        source_approval_path=approval,
        snapshot_path=snapshot,
        frame_paths=paths,
        provenance=provenance,
    )


def _load_motion_input_manifest(path: Path) -> MotionInputManifest:
    payload = _load_json(path, role="motion input manifest")
    raw_frames = payload.get("frames")
    if not isinstance(raw_frames, list):
        raise MotionAdmissionError("motion input frames are malformed")
    try:
        prepared = dict(payload)
        prepared["frames"] = tuple(MotionInputFrame(**frame) for frame in raw_frames)
        return MotionInputManifest(**prepared)
    except (TypeError, AttributeError) as error:
        raise MotionAdmissionError("motion input manifest is malformed") from error


def _load_proof_manifest(path: Path) -> ProofManifest:
    payload = _load_json(path, role="motion proof manifest")
    raw_frames = payload.get("frames")
    raw_parameters = payload.get("mask_parameters")
    if not isinstance(raw_frames, list) or not isinstance(raw_parameters, dict):
        raise MotionAdmissionError("motion proof manifest is malformed")
    prepared = dict(payload)
    try:
        prepared["frames"] = tuple(ProofFrame(**frame) for frame in raw_frames)
        prepared["mask_parameters"] = MaskParameters(**raw_parameters)
        if prepared.get("media_provenance") is not None:
            prepared["media_provenance"] = _decode_provenance(
                prepared["media_provenance"],
                role="proof source",
            )
        binding = prepared.get("generation_binding")
        if binding is not None:
            if not isinstance(binding, dict):
                raise MotionAdmissionError("proof generation binding is malformed")
            binding_value = dict(binding)
            binding_value["generated_media_provenance"] = _decode_provenance(
                binding_value.get("generated_media_provenance"),
                role="proof generated",
            )
            prepared["generation_binding"] = GenerationBinding(**binding_value)
        return ProofManifest(**prepared)
    except TypeError as error:
        raise MotionAdmissionError(
            "motion proof manifest fields are malformed"
        ) from error


def _load_audit(path: Path) -> SequenceAudit:
    payload = _load_json(path, role="motion audit")
    raw = payload.get("audit")
    if not isinstance(raw, dict):
        raise MotionAdmissionError("motion audit is malformed")
    frames_value = raw.get("frame_audits")
    if not isinstance(frames_value, list):
        raise MotionAdmissionError("motion audit frames are malformed")
    prepared = dict(raw)
    try:
        prepared["frame_audits"] = tuple(
            FrameAudit(**frame) for frame in frames_value
        )
        return SequenceAudit(**prepared)
    except TypeError as error:
        raise MotionAdmissionError("motion audit fields are malformed") from error


def _reopen_motion_proof(proof_root: Path) -> MotionProofResult:
    motion_input_path = proof_root / "motion_inputs.json"
    proof_manifest_path = proof_root / "proof_manifest.json"
    audit_path = proof_root / "motion_audit.json"
    motion_input = _load_motion_input_manifest(motion_input_path)
    proof_manifest = _load_proof_manifest(proof_manifest_path)
    audit = _load_audit(audit_path)
    result = MotionProofResult(
        source_paths=tuple(Path(frame.source_path) for frame in proof_manifest.frames),
        generated_paths=tuple(
            Path(frame.generated_path) for frame in motion_input.frames
        ),
        foreground_mask_paths=tuple(
            Path(frame.foreground_mask_path) for frame in motion_input.frames
        ),
        core_mask_paths=tuple(
            Path(frame.core_mask_path) for frame in proof_manifest.frames
        ),
        composite_paths=tuple(
            Path(frame.composite_path) for frame in proof_manifest.frames
        ),
        motion_input_manifest_path=motion_input_path,
        proof_manifest_path=proof_manifest_path,
        audit_path=audit_path,
        motion_input_manifest=motion_input,
        manifest=proof_manifest,
        audit=audit,
    )
    reopened = verify_motion_proof(result)
    if reopened != audit or not reopened.passed:
        raise MotionAdmissionError("motion proof no longer passes")
    return result


def _normalization_operation(media_path: Path) -> str:
    evidence = probe_media_evidence(media_path)
    comparison = evaluate_comparability(evidence.facts)
    if not comparison.passed:
        failures = ", ".join(comparison.failed_checks)
        raise MotionAdmissionError(f"generated media is not comparable: {failures}")
    if (
        evidence.facts.width,
        evidence.facts.height,
    ) == (CANONICAL_CONTRACT.width, CANONICAL_CONTRACT.height):
        return "none"
    return "framelock_comparability_scale_16_9_to_1280x720"


def admit_motion_reshoot(
    *,
    project_root: Path,
    approved_source_path: Path,
    source_approval_path: Path,
    source_decode_bundle_manifest_path: Path,
    temporal_matte_manifest_path: Path,
    generated_media_path: Path,
    generated_capture_receipt_path: Path,
    output_directory: Path,
    temporal_matte_adoption_path: Path | None = None,
    generated_fal_adoption_path: Path | None = None,
    generated_normalization_manifest_path: Path | None = None,
) -> MotionReshootAdmission:
    """Admit one captured generator result into the exact motion proof path."""
    root = _project_root(project_root)
    target = Path(output_directory).resolve()
    if target.exists():
        raise MotionAdmissionError("motion reshoot admission already exists")
    if target == root or not target.is_relative_to(root):
        raise MotionAdmissionError("motion reshoot admission escapes project root")
    bundle = verify_canonical_source_decode_bundle(
        source_decode_bundle_manifest_path
    )
    approved_source = _under_root(
        approved_source_path,
        root,
        role="approved source",
    )
    approval = _under_root(source_approval_path, root, role="source approval")
    if (
        bundle.approved_source_path != approved_source
        or bundle.source_approval_path != approval
    ):
        raise MotionAdmissionError("source decode bundle belongs to another approval")
    matte = verify_temporal_matte(temporal_matte_manifest_path)
    matte_manifest_payload = _load_json(
        matte.manifest_path,
        role="temporal matte manifest",
    )
    matte_source_payload = matte_manifest_payload.get("source")
    if not isinstance(matte_source_payload, dict):
        raise MotionAdmissionError("temporal matte source record is malformed")
    matte_source_hash_value = matte_source_payload.get("source_file_sha256")
    matte_source_sha256 = (
        _require_sha256(
            matte_source_hash_value,
            role="temporal matte source",
        )
        if matte_source_hash_value is not None
        else None
    )
    matte_adoption_record, matte_adoption = _optional_adoption(
        temporal_matte_adoption_path,
        expected_download_sha256=matte_source_sha256,
    )
    if matte_adoption is not None and (
        matte_adoption.derived_manifest_digest_sha256
        != matte.manifest_digest_sha256
    ):
        raise MotionAdmissionError("temporal matte adoption differs from manifest")
    generated_normalization: _GeneratedNormalization | None = None
    if generated_normalization_manifest_path is None:
        capture = _verify_capture_receipt(
            generated_capture_receipt_path,
            generated_media_path,
            project_root=root,
        )
    else:
        normalization_manifest = _under_root(
            generated_normalization_manifest_path,
            root,
            role="generated normalization manifest",
        )
        preliminary_construction = load_motion_source_construction(
            normalization_manifest
        )
        capture = _verify_capture_receipt(
            generated_capture_receipt_path,
            preliminary_construction.source_path,
            project_root=root,
        )
        generated_normalization = _verify_generated_normalization(
            project_root=root,
            capture=capture,
            generated_media_path=generated_media_path,
            normalization_manifest_path=normalization_manifest,
        )
    generated_adoption_record, _ = _optional_adoption(
        generated_fal_adoption_path,
        expected_download_sha256=capture.download_sha256,
    )

    target.mkdir(parents=True)
    try:
        snapshot_source = (
            capture.download_path
            if generated_normalization is None
            else generated_normalization.canonical_output_path
        )
        snapshot_sha256 = (
            capture.download_sha256
            if generated_normalization is None
            else generated_normalization.canonical_output_sha256
        )
        snapshot_name = (
            "generated-raw.mp4"
            if generated_normalization is None
            else "generated-canonical.mp4"
        )
        generated_snapshot = _snapshot_file(
            snapshot_source,
            target / "inputs" / snapshot_name,
            expected_sha256=snapshot_sha256,
        )
        normalization = _normalization_operation(generated_snapshot)
        generated = decode_comparable_rgb24_frames_with_provenance(
            generated_snapshot,
            target / "generated_frames",
        )
        generated_ordered_digest = _ordered_frame_digest(generated.paths)
        proof = run_canonical_motion_proof(
            source_paths=bundle.frame_paths,
            generated_paths=generated.paths,
            foreground_mask_paths=matte.soft_mask_paths,
            source_media_provenance=bundle.provenance,
            motion_root=target,
            output_directory=target / "proof",
        )
        if not proof.audit.passed:
            raise MotionAdmissionError("canonical motion proof did not pass")
        preview = target / "preview.mp4"
        encode_preview(proof.composite_paths, preview)
        generated_record: dict[str, object] = {
            "capture": {
                "attempt_id": capture.attempt_id,
                "download_json_pointer": capture.json_pointer,
                "endpoint": capture.endpoint,
                "fal_url": capture.fal_url,
                "request_id": capture.request_id,
                "receipt": _file_record(capture.receipt_path),
                "source_download": _file_record(capture.download_path),
            },
            "decode_provenance": asdict(generated.provenance),
            "fal_adoption": generated_adoption_record,
            "normalization_operation": normalization,
            "ordered_frame_digest_sha256": generated_ordered_digest,
            "snapshot": _file_record(generated_snapshot),
        }
        if generated_normalization is not None:
            generated_record["normalization"] = {
                "canonical_output": _file_record(
                    generated_normalization.canonical_output_path
                ),
                "geometry_mode": generated_normalization.geometry_mode,
                "manifest": {
                    **_file_record(generated_normalization.manifest_path),
                    "manifest_digest_sha256": (
                        generated_normalization.manifest_digest_sha256
                    ),
                },
                "raw_source": _file_record(
                    generated_normalization.raw_source_path
                ),
                "status": "verified_motion_source_construction",
            }
        payload: dict[str, object] = {
            "claim": VERIFIED_CORE_CLAIM,
            "contract": {
                "frame_count": CANONICAL_CONTRACT.frame_count,
                "frame_rate": "24/1",
                "height": CANONICAL_CONTRACT.height,
                "width": CANONICAL_CONTRACT.width,
            },
            "generated": generated_record,
            "kind": ADMISSION_KIND,
            "preview": {
                **_file_record(preview),
                "label": "Preview derived from verified canonical motion frames",
            },
            "proof": {
                "audit": _file_record(proof.audit_path),
                "audit_passed": proof.audit.passed,
                "motion_input_digest_sha256": (
                    proof.motion_input_manifest.digest_sha256
                ),
                "motion_inputs": _file_record(proof.motion_input_manifest_path),
                "proof_manifest": _file_record(proof.proof_manifest_path),
                "proof_manifest_digest_sha256": proof.manifest.digest_sha256,
                "root": str((target / "proof").resolve()),
            },
            "project_root": str(root),
            "schema_version": (
                1 if generated_normalization is None else 2
            ),
            "source": {
                "approved_source": _file_record(approved_source),
                "approval": _file_record(approval),
                "decode_bundle": {
                    **_file_record(bundle.manifest_path),
                    "manifest_digest_sha256": bundle.manifest_digest_sha256,
                    "ordered_frame_digest_sha256": _ordered_frame_digest(
                        bundle.frame_paths
                    ),
                },
            },
            "temporal_matte": {
                "fal_adoption": matte_adoption_record,
                "manifest": _file_record(matte.manifest_path),
                "manifest_digest_sha256": matte.manifest_digest_sha256,
            },
            "verdict": "admitted",
        }
        payload["digest_sha256"] = _sha256_bytes(_canonical_json_bytes(payload))
        manifest_path = target / ADMISSION_MANIFEST_NAME
        _write_exclusive_json(manifest_path, payload)
        return verify_motion_reshoot_admission(manifest_path)
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise


def verify_motion_reshoot_admission(
    manifest_path: Path,
) -> MotionReshootAdmission:
    """Reopen an admission and fail on any source, matte, proof or preview drift."""
    manifest = _resolved_file(manifest_path, role="motion admission manifest")
    if manifest.name != ADMISSION_MANIFEST_NAME:
        raise MotionAdmissionError("motion admission manifest name is noncanonical")
    payload = _load_json(manifest, role="motion admission manifest")
    schema_version = payload.get("schema_version")
    if set(payload) != {
        "claim",
        "contract",
        "digest_sha256",
        "generated",
        "kind",
        "preview",
        "proof",
        "project_root",
        "schema_version",
        "source",
        "temporal_matte",
        "verdict",
    } or schema_version not in {1, 2} or payload.get("kind") != (
        ADMISSION_KIND
    ):
        raise MotionAdmissionError("motion admission manifest schema is invalid")
    declared = _require_sha256(payload.get("digest_sha256"), role="admission")
    unsigned = dict(payload)
    unsigned.pop("digest_sha256")
    if _sha256_bytes(_canonical_json_bytes(unsigned)) != declared:
        raise MotionAdmissionError("motion admission manifest digest differs")
    if (
        payload.get("verdict") != "admitted"
        or payload.get("claim") != VERIFIED_CORE_CLAIM
        or payload.get("contract")
        != {
            "frame_count": CANONICAL_CONTRACT.frame_count,
            "frame_rate": "24/1",
            "height": CANONICAL_CONTRACT.height,
            "width": CANONICAL_CONTRACT.width,
        }
    ):
        raise MotionAdmissionError("motion admission claim is invalid")
    project_value = payload.get("project_root")
    if not isinstance(project_value, str):
        raise MotionAdmissionError("motion admission project root is malformed")
    project = _project_root(Path(project_value))
    if project_value != str(project) or not manifest.is_relative_to(project):
        raise MotionAdmissionError("motion admission project root differs")

    source = payload.get("source")
    if not isinstance(source, dict) or set(source) != {
        "approval",
        "approved_source",
        "decode_bundle",
    }:
        raise MotionAdmissionError("motion admission source record is malformed")
    approved_source = _verify_file_record(
        source["approved_source"],
        role="approved source",
    )
    approval = _verify_file_record(source["approval"], role="source approval")
    bundle_record = source["decode_bundle"]
    if not isinstance(bundle_record, dict) or set(bundle_record) != {
        "bytes",
        "manifest_digest_sha256",
        "ordered_frame_digest_sha256",
        "path",
        "sha256",
    }:
        raise MotionAdmissionError("source decode bundle record is malformed")
    bundle_file_record = dict(bundle_record)
    bundle_digest = bundle_file_record.pop("manifest_digest_sha256")
    bundle_ordered = bundle_file_record.pop("ordered_frame_digest_sha256")
    bundle_path = _verify_file_record(
        bundle_file_record,
        role="source decode manifest",
    )
    bundle = verify_canonical_source_decode_bundle(bundle_path)
    if (
        bundle.approved_source_path != approved_source
        or bundle.source_approval_path != approval
        or bundle.manifest_digest_sha256
        != _require_sha256(bundle_digest, role="source bundle")
        or _ordered_frame_digest(bundle.frame_paths)
        != _require_sha256(bundle_ordered, role="source ordered frames")
    ):
        raise MotionAdmissionError("motion admission source bundle differs")

    matte_record = payload.get("temporal_matte")
    if not isinstance(matte_record, dict) or set(matte_record) != {
        "fal_adoption",
        "manifest",
        "manifest_digest_sha256",
    }:
        raise MotionAdmissionError("motion admission matte record is malformed")
    matte_path = _verify_file_record(
        matte_record["manifest"],
        role="temporal matte manifest",
    )
    matte: TemporalMatteResult = verify_temporal_matte(matte_path)
    if matte.manifest_digest_sha256 != _require_sha256(
        matte_record.get("manifest_digest_sha256"),
        role="temporal matte",
    ):
        raise MotionAdmissionError("temporal matte digest differs")
    matte_payload = _load_json(matte.manifest_path, role="temporal matte manifest")
    matte_source = matte_payload.get("source")
    if not isinstance(matte_source, dict):
        raise MotionAdmissionError("temporal matte source record is malformed")
    matte_source_hash_value = matte_source.get("source_file_sha256")
    matte_source_sha = (
        _require_sha256(
            matte_source_hash_value,
            role="temporal matte source",
        )
        if matte_source_hash_value is not None
        else None
    )
    _verify_optional_adoption(
        matte_record.get("fal_adoption"),
        expected_download_sha256=matte_source_sha,
    )

    generated_record = payload.get("generated")
    expected_generated_keys = {
        "capture",
        "decode_provenance",
        "fal_adoption",
        "normalization_operation",
        "ordered_frame_digest_sha256",
        "snapshot",
    }
    if schema_version == 2:
        expected_generated_keys.add("normalization")
    if (
        not isinstance(generated_record, dict)
        or set(generated_record) != expected_generated_keys
    ):
        raise MotionAdmissionError("motion admission generated record is malformed")
    capture_record = generated_record.get("capture")
    if not isinstance(capture_record, dict) or set(capture_record) != {
        "attempt_id",
        "download_json_pointer",
        "endpoint",
        "fal_url",
        "receipt",
        "request_id",
        "source_download",
    }:
        raise MotionAdmissionError("motion admission capture record is malformed")
    capture_receipt = _verify_file_record(
        capture_record["receipt"],
        role="capture receipt",
    )
    captured_media = _verify_file_record(
        capture_record["source_download"],
        role="captured generated media",
    )
    capture = _verify_capture_receipt(
        capture_receipt,
        captured_media,
        project_root=project,
    )
    if (
        capture.attempt_id != capture_record.get("attempt_id")
        or capture.endpoint != capture_record.get("endpoint")
        or capture.request_id != capture_record.get("request_id")
        or capture.fal_url != capture_record.get("fal_url")
        or capture.json_pointer != capture_record.get("download_json_pointer")
    ):
        raise MotionAdmissionError("motion admission capture identity differs")
    snapshot = _verify_file_record(
        generated_record["snapshot"],
        role="generated snapshot",
    )
    generated_normalization: _GeneratedNormalization | None = None
    expected_snapshot_sha256 = capture.download_sha256
    if schema_version == 2:
        normalization_record = generated_record.get("normalization")
        if not isinstance(normalization_record, dict) or set(
            normalization_record
        ) != {
            "canonical_output",
            "geometry_mode",
            "manifest",
            "raw_source",
            "status",
        } or normalization_record.get("status") != (
            "verified_motion_source_construction"
        ):
            raise MotionAdmissionError(
                "generated normalization record is malformed"
            )
        raw_source = _verify_file_record(
            normalization_record["raw_source"],
            role="normalization raw source",
        )
        canonical_output = _verify_file_record(
            normalization_record["canonical_output"],
            role="normalization canonical output",
        )
        normalization_manifest_record = normalization_record["manifest"]
        if not isinstance(normalization_manifest_record, dict) or set(
            normalization_manifest_record
        ) != {
            "bytes",
            "manifest_digest_sha256",
            "path",
            "sha256",
        }:
            raise MotionAdmissionError(
                "generated normalization manifest record is malformed"
            )
        normalization_manifest_file = dict(normalization_manifest_record)
        normalization_manifest_digest = normalization_manifest_file.pop(
            "manifest_digest_sha256"
        )
        normalization_manifest_path = _verify_file_record(
            normalization_manifest_file,
            role="generated normalization manifest",
        )
        generated_normalization = _verify_generated_normalization(
            project_root=project,
            capture=capture,
            generated_media_path=canonical_output,
            normalization_manifest_path=normalization_manifest_path,
        )
        if (
            raw_source != generated_normalization.raw_source_path
            or canonical_output
            != generated_normalization.canonical_output_path
            or generated_normalization.manifest_digest_sha256
            != _require_sha256(
                normalization_manifest_digest,
                role="generated normalization manifest",
            )
            or normalization_record.get("geometry_mode")
            != generated_normalization.geometry_mode
        ):
            raise MotionAdmissionError(
                "generated normalization evidence differs"
            )
        expected_snapshot_sha256 = (
            generated_normalization.canonical_output_sha256
        )
    if sha256_file(snapshot) != expected_snapshot_sha256:
        raise MotionAdmissionError(
            "generated snapshot differs from admitted generated media"
        )
    normalization = _normalization_operation(snapshot)
    if generated_record.get("normalization_operation") != normalization:
        raise MotionAdmissionError("generated normalization evidence differs")
    generated_provenance = _decode_provenance(
        generated_record.get("decode_provenance"),
        role="generated",
    )
    if (
        generated_provenance.source_media_path != str(snapshot)
        or generated_provenance.source_file_sha256
        != expected_snapshot_sha256
        or generated_provenance.decoded_frame_count
        != CANONICAL_CONTRACT.frame_count
        or generated_provenance.width != CANONICAL_CONTRACT.width
        or generated_provenance.height != CANONICAL_CONTRACT.height
        or generated_provenance.frame_rate_numerator != 24
        or generated_provenance.frame_rate_denominator != 1
    ):
        raise MotionAdmissionError("generated decode provenance differs")
    _verify_optional_adoption(
        generated_record.get("fal_adoption"),
        expected_download_sha256=capture.download_sha256,
    )

    proof_record = payload.get("proof")
    if not isinstance(proof_record, dict) or set(proof_record) != {
        "audit",
        "audit_passed",
        "motion_input_digest_sha256",
        "motion_inputs",
        "proof_manifest",
        "proof_manifest_digest_sha256",
        "root",
    } or proof_record.get("audit_passed") is not True:
        raise MotionAdmissionError("motion admission proof record is malformed")
    proof_root_value = proof_record.get("root")
    if not isinstance(proof_root_value, str):
        raise MotionAdmissionError("motion proof root is malformed")
    proof_root = _resolved_directory(Path(proof_root_value), role="motion proof root")
    if proof_root_value != str(proof_root) or proof_root != manifest.parent / "proof":
        raise MotionAdmissionError("motion proof root differs")
    for key, expected_name in (
        ("audit", "motion_audit.json"),
        ("motion_inputs", "motion_inputs.json"),
        ("proof_manifest", "proof_manifest.json"),
    ):
        path = _verify_file_record(proof_record[key], role=f"proof {key}")
        if path != proof_root / expected_name:
            raise MotionAdmissionError(f"proof {key} path differs")
    proof = _reopen_motion_proof(proof_root)
    if (
        proof.motion_input_manifest.digest_sha256
        != _require_sha256(
            proof_record.get("motion_input_digest_sha256"),
            role="motion input",
        )
        or proof.manifest.digest_sha256
        != _require_sha256(
            proof_record.get("proof_manifest_digest_sha256"),
            role="motion proof",
        )
        or proof.source_paths != bundle.frame_paths
        or proof.foreground_mask_paths != matte.soft_mask_paths
    ):
        raise MotionAdmissionError("motion proof input binding differs")
    generated_paths = proof.generated_paths
    generated_ordered = _ordered_frame_digest(generated_paths)
    if generated_ordered != _require_sha256(
        generated_record.get("ordered_frame_digest_sha256"),
        role="generated ordered frames",
    ):
        raise MotionAdmissionError("generated ordered frame digest differs")

    preview_record = payload.get("preview")
    if not isinstance(preview_record, dict) or set(preview_record) != {
        "bytes",
        "label",
        "path",
        "sha256",
    } or preview_record.get("label") != (
        "Preview derived from verified canonical motion frames"
    ):
        raise MotionAdmissionError("motion admission preview record is malformed")
    preview_file_record = dict(preview_record)
    preview_file_record.pop("label")
    preview = _verify_file_record(
        preview_file_record,
        role="motion preview",
    )
    if preview != manifest.parent / "preview.mp4":
        raise MotionAdmissionError("motion preview path differs")
    return MotionReshootAdmission(
        directory=manifest.parent,
        manifest_path=manifest,
        manifest_digest_sha256=declared,
        preview_path=preview,
        generated_snapshot_path=snapshot,
        generated_frame_paths=generated_paths,
        generated_provenance=generated_provenance,
        normalization_operation=normalization,
        proof=proof,
        generated_normalization_manifest_path=(
            None
            if generated_normalization is None
            else generated_normalization.manifest_path
        ),
    )
