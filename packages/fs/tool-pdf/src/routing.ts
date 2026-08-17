/**
 * Route PDF work onto `read_pdf`: deny `read`/`read_image` on `.pdf` paths and
 * bash/pwsh conversions (WPS, pandoc, pdftotext, office GUI launchers).
 * @module @deepseek-ai/dsh-tool-pdf/routing
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

/** Model-facing deny when `read` or `read_image` is aimed at a PDF. */
export const PDF_READ_DENY_REASON = 'The read and read_image tools do not accept PDF files. Call read_pdf (local OCR/layout). It writes Markdown and an editable Word file under .dsh/pdf/; do not launch Word or WPS.'

/** Model-facing deny when a shell conversion or GUI office launch is blocked. */
export const PDF_BYPASS_DENY_REASON = 'Do not convert PDFs with bash, WPS, Word, Preview, open, pandoc, or pdftotext. Call read_pdf; it writes Markdown and an editable Word file under .dsh/pdf/.'

const BYPASS_BINARIES = /^(?:wpsoffice|soffice|libreoffice|pdftotext|pdftohtml|pdf2docx|ocrmypdf)$/i

/**
 * First argv token of a shell statement after stripping leading sudo/env.
 * @param statement - one command in a `&&` / `||` / `;` / `|` list.
 * @returns the token, including a quoted path's inner text.
 */
function firstToken(statement: string): string {
  const trimmed = statement.trim().replace(/^(?:(?:sudo|env)\s+)+/i, '')
  if (trimmed.startsWith('"')) {
    const inner = /^"([^"]*)"/.exec(trimmed)
    if (inner?.[1] !== undefined) return inner[1]
  } else if (trimmed.startsWith("'")) {
    const inner = /^'([^']*)'/.exec(trimmed)
    if (inner?.[1] !== undefined) return inner[1]
  }
  return /^\S+/.exec(trimmed)?.[0] ?? ''
}

/**
 * True when `path` names a PDF (extension only; the converter still validates).
 * @param path - raw `file_path` argument.
 * @returns whether the path ends with `.pdf`.
 */
function isPdfPath(path: string): boolean {
  return path.trim().toLowerCase().endsWith('.pdf')
}

/**
 * True when `command` would convert or preview a PDF via shell rather than a
 * CLI inspect (`which`, `ls`, `file`).
 * @param command - raw bash or pwsh command string.
 * @returns whether {@link applyPdfToolRouting} should deny the call.
 */
export function isPdfBypassShellCommand(command: string): boolean {
  const stripped = command.replace(/\\\n/g, ' ')
  if (/\bopen\s+-a\b/i.test(stripped)) return true
  if (/\bpython(?:3)?\s+-m\s+pdf2docx\b/i.test(stripped)) return true
  if (/\b(?:bash|sh|zsh|ksh)\s+-c\b/i.test(stripped)) {
    if (/\b(?:wpsoffice|soffice|libreoffice|pdftotext|pdftohtml|pdf2docx|ocrmypdf)\b/i.test(stripped)) return true
    if (/\bpandoc\b/i.test(stripped) && /\.pdf\b/i.test(stripped)) return true
  }
  if (/(?:^|[;&|\n]|&&|\|\|)\s*(?:sudo\s+)?open\s+[^\n;|&]*\.(?:pdf|docx?|pptx?|xlsx?)(?:\s|$)/i.test(stripped)) {
    return true
  }
  if (/tell application\s+"(?:WPS Office|Microsoft Word|Preview)"/i.test(stripped)) return true
  for (const statement of stripped.split(/(?:&&|\|\||[;|\n])+/)) {
    const token = firstToken(statement)
    const slash = token.lastIndexOf('/')
    const name = slash === -1 ? token : token.slice(slash + 1)
    if (BYPASS_BINARIES.test(name)) return true
    if (/^pandoc$/i.test(name) && /\.pdf\b/i.test(stripped)) return true
  }
  return false
}

/**
 * Register `tools/pre-execute` routing onto `read_pdf`.
 * @param ctx - plugin context; the listener is a fiber-scoped effect.
 */
export function applyPdfToolRouting(ctx: Context): void {
  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    if (exec.name === 'read' || exec.name === 'read_image') {
      const args = exec.arguments
      if (typeof args !== 'object' || args === null) return next()
      if (!('file_path' in args) || typeof args.file_path !== 'string' || !isPdfPath(args.file_path)) {
        return next()
      }
      return Promise.resolve({ kind: 'deny', reason: PDF_READ_DENY_REASON })
    }
    if (exec.name !== 'bash' && exec.name !== 'pwsh') return next()
    const args = exec.arguments
    if (typeof args !== 'object' || args === null) return next()
    if (!('command' in args) || typeof args.command !== 'string' || !isPdfBypassShellCommand(args.command)) {
      return next()
    }
    return Promise.resolve({ kind: 'deny', reason: PDF_BYPASS_DENY_REASON })
  })
}
