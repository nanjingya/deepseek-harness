/**
 * Resolve the packaged 南鲸 PDF engine root and the Python interpreter used to
 * run it. Defaults keep the tool self-contained for source and published
 * layouts; deployments may override via plugin config.
 * @module @deepseek-ai/dsh-tool-pdf/paths
 */

import { accessSync, constants } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Filename of the packaged converter entry inside {@link resolveEngineRoot}. */
export const ENGINE_ENTRY = 'pdf_wiki_parser.py'

/**
 * Locate an engine directory containing {@link ENGINE_ENTRY} by walking up from
 * `startDir` (source `src/`, tsc `lib/types/`, tsdown `lib/`, or a test root).
 * @param startDir - directory to start walking from.
 * @returns absolute path to the engine directory.
 */
export function resolveEngineRootFrom(startDir: string): string {
  let dir = startDir
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'engine', ENGINE_ENTRY)
    try {
      accessSync(candidate, constants.R_OK)
      return join(dir, 'engine')
    } catch {
      // Keep walking toward the package root.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('tool-pdf: packaged engine/pdf_wiki_parser.py is missing from the package layout')
}

/**
 * Locate the packaged engine directory that contains {@link ENGINE_ENTRY}.
 * @returns absolute path to the engine directory.
 */
export function resolveDefaultEngineRoot(): string {
  return resolveEngineRootFrom(dirname(fileURLToPath(import.meta.url)))
}

/**
 * Resolve a deployment-configured engine root, or the packaged default.
 * @param configured - absolute or relative path from plugin config, when set.
 * @param cwd - directory used to resolve a relative configured path.
 * @returns absolute engine root that contains {@link ENGINE_ENTRY}.
 */
export function resolveEngineRoot(configured: string | undefined, cwd: string): string {
  const root = configured === undefined || configured.trim() === ''
    ? resolveDefaultEngineRoot()
    : isAbsolute(configured) ? configured : resolve(cwd, configured)
  const entry = join(root, ENGINE_ENTRY)
  try {
    accessSync(entry, constants.R_OK)
  } catch (cause) {
    throw new Error(`tool-pdf: engine entry not readable at ${entry}`, { cause })
  }
  return root
}

/**
 * Resolve the Python 3 interpreter. Prefers an explicit config value, then
 * `PDF_WIKI_PYTHON` / `DSH_PDF_PYTHON`, then `python3` on PATH.
 * @param configured - optional absolute or bare interpreter from plugin config.
 * @returns argv[0] for the converter subprocess.
 */
export function resolvePythonExecutable(configured: string | undefined): string {
  const fromConfig = configured?.trim()
  if (fromConfig) return fromConfig
  const fromEnv = process.env.PDF_WIKI_PYTHON?.trim() || process.env.DSH_PDF_PYTHON?.trim()
  if (fromEnv) return fromEnv
  return 'python3'
}
