from __future__ import annotations

import argparse
import json
from pathlib import Path

from framelock_media.mask_preview import build_mask_preview


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Build an immutable deterministic FrameLock temporal-mask preview."
        )
    )
    parser.add_argument("temporal_matte_manifest", type=Path)
    parser.add_argument("output_directory", type=Path)
    arguments = parser.parse_args()
    artifact = build_mask_preview(
        arguments.temporal_matte_manifest,
        arguments.output_directory,
    )
    print(
        json.dumps(
            {
                "manifest": str(artifact.manifest_path),
                "manifest_digest_sha256": artifact.manifest_digest_sha256,
                "output": str(artifact.output_path),
                "output_sha256": artifact.output_sha256,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
