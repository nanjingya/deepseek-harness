/**
 * Spawn the packaged 南鲸 PDF converter through `ctx.subprocess` and load the
 * resulting Markdown and Word files. No shell layer: every path is a plain argv element.
 * @module @deepseek-ai/dsh-tool-pdf/run
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ENGINE_ENTRY, resolveEngineRoot, resolvePythonExecutable } from './paths.ts'

/** Default cooperative tool-call budget (ms) for one PDF conversion. */
export const PDF_TIMEOUT_MS = 600_000

/** Default terminate-escalation grace (ms) after the cooperative budget. */
export const PDF_GRACE_MS = 5_000

/** Default stderr diagnostic tail retained for failure messages. */
export const PDF_STDERR_MAX_BYTES = 64 * 1024

/** Default cap on Markdown characters returned inline to the model. */
export const PDF_MAX_OUTPUT_CHARS = 120_000

/** Default page-render DPI forwarded to the converter. */
export const PDF_DPI = 200

/** Default OCR worker count forwarded to the converter. */
export const PDF_WORKERS = 4

/** OCR engine choices accepted by the packaged converter. */
export type PdfOcrEngine = 'auto' | 'vision' | 'paddleocr' | 'tesseract'

/** Stable codes for PDF conversion failures. */
export type PdfErrorCode =
  | 'PDF_NOT_FOUND'
  | 'PDF_INVALID_PATH'
  | 'PDF_ENGINE_FAILED'
  | 'PDF_ABORTED'
  | 'PDF_OUTPUT_MISSING'

/** Typed PDF conversion failure with a routable {@link PdfErrorCode}. */
export class PdfError extends HarnessError {
  override readonly code: PdfErrorCode

  /**
   * @param message - human-readable failure text for the model and logs.
   * @param code - stable machine-routable failure code.
   * @param options - optional Error cause chain.
   */
  constructor(message: string, code: PdfErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

/** Validated `read_pdf` arguments after schema and local checks. */
export interface ReadPdfInput {
  /** Absolute path to the source PDF. */
  pdfPath: string
  /** Optional absolute output directory; omitted means a cache dir under the workdir. */
  outputDir?: string
  /** Page-render DPI. */
  dpi: number
  /** OCR engine selection. */
  engine: PdfOcrEngine
  /** Converter worker count. */
  workers: number
}

/** Caps resolved from plugin config. */
export interface PdfToolCaps {
  python?: string
  engineRoot?: string
  dpi: number
  workers: number
  defaultEngine: PdfOcrEngine
  maxOutputChars: number
  graceMs: number
  stderrMaxBytes: number
  timeoutMs: number
}

/** Canonical successful `read_pdf` value. */
export interface ReadPdfValue {
  /** Workdir-relative path to `document.md` when inside the workdir, else absolute. */
  markdownPath: string
  /** Workdir-relative path to `document.docx` when inside the workdir, else absolute. */
  docxPath: string
  /** Workdir-relative conversion output directory when inside the workdir, else absolute. */
  outputDir: string
  /** Absolute source PDF path. */
  sourcePdf: string
  /** OCR engine reported by the converter (or the requested engine). */
  engine: string
  /** Page count when quality-report.json is present. */
  pages?: number
  /** Whether {@link markdown} was truncated to {@link PdfToolCaps.maxOutputChars}. */
  truncated: boolean
  /** Inline Markdown for the model (may be truncated). */
  markdown: string
}

/**
 * Validate value constraints the schema DSL cannot express and resolve paths
 * against the session workdir.
 * @param args - schema-validated tool arguments.
 * @param workdir - session cwd or `process.cwd()`.
 * @param caps - resolved plugin caps (defaults for omitted optional fields).
 * @returns the accepted absolute-path input.
 */
export function parseReadPdfArgs(
  args: {
    file_path: string
    output_dir?: string
    dpi?: number
    engine?: PdfOcrEngine
    workers?: number
  },
  workdir: string,
  caps: PdfToolCaps,
): ReadPdfInput {
  if (args.file_path.trim().length === 0) {
    throw new PdfError('file_path must be a non-empty string', 'PDF_INVALID_PATH')
  }
  if (args.output_dir !== undefined && args.output_dir.trim().length === 0) {
    throw new PdfError('output_dir must be a non-empty string when given', 'PDF_INVALID_PATH')
  }
  const pdfPath = (isAbsolute(args.file_path) ? args.file_path : resolve(workdir, args.file_path)).normalize('NFC')
  if (!pdfPath.toLowerCase().endsWith('.pdf')) {
    throw new PdfError(`file_path must end with .pdf (got "${args.file_path}")`, 'PDF_INVALID_PATH')
  }
  const dpi = args.dpi ?? caps.dpi
  const workers = args.workers ?? caps.workers
  if (!Number.isInteger(dpi) || dpi < 72 || dpi > 600) {
    throw new PdfError('dpi must be an integer between 72 and 600', 'PDF_INVALID_PATH')
  }
  if (!Number.isInteger(workers) || workers < 1 || workers > 32) {
    throw new PdfError('workers must be an integer between 1 and 32', 'PDF_INVALID_PATH')
  }
  return {
    pdfPath,
    ...args.output_dir !== undefined
      ? { outputDir: isAbsolute(args.output_dir) ? args.output_dir : resolve(workdir, args.output_dir) }
      : {},
    dpi,
    engine: args.engine ?? caps.defaultEngine,
    workers,
  }
}

/**
 * When an exact PDF path is missing, recover a unique `.pdf` in the same
 * directory whose name starts with the requested basename (minus `.pdf`).
 * @param pdfPath - NFC-normalized absolute path that failed `stat`.
 * @returns the unique recovered absolute path, or `undefined`.
 */
export async function recoverPdfByPrefix(pdfPath: string): Promise<string | undefined> {
  const prefix = basename(pdfPath).replace(/\.pdf$/i, '').normalize('NFC')
  if (prefix.length < 2) return undefined
  let names: string[]
  try {
    names = await readdir(dirname(pdfPath))
  } catch {
    // Parent directory is unreadable or missing; caller keeps the original miss.
    return undefined
  }
  const matches = names.filter((name) => {
    const normalized = name.normalize('NFC')
    return normalized.toLowerCase().endsWith('.pdf') && normalized.startsWith(prefix)
  })
  const recovered = matches.length === 1 ? matches[0] : undefined
  if (recovered === undefined) return undefined
  return join(dirname(pdfPath), recovered)
}

/**
 * Resolve an existing regular PDF file, recovering a unique same-directory
 * prefix match when the exact path is missing.
 * @param pdfPath - NFC-normalized absolute path from {@link parseReadPdfArgs}.
 * @returns the existing absolute path (possibly recovered).
 */
export async function resolveExistingPdf(pdfPath: string): Promise<string> {
  try {
    const info = await stat(pdfPath)
    if (!info.isFile()) {
      throw new PdfError(`PDF path is not a regular file: ${pdfPath}`, 'PDF_NOT_FOUND')
    }
    return pdfPath
  } catch (cause) {
    if (cause instanceof PdfError) throw cause
    const recovered = await recoverPdfByPrefix(pdfPath)
    if (recovered !== undefined) {
      try {
        const info = await stat(recovered)
        if (info.isFile()) return recovered
      } catch {
        // Recovered path vanished between readdir and stat; fall through.
      }
    }
    throw new PdfError(`PDF not found: ${pdfPath}`, 'PDF_NOT_FOUND', { cause })
  }
}

/**
 * Build a stable cache directory under `<workdir>/.dsh/pdf/<hash>/` for one PDF.
 * @param workdir - session workspace root.
 * @param pdfPath - absolute PDF path.
 * @returns absolute output directory path.
 */
export async function defaultOutputDir(workdir: string, pdfPath: string): Promise<string> {
  const info = await stat(pdfPath)
  const key = createHash('sha256')
    .update(pdfPath)
    .update('\0')
    .update(String(info.mtimeMs))
    .update('\0')
    .update(String(info.size))
    .digest('hex')
    .slice(0, 24)
  return join(workdir, '.dsh', 'pdf', key)
}

/**
 * Map an absolute path to its model-facing display form relative to workdir.
 * @param absolute - absolute filesystem path.
 * @param workdir - session workspace root.
 * @returns workdir-relative path using `/`, or the absolute path when outside.
 */
export function toWorkdirRelative(absolute: string, workdir: string): string {
  const rel = relative(workdir, absolute)
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return absolute
  return rel.split(sep).join('/')
}

/**
 * Truncate Markdown to a character budget on a UTF-16 code-unit boundary and
 * append a marker when truncated.
 * @param text - full Markdown.
 * @param maxChars - inclusive character budget for the returned body before the marker.
 * @returns truncated text and whether truncation occurred.
 */
export function truncateMarkdown(text: string, maxChars: number): { markdown: string; truncated: boolean } {
  if (text.length <= maxChars) return { markdown: text, truncated: false }
  return {
    markdown: `${text.slice(0, maxChars)}\n\n…[truncated: full Markdown at markdownPath]`,
    truncated: true,
  }
}

/**
 * Run the packaged converter and return the canonical tool value.
 * @param ctx - plugin context providing `subprocess`.
 * @param exec - tool execution context (cwd + abort signal).
 * @param input - validated absolute-path arguments.
 * @param caps - resolved plugin caps.
 * @returns the canonical {@link ReadPdfValue}.
 */
export async function runPdfConversion(
  ctx: Context,
  exec: ToolExecution,
  input: ReadPdfInput,
  caps: PdfToolCaps,
): Promise<ReadPdfValue> {
  if (exec.signal.aborted) {
    throw new PdfError('read_pdf was aborted before completion (tool timeout or caller cancellation)', 'PDF_ABORTED')
  }
  const workdir = exec.agent?.session.header.cwd ?? process.cwd()
  const pdfPath = await resolveExistingPdf(input.pdfPath)

  const outputDir = input.outputDir ?? await defaultOutputDir(workdir, pdfPath)
  await mkdir(outputDir, { recursive: true })
  const engineRoot = resolveEngineRoot(caps.engineRoot, workdir)
  const python = resolvePythonExecutable(caps.python)
  const entry = join(engineRoot, ENGINE_ENTRY)
  const argv = [
    python,
    entry,
    pdfPath,
    '--output', outputDir,
    '--dpi', String(input.dpi),
    '--workers', String(input.workers),
    '--engine', input.engine,
  ]

  let handle: SubprocessHandle
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd: engineRoot,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 256 * 1024 },
        stderr: { maxBytes: caps.stderrMaxBytes },
      },
      graceMs: caps.graceMs,
      signal: exec.signal,
    } satisfies SubprocessSpawnSpec)
  } catch (error: unknown) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- AbortSignal can change during spawn
    if (exec.signal.aborted) {
      throw new PdfError('read_pdf was aborted before completion (tool timeout or caller cancellation)', 'PDF_ABORTED')
    }
    throw new PdfError('read_pdf could not start the PDF converter', 'PDF_ENGINE_FAILED', { cause: error })
  }

  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    throw new PdfError('read_pdf converter failed to start', 'PDF_ENGINE_FAILED', { cause: error })
  }

  // oxlint-disable-next-line typescript/no-unnecessary-condition -- AbortSignal can change while awaiting
  if (exec.signal.aborted) {
    throw new PdfError('read_pdf was aborted before completion (tool timeout or caller cancellation)', 'PDF_ABORTED')
  }
  if (outcome.signal !== null || outcome.exitCode === null) {
    throw new PdfError(
      `read_pdf converter was killed by signal ${outcome.signal ?? '(unknown)'}`,
      'PDF_ENGINE_FAILED',
    )
  }
  if (outcome.exitCode !== 0) {
    const stderr = handle.collected.stderr?.readFrom(0)
    const detail = stderr?.text.trim() || `exit code ${outcome.exitCode}`
    throw new PdfError(`read_pdf converter failed: ${detail}`, 'PDF_ENGINE_FAILED')
  }

  const markdownFile = join(outputDir, 'document.md')
  const docxFile = join(outputDir, 'document.docx')
  let markdown: string
  try {
    markdown = await readFile(markdownFile, 'utf8')
  } catch (cause) {
    throw new PdfError(`read_pdf converter finished but document.md is missing at ${markdownFile}`, 'PDF_OUTPUT_MISSING', { cause })
  }
  try {
    const info = await stat(docxFile)
    if (!info.isFile()) {
      throw new PdfError(`read_pdf converter finished but document.docx is missing at ${docxFile}`, 'PDF_OUTPUT_MISSING')
    }
  } catch (cause) {
    if (cause instanceof PdfError) throw cause
    throw new PdfError(`read_pdf converter finished but document.docx is missing at ${docxFile}`, 'PDF_OUTPUT_MISSING', { cause })
  }

  let pages: number | undefined
  let engine: string = input.engine
  try {
    const report = JSON.parse(await readFile(join(outputDir, 'quality-report.json'), 'utf8')) as {
      pages?: number
      ocr_engine?: string
      engine?: string
    }
    if (typeof report.pages === 'number') pages = report.pages
    if (typeof report.ocr_engine === 'string') engine = report.ocr_engine
    else if (typeof report.engine === 'string') engine = report.engine
  } catch {
    // Missing or invalid quality-report.json; Markdown alone is enough.
  }

  // Prefer engine name embedded in document.json when present.
  try {
    const doc = JSON.parse(await readFile(join(outputDir, 'document.json'), 'utf8')) as {
      ocr_engine?: string
      engine?: string
    }
    if (typeof doc.ocr_engine === 'string') engine = doc.ocr_engine
    else if (typeof doc.engine === 'string') engine = doc.engine
  } catch {
    // Missing or invalid document.json; quality-report or the requested engine remain.
  }

  const clipped = truncateMarkdown(markdown, caps.maxOutputChars)
  return {
    markdownPath: toWorkdirRelative(markdownFile, workdir),
    docxPath: toWorkdirRelative(docxFile, workdir),
    outputDir: toWorkdirRelative(outputDir, workdir),
    sourcePdf: pdfPath,
    engine,
    ...pages !== undefined ? { pages } : {},
    truncated: clipped.truncated,
    markdown: clipped.markdown,
  }
}
