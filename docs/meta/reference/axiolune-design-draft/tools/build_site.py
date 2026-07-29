#!/usr/bin/env python3
"""Build the offline HTML documentation site from Markdown sources."""

from __future__ import annotations

import html
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
HTML = ROOT / "html"
FILTER = ROOT / "tools" / "mermaid.lua"

SECTION_NAMES = {
    "00-overview": "总览与追踪",
    "01-architecture": "总体架构",
    "02-technology": "技术选型",
    "03-modules": "模块设计",
    "04-ontology": "本体工程",
    "05-algorithms": "逻辑域与算法",
    "06-engineering": "工程、安全与 SRE",
    "07-delivery": "交付与迁移",
    "08-reference": "参考与证据",
}


def title_of(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    match = re.search(r"^#\s+(.+?)\s*$", text, re.MULTILINE)
    return match.group(1).strip() if match else path.stem


def section_of(path: Path) -> str:
    if path.name == "README.md":
        return "首页"
    if path.name == "PACKAGE-SUMMARY.md":
        return "交付说明"
    return SECTION_NAMES.get(path.parent.name, path.parent.name)


def destination(path: Path) -> Path:
    if path.name == "README.md":
        return HTML / "index.html"
    relative = path.relative_to(ROOT).with_suffix(".html")
    return HTML / relative


def plain_text(markdown: str) -> str:
    markdown = re.sub(r"```.*?```", " ", markdown, flags=re.DOTALL)
    markdown = re.sub(r"`([^`]*)`", r"\1", markdown)
    markdown = re.sub(r"!\[[^\]]*\]\([^)]+\)", " ", markdown)
    markdown = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", markdown)
    markdown = re.sub(r"[#>*_|~=-]+", " ", markdown)
    return re.sub(r"\s+", " ", markdown).strip()[:24000]


def render_markdown(path: Path, output_path: Path) -> str:
    command = [
        "pandoc",
        "--from=gfm+tex_math_dollars",
        "--to=html5",
        "--wrap=none",
        "--section-divs",
        "--mathml",
        f"--lua-filter={FILTER}",
        str(path),
    ]
    rendered = subprocess.run(command, check=True, capture_output=True, text=True).stdout
    def rewrite(match: re.Match[str]) -> str:
        attribute = match.group(1)
        raw = match.group(2)
        parsed = urlsplit(raw)
        if parsed.scheme or raw.startswith("#") or raw.startswith("mailto:"):
            return match.group(0)
        source_target = (path.parent / unquote(parsed.path)).resolve()
        if source_target.suffix.lower() == ".md":
            target = destination(source_target)
        elif source_target.exists():
            target = source_target
        else:
            return match.group(0)
        relative = os.path.relpath(target, output_path.parent).replace(os.sep, "/")
        suffix = f"?{parsed.query}" if parsed.query else ""
        if parsed.fragment:
            suffix += f"#{parsed.fragment}"
        return f'{attribute}="{html.escape(relative + suffix)}"'

    rendered = re.sub(r'(href|src)="([^"]+)"', rewrite, rendered)
    return rendered


def nav_html(entries: list[dict[str, object]], current: Path) -> str:
    grouped: dict[str, list[dict[str, object]]] = {}
    for entry in entries:
        grouped.setdefault(str(entry["section"]), []).append(entry)
    parts: list[str] = []
    order = ["首页", "交付说明", *SECTION_NAMES.values()]
    for section in order:
        section_entries = grouped.get(section, [])
        if not section_entries:
            continue
        parts.append(f'<nav class="nav-section" aria-label="{html.escape(section)}">')
        parts.append(f'<h2 class="nav-section-title">{html.escape(section)}</h2>')
        for entry in section_entries:
            target = Path(str(entry["destination"]))
            href = os.path.relpath(target, current.parent).replace(os.sep, "/")
            active = " is-active" if target == current else ""
            aria = ' aria-current="page"' if active else ""
            parts.append(
                f'<a class="nav-link{active}" href="{html.escape(href)}"{aria}>'
                f'{html.escape(str(entry["title"]))}</a>'
            )
        parts.append("</nav>")
    return "\n".join(parts)


def breadcrumbs(entry: dict[str, object], current: Path) -> str:
    if entry["section"] == "首页":
        return '<span>设计入口</span>'
    home = os.path.relpath(HTML / "index.html", current.parent).replace(os.sep, "/")
    return (
        f'<a href="{html.escape(home)}">首页</a><span>›</span>'
        f'<span>{html.escape(str(entry["section"]))}</span><span>›</span>'
        f'<span>{html.escape(str(entry["title"]))}</span>'
    )


def page_html(
    entry: dict[str, object],
    entries: list[dict[str, object]],
    article: str,
) -> str:
    current = Path(str(entry["destination"]))
    site_root = os.path.relpath(HTML, current.parent).replace(os.sep, "/")
    if site_root == ".":
        site_root = ""
    elif not site_root.endswith("/"):
        site_root += "/"
    asset_root = site_root + "assets/"
    raw_root = os.path.relpath(ROOT, current.parent).replace(os.sep, "/") + "/"
    nav = nav_html(entries, current)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="金融本体驱动平台总体设计、技术选型、模块、本体、算法与交付规范">
  <title>{html.escape(str(entry["title"]))} · 金融本体驱动平台</title>
  <script>
    (function() {{
      var saved = localStorage.getItem("finance-design-theme");
      if (saved) document.documentElement.dataset.theme = saved;
    }}());
    window.SITE_ROOT = {json.dumps(site_root, ensure_ascii=False)};
    window.RAW_ROOT = {json.dumps(raw_root, ensure_ascii=False)};
  </script>
  <link rel="stylesheet" href="{asset_root}style.css">
</head>
<body>
  <a class="skip-link" href="#content">跳到正文</a>
  <div class="reading-progress" aria-hidden="true"></div>
  <header class="topbar">
    <button class="icon-button menu-button" type="button" data-menu-toggle aria-label="打开文档目录" aria-expanded="false">☰</button>
    <a class="brand" href="{site_root}index.html">
      <span class="brand-mark" aria-hidden="true">FO</span>
      <span class="brand-text">金融本体驱动平台设计</span>
    </a>
    <span class="topbar-spacer"></span>
    <button class="icon-button" type="button" data-theme-toggle aria-label="切换主题">☾</button>
  </header>
  <div class="layout">
    <aside class="sidebar" aria-label="文档目录">
      <div class="search-wrap">
        <input class="search-input" type="search" data-search placeholder="搜索全部文档…" aria-label="搜索全部文档">
        <p class="search-hint">按 Ctrl/⌘ + K 聚焦 · Esc 清除</p>
        <div class="search-results" data-search-results aria-live="polite"></div>
      </div>
      {nav}
    </aside>
    <div class="overlay" aria-hidden="true"></div>
    <main class="main" id="content">
      <div class="content-shell">
        <nav class="breadcrumbs" aria-label="面包屑">{breadcrumbs(entry, current)}</nav>
        <article class="article">
          {article}
        </article>
        <footer class="page-meta">
          <span>基线 1.0 · 2026-07-27 · Markdown 与 HTML 同源</span>
          <span><a href="{raw_root}ontology/financial-ontology.yaml">本体 YAML</a> · <a href="{raw_root}contracts/ontology-api.openapi.yaml">OpenAPI</a> · <a href="{raw_root}contracts/events.asyncapi.yaml">AsyncAPI</a></span>
        </footer>
      </div>
    </main>
  </div>
  <script src="{asset_root}search-index.js"></script>
  <script src="{asset_root}mermaid-11.16.0.min.js"></script>
  <script src="{asset_root}app.js"></script>
</body>
</html>
"""


def main() -> None:
    markdown_paths = [
        ROOT / "README.md",
        ROOT / "PACKAGE-SUMMARY.md",
        *sorted(DOCS.rglob("*.md")),
    ]
    entries: list[dict[str, object]] = []
    for path in markdown_paths:
        entries.append(
            {
                "source": path,
                "destination": destination(path),
                "title": title_of(path),
                "section": section_of(path),
            }
        )

    index_items = []
    for entry in entries:
        source = Path(str(entry["source"]))
        target = Path(str(entry["destination"]))
        target.parent.mkdir(parents=True, exist_ok=True)
        article = render_markdown(source, target)
        target.write_text(page_html(entry, entries, article), encoding="utf-8")
        index_items.append(
            {
                "title": entry["title"],
                "section": entry["section"],
                "path": target.relative_to(HTML).as_posix(),
                "text": plain_text(source.read_text(encoding="utf-8")),
            }
        )

    search = "window.SEARCH_INDEX = " + json.dumps(index_items, ensure_ascii=False) + ";\n"
    (HTML / "assets" / "search-index.js").write_text(search, encoding="utf-8")
    print(f"Built {len(entries)} HTML pages into {HTML}")


if __name__ == "__main__":
    main()
