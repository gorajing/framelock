from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
import json
from pathlib import Path

import pytest

from framelock_media.fal_lineage import (
    FalAdoptionSpec,
    FalLineageError,
    create_fal_artifact_adoption,
    verify_fal_artifact_adoption,
)


ATTEMPT_ID = "7db2d458-0a20-4b55-88bb-0c7c46d2ef84"
REQUEST_ID = "019f77d3-447e-7ee2-8540-08639f551584"
ENDPOINT = "veed/video-background-removal"
DOWNLOAD_POINTER = "/video/0/url"
FAL_SOURCE_URL = (
    "https://v3b.fal.media/files/b/source/source-canonical.mp4"
)
FAL_DOWNLOAD_URL = (
    "https://v3b.fal.media/files/b/matte/veed-output.webm"
)


def _canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _write_json(path: Path, payload: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return path


def _with_digest(payload: dict[str, object]) -> dict[str, object]:
    signed = dict(payload)
    signed["digest_sha256"] = _sha256_bytes(_canonical_bytes(payload))
    return signed


@dataclass(frozen=True)
class _Fixture:
    root: Path
    spec: FalAdoptionSpec
    ledger: Path
    plan: Path
    capture_receipt: Path
    remote_status: Path
    remote_result: Path
    download: Path
    source_approval: Path
    source_construction: Path
    source_canonical: Path
    upload_receipt: Path
    derived_manifest: Path
    output: Path


@pytest.fixture
def lineage_fixture(tmp_path: Path) -> _Fixture:
    root = (tmp_path / "project").resolve()
    artifacts = root / "artifacts" / "motion-v1"
    capture = artifacts / "attempts" / ATTEMPT_ID / "capture-02"
    capture.mkdir(parents=True)

    source_canonical = (
        artifacts / "source" / "canonical-02" / "source-canonical.mp4"
    )
    source_canonical.parent.mkdir(parents=True)
    source_canonical.write_bytes(b"canonical approved source")
    canonical_sha = _sha256_file(source_canonical)

    source_construction_payload = _with_digest(
        {
            "schema_version": 1,
            "kind": "motion_v1_source_construction",
            "output": {
                "path": str(source_canonical),
                "sha256": canonical_sha,
            },
        }
    )
    source_construction = _write_json(
        source_canonical.parent / "source-construction.json",
        source_construction_payload,
    )

    upload_receipt = _write_json(
        artifacts / "uploads" / "canonical-source-upload-02.json",
        {
            "schemaVersion": 1,
            "kind": "motion-v1-fal-upload",
            "uploadedAt": "2026-07-19T00:34:34.622Z",
            "localFile": {
                "path": str(source_canonical),
                "name": "source-canonical.mp4",
                "mime": "video/mp4",
                "bytes": source_canonical.stat().st_size,
                "sha256": canonical_sha,
            },
            "falUrl": FAL_SOURCE_URL,
        },
    )

    source_approval = _write_json(
        artifacts / "source" / "source-approval.json",
        {
            "schemaVersion": 1,
            "decision": "approved_for_motion_v1_generation",
            "approvedAt": "2026-07-19T00:34:34Z",
            "approvedCanonical": {
                "path": str(source_canonical.relative_to(root)),
                "sha256": canonical_sha,
                "constructionManifest": str(
                    source_construction.relative_to(root)
                ),
                "constructionManifestDigestSha256": (
                    source_construction_payload["digest_sha256"]
                ),
                "width": 1280,
                "height": 720,
                "frameCount": 121,
                "frameRate": "24/1",
            },
            "falUpload": {
                "receipt": str(upload_receipt.relative_to(root)),
                "url": FAL_SOURCE_URL,
            },
            "review": {
                "verdict": "approve",
                "allFullBodyFramesPassed": True,
                "allFaceFramesPassed": True,
                "allBadgeFramesPassed": True,
            },
        },
    )

    fal_input = {
        "video_url": FAL_SOURCE_URL,
        "output_codec": "vp9",
        "refine_foreground_edges": True,
        "subject_is_person": True,
    }
    input_digest = _sha256_bytes(_canonical_bytes(fal_input))
    plan = _write_json(
        artifacts / "plans" / "temporal-matte-veed-vp9-02.json",
        {
            "schemaVersion": 1,
            "state": "approved_for_submission",
            "candidateId": "motion-temporal-matte-veed-vp9-02",
            "stage": "temporal_character_matte",
            "sourceApproval": str(source_approval.relative_to(root)),
            "sourceConstructionManifestDigestSha256": (
                source_construction_payload["digest_sha256"]
            ),
            "sourceCanonicalSha256": canonical_sha,
            "sourceUploadReceipt": str(upload_receipt.relative_to(root)),
            "endpoint": ENDPOINT,
            "falInput": fal_input,
        },
    )

    status_url = (
        f"https://queue.fal.run/{ENDPOINT}/requests/{REQUEST_ID}/status"
    )
    response_url = (
        f"https://queue.fal.run/{ENDPOINT}/requests/{REQUEST_ID}"
    )
    attempt = {
        "attemptId": ATTEMPT_ID,
        "reservedAt": "2026-07-19T00:42:41.714Z",
        "endpoint": ENDPOINT,
        "inputDigest": input_digest,
        "pricing": {
            "unitPriceUsd": "0.00125",
            "billingUnit": "compute-second",
            "estimatedUnits": "72.6",
            "estimatedCostUsd": "0.09075",
            "pricingSource": "synthetic test observation",
            "priceObservedAt": "2026-07-18T21:17:34.000Z",
            "priceValidUntil": "2026-07-19T21:17:34.000Z",
        },
        "state": "submitted",
        "completedAt": "2026-07-19T00:42:42.233Z",
        "httpStatus": 200,
        "requestId": REQUEST_ID,
        "remoteStatus": "IN_QUEUE",
        "statusUrl": status_url,
        "responseUrl": response_url,
    }
    ledger = _write_json(
        artifacts / "spend-ledger.json",
        {
            "schemaVersion": 1,
            "ceilingUsd": "100",
            "attempts": [attempt],
        },
    )

    remote_status = _write_json(
        capture / "remote-status.json",
        {
            "status": "COMPLETED",
            "request_id": REQUEST_ID,
        },
    )
    remote_result = _write_json(
        capture / "remote-result.json",
        {
            "video": [
                {
                    "url": FAL_DOWNLOAD_URL,
                    "content_type": "application/octet-stream",
                    "file_name": "output.webm",
                    "file_size": 26,
                }
            ]
        },
    )
    download = capture / "veed-matte-quarantine.webm"
    download.write_bytes(b"transparent webm with alpha")
    download_sha = _sha256_file(download)
    capture_receipt = _write_json(
        capture / "capture-receipt.json",
        {
            "schemaVersion": 1,
            "kind": "motion-v1-fal-read-capture",
            "capturedAt": "2026-07-19T00:45:15.430Z",
            "attempt": {
                "attemptId": ATTEMPT_ID,
                "endpoint": ENDPOINT,
                "requestId": REQUEST_ID,
                "inputDigest": input_digest,
                "statusUrl": status_url,
                "responseUrl": response_url,
            },
            "status": {
                "fileName": remote_status.name,
                "mime": "application/json",
                "bytes": remote_status.stat().st_size,
                "sha256": _sha256_file(remote_status),
            },
            "result": {
                "fileName": remote_result.name,
                "mime": "application/json",
                "bytes": remote_result.stat().st_size,
                "sha256": _sha256_file(remote_result),
            },
            "downloads": [
                {
                    "jsonPointer": DOWNLOAD_POINTER,
                    "falUrl": FAL_DOWNLOAD_URL,
                    "fileName": download.name,
                    "mime": "application/octet-stream",
                    "bytes": download.stat().st_size,
                    "sha256": download_sha,
                }
            ],
        },
    )

    derived_manifest_payload = _with_digest(
        {
            "artifact_root": str(
                artifacts / "derived" / "matte" / "temporal-matte-01"
            ),
            "artifacts": {
                "vace_transport_compatible": True,
            },
            "contract": {
                "frame_count": 121,
                "width": 1280,
                "height": 720,
            },
            "frames": [],
            "qa": {"passed": True},
            "schema_version": 1,
            "source": {
                "kind": "transparent_webm",
                "source_path": str(download),
                "source_file_sha256": download_sha,
            },
        }
    )
    derived_manifest = _write_json(
        artifacts
        / "derived"
        / "matte"
        / "temporal-matte-01"
        / "temporal_matte_manifest.json",
        derived_manifest_payload,
    )
    output = (
        artifacts
        / "adoptions"
        / "temporal-matte-veed-vp9-02-adoption.json"
    )
    spec = FalAdoptionSpec(
        project_root=root,
        spend_ledger_path=ledger,
        attempt_id=ATTEMPT_ID,
        endpoint=ENDPOINT,
        request_id=REQUEST_ID,
        plan_path=plan,
        capture_receipt_path=capture_receipt,
        download_json_pointer=DOWNLOAD_POINTER,
        source_approval_path=source_approval,
        fal_input_source_url_json_pointer="/video_url",
        derived_manifest_path=derived_manifest,
        derived_source_sha256_json_pointer="/source/source_file_sha256",
        derived_source_path_json_pointer="/source/source_path",
        derived_digest_json_pointer="/digest_sha256",
        adoption_role="temporal_character_matte",
    )
    return _Fixture(
        root=root,
        spec=spec,
        ledger=ledger,
        plan=plan,
        capture_receipt=capture_receipt,
        remote_status=remote_status,
        remote_result=remote_result,
        download=download,
        source_approval=source_approval,
        source_construction=source_construction,
        source_canonical=source_canonical,
        upload_receipt=upload_receipt,
        derived_manifest=derived_manifest,
        output=output,
    )


def test_adoption_cross_binds_paid_capture_source_and_derived_manifest(
    lineage_fixture: _Fixture,
) -> None:
    result = create_fal_artifact_adoption(
        lineage_fixture.spec,
        lineage_fixture.output,
    )

    assert result.path == lineage_fixture.output.resolve()
    assert result.attempt_id == ATTEMPT_ID
    assert result.request_id == REQUEST_ID
    assert result.download_sha256 == _sha256_file(lineage_fixture.download)
    assert result.derived_manifest_digest_sha256

    payload = json.loads(lineage_fixture.output.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert payload["kind"] == "motion_v1_fal_artifact_adoption"
    assert payload["attempt"]["endpoint"] == ENDPOINT
    assert payload["capture"]["download"]["json_pointer"] == (
        DOWNLOAD_POINTER
    )
    assert payload["source_approval"]["fal_upload_url"] == FAL_SOURCE_URL
    assert payload["derived"]["source_file_sha256"] == (
        payload["capture"]["download"]["sha256"]
    )
    assert verify_fal_artifact_adoption(lineage_fixture.output) == result

    with pytest.raises(FalLineageError, match="already exists"):
        create_fal_artifact_adoption(
            lineage_fixture.spec,
            lineage_fixture.output,
        )


@pytest.mark.parametrize(
    "role",
    [
        "plan",
        "capture_receipt",
        "remote_status",
        "remote_result",
        "download",
        "source_approval",
        "source_construction",
        "source_canonical",
        "upload_receipt",
        "derived_manifest",
    ],
)
def test_reopen_fails_on_referenced_artifact_tamper(
    lineage_fixture: _Fixture,
    role: str,
) -> None:
    create_fal_artifact_adoption(lineage_fixture.spec, lineage_fixture.output)
    target = getattr(lineage_fixture, role)
    target.write_bytes(target.read_bytes() + b" ")

    with pytest.raises(FalLineageError, match="differs"):
        verify_fal_artifact_adoption(lineage_fixture.output)


def test_unrelated_ledger_append_is_allowed_but_bound_attempt_tamper_fails(
    lineage_fixture: _Fixture,
) -> None:
    create_fal_artifact_adoption(lineage_fixture.spec, lineage_fixture.output)
    ledger = json.loads(lineage_fixture.ledger.read_text(encoding="utf-8"))
    unrelated = dict(ledger["attempts"][0])
    unrelated["attemptId"] = "unrelated-attempt"
    unrelated["requestId"] = "unrelated-request"
    unrelated["statusUrl"] = (
        f"https://queue.fal.run/{ENDPOINT}/requests/unrelated-request/status"
    )
    unrelated["responseUrl"] = (
        f"https://queue.fal.run/{ENDPOINT}/requests/unrelated-request"
    )
    ledger["attempts"].append(unrelated)
    _write_json(lineage_fixture.ledger, ledger)

    verify_fal_artifact_adoption(lineage_fixture.output)

    ledger["attempts"][0]["remoteStatus"] = "TAMPERED"
    _write_json(lineage_fixture.ledger, ledger)
    with pytest.raises(FalLineageError, match="attempt record digest differs"):
        verify_fal_artifact_adoption(lineage_fixture.output)


def test_cross_job_capture_substitution_is_rejected(
    lineage_fixture: _Fixture,
) -> None:
    receipt = json.loads(
        lineage_fixture.capture_receipt.read_text(encoding="utf-8")
    )
    receipt["attempt"]["attemptId"] = "other-paid-attempt"
    _write_json(lineage_fixture.capture_receipt, receipt)

    with pytest.raises(FalLineageError, match="attempt identity differs"):
        create_fal_artifact_adoption(
            lineage_fixture.spec,
            lineage_fixture.output,
        )


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("expected_endpoint", "endpoint differs"),
        ("expected_request", "request ID differs"),
        ("receipt_endpoint", "attempt identity differs"),
        ("receipt_request", "attempt identity differs"),
    ],
)
def test_wrong_endpoint_or_request_is_rejected(
    lineage_fixture: _Fixture,
    mutation: str,
    message: str,
) -> None:
    spec = lineage_fixture.spec
    if mutation == "expected_endpoint":
        spec = replace(spec, endpoint="fal-ai/other-model")
    elif mutation == "expected_request":
        spec = replace(spec, request_id="other-request")
    else:
        receipt = json.loads(
            lineage_fixture.capture_receipt.read_text(encoding="utf-8")
        )
        key = "endpoint" if mutation == "receipt_endpoint" else "requestId"
        receipt["attempt"][key] = "other-value"
        _write_json(lineage_fixture.capture_receipt, receipt)

    with pytest.raises(FalLineageError, match=message):
        create_fal_artifact_adoption(spec, lineage_fixture.output)


def test_missing_capture_receipt_is_rejected(
    lineage_fixture: _Fixture,
) -> None:
    lineage_fixture.capture_receipt.unlink()

    with pytest.raises(FalLineageError, match="capture receipt.*missing"):
        create_fal_artifact_adoption(
            lineage_fixture.spec,
            lineage_fixture.output,
        )


def test_rejected_source_approval_is_rejected(
    lineage_fixture: _Fixture,
) -> None:
    approval = json.loads(
        lineage_fixture.source_approval.read_text(encoding="utf-8")
    )
    approval["decision"] = "rejected_before_source_approval"
    approval["downstreamInferenceAllowed"] = False
    _write_json(lineage_fixture.source_approval, approval)

    with pytest.raises(FalLineageError, match="not approved"):
        create_fal_artifact_adoption(
            lineage_fixture.spec,
            lineage_fixture.output,
        )


def test_plan_input_digest_must_equal_paid_attempt_digest(
    lineage_fixture: _Fixture,
) -> None:
    plan = json.loads(lineage_fixture.plan.read_text(encoding="utf-8"))
    plan["falInput"]["subject_is_person"] = False
    _write_json(lineage_fixture.plan, plan)

    with pytest.raises(FalLineageError, match="fal input digest differs"):
        create_fal_artifact_adoption(
            lineage_fixture.spec,
            lineage_fixture.output,
        )


def test_remote_result_pointer_must_equal_explicit_download_record(
    lineage_fixture: _Fixture,
) -> None:
    result = json.loads(lineage_fixture.remote_result.read_text(encoding="utf-8"))
    result["video"][0]["url"] = "https://v3b.fal.media/files/other.webm"
    _write_json(lineage_fixture.remote_result, result)
    receipt = json.loads(
        lineage_fixture.capture_receipt.read_text(encoding="utf-8")
    )
    receipt["result"]["bytes"] = lineage_fixture.remote_result.stat().st_size
    receipt["result"]["sha256"] = _sha256_file(lineage_fixture.remote_result)
    _write_json(lineage_fixture.capture_receipt, receipt)

    with pytest.raises(FalLineageError, match="JSON pointer differs"):
        create_fal_artifact_adoption(
            lineage_fixture.spec,
            lineage_fixture.output,
        )


def test_download_hash_must_equal_derived_manifest_source_hash(
    lineage_fixture: _Fixture,
) -> None:
    manifest = json.loads(
        lineage_fixture.derived_manifest.read_text(encoding="utf-8")
    )
    manifest["source"]["source_file_sha256"] = "0" * 64
    manifest.pop("digest_sha256")
    _write_json(lineage_fixture.derived_manifest, _with_digest(manifest))

    with pytest.raises(FalLineageError, match="downloaded file SHA-256"):
        create_fal_artifact_adoption(
            lineage_fixture.spec,
            lineage_fixture.output,
        )


def test_adoption_manifest_digest_tamper_is_rejected(
    lineage_fixture: _Fixture,
) -> None:
    create_fal_artifact_adoption(lineage_fixture.spec, lineage_fixture.output)
    payload = json.loads(lineage_fixture.output.read_text(encoding="utf-8"))
    payload["adoption_role"] = "substituted-role"
    _write_json(lineage_fixture.output, payload)

    with pytest.raises(FalLineageError, match="adoption digest differs"):
        verify_fal_artifact_adoption(lineage_fixture.output)
