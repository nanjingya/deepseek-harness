/**
 * Session-scoped workspace file listing and search for the host RPC surface.
 * Containment uses {@link FileSystem.contains}; names only cross the wire.
 */

import { join } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'

/** One file or directory row under a session project root. */
export interface SessionFileEntry {
  /** Basename for display. */
  name: string
  /** POSIX-style path relative to the session cwd (used by `@` picks). */
  relativePath: string
  /** Absolute host path for {@link HostApi.openPath}. */
  path: string
  /** Entry kind. */
  kind: 'file' | 'directory'
  /** Dot-prefixed basename on POSIX. */
  hidden: boolean
}

/** One directory level under a session cwd. */
export interface SessionDirectoryListing {
  /** Listed directory relative to the session cwd (`''` is the project root). */
  relativePath: string
  /** Direct children, name-sorted, with heavy directories skipped. */
  entries: SessionFileEntry[]
}

/** Thrown when a requested relative path escapes the session project root. */
export class SessionPathDenied extends Error {
  /** @param path - the rejected relative or absolute path fragment. */
  constructor(public readonly path: string) {
    super(`path "${path}" escapes the session workspace`)
    this.name = 'SessionPathDenied'
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh'])
const MAX_SEARCH_FILES = 400
const MAX_SEARCH_DEPTH = 8

function isHidden(name: string): boolean {
  return name.startsWith('.')
}

/**
 * Normalize one caller-relative path segment chain.
 * @param relativePath - optional path under the session cwd.
 * @returns normalized POSIX-style relative path (`''` for root).
 */
export function normalizeSessionRelativePath(relativePath: string | undefined): string {
  if (relativePath === undefined || relativePath === '' || relativePath === '.') return ''
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized === '..' || normalized.includes('/../') || normalized.endsWith('/..') || normalized.startsWith('../')) {
    throw new SessionPathDenied(relativePath)
  }
  return normalized
}

function toPosixRelative(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`
}

function entryFromDirChild(
  parentAbs: string,
  relativeParent: string,
  entry: FsDirEntry,
): SessionFileEntry | undefined {
  if (entry.type !== 'file' && entry.type !== 'directory') return undefined
  const relativePath = toPosixRelative(relativeParent, entry.name)
  return {
    name: entry.name,
    relativePath,
    path: join(parentAbs, entry.name),
    kind: entry.type,
    hidden: isHidden(entry.name),
  }
}

/**
 * Resolve one directory target and refuse paths outside the session root.
 * @param fs - composed filesystem service.
 * @param sessionCwd - absolute session project directory.
 * @param relativePath - optional path under the session cwd.
 * @param signal - aborts resolution and listing.
 * @returns resolved directory target contained by the session root.
 */
async function resolveSessionDirectory(
  fs: FileSystem,
  sessionCwd: string,
  relativePath: string | undefined,
  signal?: AbortSignal,
): Promise<{ root: FsTarget; dir: FsTarget; relativePath: string; absDir: string }> {
  const rel = normalizeSessionRelativePath(relativePath)
  const root = await fs.resolve(sessionCwd, signal === undefined ? {} : { signal })
  const absDir = rel === '' ? sessionCwd : join(sessionCwd, ...rel.split('/'))
  const dir = await fs.resolve(absDir, signal === undefined ? {} : { signal })
  if (!fs.contains(root, dir)) throw new SessionPathDenied(rel === '' ? '.' : rel)
  return { root, dir, relativePath: rel, absDir }
}

/**
 * List one directory level under a session cwd.
 * @param fs - composed filesystem service.
 * @param sessionCwd - absolute session project directory.
 * @param relativePath - optional path under the session cwd.
 * @param signal - aborts resolution and listing.
 * @returns one bounded directory page.
 */
export async function listSessionDirectory(
  fs: FileSystem,
  sessionCwd: string,
  relativePath: string | undefined,
  signal?: AbortSignal,
): Promise<SessionDirectoryListing> {
  const { dir, relativePath: rel, absDir } = await resolveSessionDirectory(fs, sessionCwd, relativePath, signal)
  const children = await fs.listDir(dir, signal)
  const entries: SessionFileEntry[] = []
  for (const child of children) {
    if (child.type === 'directory' && SKIP_DIRS.has(child.name)) continue
    const row = entryFromDirChild(absDir, rel, child)
    if (row !== undefined) entries.push(row)
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  return { relativePath: rel, entries }
}

/**
 * Walk the session tree for `@` file candidates.
 * @param fs - composed filesystem service.
 * @param sessionCwd - absolute session project directory.
 * @param query - basename prefix filter.
 * @param signal - aborts the walk.
 * @returns matching files only, bounded by count and depth.
 */
export async function searchSessionFiles(
  fs: FileSystem,
  sessionCwd: string,
  query: string,
  signal?: AbortSignal,
): Promise<{ matches: SessionFileEntry[]; truncated: boolean }> {
  const root = await fs.resolve(sessionCwd, signal === undefined ? {} : { signal })
  const matches: SessionFileEntry[] = []
  let truncated = false

  async function walk(dirTarget: FsTarget, relativeDir: string, absDir: string, depth: number): Promise<void> {
    signal?.throwIfAborted()
    if (depth > MAX_SEARCH_DEPTH) return
    const children = await fs.listDir(dirTarget, signal)
    for (const child of children) {
      signal?.throwIfAborted()
      if (child.type === 'directory' && SKIP_DIRS.has(child.name)) continue
      const relativePath = toPosixRelative(relativeDir, child.name)
      const absPath = join(absDir, child.name)
      if (child.type === 'file') {
        if (child.name.includes(query)) {
          matches.push({
            name: child.name,
            relativePath,
            path: absPath,
            kind: 'file',
            hidden: isHidden(child.name),
          })
          if (matches.length >= MAX_SEARCH_FILES) {
            truncated = true
            return
          }
        }
      } else if (child.type === 'directory') {
        if (!fs.contains(root, child.target)) continue
        await walk(child.target, relativePath, absPath, depth + 1)
        if (truncated) return
      }
    }
  }

  await walk(root, '', sessionCwd, 0)
  matches.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { matches, truncated }
}
