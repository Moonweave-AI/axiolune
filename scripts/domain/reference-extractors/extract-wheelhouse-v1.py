#!/usr/bin/env python3
"""Safely unpack an exact wheelhouse without path-dependent script generation."""

from __future__ import annotations

import argparse
import shutil
import stat
import sys
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath


EXPECTED_PYTHON = (3, 12, 13)


def _checked_member_path(name: str) -> PurePosixPath:
    if "\x00" in name or "\\" in name or unicodedata.normalize("NFC", name) != name:
        raise RuntimeError(f"unsafe or non-NFC wheel member path: {name!r}")
    member = PurePosixPath(name)
    if member.is_absolute() or not member.parts:
        raise RuntimeError(f"absolute or empty wheel member path: {name!r}")
    if any(part in {"", ".", ".."} for part in member.parts):
        raise RuntimeError(f"ambiguous wheel member path: {name!r}")
    return member


def extract_wheelhouse(wheelhouse: Path, target: Path) -> int:
    if sys.version_info[:3] != EXPECTED_PYTHON:
        raise RuntimeError(
            f"python runtime drift: expected {EXPECTED_PYTHON}, got {sys.version_info[:3]}"
        )
    wheels = sorted(wheelhouse.glob("*.whl"), key=lambda item: item.name.encode("utf-8"))
    if not wheels:
        raise RuntimeError("wheelhouse contains no wheels")
    if target.exists():
        if not target.is_dir() or any(target.iterdir()):
            raise RuntimeError("target must be absent or an empty directory")
    else:
        target.mkdir(parents=False)
    target_resolved = target.resolve(strict=True)
    extracted_files: set[str] = set()
    for wheel in wheels:
        with zipfile.ZipFile(wheel, "r") as archive:
            for info in archive.infolist():
                member = _checked_member_path(info.filename.rstrip("/"))
                member_key = member.as_posix()
                output = target.joinpath(*member.parts)
                output_resolved = output.resolve(strict=False)
                if target_resolved not in output_resolved.parents:
                    raise RuntimeError(f"wheel member escapes target: {info.filename!r}")
                unix_mode = (info.external_attr >> 16) & 0o177777
                if stat.S_ISLNK(unix_mode):
                    raise RuntimeError(f"wheel member is a symbolic link: {info.filename!r}")
                if info.is_dir():
                    output.mkdir(parents=True, exist_ok=True)
                    continue
                if member_key in extracted_files:
                    raise RuntimeError(f"duplicate wheel file member: {member_key}")
                extracted_files.add(member_key)
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info, "r") as source, output.open("xb") as destination:
                    shutil.copyfileobj(source, destination, length=1024 * 1024)
    if not extracted_files:
        raise RuntimeError("wheelhouse extraction produced no files")
    return len(extracted_files)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("wheelhouse", type=Path)
    parser.add_argument("target", type=Path)
    arguments = parser.parse_args()
    count = extract_wheelhouse(arguments.wheelhouse, arguments.target)
    print(count)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
