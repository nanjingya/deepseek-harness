/**
 * Unit coverage for path helpers, argument parsing, truncation, registration,
 * and conversion outcomes over a scriptable FakeSubprocess — no real OCR.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as ToolPdf from '../src/index.ts'
import {
  PdfError,
  defaultOutputDir,
  parseReadPdfArgs,
  recoverPdfByPrefix,
  resolveExistingPdf,
  runPdfConversion,
  toWorkdirRelative,
  truncateMarkdown,
} from '../src/run.ts'
import { resolveDefaultEngineRoot, resolveEngineRoot, resolveEngineRootFrom, resolvePythonExecutable } from '../src/paths.ts'
import {
  READ_PDF_PROMPT_TEXT,
  formatReadPdfOutput,
  presentReadPdfCall,
  presentReadPdfResult,
} from '../src/read-pdf.ts'
import { PDF_BYPASS_DENY_REASON, PDF_READ_DENY_REASON, isPdfBypassShellCommand } from '../src/routing.ts'

const testToolSignal = new AbortController().signal

interface ScriptedStream {
  text: string
}

interface ScriptedRun {
  outcome: SubprocessOutcome
  stdout: ScriptedStream
  stderr: ScriptedStream
}

function runResult(
  overrides?: Partial<SubprocessOutcome> & { stdout?: string; stderr?: string },
): ScriptedRun {
  const { stdout, stderr, ...outcome } = overrides ?? {}
  return {
    outcome: { exitCode: 0, signal: null, ...outcome },
    stdout: { text: stdout ?? '' },
    stderr: { text: stderr ?? '' },
  }
}

class FakeReader implements SubprocessOutputReader {
  constructor(private readonly read: ScriptedStream) {}

  readFrom(_fromByte: number): SubprocessOutputRead {
    return { text: this.read.text, nextOffset: 0, lossy: false }
  }
}

class FakeHandle implements SubprocessHandle {
  readonly pid = 4242
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>

  constructor(
    _spec: SubprocessSpawnSpec,
    script: () => ScriptedRun | { reject: Error },
    abortOnSettle?: AbortController,
  ) {
    const scripted = script()
    if ('reject' in scripted) {
      this.collected = {}
      this.done = Promise.reject(scripted.reject)
    } else {
      this.collected = {
        stdout: new FakeReader(scripted.stdout),
        stderr: new FakeReader(scripted.stderr),
      }
      this.done = abortOnSettle === undefined
        ? Promise.resolve(scripted.outcome)
        : Promise.resolve().then(() => {
          abortOnSettle.abort()
          return scripted.outcome
        })
    }
  }

  terminate(): void {}
  waitForExit(_signal?: AbortSignal): Promise<boolean> {
    return Promise.resolve(true)
  }
}

class FakeSubprocess extends SubprocessRuntime {
  spawns: SubprocessSpawnSpec[] = []
  handler: (spec: SubprocessSpawnSpec) => ScriptedRun | { reject: Error } = () => runResult()
  throwOnSpawn?: Error
  abortOnSettle?: AbortController

  override async resolveExecutable(command: string): Promise<string> {
    return command
  }

  override spawnTerminal(): Promise<never> {
    throw new Error('tool-pdf spawns pipes, never terminals')
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.throwOnSpawn !== undefined) throw this.throwOnSpawn
    this.spawns.push(spec)
    return new FakeHandle(spec, () => this.handler(spec), this.abortOnSettle)
  }
}

const caps = {
  dpi: 200,
  workers: 4,
  defaultEngine: 'auto' as const,
  maxOutputChars: 100,
  graceMs: 5000,
  stderrMaxBytes: 65536,
  timeoutMs: 600_000,
}

async function setup(options: {
  config?: ToolPdf.Config
  skills?: boolean
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeSubprocess)
  if (options.skills === true) await ctx.plugin(SkillRegistry)
  const fiber = await ctx.plugin(ToolPdf, options.config)
  return { ctx, subprocess: ctx.subprocess as FakeSubprocess, fiber }
}

function agent(cwd: string) {
  return { session: { header: { id: 'session-1', cwd } } }
}

let callCounter = 0
function call(ctx: Context, args: unknown, cwd: string, signal = testToolSignal) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`pdf-${++callCounter}`),
    name: 'read_pdf',
    arguments: args,
    agent: agent(cwd) as never,
  })
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function registerPathTool(ctx: Context, name: string, onRun: () => void): void {
  ctx.tools.register(defineTool({
    name,
    description: name,
    parameters: {
      file_path: { type: 'string', required: true },
    },
    async execute() {
      onRun()
      return { ok: true }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'ok' }],
    },
  }))
}

function registerCommandTool(ctx: Context, name: string, onRun: () => void): void {
  ctx.tools.register(defineTool({
    name,
    description: name,
    parameters: {
      command: { type: 'string', required: true },
      description: { type: 'string', required: true },
    },
    async execute() {
      onRun()
      return { ok: true }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'ok' }],
    },
  }))
}

describe('tool-pdf helpers', () => {
  it('resolves the packaged engine root containing pdf_wiki_parser.py', () => {
    const root = resolveDefaultEngineRoot()
    expect(root).toContain('engine')
    expect(resolveEngineRoot(undefined, process.cwd())).toBe(root)
    expect(resolveEngineRoot('  ', process.cwd())).toBe(root)
  })

  it('resolves a configured engine root and rejects a missing entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pdf-engine-'))
    try {
      await writeFile(join(dir, 'pdf_wiki_parser.py'), '# stub\n')
      expect(resolveEngineRoot(dir, process.cwd())).toBe(dir)
      expect(resolveEngineRoot('.', dir)).toBe(dir)
      expect(() => resolveEngineRoot(join(dir, 'missing'), process.cwd())).toThrow(/engine entry not readable/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('prefers config then env for the Python interpreter', () => {
    expect(resolvePythonExecutable('/opt/bin/python3')).toBe('/opt/bin/python3')
    const previousWiki = process.env.PDF_WIKI_PYTHON
    const previousDsh = process.env.DSH_PDF_PYTHON
    delete process.env.PDF_WIKI_PYTHON
    process.env.DSH_PDF_PYTHON = '/env/python'
    try {
      expect(resolvePythonExecutable(undefined)).toBe('/env/python')
      process.env.PDF_WIKI_PYTHON = '/wiki/python'
      expect(resolvePythonExecutable(undefined)).toBe('/wiki/python')
      delete process.env.PDF_WIKI_PYTHON
      delete process.env.DSH_PDF_PYTHON
      expect(resolvePythonExecutable(undefined)).toBe('python3')
    } finally {
      if (previousWiki === undefined) delete process.env.PDF_WIKI_PYTHON
      else process.env.PDF_WIKI_PYTHON = previousWiki
      if (previousDsh === undefined) delete process.env.DSH_PDF_PYTHON
      else process.env.DSH_PDF_PYTHON = previousDsh
    }
  })

  it('parses paths against the workdir and rejects invalid inputs', () => {
    const workdir = '/work'
    expect(parseReadPdfArgs({ file_path: 'docs/a.pdf' }, workdir, caps)).toEqual({
      pdfPath: join(workdir, 'docs/a.pdf'),
      dpi: 200,
      engine: 'auto',
      workers: 4,
    })
    expect(parseReadPdfArgs({
      file_path: '/abs/a.pdf',
      output_dir: 'out',
      dpi: 150,
      engine: 'tesseract',
      workers: 2,
    }, workdir, caps)).toEqual({
      pdfPath: '/abs/a.pdf',
      outputDir: join(workdir, 'out'),
      dpi: 150,
      engine: 'tesseract',
      workers: 2,
    })
    expect(parseReadPdfArgs({
      file_path: '/abs/a.pdf',
      output_dir: '/abs/out',
      dpi: 150,
      engine: 'tesseract',
      workers: 2,
    }, workdir, caps)).toEqual({
      pdfPath: '/abs/a.pdf',
      outputDir: '/abs/out',
      dpi: 150,
      engine: 'tesseract',
      workers: 2,
    })
    expect(() => parseReadPdfArgs({ file_path: 'a.pdf', workers: 99 }, workdir, caps)).toThrow(/workers/)
    expect(() => parseReadPdfArgs({ file_path: '  ' }, workdir, caps)).toThrow(PdfError)
    expect(() => parseReadPdfArgs({ file_path: 'a.pdf', output_dir: ' ' }, workdir, caps)).toThrow(/output_dir/)
    expect(() => parseReadPdfArgs({ file_path: 'notes.md' }, workdir, caps)).toThrow(/\.pdf/)
    expect(() => parseReadPdfArgs({ file_path: 'a.pdf', dpi: 10 }, workdir, caps)).toThrow(/dpi/)
    expect(() => parseReadPdfArgs({ file_path: 'a.pdf', workers: 0 }, workdir, caps)).toThrow(/workers/)
  })

  it('truncates markdown and maps workdir-relative paths', () => {
    expect(truncateMarkdown('short', 100)).toEqual({ markdown: 'short', truncated: false })
    const long = 'x'.repeat(120)
    const clipped = truncateMarkdown(long, 100)
    expect(clipped.truncated).toBe(true)
    expect(clipped.markdown.startsWith('x'.repeat(100))).toBe(true)
    expect(toWorkdirRelative(join('/work', 'a', 'b.md'), '/work')).toBe('a/b.md')
    expect(toWorkdirRelative('/work', '/work')).toBe('/work')
    expect(toWorkdirRelative('/other/a.md', '/work')).toBe('/other/a.md')
    expect(() => resolveEngineRootFrom('/')).toThrow(/missing from the package layout/)
  })

  it('builds a stable cache directory under .dsh/pdf', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pdf-cache-'))
    try {
      const pdf = join(dir, 'sample.pdf')
      await writeFile(pdf, '%PDF-1.4')
      const out = await defaultOutputDir(dir, pdf)
      expect(out.startsWith(join(dir, '.dsh', 'pdf'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('formats native output and presentation cards', () => {
    const text = formatReadPdfOutput({}, {
      markdownPath: '.dsh/pdf/abc/document.md',
      docxPath: '.dsh/pdf/abc/document.docx',
      outputDir: '.dsh/pdf/abc',
      sourcePdf: '/work/a.pdf',
      engine: 'vision',
      pages: 3,
      truncated: true,
      markdown: '# Title',
    })
    expect(text[0]?.text).toContain('<path>.dsh/pdf/abc/document.md</path>')
    expect(text[0]?.text).toContain('<docx>.dsh/pdf/abc/document.docx</docx>')
    expect(text[0]?.text).toContain('# Title')
    expect(formatReadPdfOutput({}, {
      markdownPath: 'document.md',
      docxPath: 'document.docx',
      outputDir: 'out',
      sourcePdf: '/a.pdf',
      engine: 'auto',
      truncated: false,
      markdown: 'body',
    })[0]?.text).not.toContain('<pages>')
    expect(presentReadPdfCall({ file_path: 'a.pdf' })?.locations?.[0]?.path).toBe('a.pdf')
    expect(presentReadPdfCall({})).toBeUndefined()
    expect(presentReadPdfResult({ file_path: 'a.pdf' }, { content: [], isError: false })?.title)
      .toContain('read_pdf: a.pdf')
    expect(presentReadPdfResult({}, { content: [], isError: true })?.title)
      .toContain('read_pdf failed')
  })
})

describe('tool-pdf plugin registration', () => {
  it('registers read_pdf and prompt guidance without spawning', async () => {
    const { ctx, subprocess, fiber } = await setup()
    expect(subprocess.spawns).toHaveLength(0)
    expect(ctx.tools.get('read_pdf')).toBeDefined()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(READ_PDF_PROMPT_TEXT)
    await fiber.dispose()
    expect(ctx.tools.get('read_pdf')).toBeUndefined()
  })

  it('registers the bundled skill only when ctx.skills is mounted', async () => {
    const without = await setup()
    expect(without.ctx.get('skills')).toBeUndefined()
    await without.fiber.dispose()

    const withSkills = await setup({ skills: true })
    const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))
    expect(await withSkills.ctx.skills.list()).toEqual([expect.objectContaining({
      name: 'read-pdf',
      provider: 'read-pdf',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: resourcePath },
    })])
    const loaded = await withSkills.ctx.skills.get('read-pdf')
    expect(loaded?.content).toContain('read_pdf')
    expect(loaded?.content).toContain('WPS')
    expect(loaded?.content).toContain('document.docx')
    await withSkills.fiber.dispose()
  })

  it('stays pending until ctx.subprocess exists', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolPdf)
    expect(ctx.tools.schemas()).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('rejects invalid config at load', async () => {
    await expect(setup({ config: { dpi: 0 } })).rejects.toThrow(/dpi/)
    await expect(setup({ config: { workers: 33 } })).rejects.toThrow(/workers/)
    await expect(setup({ config: { graceMs: MAX_TIMER_DELAY_MS + 1 } })).rejects.toThrow(/graceMs/)
    await expect(setup({ config: { dpi: 50 } })).rejects.toThrow(/between 72 and 600/)
    await expect(setup({ config: { stderrMaxBytes: 0 } })).rejects.toThrow(/stderrMaxBytes/)
    await expect(setup({ config: { timeoutMs: 0 } })).rejects.toThrow(/timeoutMs/)
    await expect(setup({ config: { graceMs: 0 } })).rejects.toThrow(/graceMs/)
  })

  it('routes PDF work onto read_pdf and still allows inspect commands', async () => {
    expect(isPdfBypassShellCommand('wpsoffice --help')).toBe(true)
    expect(isPdfBypassShellCommand('/usr/local/bin/wpsoffice -convert')).toBe(true)
    expect(isPdfBypassShellCommand('"/Applications/WPS Office.app/Contents/MacOS/wpsoffice" --help')).toBe(true)
    expect(isPdfBypassShellCommand("'/Applications/WPS Office.app/Contents/MacOS/wpsoffice' --help")).toBe(true)
    expect(isPdfBypassShellCommand('sudo env wpsoffice --help')).toBe(true)
    expect(isPdfBypassShellCommand('wpsoffice \\\n --help')).toBe(true)
    expect(isPdfBypassShellCommand("bash -c 'wpsoffice --help'")).toBe(true)
    expect(isPdfBypassShellCommand("bash -c 'echo hi'")).toBe(false)
    expect(isPdfBypassShellCommand('true && wpsoffice --help')).toBe(true)
    expect(isPdfBypassShellCommand('sudo open notes.pptx')).toBe(true)
    expect(isPdfBypassShellCommand('open -a Preview a.pdf')).toBe(true)
    expect(isPdfBypassShellCommand('open ./GMT-0034.pdf')).toBe(true)
    expect(isPdfBypassShellCommand('open notes.docx')).toBe(true)
    expect(isPdfBypassShellCommand('osascript -e \'tell application "WPS Office" to activate\'')).toBe(true)
    expect(isPdfBypassShellCommand('osascript -e \'tell application "Microsoft Word" to activate\'')).toBe(true)
    expect(isPdfBypassShellCommand('osascript -e \'tell application "Preview" to activate\'')).toBe(true)
    expect(isPdfBypassShellCommand('which wpsoffice')).toBe(false)
    expect(isPdfBypassShellCommand('ls "/Applications/WPS Office.app"')).toBe(false)
    expect(isPdfBypassShellCommand('file "$(which wpsoffice)"')).toBe(false)
    expect(isPdfBypassShellCommand('echo hello')).toBe(false)
    expect(isPdfBypassShellCommand('"unterminated')).toBe(false)
    expect(isPdfBypassShellCommand("'unterminated")).toBe(false)
    expect(isPdfBypassShellCommand(' ; echo hello')).toBe(false)
    expect(isPdfBypassShellCommand('pdftotext a.pdf -')).toBe(true)
    expect(isPdfBypassShellCommand('soffice --headless --convert-to docx a.pdf')).toBe(true)
    expect(isPdfBypassShellCommand('pandoc a.pdf -o a.docx')).toBe(true)
    expect(isPdfBypassShellCommand('pandoc notes.md -o notes.docx')).toBe(false)
    expect(isPdfBypassShellCommand('python3 -m pdf2docx convert a.pdf a.docx')).toBe(true)
    expect(isPdfBypassShellCommand('python -m pdf2docx convert a.pdf a.docx')).toBe(true)
    expect(isPdfBypassShellCommand("bash -c 'pdftotext a.pdf -'")).toBe(true)
    expect(isPdfBypassShellCommand("bash -c 'pandoc a.pdf -o a.docx'")).toBe(true)
    expect(isPdfBypassShellCommand("bash -c 'pandoc notes.md -o out.docx'")).toBe(false)
    expect(isPdfBypassShellCommand('pdf2docx a.pdf a.docx')).toBe(true)
    expect(isPdfBypassShellCommand('libreoffice --headless a.pdf')).toBe(true)
    expect(isPdfBypassShellCommand('which pdftotext')).toBe(false)

    const { ctx, fiber } = await setup()
    let ran = false
    registerCommandTool(ctx, 'bash', () => {
      ran = true
    })
    const denied = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('bash-gui'),
      name: 'bash',
      arguments: { command: 'wpsoffice --help', description: 'Check wpsoffice help' },
    })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain(PDF_BYPASS_DENY_REASON)
    expect(ran).toBe(false)

    const allowed = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('bash-ls'),
      name: 'bash',
      arguments: { command: 'ls', description: 'List files' },
    })
    expect(allowed.isError).toBe(false)
    expect(ran).toBe(true)

    ran = false
    const untyped = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('bash-untyped'),
      name: 'bash',
      arguments: { command: 1, description: 'not a string' },
    })
    expect(untyped.isError).toBe(true)
    expect(textOf(untyped)).not.toContain(PDF_BYPASS_DENY_REASON)
    expect(ran).toBe(false)

    const nonObject = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('bash-string-args'),
      name: 'bash',
      arguments: 'wpsoffice --help',
    })
    expect(textOf(nonObject)).not.toContain(PDF_BYPASS_DENY_REASON)

    const nullArgs = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('bash-null-args'),
      name: 'bash',
      arguments: null,
    })
    expect(textOf(nullArgs)).not.toContain(PDF_BYPASS_DENY_REASON)

    const missingCommand = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('bash-missing-command'),
      name: 'bash',
      arguments: { description: 'no command field' },
    })
    expect(textOf(missingCommand)).not.toContain(PDF_BYPASS_DENY_REASON)

    ran = false
    registerPathTool(ctx, 'read', () => {
      ran = true
    })
    const readPdf = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('read-pdf'),
      name: 'read',
      arguments: { file_path: 'GMT-0034.PDF' },
    })
    expect(readPdf.isError).toBe(true)
    expect(textOf(readPdf)).toContain(PDF_READ_DENY_REASON)
    expect(ran).toBe(false)

    const readText = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('read-md'),
      name: 'read',
      arguments: { file_path: 'notes.md' },
    })
    expect(readText.isError).toBe(false)
    expect(ran).toBe(true)

    const readImagePdf = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('read-image-pdf'),
      name: 'read_image',
      arguments: { file_path: 'scan.pdf' },
    })
    expect(textOf(readImagePdf)).toContain(PDF_READ_DENY_REASON)

    const readMissingPath = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('read-missing-path'),
      name: 'read',
      arguments: {},
    })
    expect(textOf(readMissingPath)).not.toContain(PDF_READ_DENY_REASON)

    const readNonStringPath = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('read-non-string-path'),
      name: 'read',
      arguments: { file_path: 1 },
    })
    expect(textOf(readNonStringPath)).not.toContain(PDF_READ_DENY_REASON)

    const readNullArgs = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('read-null-args'),
      name: 'read',
      arguments: null,
    })
    expect(textOf(readNullArgs)).not.toContain(PDF_READ_DENY_REASON)

    const readImagePng = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('read-image-png'),
      name: 'read_image',
      arguments: { file_path: 'shot.png' },
    })
    expect(textOf(readImagePng)).not.toContain(PDF_READ_DENY_REASON)

    ran = false
    registerCommandTool(ctx, 'pwsh', () => {
      ran = true
    })
    const pwshDenied = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('pwsh-gui'),
      name: 'pwsh',
      arguments: { command: 'wpsoffice --help', description: 'Check wpsoffice help' },
    })
    expect(pwshDenied.isError).toBe(true)
    expect(ran).toBe(false)
    await fiber.dispose()
  })
})

describe('tool-pdf conversion', () => {
  let dir: string

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  })

  async function preparePdf(): Promise<{ pdf: string; out: string }> {
    dir = await mkdtemp(join(tmpdir(), 'dsh-pdf-run-'))
    const pdf = join(dir, 'sample.pdf')
    await writeFile(pdf, '%PDF-1.4 stub')
    const out = join(dir, 'out')
    await mkdir(out, { recursive: true })
    return { pdf, out }
  }

  async function seedConverterOutput(out: string, markdown: string): Promise<void> {
    await writeFile(join(out, 'document.md'), markdown)
    await writeFile(join(out, 'document.docx'), 'stub')
  }

  it('returns markdown and metadata on a successful conversion', async () => {
    const { pdf, out } = await preparePdf()
    await seedConverterOutput(out, '# Hello\n\nbody')
    await writeFile(join(out, 'quality-report.json'), JSON.stringify({ pages: 2, ocr_engine: 'vision' }))
    const { ctx, subprocess } = await setup({ config: { maxOutputChars: 10_000 } })
    subprocess.handler = () => runResult()
    const result = await call(ctx, {
      file_path: pdf,
      output_dir: out,
      engine: 'vision',
      dpi: 150,
      workers: 2,
    }, dir)
    expect(result.isError).toBe(false)
    const text = textOf(result)
    expect(text).toContain('# Hello')
    expect(text).toContain('<docx>')
    expect(text).toContain('<engine>vision</engine>')
    expect(text).toContain('<pages>2</pages>')
    expect(subprocess.spawns[0]?.argv).toEqual(expect.arrayContaining([
      'python3',
      expect.stringContaining('pdf_wiki_parser.py'),
      pdf,
      '--output', out,
      '--dpi', '150',
      '--workers', '2',
      '--engine', 'vision',
    ]))
    await ctx.fiber.dispose()
  })

  it('prefers document.json engine and truncates long markdown', async () => {
    const { pdf, out } = await preparePdf()
    await seedConverterOutput(out, 'y'.repeat(200))
    await writeFile(join(out, 'document.json'), JSON.stringify({ engine: 'paddleocr' }))
    const { ctx, subprocess } = await setup({ config: { maxOutputChars: 50 } })
    subprocess.handler = () => runResult()
    const result = await call(ctx, { file_path: pdf, output_dir: out }, dir)
    expect(result.isError).toBe(false)
    const text = textOf(result)
    expect(text).toContain('<engine>paddleocr</engine>')
    expect(text).toContain('<truncated>true</truncated>')
    expect(text).toContain('…[truncated:')
    await ctx.fiber.dispose()
  })

  it('recovers a unique truncated basename and rejects an ambiguous prefix', async () => {
    const { out } = await preparePdf()
    const full = join(dir, 'GMT 0034-2014 基于SM2规范.pdf')
    await writeFile(full, '%PDF-1.4 stub')
    await seedConverterOutput(out, 'recovered')
    const recovered = await setup()
    recovered.subprocess.handler = () => runResult()
    const result = await call(recovered.ctx, {
      file_path: join(dir, 'GMT 0034-2014.pdf'),
      output_dir: out,
    }, dir)
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('recovered')
    expect(textOf(result)).toContain(full)
    expect(recovered.subprocess.spawns[0]?.argv).toContain(full)
    await recovered.fiber.dispose()

    await writeFile(join(dir, 'GMT 0034-2014 other.pdf'), '%PDF-1.4 stub')
    const ambiguous = await setup()
    expect(textOf(await call(ambiguous.ctx, { file_path: join(dir, 'GMT 0034-2014.pdf') }, dir)))
      .toMatch(/PDF_NOT_FOUND|not found/i)
    await ambiguous.fiber.dispose()

    expect(await recoverPdfByPrefix(join(dir, 'x.pdf'))).toBeUndefined()
    expect(await recoverPdfByPrefix(join(dir, 'no-such-parent', 'GMT 0034-2014.pdf'))).toBeUndefined()
    await symlink(join(dir, 'missing-target.pdf'), join(dir, 'GMT 0034-only-link.pdf'))
    await expect(resolveExistingPdf(join(dir, 'GMT 0034-only-link.pdf'))).rejects.toThrow(/not found/i)
    await mkdir(join(dir, 'GMT 0034-prefix extra.pdf'))
    await expect(resolveExistingPdf(join(dir, 'GMT 0034-prefix.pdf'))).rejects.toThrow(/not found/i)
  })

  it('succeeds when optional report files are absent', async () => {
    const { pdf, out } = await preparePdf()
    await seedConverterOutput(out, 'only md')
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult()
    const result = await call(ctx, { file_path: pdf, output_dir: out }, dir)
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('only md')
    await ctx.fiber.dispose()
  })

  it('classifies missing PDF, non-file path, abort, spawn, and converter failures', async () => {
    const { pdf, out } = await preparePdf()
    const asDir = join(dir, 'dir.pdf')
    await mkdir(asDir)

    const missing = await setup()
    expect((await call(missing.ctx, { file_path: join(dir, 'nope.pdf') }, dir)).isError).toBe(true)
    expect(textOf(await call(missing.ctx, { file_path: join(dir, 'nope.pdf') }, dir))).toMatch(/PDF_NOT_FOUND|not found/i)
    await missing.fiber.dispose()

    const notFile = await setup()
    expect(textOf(await call(notFile.ctx, { file_path: asDir }, dir))).toMatch(/not a regular file|PDF_NOT_FOUND/i)
    await notFile.fiber.dispose()

    const aborted = await setup()
    const controller = new AbortController()
    controller.abort()
    expect(textOf(await call(aborted.ctx, { file_path: pdf, output_dir: out }, dir, controller.signal)))
      .toMatch(/PDF_ABORTED|aborted/i)
    await aborted.fiber.dispose()

    const spawnThrow = await setup()
    spawnThrow.subprocess.throwOnSpawn = new Error('spawn blocked')
    expect(textOf(await call(spawnThrow.ctx, { file_path: pdf, output_dir: out }, dir)))
      .toMatch(/PDF_ENGINE_FAILED|could not start/i)
    await spawnThrow.fiber.dispose()

    const spawnAbort = await setup()
    const abortDuringSpawn = new AbortController()
    spawnAbort.subprocess.spawn = (_spec: SubprocessSpawnSpec): SubprocessHandle => {
      abortDuringSpawn.abort()
      throw new Error('spawn after abort')
    }
    expect(textOf(await call(spawnAbort.ctx, { file_path: pdf, output_dir: out }, dir, abortDuringSpawn.signal)))
      .toMatch(/PDF_ABORTED|aborted/i)
    await spawnAbort.fiber.dispose()

    const doneReject = await setup()
    doneReject.subprocess.handler = () => ({ reject: new Error('execve failed') })
    expect(textOf(await call(doneReject.ctx, { file_path: pdf, output_dir: out }, dir)))
      .toMatch(/PDF_ENGINE_FAILED|failed to start/i)
    await doneReject.fiber.dispose()

    const signaled = await setup()
    signaled.subprocess.handler = () => runResult({ exitCode: null, signal: 'SIGTERM' })
    expect(textOf(await call(signaled.ctx, { file_path: pdf, output_dir: out }, dir)))
      .toMatch(/PDF_ENGINE_FAILED|killed by signal/i)
    await signaled.fiber.dispose()

    const nonzero = await setup()
    nonzero.subprocess.handler = () => runResult({ exitCode: 2, stderr: 'ocr boom' })
    expect(textOf(await call(nonzero.ctx, { file_path: pdf, output_dir: out }, dir)))
      .toMatch(/ocr boom|PDF_ENGINE_FAILED/i)
    await nonzero.fiber.dispose()

    const missingMd = await setup()
    missingMd.subprocess.handler = () => runResult()
    expect(textOf(await call(missingMd.ctx, { file_path: pdf, output_dir: out }, dir)))
      .toMatch(/PDF_OUTPUT_MISSING|document\.md is missing/i)
    await missingMd.fiber.dispose()

    const missingDocx = await setup()
    missingDocx.subprocess.handler = () => runResult()
    await writeFile(join(out, 'document.md'), 'md only')
    expect(textOf(await call(missingDocx.ctx, { file_path: pdf, output_dir: out }, dir)))
      .toMatch(/PDF_OUTPUT_MISSING|document\.docx is missing/i)
    await missingDocx.fiber.dispose()

    const docxIsDir = await setup()
    docxIsDir.subprocess.handler = () => runResult()
    await mkdir(join(out, 'document.docx'))
    expect(textOf(await call(docxIsDir.ctx, { file_path: pdf, output_dir: out }, dir)))
      .toMatch(/PDF_OUTPUT_MISSING|document\.docx is missing/i)
    await docxIsDir.fiber.dispose()

    const emptyStderr = await setup()
    emptyStderr.subprocess.handler = () => runResult({ exitCode: 3, stderr: '  ' })
    expect(textOf(await call(emptyStderr.ctx, { file_path: pdf, output_dir: out }, dir)))
      .toMatch(/exit code 3/i)
    await emptyStderr.fiber.dispose()

    const unknownSignal = await setup()
    unknownSignal.subprocess.handler = () => runResult({ exitCode: null, signal: null })
    expect(textOf(await call(unknownSignal.ctx, { file_path: pdf, output_dir: out }, dir)))
      .toMatch(/\(unknown\)/i)
    await unknownSignal.fiber.dispose()
  })

  it('aborts after the converter process settles', async () => {
    const { pdf, out } = await preparePdf()
    await seedConverterOutput(out, 'late abort')
    const { ctx, subprocess, fiber } = await setup()
    const controller = new AbortController()
    subprocess.abortOnSettle = controller
    subprocess.handler = () => runResult()
    expect(textOf(await call(ctx, { file_path: pdf, output_dir: out }, dir, controller.signal)))
      .toMatch(/PDF_ABORTED|aborted/i)
    await fiber.dispose()
  })

  it('uses plugin python/engineRoot and quality-report engine fallback', async () => {
    const { pdf, out } = await preparePdf()
    await seedConverterOutput(out, 'ok')
    await writeFile(join(out, 'quality-report.json'), JSON.stringify({ engine: 'tesseract', pages: 'nope' }))
    await writeFile(join(dir, 'pdf_wiki_parser.py'), '# stub\n')
    const { ctx, subprocess, fiber } = await setup({
      config: { python: '/opt/python3', engineRoot: dir },
    })
    subprocess.handler = () => runResult()
    const result = await call(ctx, { file_path: pdf, output_dir: out }, dir)
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('<engine>tesseract</engine>')
    expect(subprocess.spawns[0]?.argv[0]).toBe('/opt/python3')
    expect(subprocess.spawns[0]?.cwd).toBe(dir)
    await fiber.dispose()
  })

  it('prefers document.json ocr_engine and default cache output', async () => {
    const { pdf } = await preparePdf()
    const { ctx, subprocess, fiber } = await setup()
    subprocess.spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
      const outputIdx = spec.argv.indexOf('--output')
      const outputDir = spec.argv[outputIdx + 1]
      if (typeof outputDir !== 'string') throw new Error('missing --output')
      writeFileSync(join(outputDir, 'document.md'), 'cached')
      writeFileSync(join(outputDir, 'document.docx'), 'stub')
      writeFileSync(join(outputDir, 'document.json'), JSON.stringify({ ocr_engine: 'vision' }))
      subprocess.spawns.push(spec)
      return new FakeHandle(spec, () => runResult())
    }
    const result = await call(ctx, { file_path: pdf }, dir)
    expect(result.isError).toBe(false)
    const text = textOf(result)
    expect(text).toContain('cached')
    expect(text).toContain('<engine>vision</engine>')
    expect(text).toContain('.dsh/pdf/')
    await fiber.dispose()
  })

  it('falls back to process.cwd when the call has no agent', async () => {
    const { ctx, fiber } = await setup()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId(`pdf-${++callCounter}`),
      name: 'read_pdf',
      arguments: { file_path: join(process.cwd(), 'no-such.pdf') },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/not found|PDF_NOT_FOUND/i)
    await fiber.dispose()
  })

  it('aborts at conversion start and ignores empty engine metadata', async () => {
    const { pdf, out } = await preparePdf()
    await seedConverterOutput(out, 'meta')
    await writeFile(join(out, 'quality-report.json'), JSON.stringify({ pages: 1 }))
    await writeFile(join(out, 'document.json'), JSON.stringify({}))
    const { ctx, subprocess, fiber } = await setup()
    const aborted = new AbortController()
    aborted.abort()
    await expect(runPdfConversion(
      ctx,
      { signal: aborted.signal, agent: agent(dir) } as never,
      { pdfPath: pdf, outputDir: out, dpi: 200, engine: 'auto', workers: 1 },
      { ...caps, maxOutputChars: 10_000 },
    )).rejects.toThrow(/aborted/)

    subprocess.handler = () => runResult()
    const value = await runPdfConversion(
      ctx,
      { signal: testToolSignal } as never,
      { pdfPath: pdf, outputDir: out, dpi: 200, engine: 'auto', workers: 1 },
      { ...caps, maxOutputChars: 10_000 },
    )
    expect(value.engine).toBe('auto')
    expect(value.pages).toBe(1)
    await fiber.dispose()
  })
})
