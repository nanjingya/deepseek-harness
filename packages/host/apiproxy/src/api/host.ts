/**
 * host domain contract. No protocol version: client and host ship
 * together; introduce protocolVersion only when an independently released client appears.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One directory row of a listing: a child entry or a breadcrumb ancestor. */
export interface DirectoryEntry {
  /** Base name shown in a browser row (a root crumb carries its full path). */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean
}

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

/** host.listSessionDirectory response value. */
export interface SessionDirectoryListing {
  /** Listed directory relative to the session cwd (`''` is the project root). */
  relativePath: string
  /** Direct children, name-sorted, with heavy directories skipped. */
  entries: SessionFileEntry[]
}

/** Top-level PTY process status on the wire (mirrors {@link TerminalSessionStatus}). */
export type SessionTerminalStatus =
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number | null; signal: string | null }

/** Owner-visible PTY summary for one session. */
export interface SessionTerminalSnapshot {
  /** Registry-minted PTY identity. */
  sessionId: string
  /** Optional owner-local display name. */
  name?: string
  /** Backend type that created the session. */
  type: string
  /** Top-level process id when the backend has one. */
  pid?: number
  /** Current top-level process status. */
  status: SessionTerminalStatus
}

/** Open PTY response: snapshot plus initial scrollback text. */
export interface SessionTerminalOpenResult extends SessionTerminalSnapshot {
  /** Initial bounded terminal output from spawn. */
  motd: string
}

/** Bounded scrollback page for one PTY. */
export interface SessionTerminalReadResult {
  /** Retained text in chronological order. */
  text: string
  /** Number of lines currently retained. */
  totalLines: number
  /** Inclusive newest-relative offset of the first returned line. */
  lineBegin: number
  /** Exclusive newest-relative offset after the returned page. */
  lineEnd: number
  /** Whether older retained output exceeded a bound. */
  truncated: boolean
}

/** host.listDirectory response value: one directory level plus its ancestry. */
export interface DirectoryListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The host account's home directory (breadcrumb "Home" rooting). */
  home: string
  /**
   * Ancestor chain from the filesystem root to the listed directory
   * inclusive; every crumb is a jump target (crumb `hidden` is always false).
   */
  crumbs: DirectoryEntry[]
  /** Direct child directories, name-sorted; symlinks to directories included. */
  entries: DirectoryEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean
}

/** Host-level unary methods. */
export interface HostApi {
  /**
   * One-shot host snapshot. Empty payload uses the literal `{}` (extend in place when fields arrive).
   * version = the host app's (apps/cli) package.json version; cwd = the host process working
   * directory (root for session persistence and tool execution); provider/model = the defaults
   * applied when a new agent doesn't specify them explicitly, absent when the host configures
   * no explicit default (the adapter falls back internally);
   * attachedSessions = count of currently attached sessions (those with a live agent);
   * canOpenPath = whether this deployment can hand a path to a user-visible native desktop.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    version: string
    cwd: string
    provider?: string
    model?: string
    attachedSessions: number
    canOpenPath: boolean
  }>>

  /**
   * Open the operating system's single-directory picker; cancellation returns
   * null. Only served under the `native` capability.
   */
  pickDirectory(
    request: RpcRequest<{}>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ path: string | null }>>

  /**
   * List one directory level for the in-app browser; an absent path lists the
   * host account's home directory. Only served under the `browse` capability;
   * unreadable or missing targets fail with `directory-unreadable`. The
   * carrier's request signal follows the caller, stopping the backend's scan
   * on disconnect or timeout.
   */
  listDirectory(
    request: RpcRequest<{ path?: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<DirectoryListing>>

  /**
   * Create one child directory under an existing parent (the browser's
   * "New folder"). Only served under the `browse` capability; an existing
   * child fails with `directory-exists`, every other filesystem failure with
   * `directory-create-failed`.
   */
  createDirectory(
    request: RpcRequest<{ path: string; name: string }>,
  ): Promise<RpcResponse<{ path: string }>>

  /**
   * Open a filesystem path with the operating system's default application
   * (Finder / Explorer / xdg-open hand-off). The browser carrier's
   * prefix-wide trust fence covers this privileged method like every other
   * `/api` request.
   */
  openPath(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>>

  /**
   * List one directory level under a session's project cwd. Requires
   * {@link ctx.fs}; paths outside the session root fail with
   * `session-path-denied`.
   */
  listSessionDirectory(
    request: RpcRequest<{ sessionId: SessionId; relativePath?: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<SessionDirectoryListing>>

  searchSessionFiles(
    request: RpcRequest<{ sessionId: SessionId; query: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ matches: SessionFileEntry[]; truncated: boolean }>>

  listSessionTerminals(
    request: RpcRequest<{ sessionId: SessionId }>,
  ): Promise<RpcResponse<{ terminals: SessionTerminalSnapshot[] }>>

  openSessionTerminal(
    request: RpcRequest<{ sessionId: SessionId; name?: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<SessionTerminalOpenResult>>

  readSessionTerminal(
    request: RpcRequest<{ sessionId: SessionId; terminalId: string; offset?: number; count?: number }>,
  ): Promise<RpcResponse<SessionTerminalReadResult>>

  /**
   * Write one submitted line into a live-agent PTY and wait until that send
   * settles (prompt return, timeout, or abort).
   * @param request - chat session id, PTY id, and the line to write.
   * @param signal - aborts the wait and interrupts the foreground command.
   */
  sendSessionTerminal(
    request: RpcRequest<{ sessionId: SessionId; terminalId: string; text: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ accepted: true }>>

  closeSessionTerminal(
    request: RpcRequest<{ sessionId: SessionId; terminalId: string }>,
  ): Promise<RpcResponse<{ closed: boolean }>>
}
