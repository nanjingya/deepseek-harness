# Agent Note: Model-facing read_pdf over the packaged 南鲸 converter

Status: implemented

English | [中文](2026-08-17-read-pdf-tool.zh.md)

## Problem

`read` is UTF-8 text only, `read_image` is raster-only, and `web_fetch` has no PDF arm — agents asked to summarize or quote a PDF either failed or invented shell OCR one-offs. The standalone 南鲸 PDF 识别 tool already performed layout-aware OCR to Markdown, but it lived outside the harness plugin graph, so it had no tool schema, system-prompt guidance, session-cwd path rules, or optional skill registration.

## Decision

Ship `@deepseek-ai/dsh-tool-pdf` beside `tool-fs-search` as a subprocess-backed consumer:

- **`read_pdf` registers unconditionally** once `tools`, `systemPrompt`, and `subprocess` exist. The call spawns the packaged `engine/pdf_wiki_parser.py` through `ctx.subprocess` with a fixed argv vector (no shell). Defaults cache under `<cwd>/.dsh/pdf/<hash>/` keyed by path + mtime + size. The converter writes `document.md` and an editable `document.docx` (南鲸 `docx_exporter.py` over `semantic_blocks`); host Python must provide python-docx.
- **Engine stays in-package** (`engine/`, `assets/`); host Python, Poppler, python-docx, and OCR backends remain deployment requirements. Config may override `python` and `engineRoot`.
- **Bundled `read-pdf` skill is optional** via `ctx.get('skills')`, matching `skill-badge` resource layout, so deployments without the skill seam still get the tool.
- **Base profile mounts `tool-pdf`** next to `tool-fs-search`. The Web bundle disables that host-plane copy so the standard/code/cordis agent presets own the tool, matching `tool-fs` / `tool-fs-search`. Headless keeps the host-plane registration. The tool catalog harvests the schema through `LocalSubprocessRuntime`.
- **PDF work is routed onto `read_pdf`** at `tools/pre-execute`: `read`/`read_image` on `.pdf` paths, and `bash`/`pwsh` conversions (WPS including quoted Mac app paths, `open -a`, `open` on PDF/Office files, osascript tell WPS/Word/Preview, pandoc/pdftotext/soffice). Inspect commands (`which`/`ls`/`file`) still run. Prompt, schema, and skill text tell the model to call `read_pdf` as soon as a PDF path is known and to hand over `document.docx` rather than write a second converter. Word is editable OCR in A4 Chinese-standard styles, not a page-faithful scan: a standards cover is native OCR text when page 1 has enough CJK, 目次 keeps source numbering, indent, and dotted leaders, and PDF source-page markers stay in Markdown only. The global `tool:bash` prompt is unchanged so ACP `text-turn` snapshots stay stable.
- **Uncaptioned full-page images** are kept only when printable ink occupies most of the page (diagrams). Blank versos, binding-shadow noise, and centered logo/stamp pages are omitted; captioned figures still use `ink_bbox_for_figure`.

## Alternatives considered

- **Extend `read` / `ctx.fs` for PDF** — rejected: PDF conversion is a process-backed OCR workflow, not a filesystem primitive; putting it on `ctx.fs` would force every backend to grow OCR.
- **Shell one-offs or a Skill-only path** — rejected: Skills cannot replace a typed tool schema or guarantee model-visible guidance; shell OCR bypasses budgets, path validation, and error codes.
- **Pixel-faithful Word (page rasters) as the default** — rejected: that embeds every PDF page as an image and recreates the extra-image failure mode. Keep the PDF for visual layout; editable Word consumes `semantic_blocks`.
- **Markdown-only with no Word artifact** — rejected: convert-to-Word requests then produce one-off Markdown-to-Word scripts that page-break every PDF marker and paste full-page scans. The packaged exporter is the Word path.
- **Remote OCR API as the default** — deferred: the local engine matches the user's existing offline tool; a provider seam can wrap another backend later without changing the tool name.

## Consequences

- Assembled prompts and the tool catalog grow by one schema and one guidance section on compositions that mount the plugin. The ACP example does not mount it, so `text-turn` stays unchanged. Product CLI/headless keep the host-plane row; Web remounts it from the standard/code/cordis presets. A model that still tries `read`, WPS, or pandoc on a PDF gets a deny result pointing at `read_pdf`.
- Keyless OCR end-to-end snapshots are deferred until a host-independent fixture strategy exists; package tests pin argv, cache paths, truncation, `docxPath`, and `PdfError` codes over a fake subprocess. `engine/test_full_page_artwork.py` and `engine/test_cover_and_toc.py` pin converter heuristics and are not part of the Vitest coverage gate.
- Converter quality (TOC pairing, cover reconstruction, figure crops, full-page artwork detection) remains owned by `engine/`; the Cordis adapter owns only registration, budgets, and path presentation. Missing python-docx fails at converter start.
