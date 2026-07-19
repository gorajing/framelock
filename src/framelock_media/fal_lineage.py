from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from decimal import Decimal
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from typing import Any
from urllib.parse import urlsplit


_HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_ENDPOINT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")
_SAFE_FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_ADOPTION_KEYS = frozenset(
    {
        "adoption_role",
        "attempt",
        "capture",
        "derived",
        "digest_sha256",
        "kind",
        "plan",
        "project_root",
        "schema_version",
        "source_approval",
    }
)


class FalLineageError(ValueError):
    """Raised when paid fal evidence cannot be safely adopted."""


@dataclass(frozen=True)
class FalAdoptionSpec:
    project_root: Path
    spend_ledger_path: Path
    attempt_id: str
    endpoint: str
    request_id: str
    plan_path: Path
    capture_receipt_path: Path
    download_json_pointer: str
    source_approval_path: Path
    fal_input_source_url_json_pointer: str
    derived_manifest_path: Path
    derived_source_sha256_json_pointer: str
    derived_source_path_json_pointer: str
    derived_digest_json_pointer: str
    adoption_role: str


@dataclass(frozen=True)
class VerifiedFalArtifactAdoption:
    path: Path
    digest_sha256: str
    attempt_id: str
    request_id: str
    download_sha256: str
    derived_manifest_digest_sha256: str


def _canonical_json_bytes(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise FalLineageError("evidence contains noncanonical JSON") from error


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise FalLineageError(f"referenced file is unreadable: {path}") from error
    return digest.hexdigest()


def _require_sha256(value: object, *, role: str) -> str:
    if not isinstance(value, str) or _HEX_SHA256.fullmatch(value) is None:
        raise FalLineageError(f"{role} SHA-256 is malformed")
    return value


def _load_json_object(path: Path, *, role: str) -> dict[str, Any]:
    if not path.is_file():
        raise FalLineageError(f"{role} is missing: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise FalLineageError(f"{role} is unreadable") from error
    if not isinstance(payload, dict):
        raise FalLineageError(f"{role} must be a JSON object")
    return payload


def _resolved_file(path: Path, *, role: str) -> Path:
    try:
        resolved = Path(path).resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise FalLineageError(f"{role} is missing: {path}") from error
    if not resolved.is_file():
        raise FalLineageError(f"{role} is not a file: {path}")
    return resolved


def _under_root(path: Path, root: Path, *, role: str) -> Path:
    resolved = _resolved_file(path, role=role)
    if not resolved.is_relative_to(root):
        raise FalLineageError(f"{role} escapes the project root")
    return resolved


def _resolve_project_reference(value: object, root: Path, *, role: str) -> Path:
    if not isinstance(value, str) or not value:
        raise FalLineageError(f"{role} path is malformed")
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = root / candidate
    return _under_root(candidate, root, role=role)


def _json_pointer_tokens(pointer: str) -> tuple[str, ...]:
    if not isinstance(pointer, str) or not pointer.startswith("/"):
        raise FalLineageError("JSON pointer must be a non-root RFC 6901 pointer")
    tokens: list[str] = []
    for raw in pointer[1:].split("/"):
        index = 0
        while index < len(raw):
            if raw[index] == "~" and (
                index + 1 >= len(raw) or raw[index + 1] not in "01"
            ):
                raise FalLineageError("JSON pointer escape is malformed")
            index += 2 if raw[index] == "~" else 1
        tokens.append(raw.replace("~1", "/").replace("~0", "~"))
    return tuple(tokens)


def _json_pointer_get(document: object, pointer: str, *, role: str) -> object:
    current = document
    for token in _json_pointer_tokens(pointer):
        if isinstance(current, dict):
            if token not in current:
                raise FalLineageError(f"{role} JSON pointer is missing")
            current = current[token]
        elif isinstance(current, list):
            if not token.isdigit() or (len(token) > 1 and token[0] == "0"):
                raise FalLineageError(f"{role} JSON pointer index is malformed")
            index = int(token)
            if index >= len(current):
                raise FalLineageError(f"{role} JSON pointer is missing")
            current = current[index]
        else:
            raise FalLineageError(f"{role} JSON pointer crosses a scalar")
    return current


def _json_pointer_remove(document: object, pointer: str, *, role: str) -> object:
    clone = deepcopy(document)
    tokens = _json_pointer_tokens(pointer)
    parent: object = clone
    for token in tokens[:-1]:
        if isinstance(parent, dict) and token in parent:
            parent = parent[token]
        elif isinstance(parent, list) and token.isdigit() and int(token) < len(parent):
            parent = parent[int(token)]
        else:
            raise FalLineageError(f"{role} digest JSON pointer is missing")
    final = tokens[-1]
    if isinstance(parent, dict) and final in parent:
        del parent[final]
    elif isinstance(parent, list) and final.isdigit() and int(final) < len(parent):
        del parent[int(final)]
    else:
        raise FalLineageError(f"{role} digest JSON pointer is missing")
    return clone


def _javascript_number(value: float) -> str:
    if not math.isfinite(value):
        raise FalLineageError("fal input contains a non-finite number")
    if value == 0:
        return "0"
    negative = value < 0
    absolute = abs(value)
    decimal = Decimal(repr(absolute))
    sign, raw_digits, exponent = decimal.as_tuple()
    del sign
    digits = "".join(str(digit) for digit in raw_digits)
    while len(digits) > 1 and digits.endswith("0"):
        digits = digits[:-1]
        exponent += 1
    decimal_point = len(digits) + exponent
    prefix = "-" if negative else ""
    if 1e-6 <= absolute < 1e21:
        if decimal_point <= 0:
            body = "0." + "0" * (-decimal_point) + digits
        elif decimal_point >= len(digits):
            body = digits + "0" * (decimal_point - len(digits))
        else:
            body = digits[:decimal_point] + "." + digits[decimal_point:]
        return prefix + body
    scientific_exponent = decimal_point - 1
    mantissa = digits[0]
    if len(digits) > 1:
        mantissa += "." + digits[1:]
    exponent_sign = "+" if scientific_exponent >= 0 else ""
    return prefix + mantissa + "e" + exponent_sign + str(scientific_exponent)


def _javascript_json(value: object) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        if abs(value) > 9_007_199_254_740_991:
            raise FalLineageError("fal input integer exceeds JavaScript safe range")
        return str(value)
    if isinstance(value, float):
        return _javascript_number(value)
    if isinstance(value, list):
        return "[" + ",".join(_javascript_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise FalLineageError("fal input object keys must be strings")
        keys = sorted(
            value,
            key=lambda key: key.encode("utf-16-be", errors="surrogatepass"),
        )
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False) + ":" + _javascript_json(value[key])
            for key in keys
        ) + "}"
    raise FalLineageError("fal input contains a non-JSON value")


def _fal_input_digest(value: object) -> str:
    if not isinstance(value, dict):
        raise FalLineageError("plan falInput must be a JSON object")
    return _sha256_bytes(_javascript_json(value).encode("utf-8"))


def _require_fal_media_url(value: object, *, role: str) -> str:
    if not isinstance(value, str):
        raise FalLineageError(f"{role} URL is malformed")
    parsed = urlsplit(value)
    host = parsed.hostname or ""
    if (
        parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
        or (host != "fal.media" and not host.endswith(".fal.media"))
        or not parsed.path.startswith("/files/")
        or parsed.fragment
    ):
        raise FalLineageError(f"{role} URL is not trusted fal media")
    return value


def _require_queue_url(
    value: object,
    *,
    endpoint: str,
    request_id: str,
    status: bool,
) -> str:
    if not isinstance(value, str):
        raise FalLineageError("fal queue URL is malformed")
    parsed = urlsplit(value)
    suffix = "/status" if status else ""
    expected_path = f"/{endpoint}/requests/{request_id}{suffix}"
    if (
        parsed.scheme != "https"
        or parsed.hostname != "queue.fal.run"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
        or parsed.path != expected_path
        or parsed.query
        or parsed.fragment
    ):
        raise FalLineageError("fal queue URL differs from endpoint/request identity")
    return value


def _file_record(path: Path) -> dict[str, object]:
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": _sha256_file(path),
    }


def _verify_self_digest(
    payload: dict[str, Any],
    pointer: str,
    *,
    role: str,
) -> str:
    declared = _require_sha256(
        _json_pointer_get(payload, pointer, role=role),
        role=f"{role} digest",
    )
    unsigned = _json_pointer_remove(payload, pointer, role=role)
    if declared != _sha256_bytes(_canonical_json_bytes(unsigned)):
        raise FalLineageError(f"{role} digest differs")
    return declared


def _evidence_file_from_capture(
    capture_directory: Path,
    record: object,
    *,
    role: str,
) -> tuple[Path, dict[str, object]]:
    if not isinstance(record, dict):
        raise FalLineageError(f"capture {role} record is malformed")
    name = record.get("fileName")
    if not isinstance(name, str) or _SAFE_FILE_NAME.fullmatch(name) is None:
        raise FalLineageError(f"capture {role} file name is unsafe")
    path = _resolved_file(capture_directory / name, role=f"capture {role}")
    if path.parent != capture_directory:
        raise FalLineageError(f"capture {role} escapes its capture directory")
    expected_bytes = record.get("bytes")
    expected_sha = _require_sha256(record.get("sha256"), role=f"capture {role}")
    if not isinstance(expected_bytes, int) or expected_bytes < 0:
        raise FalLineageError(f"capture {role} byte count is malformed")
    if path.stat().st_size != expected_bytes:
        raise FalLineageError(f"capture {role} byte count differs")
    if _sha256_file(path) != expected_sha:
        raise FalLineageError(f"capture {role} file SHA-256 differs")
    return path, {
        "path": str(path),
        "bytes": expected_bytes,
        "sha256": expected_sha,
    }


def _collect_evidence(spec: FalAdoptionSpec) -> dict[str, object]:
    try:
        root = Path(spec.project_root).resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise FalLineageError("project root is missing") from error
    if not root.is_dir():
        raise FalLineageError("project root is not a directory")
    if _IDENTIFIER.fullmatch(spec.attempt_id) is None:
        raise FalLineageError("attempt ID is malformed")
    if _IDENTIFIER.fullmatch(spec.request_id) is None:
        raise FalLineageError("request ID is malformed")
    if (
        _ENDPOINT.fullmatch(spec.endpoint) is None
        or "//" in spec.endpoint
        or spec.endpoint.endswith("/")
        or ".." in spec.endpoint.split("/")
    ):
        raise FalLineageError("endpoint is malformed")
    if _IDENTIFIER.fullmatch(spec.adoption_role) is None:
        raise FalLineageError("adoption role is malformed")

    ledger_path = _under_root(
        spec.spend_ledger_path,
        root,
        role="spend ledger",
    )
    ledger = _load_json_object(ledger_path, role="spend ledger")
    attempts = ledger.get("attempts")
    if (
        ledger.get("schemaVersion") != 1
        or ledger.get("ceilingUsd") != "100"
        or not isinstance(attempts, list)
    ):
        raise FalLineageError("spend ledger schema is invalid")
    matches = [
        attempt
        for attempt in attempts
        if isinstance(attempt, dict)
        and attempt.get("attemptId") == spec.attempt_id
    ]
    if len(matches) != 1:
        raise FalLineageError("paid attempt ID is missing or duplicated")
    attempt = matches[0]
    if attempt.get("endpoint") != spec.endpoint:
        raise FalLineageError("paid attempt endpoint differs")
    if attempt.get("requestId") != spec.request_id:
        raise FalLineageError("paid attempt request ID differs")
    if attempt.get("state") != "submitted":
        raise FalLineageError("paid attempt is not submitted")
    input_digest = _require_sha256(
        attempt.get("inputDigest"),
        role="paid attempt input",
    )
    status_url = _require_queue_url(
        attempt.get("statusUrl"),
        endpoint=spec.endpoint,
        request_id=spec.request_id,
        status=True,
    )
    response_url = _require_queue_url(
        attempt.get("responseUrl"),
        endpoint=spec.endpoint,
        request_id=spec.request_id,
        status=False,
    )

    plan_path = _under_root(spec.plan_path, root, role="fal request plan")
    plan = _load_json_object(plan_path, role="fal request plan")
    if (
        plan.get("schemaVersion") != 1
        or plan.get("state") != "approved_for_submission"
    ):
        raise FalLineageError("fal request plan is not approved")
    if plan.get("endpoint") != spec.endpoint:
        raise FalLineageError("fal request plan endpoint differs")
    calculated_input_digest = _fal_input_digest(plan.get("falInput"))
    if calculated_input_digest != input_digest:
        raise FalLineageError("fal input digest differs from paid attempt")

    capture_receipt_path = _under_root(
        spec.capture_receipt_path,
        root,
        role="capture receipt",
    )
    if capture_receipt_path.name != "capture-receipt.json":
        raise FalLineageError("capture receipt file name is noncanonical")
    capture_directory = capture_receipt_path.parent
    if capture_directory.parent.name != spec.attempt_id:
        raise FalLineageError("capture receipt belongs to a different attempt")
    capture = _load_json_object(capture_receipt_path, role="capture receipt")
    captured_attempt = capture.get("attempt")
    expected_captured_attempt = {
        "attemptId": spec.attempt_id,
        "endpoint": spec.endpoint,
        "requestId": spec.request_id,
        "inputDigest": input_digest,
        "statusUrl": status_url,
        "responseUrl": response_url,
    }
    if (
        capture.get("schemaVersion") != 1
        or capture.get("kind") != "motion-v1-fal-read-capture"
        or captured_attempt != expected_captured_attempt
    ):
        raise FalLineageError("capture receipt attempt identity differs")
    remote_status_path, remote_status_record = _evidence_file_from_capture(
        capture_directory,
        capture.get("status"),
        role="status",
    )
    remote_result_path, remote_result_record = _evidence_file_from_capture(
        capture_directory,
        capture.get("result"),
        role="result",
    )
    remote_status = _load_json_object(remote_status_path, role="remote status")
    if remote_status.get("request_id") not in (None, spec.request_id):
        raise FalLineageError("remote status request ID differs")
    if remote_status.get("status_url") not in (None, status_url):
        raise FalLineageError("remote status URL differs")
    if remote_status.get("response_url") not in (None, response_url):
        raise FalLineageError("remote response URL differs")
    remote_result = _load_json_object(remote_result_path, role="remote result")
    downloads = capture.get("downloads")
    if not isinstance(downloads, list):
        raise FalLineageError("capture downloads are malformed")
    download_matches = [
        record
        for record in downloads
        if isinstance(record, dict)
        and record.get("jsonPointer") == spec.download_json_pointer
    ]
    if len(download_matches) != 1:
        raise FalLineageError("explicit capture download record is missing or duplicated")
    download_record = download_matches[0]
    remote_url = _json_pointer_get(
        remote_result,
        spec.download_json_pointer,
        role="remote result",
    )
    fal_download_url = _require_fal_media_url(
        download_record.get("falUrl"),
        role="captured download",
    )
    if remote_url != fal_download_url:
        raise FalLineageError("remote result JSON pointer differs from download record")
    download_path, download_file_record = _evidence_file_from_capture(
        capture_directory,
        download_record,
        role="download",
    )
    download_file_record.update(
        {
            "fal_url": fal_download_url,
            "json_pointer": spec.download_json_pointer,
            "mime": download_record.get("mime"),
        }
    )

    source_approval_path = _under_root(
        spec.source_approval_path,
        root,
        role="source approval",
    )
    if _resolve_project_reference(
        plan.get("sourceApproval"), root, role="plan source approval"
    ) != source_approval_path:
        raise FalLineageError("plan source approval path differs")
    source_approval = _load_json_object(
        source_approval_path,
        role="source approval",
    )
    if source_approval.get("decision") != "approved_for_motion_v1_generation":
        raise FalLineageError("source is not approved for Motion v1 generation")
    approved_canonical = source_approval.get("approvedCanonical")
    fal_upload = source_approval.get("falUpload")
    if not isinstance(approved_canonical, dict) or not isinstance(fal_upload, dict):
        raise FalLineageError("source approval evidence is incomplete")
    canonical_path = _resolve_project_reference(
        approved_canonical.get("path"),
        root,
        role="approved canonical source",
    )
    canonical_sha = _require_sha256(
        approved_canonical.get("sha256"),
        role="approved canonical source",
    )
    if _sha256_file(canonical_path) != canonical_sha:
        raise FalLineageError("approved canonical source SHA-256 differs")
    construction_path = _resolve_project_reference(
        approved_canonical.get("constructionManifest"),
        root,
        role="source construction manifest",
    )
    construction = _load_json_object(
        construction_path,
        role="source construction manifest",
    )
    construction_digest = _verify_self_digest(
        construction,
        "/digest_sha256",
        role="source construction manifest",
    )
    if construction_digest != approved_canonical.get(
        "constructionManifestDigestSha256"
    ):
        raise FalLineageError("source construction approval digest differs")
    construction_output = construction.get("output")
    if (
        not isinstance(construction_output, dict)
        or construction_output.get("sha256") != canonical_sha
        or _resolve_project_reference(
            construction_output.get("path"),
            root,
            role="source construction output",
        )
        != canonical_path
    ):
        raise FalLineageError("source construction output binding differs")
    upload_receipt_path = _resolve_project_reference(
        fal_upload.get("receipt"),
        root,
        role="source upload receipt",
    )
    if _resolve_project_reference(
        plan.get("sourceUploadReceipt"),
        root,
        role="plan source upload receipt",
    ) != upload_receipt_path:
        raise FalLineageError("plan source upload receipt differs")
    upload_receipt = _load_json_object(
        upload_receipt_path,
        role="source upload receipt",
    )
    local_file = upload_receipt.get("localFile")
    fal_upload_url = _require_fal_media_url(
        upload_receipt.get("falUrl"),
        role="source upload",
    )
    if (
        upload_receipt.get("schemaVersion") != 1
        or upload_receipt.get("kind") != "motion-v1-fal-upload"
        or not isinstance(local_file, dict)
        or _resolve_project_reference(
            local_file.get("path"), root, role="uploaded local source"
        )
        != canonical_path
        or local_file.get("sha256") != canonical_sha
        or local_file.get("bytes") != canonical_path.stat().st_size
        or fal_upload.get("url") != fal_upload_url
    ):
        raise FalLineageError("source upload receipt binding differs")
    if plan.get("sourceCanonicalSha256") != canonical_sha:
        raise FalLineageError("plan canonical source SHA-256 differs")
    if plan.get("sourceConstructionManifestDigestSha256") != construction_digest:
        raise FalLineageError("plan source construction digest differs")
    fal_input_source_url = _json_pointer_get(
        plan["falInput"],
        spec.fal_input_source_url_json_pointer,
        role="fal input source URL",
    )
    if fal_input_source_url != fal_upload_url:
        raise FalLineageError("fal input source URL differs from approved upload")

    derived_manifest_path = _under_root(
        spec.derived_manifest_path,
        root,
        role="derived artifact manifest",
    )
    derived_manifest = _load_json_object(
        derived_manifest_path,
        role="derived artifact manifest",
    )
    derived_digest = _verify_self_digest(
        derived_manifest,
        spec.derived_digest_json_pointer,
        role="derived artifact manifest",
    )
    derived_source_sha = _require_sha256(
        _json_pointer_get(
            derived_manifest,
            spec.derived_source_sha256_json_pointer,
            role="derived source SHA-256",
        ),
        role="derived source file",
    )
    if derived_source_sha != download_file_record["sha256"]:
        raise FalLineageError(
            "downloaded file SHA-256 differs from derived manifest source"
        )
    derived_source_path_value = _json_pointer_get(
        derived_manifest,
        spec.derived_source_path_json_pointer,
        role="derived source path",
    )
    if _resolve_project_reference(
        derived_source_path_value,
        root,
        role="derived source file",
    ) != download_path:
        raise FalLineageError("derived manifest source path differs from download")

    return {
        "adoption_role": spec.adoption_role,
        "attempt": {
            "attempt_id": spec.attempt_id,
            "endpoint": spec.endpoint,
            "input_digest_sha256": input_digest,
            "ledger_path": str(ledger_path),
            "record_digest_sha256": _sha256_bytes(
                _canonical_json_bytes(attempt)
            ),
            "request_id": spec.request_id,
            "response_url": response_url,
            "status_url": status_url,
        },
        "capture": {
            "download": download_file_record,
            "receipt": _file_record(capture_receipt_path),
            "remote_result": remote_result_record,
            "remote_status": remote_status_record,
        },
        "derived": {
            **_file_record(derived_manifest_path),
            "digest_json_pointer": spec.derived_digest_json_pointer,
            "manifest_digest_sha256": derived_digest,
            "source_file_sha256": derived_source_sha,
            "source_path_json_pointer": spec.derived_source_path_json_pointer,
            "source_sha256_json_pointer": (
                spec.derived_source_sha256_json_pointer
            ),
        },
        "plan": {
            **_file_record(plan_path),
            "fal_input_digest_sha256": calculated_input_digest,
            "source_url_json_pointer": (
                spec.fal_input_source_url_json_pointer
            ),
        },
        "project_root": str(root),
        "source_approval": {
            "approved_canonical": _file_record(canonical_path),
            "construction_manifest": {
                **_file_record(construction_path),
                "manifest_digest_sha256": construction_digest,
            },
            "decision": source_approval["decision"],
            "fal_upload_url": fal_upload_url,
            "path": str(source_approval_path),
            "sha256": _sha256_file(source_approval_path),
            "upload_receipt": _file_record(upload_receipt_path),
        },
    }


def _result(path: Path, payload: dict[str, Any]) -> VerifiedFalArtifactAdoption:
    return VerifiedFalArtifactAdoption(
        path=path,
        digest_sha256=payload["digest_sha256"],
        attempt_id=payload["attempt"]["attempt_id"],
        request_id=payload["attempt"]["request_id"],
        download_sha256=payload["capture"]["download"]["sha256"],
        derived_manifest_digest_sha256=payload["derived"][
            "manifest_digest_sha256"
        ],
    )


def _write_exclusive_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FalLineageError("fal adoption evidence already exists")
    encoded = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError as error:
            raise FalLineageError("fal adoption evidence already exists") from error
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def create_fal_artifact_adoption(
    spec: FalAdoptionSpec,
    output_path: Path,
) -> VerifiedFalArtifactAdoption:
    """Cross-bind one paid fal capture to a derived local artifact manifest."""
    target = Path(output_path).resolve()
    if target.exists():
        raise FalLineageError("fal adoption evidence already exists")
    evidence = _collect_evidence(spec)
    root = Path(evidence["project_root"])
    if target == root or not target.is_relative_to(root):
        raise FalLineageError("adoption evidence must remain under project root")
    payload: dict[str, Any] = {
        "schema_version": 1,
        "kind": "motion_v1_fal_artifact_adoption",
        **evidence,
    }
    payload["digest_sha256"] = _sha256_bytes(_canonical_json_bytes(payload))
    _write_exclusive_json(target, payload)
    return verify_fal_artifact_adoption(target)


def verify_fal_artifact_adoption(
    adoption_path: Path,
) -> VerifiedFalArtifactAdoption:
    """Reopen an adoption and re-verify every bound local and remote identity."""
    path = _resolved_file(adoption_path, role="fal adoption evidence")
    payload = _load_json_object(path, role="fal adoption evidence")
    if (
        set(payload) != _ADOPTION_KEYS
        or payload.get("schema_version") != 1
        or payload.get("kind") != "motion_v1_fal_artifact_adoption"
    ):
        raise FalLineageError("fal adoption schema is invalid")
    declared = _require_sha256(
        payload.get("digest_sha256"),
        role="fal adoption",
    )
    unsigned = dict(payload)
    unsigned.pop("digest_sha256")
    if declared != _sha256_bytes(_canonical_json_bytes(unsigned)):
        raise FalLineageError("fal adoption digest differs")
    attempt = payload.get("attempt")
    plan = payload.get("plan")
    capture = payload.get("capture")
    source = payload.get("source_approval")
    derived = payload.get("derived")
    if not all(
        isinstance(value, dict)
        for value in (attempt, plan, capture, source, derived)
    ):
        raise FalLineageError("fal adoption evidence records are malformed")
    receipt = capture.get("receipt")
    download = capture.get("download")
    if not isinstance(receipt, dict) or not isinstance(download, dict):
        raise FalLineageError("fal adoption capture record is malformed")
    spec = FalAdoptionSpec(
        project_root=Path(payload["project_root"]),
        spend_ledger_path=Path(attempt["ledger_path"]),
        attempt_id=attempt["attempt_id"],
        endpoint=attempt["endpoint"],
        request_id=attempt["request_id"],
        plan_path=Path(plan["path"]),
        capture_receipt_path=Path(receipt["path"]),
        download_json_pointer=download["json_pointer"],
        source_approval_path=Path(source["path"]),
        fal_input_source_url_json_pointer=plan["source_url_json_pointer"],
        derived_manifest_path=Path(derived["path"]),
        derived_source_sha256_json_pointer=derived[
            "source_sha256_json_pointer"
        ],
        derived_source_path_json_pointer=derived[
            "source_path_json_pointer"
        ],
        derived_digest_json_pointer=derived["digest_json_pointer"],
        adoption_role=payload["adoption_role"],
    )
    reopened = _collect_evidence(spec)
    reopened_attempt = reopened["attempt"]
    if reopened_attempt["record_digest_sha256"] != attempt.get(
        "record_digest_sha256"
    ):
        raise FalLineageError("paid attempt record digest differs")
    expected_unsigned = {
        "schema_version": 1,
        "kind": "motion_v1_fal_artifact_adoption",
        **reopened,
    }
    if unsigned != expected_unsigned:
        raise FalLineageError("reopened fal adoption evidence differs")
    return _result(path, payload)
