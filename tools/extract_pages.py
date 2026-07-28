#!/usr/bin/env python3
"""Vision-extract manual pages into structured markdown using the Copilot CLI (dev-time only).

Usage:
    python3 tools/extract_pages.py [--workers N] [--force] [stem ...]

With no stems, processes every page PNG under kb/pages/.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = ROOT / "kb" / "pages"
OUT_DIR = ROOT / "kb" / "extracted"

PROMPT = """You are a technical documentation extraction specialist working on the Vulcan OmniPro 220
multiprocess welder owner's manual (Harbor Freight item 57812).

Read the page image at {png}. Also read the raw pdftotext layer at {txt} if it exists
(it may have garbled table columns -- trust the IMAGE over the text layer when they conflict).

Produce a single markdown document that fully represents this page for a downstream RAG agent.
Rules:
- Transcribe ALL text verbatim, preserving headings and section names.
- Render EVERY table as a proper GitHub markdown table with all rows and columns. Never summarize a table.
- For every figure, diagram, photo, schematic, or chart on the page, emit a block:
    ### FIGURE: <short-slug>
    **Caption:** <caption if printed, else none>
    **Type:** photo|diagram|schematic|chart|table-image|icon
    **Description:** <exhaustive description: every callout number and its label, every
      connector/socket, wire colors, arrows, and what the figure teaches>
    **Answers questions like:** <3-6 example user questions this figure answers>
- Capture all callout/legend numbering exactly (e.g. "3. Wire Feed Tension Knob").
- At the very end, emit a YAML block fenced as ```yaml with keys:
    page: <int>
    doc: {doc}
    section: <manual section name>
    topics: [lowercase topic slugs]
    processes: [mig|flux-cored|tig|stick|general]
    has_table: true|false
    has_figure: true|false
    figure_slugs: [..]
    key_facts: [atomic self-contained factual statements found on this page]
- Do NOT invent any value that is not visible on the page. If a cell is illegible write "illegible".

Write the result to {out}. Output nothing else to stdout."""


def extract(stem: str, force: bool = False) -> str:
    png = PAGES / f"{stem}.png"
    txt = PAGES / f"{stem}.txt"
    out = OUT_DIR / f"{stem}.md"
    if not png.exists():
        return f"MISSING {stem}"
    if out.exists() and out.stat().st_size > 200 and not force:
        return f"skip    {stem}"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    doc = stem.rsplit("-", 1)[0]
    prompt = PROMPT.format(png=png, txt=txt, out=out, doc=doc)
    try:
        subprocess.run(
            ["copilot", "-p", prompt, "--allow-all", "--no-color"],
            cwd=ROOT,
            capture_output=True,
            timeout=900,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return f"TIMEOUT {stem}"
    if out.exists() and out.stat().st_size > 200:
        return f"ok      {stem} {out.stat().st_size}B"
    return f"FAIL    {stem}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("stems", nargs="*")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    stems = args.stems or sorted(p.stem for p in PAGES.glob("*.png"))
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(extract, s, args.force): s for s in stems}
        for fut in concurrent.futures.as_completed(futures):
            print(fut.result(), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
