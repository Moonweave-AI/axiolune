#!/usr/bin/env python3
"""Validate structure, links, contracts, evidence counts and secret hygiene."""

from __future__ import annotations

import csv
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

import yaml


ROOT = Path(__file__).resolve().parents[1]
ERRORS: list[str] = []
WARNINGS: list[str] = []


def error(message: str) -> None:
    ERRORS.append(message)


def warning(message: str) -> None:
    WARNINGS.append(message)


def resolve_link(source: Path, target: str) -> Path | None:
    parsed = urlsplit(target)
    if parsed.scheme or target.startswith("#") or target.startswith("mailto:"):
        return None
    path = unquote(parsed.path)
    if not path:
        return None
    return (source.parent / path).resolve()


def validate_markdown() -> list[Path]:
    markdown = [
        ROOT / "README.md",
        ROOT / "PACKAGE-SUMMARY.md",
        *sorted((ROOT / "docs").rglob("*.md")),
    ]
    pattern = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
    for path in markdown:
        text = path.read_text(encoding="utf-8")
        if text.count("```") % 2:
            error(f"unbalanced code fence: {path.relative_to(ROOT)}")
        if not re.search(r"^#\s+\S", text, re.MULTILINE):
            error(f"missing H1: {path.relative_to(ROOT)}")
        for raw in pattern.findall(text):
            target = raw.strip().split()[0].strip("<>")
            resolved = resolve_link(path, target)
            if resolved is not None and not resolved.exists():
                error(f"broken Markdown link: {path.relative_to(ROOT)} -> {target}")
    return markdown


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in {"a", "link", "script", "img", "video", "source"}:
            return
        attr_name = "href" if tag in {"a", "link"} else "src"
        for key, value in attrs:
            if key == attr_name and value:
                self.links.append(value)


def validate_html(markdown: list[Path]) -> None:
    html_root = ROOT / "html"
    pages = sorted(html_root.rglob("*.html"))
    if len(pages) != len(markdown):
        error(f"HTML page count {len(pages)} != Markdown source count {len(markdown)}")
    for path in pages:
        text = path.read_text(encoding="utf-8")
        if 'lang="zh-CN"' not in text or "<article" not in text:
            error(f"invalid HTML shell: {path.relative_to(ROOT)}")
        if re.search(r'href="[^"]+\.md(?:#|")', text):
            error(f"unconverted .md link: {path.relative_to(ROOT)}")
        parser = LinkParser()
        parser.feed(text)
        for target in parser.links:
            resolved = resolve_link(path, target)
            if resolved is not None and not resolved.exists():
                error(f"broken HTML asset/link: {path.relative_to(ROOT)} -> {target}")
    required_assets = [
        html_root / "assets" / "style.css",
        html_root / "assets" / "app.js",
        html_root / "assets" / "search-index.js",
        html_root / "assets" / "mermaid-11.16.0.min.js",
        html_root / "assets" / "MERMAID-LICENSE.txt",
    ]
    for asset in required_assets:
        if not asset.exists():
            error(f"missing HTML asset: {asset.relative_to(ROOT)}")


def validate_yaml() -> None:
    required = {
        ROOT / "ontology" / "financial-ontology.yaml": ["ontology", "valueTypes", "interfaces", "domains", "objectTypes", "linkTypes", "actionTypes", "functionTypes", "policies", "invariants"],
        ROOT / "contracts" / "ontology-api.openapi.yaml": ["openapi", "info", "paths", "components"],
        ROOT / "contracts" / "events.asyncapi.yaml": ["asyncapi", "info", "channels", "operations", "components"],
        ROOT / "contracts" / "data-contract.example.yaml": ["dataContract"],
    }
    for path, keys in required.items():
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception as exc:
            error(f"invalid YAML {path.relative_to(ROOT)}: {exc}")
            continue
        if not isinstance(data, dict):
            error(f"YAML root is not a mapping: {path.relative_to(ROOT)}")
            continue
        for key in keys:
            if key not in data:
                error(f"missing YAML key {key}: {path.relative_to(ROOT)}")
    ontology_path = ROOT / "ontology" / "financial-ontology.yaml"
    ontology = yaml.safe_load(ontology_path.read_text(encoding="utf-8"))
    if len(ontology.get("objectTypes", {})) < 40:
        error("ontology contains fewer than 40 object types")
    if len(ontology.get("linkTypes", {})) < 30:
        error("ontology contains fewer than 30 link types")
    if len(ontology.get("domains", [])) != 12:
        error("ontology must contain exactly 12 top-level domains")


def csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def validate_evidence() -> None:
    attachment = csv_rows(ROOT / "evidence" / "attachment_inventory.csv")
    palantir = csv_rows(ROOT / "evidence" / "palantir_url_inventory.csv")
    platform = csv_rows(ROOT / "evidence" / "platform_sources.csv")
    if len(attachment) != 145:
        error(f"attachment inventory count is {len(attachment)}, expected 145")
    if len(palantir) != 3275:
        error(f"Palantir URL inventory count is {len(palantir)}, expected 3275")
    if len(platform) != 93:
        error(f"platform source count is {len(platform)}, expected 93")
    urls = [row.get("url", "") for row in palantir]
    if len(set(urls)) != len(urls):
        error("Palantir URL inventory contains duplicate URLs")
    required_attachment = [
        "asset_id",
        "relative_path",
        "asset_type",
        "source_section",
        "page_or_function",
        "content_or_visual_summary",
        "sensitivity_or_risk",
        "review_status",
    ]
    for index, row in enumerate(attachment, start=2):
        if any(row.get(field, "") == "" for field in required_attachment):
            error(f"attachment CSV contains an empty required field at row {index}")
            break
    for name, rows in [("palantir", palantir), ("platform", platform)]:
        for index, row in enumerate(rows, start=2):
            if any(value == "" for value in row.values()):
                error(f"{name} CSV contains an empty field at row {index}")
                break


def validate_hygiene() -> None:
    text_suffixes = {".md", ".yaml", ".yml", ".json", ".csv", ".js", ".css", ".html", ".txt", ".py", ".lua"}
    secret_patterns = [
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
        re.compile(r"(?i)(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*['\"]?[A-Za-z0-9+/=_-]{12,}"),
        re.compile(r"(?i)https?://[^/\s:@]+:[^/\s@]+@"),
    ]
    placeholder_words = ["TO" + "DO", "TB" + "D", "FIX" + "ME"]
    placeholder_pattern = re.compile(r"\b(?:" + "|".join(placeholder_words) + r")\b")
    private_ip = re.compile(r"(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])")
    raw_media = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if path.name == "mermaid-11.16.0.min.js":
            continue
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov"}:
            raw_media.append(path.relative_to(ROOT).as_posix())
        if path.suffix.lower() not in text_suffixes:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for pattern in secret_patterns:
            if pattern.search(text):
                error(f"possible embedded secret in {path.relative_to(ROOT)}")
        if placeholder_pattern.search(text):
            error(f"unfinished placeholder in {path.relative_to(ROOT)}")
        if private_ip.search(text):
            error(f"private IP literal in {path.relative_to(ROOT)}")
    if raw_media:
        error("raw media unexpectedly packaged: " + ", ".join(raw_media[:5]))


def main() -> int:
    required_dirs = ["docs", "ontology", "contracts", "evidence", "html", "tools"]
    for name in required_dirs:
        if not (ROOT / name).is_dir():
            error(f"missing directory: {name}")
    markdown = validate_markdown()
    validate_html(markdown)
    validate_yaml()
    validate_evidence()
    validate_hygiene()
    print(f"Validated {len(markdown)} Markdown sources.")
    for item in WARNINGS:
        print(f"WARNING: {item}")
    if ERRORS:
        for item in ERRORS:
            print(f"ERROR: {item}")
        print(f"Validation failed with {len(ERRORS)} error(s).")
        return 1
    print("Validation passed: structure, links, YAML, evidence counts and hygiene.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
