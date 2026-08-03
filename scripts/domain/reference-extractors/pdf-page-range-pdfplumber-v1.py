#!/usr/bin/env python3
"""Emit a deterministic, version-locked text framing for physical PDF pages."""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

import pdfminer
import pdfplumber


EXPECTED_PYTHON = (3, 12, 13)
EXPECTED_PDFPLUMBER = "0.11.9"
EXPECTED_PDFMINER = "20251230"


def _require_locked_runtime() -> None:
    actual_python = sys.version_info[:3]
    if actual_python != EXPECTED_PYTHON:
        raise RuntimeError(
            f"python runtime drift: expected {EXPECTED_PYTHON}, got {actual_python}"
        )
    if pdfplumber.__version__ != EXPECTED_PDFPLUMBER:
        raise RuntimeError(
            "pdfplumber runtime drift: "
            f"expected {EXPECTED_PDFPLUMBER}, got {pdfplumber.__version__}"
        )
    if pdfminer.__version__ != EXPECTED_PDFMINER:
        raise RuntimeError(
            f"pdfminer runtime drift: expected {EXPECTED_PDFMINER}, got {pdfminer.__version__}"
        )


def select_page_text_bytes(source: Path, start_page: int, end_page: int) -> bytes:
    _require_locked_runtime()
    if start_page < 1 or end_page < start_page:
        raise ValueError("page range must be one-based, inclusive, and non-reversed")
    with pdfplumber.open(source) as document:
        if end_page > len(document.pages):
            raise ValueError(
                f"page range ends at {end_page}, but document has {len(document.pages)} pages"
            )
        selected = bytearray(struct.pack(">Q", end_page - start_page + 1))
        for page_number in range(start_page, end_page + 1):
            payload = (document.pages[page_number - 1].extract_text() or "").encode("utf-8")
            selected.extend(struct.pack(">Q", page_number))
            selected.extend(struct.pack(">Q", len(payload)))
            selected.extend(payload)
        return bytes(selected)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("start_page", type=int)
    parser.add_argument("end_page", type=int)
    arguments = parser.parse_args()
    sys.stdout.buffer.write(
        select_page_text_bytes(arguments.source, arguments.start_page, arguments.end_page)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
