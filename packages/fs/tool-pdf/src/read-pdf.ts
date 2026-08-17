/**
 * Register the model-facing `read_pdf` tool and its system-prompt guidance.
 * @module @deepseek-ai/dsh-tool-pdf/read-pdf
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  parseReadPdfArgs,
  runPdfConversion,
  type PdfToolCaps,
  type ReadPdfValue,
} from './run.ts'

/** Cross-call habits for PDF reading that a single schema description cannot carry. */
export const READ_PDF_PROMPT_TEXT = 'When a PDF path is known, call read_pdf immediately — not read, bash, WPS, Word, Preview, open, pandoc, or pdftotext. It returns Markdown plus document.md and an editable document.docx under .dsh/pdf/. Word is OCR text in A4 Chinese-standard styles, not a page-faithful copy of the scan; do not write a second converter. Pass the exact path from glob or ls without truncating long names. Prefer read on that Markdown for follow-up slices; do not claim PDF contents without calling read_pdf first.'

/**
 * Format the canonical value for Native model content.
 * @param _args - unused call arguments.
 * @param value - successful conversion value.
 * @returns model-facing text blocks.
 */
export function formatReadPdfOutput(_args: unknown, value: ReadPdfValue): { type: 'text'; text: string }[] {
  const header = [
    `<path>${value.markdownPath}</path>`,
    `<docx>${value.docxPath}</docx>`,
    `<source>${value.sourcePdf}</source>`,
    `<engine>${value.engine}</engine>`,
    value.pages !== undefined ? `<pages>${value.pages}</pages>` : undefined,
    value.truncated ? '<truncated>true</truncated>' : undefined,
    `<output_dir>${value.outputDir}</output_dir>`,
  ].filter((line): line is string => line !== undefined)
  return [{ type: 'text', text: `${header.join('\n')}\n\n${value.markdown}` }]
}

/**
 * Pending card for a `read_pdf` call.
 * @param args - tool arguments (may be partially invalid on replay).
 * @returns a generic read-family card, or undefined for fallback.
 */
export function presentReadPdfCall(args: { file_path?: string }): GenericCallView | undefined {
  if (typeof args.file_path !== 'string' || args.file_path.trim() === '') return undefined
  return {
    card: 'generic',
    kind: 'read',
    title: 'read_pdf',
    locations: [{ path: args.file_path }],
  }
}

/**
 * Completed card for a `read_pdf` result.
 * @param args - original arguments.
 * @param result - normalized tool result.
 * @returns a generic card summarizing success or error.
 */
export function presentReadPdfResult(
  args: { file_path?: string },
  result: ToolResult,
): GenericCallView | undefined {
  const path = typeof args.file_path === 'string' ? args.file_path : 'pdf'
  if (result.isError) {
    return { card: 'generic', kind: 'read', title: `read_pdf failed: ${path}` }
  }
  return { card: 'generic', kind: 'read', title: `read_pdf: ${path}` }
}

/**
 * Register `read_pdf` and its prompt section.
 * @param ctx - plugin context; registrations are fiber-scoped effects.
 * @param caps - resolved plugin caps.
 */
export function applyReadPdfTool(ctx: Context, caps: PdfToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:read_pdf',
    order: 104,
    text: READ_PDF_PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'read_pdf',
    description:
      'Required for every PDF the user wants read, summarized, quoted, or converted. Returns Markdown and an editable Word file via local OCR/layout. Word is not a facsimile of the scan. Do not use read, bash, WPS, pandoc, or pdftotext. '
      + 'Returns inline Markdown (possibly truncated) and durable document.md / document.docx paths under .dsh/pdf/. '
      + 'Requires a host Python 3 with Pillow/numpy/python-docx plus Poppler; macOS prefers Vision OCR, other platforms prefer PaddleOCR or Tesseract.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Path to the .pdf file. Relative paths resolve against the session working directory. Pass the exact path from glob or ls; do not truncate long names.',
      },
      output_dir: {
        type: 'string',
        description: 'Optional directory for conversion artifacts. Defaults to .dsh/pdf/<hash>/ under the session working directory.',
      },
      dpi: {
        type: 'number',
        description: `Page render DPI (72–600). Defaults to ${caps.dpi}.`,
      },
      engine: {
        type: 'string',
        enum: ['auto', 'vision', 'paddleocr', 'tesseract'],
        description: `OCR engine. Defaults to ${caps.defaultEngine}. auto selects Vision on macOS and PaddleOCR/Tesseract elsewhere.`,
      },
      workers: {
        type: 'number',
        description: `OCR worker processes (1–32). Defaults to ${caps.workers}.`,
      },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          markdownPath: { type: 'string', required: true },
          docxPath: { type: 'string', required: true },
          outputDir: { type: 'string', required: true },
          sourcePdf: { type: 'string', required: true },
          engine: { type: 'string', required: true },
          pages: { type: 'number' },
          truncated: { type: 'boolean', required: true },
          markdown: { type: 'string', required: true },
        },
      },
      render: formatReadPdfOutput,
    },
    presentCall: presentReadPdfCall,
    presentResult: presentReadPdfResult,
    async execute(args, exec) {
      const workdir = exec.agent?.session.header.cwd ?? process.cwd()
      return runPdfConversion(ctx, exec, parseReadPdfArgs(args, workdir, caps), caps)
    },
  }))
}
