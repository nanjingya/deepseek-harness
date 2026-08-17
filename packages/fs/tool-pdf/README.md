# @deepseek-ai/dsh-tool-pdf

English | [中文](README.zh.md)

Model-facing **`read_pdf`**: convert a PDF (native text or scanned) to LLM-ready Markdown and an editable Word file through the packaged 南鲸 OCR/layout engine. Spawns Python via `ctx.subprocess` (never `ctx.shell`); optionally registers a bundled **`read-pdf`** skill when `ctx.skills` is mounted.

```ts ignore-check
await ctx.plugin(LocalSubprocessRuntime) // @deepseek-ai/dsh-subprocess-local
await ctx.plugin(ToolPdf)                // @deepseek-ai/dsh-tool-pdf
// Optional: skill discovery / load_skill
await ctx.plugin(SkillRegistry)          // @deepseek-ai/dsh-skill
```

The base profile mounts this plugin next to `tool-fs-search`. The Web bundle disables that host-plane copy so the standard/code/cordis agent presets own the tool. Hosts still need Python 3 (Pillow, numpy, python-docx), Poppler (`pdftoppm`/`pdfinfo`), and an OCR backend (Vision on macOS; PaddleOCR or Tesseract elsewhere). Registration is unconditional; missing host tools fail at call time.

## Config

| Key | Default | Meaning |
|---|---|---|
| `python` | `$PDF_WIKI_PYTHON` / `$DSH_PDF_PYTHON` / `python3` | Interpreter argv[0] for the converter. |
| `engineRoot` | packaged `engine/` | Directory containing `pdf_wiki_parser.py` and `docx_exporter.py`. |
| `dpi` | `200` | Default page-render DPI when the call omits `dpi`. |
| `workers` | `4` | Default OCR worker count when the call omits `workers`. |
| `defaultEngine` | `auto` | Default OCR engine (`auto` / `vision` / `paddleocr` / `tesseract`). |
| `maxOutputChars` | `120000` | Max Markdown characters returned inline; full text stays at `markdownPath`. |
| `timeoutMs` | `600000` | Cooperative tool-call budget (long scanned PDFs). |
| `graceMs` | `5000` | Terminate-escalation grace after the cooperative budget. |
| `stderrMaxBytes` | `65536` | Converter stderr retained for failure messages. |

## Tool

| Tool | Arguments | Behavior |
|---|---|---|
| `read_pdf` | `file_path`, `output_dir?`, `dpi?`, `engine?`, `workers?` | Spawns the packaged converter; returns inline Markdown (possibly truncated) plus durable `document.md` and `document.docx` under `.dsh/pdf/<hash>/` (or `output_dir`). Prefer ordinary `read` on `markdownPath` for follow-up slices. |

While mounted, `tools/pre-execute` denies `read`/`read_image` on `.pdf` paths and `bash`/`pwsh` conversions (WPS, pandoc, pdftotext, office GUI apps). Inspect commands (`which`, `ls`, `file`) still run. Hand the user `document.docx` when they asked for Word; do not write a second converter.

## Errors

Failures carry package-owned `PdfError` codes: `PDF_NOT_FOUND`, `PDF_INVALID_PATH`, `PDF_ENGINE_FAILED`, `PDF_ABORTED`, `PDF_OUTPUT_MISSING`.

## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope contains the independently registered `read_pdf` guidance below. Agent-scoped tool restrictions can hide the schema without removing its prompt section.

##### read_pdf guidance

```markdown
When a PDF path is known, call read_pdf immediately — not read, bash, WPS, Word, Preview, open, pandoc, or pdftotext. It returns Markdown plus document.md and an editable document.docx under .dsh/pdf/. Word is OCR text in A4 Chinese-standard styles, not a page-faithful copy of the scan; do not write a second converter. Pass the exact path from glob or ls without truncating long names. Prefer read on that Markdown for follow-up slices; do not claim PDF contents without calling read_pdf first.
```

#### Token effect

Fixed guidance cost per request while the plugin is registered.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged.

### Tool schemas

#### What the model sees

The generated [`read_pdf` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pdf) describes local OCR/layout conversion and host requirements.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Results

#### What the model sees

A header with `<path>`, `<docx>`, `<source>`, `<engine>`, optional `<pages>` / `<truncated>`, and `<output_dir>`, then the Markdown body.

#### Token effect

Bounded by `maxOutputChars`; the full Markdown remains on disk for follow-up `read`.

#### KV Cache effect

Append-only for newly visible tool results.

### Tool errors

#### What the model sees

Normalized `Error: <message>` with structured `PdfError` codes for callers.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only.

## Known Limitations and Deferred Work

- **Host OCR, Poppler, and python-docx are required** — the packaged engine is not a self-contained binary; macOS Vision / PaddleOCR / Tesseract, Poppler, and python-docx must be installed on the host.
- **Conversion can take minutes** — long scanned standards use a 10-minute default `timeoutMs`; background jobs are not exposed.
- **Word is editable OCR, not a facsimile** — A4 Chinese-standard styles, native text, and captioned figure crops; pagination and type sizes do not match the scan. A standards cover is native OCR text when page 1 has enough CJK; otherwise the page raster is kept. 目次 keeps source numbering, indent, and dotted page leaders. PDF source-page markers stay in Markdown only. Keep the PDF for visual layout. Blank pages and logo stamps are omitted.
- **No keyless OCR snapshot yet** — package tests cover argv, caching, and error codes with a fake subprocess; assembled OCR transcripts wait on a host-independent fixture strategy.
- **Engine quality heuristics remain upstream** — TOC pairing, cover reconstruction, figure crops, and uncaptioned full-page artwork detection inherit from the vendored 南鲸 converter; fix them in `engine/` rather than in the Cordis adapter.
