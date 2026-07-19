from __future__ import annotations

import json
from pathlib import Path

from framelock_media.ai_source import (
    verify_ai_source_bundle,
    verify_chroma_preparation,
)
from framelock_media.artifacts import sha256_file


REPOSITORY = Path(__file__).resolve().parents[1]
ORIGINAL_SHA256 = (
    "131b1ec6720808a1b4b67f5ab29c5c504d2d10c933485f13be9eabd986c68a11"
)
ALGORITHM_SHA256 = (
    "1edb1270ba926dbde2b3870f0dcd7548f8f459ff77bed4518ec723c3d23be827"
)
SOURCE = (
    REPOSITORY
    / "artifacts"
    / "ai-source"
    / "frm-01-v3"
    / "sha256"
    / ORIGINAL_SHA256
)
CHROMA = (
    REPOSITORY
    / "artifacts"
    / "ai-source"
    / "frm-01-v3-chroma"
    / "sha256"
    / ORIGINAL_SHA256
    / ALGORITHM_SHA256
)
SELECTION = (
    REPOSITORY
    / "artifacts"
    / "ai-source"
    / "frm-01-v3-chroma"
    / "chroma_selection.json"
)
SUPERSESSION = (
    REPOSITORY
    / "artifacts"
    / "ai-source"
    / "frm-01-v2"
    / "supersession_record.json"
)


def _read_json(path: Path) -> dict[str, object]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(payload, dict)
    return payload


def test_frm01_v3_release_rederives_and_binds_every_intake_artifact() -> None:
    chroma = verify_chroma_preparation(CHROMA)
    source = verify_ai_source_bundle(SOURCE)
    selection = _read_json(SELECTION)
    supersession = _read_json(SUPERSESSION)
    approval = _read_json(SOURCE / "visual_approval.json")
    provenance = _read_json(SOURCE / "source-provenance.json")
    release = _read_json(SOURCE / "source_release.json")

    assert chroma["manifest_digest_sha256"] == (
        "72060908a884524f7a559f62663dad4abaeae8cb26be2fd33f2854b1c15e8bad"
    )
    assert chroma["prepared_rgba"]["sha256"] == (
        "12b57e110d1263cd3709656ab8df13ff689fc8d2b6b00b296a946e42152c9ff6"
    )
    assert selection["selectedCandidate"]["algorithmManifestFileSha256"] == (
        sha256_file(CHROMA / "chroma_derivation.json")
    )
    assert selection["selectedCandidate"]["preparedRgbaSha256"] == (
        sha256_file(CHROMA / "prepared_rgba.png")
    )
    assert len(selection["rejectedCandidates"]) == 2

    source_video = source["source_video"]
    foreground = source["mask"]["confirmed_foreground"]
    assert source_video["width"] == 1280
    assert source_video["height"] == 720
    assert source_video["frame_rate_numerator"] == 24
    assert source_video["frame_rate_denominator"] == 1
    assert source_video["decoded_frame_count"] == 121
    assert source_video["unique_decoded_rgb_hash_count"] == 1
    assert source_video["audio_stream_count"] == 0
    assert source_video["sha256"] == sha256_file(SOURCE / "source.mp4")
    assert foreground["sha256"] == sha256_file(SOURCE / "foreground.png")

    assert approval["sourceBundleManifestSha256"] == sha256_file(
        SOURCE / "source_bundle.json"
    )
    assert provenance["approval"]["recordSha256"] == sha256_file(
        SOURCE / "visual_approval.json"
    )
    assert provenance["sourceBundleManifestSha256"] == sha256_file(
        SOURCE / "source_bundle.json"
    )
    assert provenance["canonicalSourceMp4Sha256"] == source_video["sha256"]
    assert provenance["foregroundMaskSha256"] == foreground["sha256"]

    assert release["state"] == "ready_for_local_application_intake"
    assert release["paidRunAuthorized"] is False
    assert release["provenance"]["fileSha256"] == sha256_file(
        SOURCE / "source-provenance.json"
    )
    assert release["chromaPreparation"]["selectionRecordSha256"] == (
        sha256_file(SELECTION)
    )
    assert release["source"]["bundleManifestFileSha256"] == sha256_file(
        SOURCE / "source_bundle.json"
    )
    assert release["source"]["canonicalSourceMp4Sha256"] == (
        source_video["sha256"]
    )
    assert release["source"]["foregroundMaskSha256"] == foreground["sha256"]
    assert release["supersedes"]["supersessionRecordSha256"] == (
        sha256_file(SUPERSESSION)
    )
    assert supersession["state"] == (
        "valid_but_superseded_before_application_intake"
    )
