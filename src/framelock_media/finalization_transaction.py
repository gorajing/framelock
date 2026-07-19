from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
from typing import Iterator, Literal
import uuid


FINALIZATION_JOURNAL_NAME = ".finalization-transaction.json"
FINALIZATION_COMMIT_NAME = ".finalization-committed.json"
FINALIZATION_LOCK_NAME = ".finalization.lock"
_SCHEMA_VERSION = 1
_SHA256_LENGTH = 64


class FinalizationTransactionError(ValueError):
    """Raised when finalization transaction evidence is unsafe to recover."""


OutputKind = Literal["file", "directory"]


@dataclass(frozen=True)
class FinalizationOutput:
    path: Path
    kind: OutputKind


@dataclass(frozen=True)
class CommittedFinalizationEvidence:
    marker_path: Path
    marker_sha256: str
    schema_version: int
    attempt_id: str
    review_manifest_sha256: str
    outputs: tuple[dict[str, object], ...]
    stale_journal_reconciled: bool


def _canonical_digest(payload: object) -> str:
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == _SHA256_LENGTH
        and all(character in "0123456789abcdef" for character in value)
    )


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_file(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _path_exists(path: Path) -> bool:
    return os.path.lexists(path)


def _remove_owned_path(path: Path) -> None:
    if not _path_exists(path):
        return
    mode = path.lstat().st_mode
    if stat.S_ISDIR(mode):
        shutil.rmtree(path)
    else:
        path.unlink()


def _write_exclusive_durable_json(
    path: Path,
    payload: dict[str, object],
) -> None:
    encoded = (
        json.dumps(payload, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        view = memoryview(encoded)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    _fsync_directory(path.parent)


def _read_json_object(path: Path, *, role: str) -> dict[str, object]:
    try:
        if not stat.S_ISREG(path.lstat().st_mode):
            raise FinalizationTransactionError(
                f"finalization {role} is malformed"
            )
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FinalizationTransactionError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FinalizationTransactionError(
            f"finalization {role} is malformed"
        ) from error
    if not isinstance(payload, dict):
        raise FinalizationTransactionError(
            f"finalization {role} is malformed"
        )
    return payload


def _validated_committed_state(
    *,
    root: Path,
    review_manifest_sha256: str,
    specs: tuple[tuple[str, OutputKind], ...],
    reconcile_stale_journal: bool,
) -> CommittedFinalizationEvidence:
    relative_paths = tuple(path for path, _ in specs)
    commit_path = root / FINALIZATION_COMMIT_NAME
    journal_path = root / FINALIZATION_JOURNAL_NAME
    if not _path_exists(commit_path):
        raise FinalizationTransactionError(
            "finalization commit marker is missing"
        )
    commit = _validated_commit_marker(
        commit_path,
        root=root,
        review_manifest_sha256=review_manifest_sha256,
        specs=specs,
    )
    journal_reconciled = False
    if _path_exists(journal_path):
        journal = _validated_journal(
            journal_path,
            review_manifest_sha256=review_manifest_sha256,
            relative_paths=relative_paths,
        )
        if journal["attempt_id"] != commit["attempt_id"]:
            raise FinalizationTransactionError(
                "finalization journal and commit marker attempts differ"
            )
        if not reconcile_stale_journal:
            raise FinalizationTransactionError(
                "committed finalization still has a live journal"
            )
        _remove_owned_path(root / str(journal["commit_temp_path"]))
        journal_path.unlink()
        _fsync_directory(root)
        journal_reconciled = True
    raw_outputs = commit["outputs"]
    assert isinstance(raw_outputs, list)
    return CommittedFinalizationEvidence(
        marker_path=commit_path,
        marker_sha256=_sha256_file(commit_path),
        schema_version=_SCHEMA_VERSION,
        attempt_id=str(commit["attempt_id"]),
        review_manifest_sha256=review_manifest_sha256,
        outputs=tuple(dict(record) for record in raw_outputs),
        stale_journal_reconciled=journal_reconciled,
    )


def validate_committed_finalization(
    *,
    root: Path,
    review_manifest_sha256: str,
    outputs: tuple[FinalizationOutput, ...],
) -> CommittedFinalizationEvidence:
    """Validate committed bytes, reconciling only matching transaction metadata.

    Final proof outputs are read-only. If publication completed immediately
    before process death, this may remove the matching commit-temp path and
    stale journal after both records and all output hashes validate.
    """
    root = root.resolve()
    specs = _relative_output_specs(root, outputs)
    with finalization_lock(root):
        return _validated_committed_state(
            root=root,
            review_manifest_sha256=review_manifest_sha256,
            specs=specs,
            reconcile_stale_journal=True,
        )


def _relative_output_specs(
    root: Path,
    outputs: tuple[FinalizationOutput, ...],
) -> tuple[tuple[str, OutputKind], ...]:
    root = root.resolve()
    specs: list[tuple[str, OutputKind]] = []
    for output in outputs:
        try:
            relative = output.path.resolve().relative_to(root)
        except ValueError as error:
            raise FinalizationTransactionError(
                "finalization output escapes the review directory"
            ) from error
        if (
            relative == Path(".")
            or relative.is_absolute()
            or ".." in relative.parts
            or output.kind not in ("file", "directory")
        ):
            raise FinalizationTransactionError(
                "finalization output path or kind is invalid"
            )
        specs.append((relative.as_posix(), output.kind))
    relative_paths = [path for path, _ in specs]
    if len(set(relative_paths)) != len(relative_paths):
        raise FinalizationTransactionError(
            "finalization output paths must be unique"
        )
    return tuple(specs)


def _journal_payload(
    *,
    attempt_id: str,
    review_manifest_sha256: str,
    relative_paths: tuple[str, ...],
    commit_temp_path: str,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "schema_version": _SCHEMA_VERSION,
        "attempt_id": attempt_id,
        "review_manifest_sha256": review_manifest_sha256,
        "owned_output_paths": list(relative_paths),
        "commit_temp_path": commit_temp_path,
    }
    payload["digest_sha256"] = _canonical_digest(payload)
    return payload


def _validated_journal(
    path: Path,
    *,
    review_manifest_sha256: str,
    relative_paths: tuple[str, ...],
) -> dict[str, object]:
    payload = _read_json_object(path, role="transaction journal")
    digest = payload.get("digest_sha256")
    unsigned = dict(payload)
    unsigned.pop("digest_sha256", None)
    attempt_id = payload.get("attempt_id")
    try:
        parsed_attempt = uuid.UUID(str(attempt_id))
    except (ValueError, AttributeError) as error:
        raise FinalizationTransactionError(
            "finalization transaction journal is malformed"
        ) from error
    expected_temp_path = f".{FINALIZATION_COMMIT_NAME[1:]}.{parsed_attempt}.tmp"
    if (
        set(payload)
        != {
            "schema_version",
            "attempt_id",
            "review_manifest_sha256",
            "owned_output_paths",
            "commit_temp_path",
            "digest_sha256",
        }
        or payload.get("schema_version") != _SCHEMA_VERSION
        or str(parsed_attempt) != attempt_id
        or payload.get("review_manifest_sha256") != review_manifest_sha256
        or payload.get("owned_output_paths") != list(relative_paths)
        or payload.get("commit_temp_path") != expected_temp_path
        or not _is_sha256(digest)
        or digest != _canonical_digest(unsigned)
    ):
        raise FinalizationTransactionError(
            "finalization transaction journal is malformed"
        )
    return payload


def _directory_record(path: Path, relative_path: str) -> dict[str, object]:
    if path.is_symlink() or not path.is_dir():
        raise FinalizationTransactionError(
            f"finalization output is not a directory: {relative_path}"
        )
    files: list[dict[str, str]] = []
    directories = [path]
    for child in sorted(path.rglob("*")):
        if child.is_symlink():
            raise FinalizationTransactionError(
                f"finalization output contains a symlink: {relative_path}"
            )
        if child.is_dir():
            directories.append(child)
            continue
        if not child.is_file():
            raise FinalizationTransactionError(
                f"finalization output contains a non-file: {relative_path}"
            )
        _fsync_file(child)
        files.append(
            {
                "path": child.relative_to(path).as_posix(),
                "sha256": _sha256_file(child),
            }
        )
    if not files:
        raise FinalizationTransactionError(
            f"finalization output directory is empty: {relative_path}"
        )
    for directory in reversed(directories):
        _fsync_directory(directory)
    return {
        "path": relative_path,
        "kind": "directory",
        "file_count": len(files),
        "tree_digest_sha256": _canonical_digest(files),
    }


def _file_record(path: Path, relative_path: str) -> dict[str, object]:
    if path.is_symlink() or not path.is_file():
        raise FinalizationTransactionError(
            f"finalization output is not a file: {relative_path}"
        )
    _fsync_file(path)
    return {
        "path": relative_path,
        "kind": "file",
        "sha256": _sha256_file(path),
        "size_bytes": path.stat().st_size,
    }


def _output_records(
    root: Path,
    specs: tuple[tuple[str, OutputKind], ...],
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for relative_path, kind in specs:
        path = root / relative_path
        record = (
            _file_record(path, relative_path)
            if kind == "file"
            else _directory_record(path, relative_path)
        )
        records.append(record)
    return records


def _validated_commit_marker(
    path: Path,
    *,
    root: Path,
    review_manifest_sha256: str,
    specs: tuple[tuple[str, OutputKind], ...],
) -> dict[str, object]:
    payload = _read_json_object(path, role="commit marker")
    digest = payload.get("digest_sha256")
    unsigned = dict(payload)
    unsigned.pop("digest_sha256", None)
    attempt_id = payload.get("attempt_id")
    try:
        parsed_attempt = uuid.UUID(str(attempt_id))
    except (ValueError, AttributeError) as error:
        raise FinalizationTransactionError(
            "finalization commit marker is malformed"
        ) from error
    if (
        set(payload)
        != {
            "schema_version",
            "attempt_id",
            "review_manifest_sha256",
            "outputs",
            "digest_sha256",
        }
        or payload.get("schema_version") != _SCHEMA_VERSION
        or str(parsed_attempt) != attempt_id
        or payload.get("review_manifest_sha256") != review_manifest_sha256
        or not isinstance(payload.get("outputs"), list)
        or not _is_sha256(digest)
        or digest != _canonical_digest(unsigned)
    ):
        raise FinalizationTransactionError(
            "finalization commit marker is malformed"
        )
    observed = _output_records(root, specs)
    if payload["outputs"] != observed:
        raise FinalizationTransactionError(
            "committed finalization output set is incomplete or differs"
        )
    return payload


@contextmanager
def finalization_lock(root: Path) -> Iterator[None]:
    """Serialize recovery and finalization without deleting the lock inode."""
    lock_path = root / FINALIZATION_LOCK_NAME
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


@dataclass
class FinalizationTransaction:
    root: Path
    attempt_id: str
    review_manifest_sha256: str
    specs: tuple[tuple[str, OutputKind], ...]
    commit_temp_path: Path
    committed: bool = False

    @property
    def journal_path(self) -> Path:
        return self.root / FINALIZATION_JOURNAL_NAME

    @property
    def commit_path(self) -> Path:
        return self.root / FINALIZATION_COMMIT_NAME

    @classmethod
    def begin(
        cls,
        *,
        root: Path,
        review_manifest_sha256: str,
        outputs: tuple[FinalizationOutput, ...],
    ) -> FinalizationTransaction:
        root = root.resolve()
        specs = _relative_output_specs(root, outputs)
        relative_paths = tuple(path for path, _ in specs)
        journal_path = root / FINALIZATION_JOURNAL_NAME
        commit_path = root / FINALIZATION_COMMIT_NAME

        if _path_exists(commit_path):
            _validated_committed_state(
                root=root,
                review_manifest_sha256=review_manifest_sha256,
                specs=specs,
                reconcile_stale_journal=True,
            )
            raise FileExistsError(
                "proof artifacts already exist in review directory"
            )

        if _path_exists(journal_path):
            journal = _validated_journal(
                journal_path,
                review_manifest_sha256=review_manifest_sha256,
                relative_paths=relative_paths,
            )
            for relative_path in reversed(relative_paths):
                _remove_owned_path(root / relative_path)
            _remove_owned_path(root / str(journal["commit_temp_path"]))
            _fsync_directory(root)
            journal_path.unlink()
            _fsync_directory(root)

        if any(_path_exists(root / path) for path in relative_paths):
            raise FileExistsError(
                "proof artifacts already exist in review directory"
            )

        attempt_id = str(uuid.uuid4())
        commit_temp_name = f".{FINALIZATION_COMMIT_NAME[1:]}.{attempt_id}.tmp"
        payload = _journal_payload(
            attempt_id=attempt_id,
            review_manifest_sha256=review_manifest_sha256,
            relative_paths=relative_paths,
            commit_temp_path=commit_temp_name,
        )
        _write_exclusive_durable_json(journal_path, payload)
        return cls(
            root=root,
            attempt_id=attempt_id,
            review_manifest_sha256=review_manifest_sha256,
            specs=specs,
            commit_temp_path=root / commit_temp_name,
        )

    def commit(self) -> None:
        records = _output_records(self.root, self.specs)
        payload: dict[str, object] = {
            "schema_version": _SCHEMA_VERSION,
            "attempt_id": self.attempt_id,
            "review_manifest_sha256": self.review_manifest_sha256,
            "outputs": records,
        }
        payload["digest_sha256"] = _canonical_digest(payload)
        _write_exclusive_durable_json(self.commit_temp_path, payload)
        os.replace(self.commit_temp_path, self.commit_path)
        self.committed = True
        _fsync_directory(self.root)
        self.journal_path.unlink()
        _fsync_directory(self.root)

    def abort(self) -> None:
        if self.committed or _path_exists(self.commit_path):
            return
        for relative_path, _ in reversed(self.specs):
            _remove_owned_path(self.root / relative_path)
        _remove_owned_path(self.commit_temp_path)
        _fsync_directory(self.root)
        self.journal_path.unlink(missing_ok=True)
        _fsync_directory(self.root)
