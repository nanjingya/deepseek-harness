---
name: read-pdf
description: Required as soon as a PDF path is known: read, summarize, quote, or convert it via read_pdf. Output is Markdown plus an editable Word file. Do not use bash, WPS, pandoc, or pdftotext.
---

# Read PDF (OCR / layout)

Use the `read_pdf` tool as soon as a PDF path is known. Do not invent PDF contents from the filename alone, and do not convert with Word, WPS, pandoc, or `read`.

## Workflow

1. Call `read_pdf` with `file_path` (session-cwd relative or absolute) before any other conversion attempt.
2. Read the returned Markdown. If `truncated` is true, follow up with the ordinary `read` tool on `markdownPath` for the remainder.
3. Hand the user `docxPath` (`document.docx`) when they asked for Word. That file is editable OCR in A4 Chinese-standard styles, not a page-faithful copy of the scan. Do not write a second Markdown-to-Word converter.
4. For multi-document work, reuse the same `output_dir` only when intentionally overwriting; the default `.dsh/pdf/<hash>/` cache keys on path + mtime + size.

## Engine notes

- `engine: auto` (default) selects Vision OCR on macOS and PaddleOCR/Tesseract elsewhere.
- Host requirements: Python 3 with Pillow, numpy, and python-docx; Poppler (`pdftoppm`/`pdfinfo`); plus the selected OCR backend.
- Conversion can take minutes for long scanned standards; prefer one call per PDF rather than page-by-page shell loops.
- Images in the result are captioned figures (and rare uncaptioned full-page diagrams). Blank pages and logo stamps are omitted. A standards cover is native OCR text when page 1 has enough CJK; 目次 keeps source numbering, indent, and dotted page leaders.

## Do not

- Run ad-hoc `tesseract`/`pdftotext` shell pipelines when `read_pdf` is available.
- Launch WPS, Word, Preview, or `open` to convert a PDF — that steals the host display and can crash with an OS dialog.
- Claim the Word file matches GB/T pagination or type sizes of the original scan; keep the PDF for visual layout.
- Commit `.dsh/pdf/` artifacts unless the user asks.
- Paste secrets from a PDF into logs beyond what the task requires.
