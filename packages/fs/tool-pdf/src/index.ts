/**
 * Model-facing `read_pdf` tool over the packaged 南鲸 PDF OCR/layout engine.
 * Spawns Python through `ctx.subprocess` (never `ctx.shell`); writes Markdown
 * and an editable Word file; optionally registers a bundled `read-pdf` skill
 * when `ctx.skills` is mounted.
 * @module @deepseek-ai/dsh-tool-pdf
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { applyReadPdfTool } from './read-pdf.ts'
import { applyReadPdfSkill } from './skill.ts'
import { applyPdfToolRouting } from './routing.ts'
import {
  PDF_DPI,
  PDF_GRACE_MS,
  PDF_MAX_OUTPUT_CHARS,
  PDF_STDERR_MAX_BYTES,
  PDF_TIMEOUT_MS,
  PDF_WORKERS,
  type PdfOcrEngine,
} from './run.ts'

export {
  ENGINE_ENTRY,
  resolveDefaultEngineRoot,
  resolveEngineRoot,
  resolveEngineRootFrom,
  resolvePythonExecutable,
} from './paths.ts'
export {
  PDF_DPI,
  PDF_GRACE_MS,
  PDF_MAX_OUTPUT_CHARS,
  PDF_STDERR_MAX_BYTES,
  PDF_TIMEOUT_MS,
  PDF_WORKERS,
  PdfError,
  defaultOutputDir,
  parseReadPdfArgs,
  recoverPdfByPrefix,
  resolveExistingPdf,
  runPdfConversion,
  toWorkdirRelative,
  truncateMarkdown,
} from './run.ts'
export type { PdfErrorCode, PdfOcrEngine, PdfToolCaps, ReadPdfInput, ReadPdfValue } from './run.ts'
export {
  READ_PDF_PROMPT_TEXT,
  applyReadPdfTool,
  formatReadPdfOutput,
  presentReadPdfCall,
  presentReadPdfResult,
} from './read-pdf.ts'
export { applyReadPdfSkill } from './skill.ts'
export {
  applyPdfToolRouting,
  PDF_BYPASS_DENY_REASON,
  PDF_READ_DENY_REASON,
  isPdfBypassShellCommand,
} from './routing.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-pdf'

/** Services required by the PDF tool (`skills` is optional via `ctx.get`). */
export const inject = ['tools', 'systemPrompt', 'subprocess']

/** Plugin config: host Python, engine root overrides, OCR defaults, and budgets. */
export interface Config {
  /** Python 3 interpreter. Defaults to `$PDF_WIKI_PYTHON` / `$DSH_PDF_PYTHON` / `python3`. */
  python?: string
  /**
   * Absolute or workdir-relative engine root containing `pdf_wiki_parser.py`
   * and `docx_exporter.py`. Defaults to the packaged `engine/`.
   */
  engineRoot?: string
  /** Default page-render DPI when the tool call omits `dpi`. */
  dpi?: number
  /** Default OCR worker count when the tool call omits `workers`. */
  workers?: number
  /** Default OCR engine when the tool call omits `engine`. */
  defaultEngine?: PdfOcrEngine
  /** Max Markdown characters returned inline; the full file remains at `markdownPath`. */
  maxOutputChars?: number
  /** Terminate-escalation grace (ms) after the cooperative timeout. */
  graceMs?: number
  /** Cap on retained converter stderr for failure messages. */
  stderrMaxBytes?: number
  /** Cooperative tool-call timeout budget (ms). */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  python: z.string(),
  engineRoot: z.string(),
  dpi: z.number().default(PDF_DPI),
  workers: z.number().default(PDF_WORKERS),
  defaultEngine: z.union([
    z.const('auto' as const),
    z.const('vision' as const),
    z.const('paddleocr' as const),
    z.const('tesseract' as const),
  ]).default('auto'),
  maxOutputChars: z.number().default(PDF_MAX_OUTPUT_CHARS),
  graceMs: z.number().default(PDF_GRACE_MS),
  stderrMaxBytes: z.number().default(PDF_STDERR_MAX_BYTES),
  timeoutMs: z.number().default(PDF_TIMEOUT_MS),
})

/** Config after schemastery defaults. Optional string overrides may remain unset. */
type ResolvedConfig = Required<Pick<Config, 'dpi' | 'workers' | 'defaultEngine' | 'maxOutputChars' | 'graceMs' | 'stderrMaxBytes' | 'timeoutMs'>> & Pick<Config, 'python' | 'engineRoot'>

/** Positive integer caps avoid silent retention/timeout arithmetic bugs. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-pdf: ${field} must be a positive integer`)
  }
}

/**
 * Register `read_pdf` and, when available, the bundled `read-pdf` skill.
 * @param ctx - plugin context; registrations are effects scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 */
// oxlint-disable-next-line typescript/require-await -- async keeps load-time config rejection a rejection
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('dpi', resolved.dpi)
  assertPositiveInteger('workers', resolved.workers)
  assertPositiveInteger('maxOutputChars', resolved.maxOutputChars)
  assertPositiveInteger('graceMs', resolved.graceMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-pdf: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  assertPositiveInteger('stderrMaxBytes', resolved.stderrMaxBytes)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  if (resolved.dpi < 72 || resolved.dpi > 600) {
    throw new Error('tool-pdf: dpi must be between 72 and 600')
  }
  if (resolved.workers > 32) {
    throw new Error('tool-pdf: workers must be at most 32')
  }

  applyReadPdfTool(ctx, {
    ...resolved.python !== undefined ? { python: resolved.python } : {},
    ...resolved.engineRoot !== undefined ? { engineRoot: resolved.engineRoot } : {},
    dpi: resolved.dpi,
    workers: resolved.workers,
    defaultEngine: resolved.defaultEngine,
    maxOutputChars: resolved.maxOutputChars,
    graceMs: resolved.graceMs,
    stderrMaxBytes: resolved.stderrMaxBytes,
    timeoutMs: resolved.timeoutMs,
  })
  applyPdfToolRouting(ctx)
  applyReadPdfSkill(ctx)
}
