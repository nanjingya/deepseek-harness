import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, afterEach } from 'vitest'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import {
  listSessionDirectory,
  normalizeSessionRelativePath,
  searchSessionFiles,
  SessionPathDenied,
} from '../src/session-files.ts'

describe('session-files', () => {
  it('rejects path escape in normalizeSessionRelativePath', () => {
    expect(() => normalizeSessionRelativePath('../etc/passwd')).toThrow(SessionPathDenied)
  })

  describe('with local fs', () => {
    let root: string
    let ctx: Context
    let fiber: Awaited<ReturnType<Context['plugin']>>

    afterEach(async () => {
      await fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    })

    it('lists one directory under a session cwd', async () => {
      root = mkdtempSync(join(tmpdir(), 'dsh-session-files-'))
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'index.ts'), 'export {}\n')
      ctx = new Context()
      fiber = await ctx.plugin(LocalFileSystem, { cwd: root })
      const listing = await listSessionDirectory(ctx.fs, root, 'src')
      expect(listing.entries.some(entry => entry.name === 'index.ts' && entry.kind === 'file')).toBe(true)
    })

    it('searches files by query substring', async () => {
      root = mkdtempSync(join(tmpdir(), 'dsh-session-files-search-'))
      mkdirSync(join(root, 'pkg'))
      writeFileSync(join(root, 'pkg', 'widget.ts'), '')
      ctx = new Context()
      fiber = await ctx.plugin(LocalFileSystem, { cwd: root })
      const { matches } = await searchSessionFiles(ctx.fs, root, 'widget')
      expect(matches).toHaveLength(1)
      expect(matches[0]?.relativePath).toBe('pkg/widget.ts')
    })
  })
})
