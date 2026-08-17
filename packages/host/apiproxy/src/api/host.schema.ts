/**
 * host domain zod schemas (names derived from map keys).
 */

import { z } from 'zod'
import type { DirectoryEntry } from './host.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'

/** host.describe request payload (empty object literal). */
export const hostDescribeRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.describe'>>>

/** host.describe response value. */
export const hostDescribeValueSchema = z.object({
  version: z.string(),
  cwd: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  attachedSessions: z.number().int().nonnegative(),
  canOpenPath: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.describe'>>>

/** host.pickDirectory request payload (empty object literal). */
export const hostPickDirectoryRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.pickDirectory'>>>

/** host.pickDirectory response value; null means the user cancelled. */
export const hostPickDirectoryValueSchema = z.object({
  path: z.string().nullable(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.pickDirectory'>>>

/** Directory row shared by listing entries and breadcrumb crumbs. */
export const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  hidden: z.boolean(),
}) satisfies z.ZodType<Wire<DirectoryEntry>>

/** host.listDirectory request payload; an absent path lists the home directory. */
export const hostListDirectoryRequestSchema = z.object({
  path: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.listDirectory'>>>

/** host.listDirectory response value. */
export const hostListDirectoryValueSchema = z.object({
  path: z.string(),
  home: z.string(),
  crumbs: z.array(directoryEntrySchema),
  entries: z.array(directoryEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.listDirectory'>>>

/** host.createDirectory request payload: name must be one plain path segment. */
export const hostCreateDirectoryRequestSchema = z.object({
  path: z.string(),
  name: z.string(),
}).refine(
  payload => payload.name.trim() !== '' && payload.name !== '.' && payload.name !== '..'
    && !/[/\\]/.test(payload.name),
  { message: 'host.createDirectory requires a single non-blank path segment name' },
) satisfies z.ZodType<Wire<RequestPayload<'host.createDirectory'>>>

/** host.createDirectory response value: the created directory's absolute path. */
export const hostCreateDirectoryValueSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.createDirectory'>>>
/** host.openPath request payload. */
export const hostOpenPathRequestSchema = z.object({
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'host.openPath'>>>

/** host.openPath response value. */
export const hostOpenPathValueSchema = z.object({
  opened: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'host.openPath'>>>

/** Session file row shared by listing and search responses. */
export const sessionFileEntrySchema = z.object({
  name: z.string(),
  relativePath: z.string(),
  path: z.string(),
  kind: z.enum(['file', 'directory']),
  hidden: z.boolean(),
}) satisfies z.ZodType<Wire<import('./host.ts').SessionFileEntry>>

/** host.listSessionDirectory request payload. */
export const hostListSessionDirectoryRequestSchema = z.object({
  sessionId: sessionIdSchema,
  relativePath: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.listSessionDirectory'>>>

/** host.listSessionDirectory response value. */
export const hostListSessionDirectoryValueSchema = z.object({
  relativePath: z.string(),
  entries: z.array(sessionFileEntrySchema),
}) satisfies z.ZodType<Wire<ResponseValue<'host.listSessionDirectory'>>>

/** host.searchSessionFiles request payload. */
export const hostSearchSessionFilesRequestSchema = z.object({
  sessionId: sessionIdSchema,
  query: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.searchSessionFiles'>>>

/** host.searchSessionFiles response value. */
export const hostSearchSessionFilesValueSchema = z.object({
  matches: z.array(sessionFileEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.searchSessionFiles'>>>

/** PTY status on the wire. */
export const sessionTerminalStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('running') }),
  z.object({
    kind: z.literal('exited'),
    exitCode: z.number().nullable(),
    signal: z.string().nullable(),
  }),
])

/** PTY snapshot shared by list and open responses. */
export const sessionTerminalSnapshotSchema = z.object({
  sessionId: z.string(),
  name: z.string().optional(),
  type: z.string(),
  pid: z.number().optional(),
  status: sessionTerminalStatusSchema,
})

/** host.listSessionTerminals request payload. */
export const hostListSessionTerminalsRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'host.listSessionTerminals'>>>

/** host.listSessionTerminals response value. */
export const hostListSessionTerminalsValueSchema = z.object({
  terminals: z.array(sessionTerminalSnapshotSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'host.listSessionTerminals'>>>

/** host.openSessionTerminal request payload. */
export const hostOpenSessionTerminalRequestSchema = z.object({
  sessionId: sessionIdSchema,
  name: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.openSessionTerminal'>>>

/** host.openSessionTerminal response value. */
export const hostOpenSessionTerminalValueSchema = sessionTerminalSnapshotSchema.extend({
  motd: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.openSessionTerminal'>>>

/** host.readSessionTerminal request payload. */
export const hostReadSessionTerminalRequestSchema = z.object({
  sessionId: sessionIdSchema,
  terminalId: z.string(),
  offset: z.number().int().nonnegative().optional(),
  count: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.readSessionTerminal'>>>

/** host.readSessionTerminal response value. */
export const hostReadSessionTerminalValueSchema = z.object({
  text: z.string(),
  totalLines: z.number().int().nonnegative(),
  lineBegin: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.readSessionTerminal'>>>

/** host.sendSessionTerminal request payload. */
export const hostSendSessionTerminalRequestSchema = z.object({
  sessionId: sessionIdSchema,
  terminalId: z.string(),
  text: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.sendSessionTerminal'>>>

/** host.sendSessionTerminal response value. */
export const hostSendSessionTerminalValueSchema = z.object({
  accepted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'host.sendSessionTerminal'>>>

/** host.closeSessionTerminal request payload. */
export const hostCloseSessionTerminalRequestSchema = z.object({
  sessionId: sessionIdSchema,
  terminalId: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.closeSessionTerminal'>>>

/** host.closeSessionTerminal response value. */
export const hostCloseSessionTerminalValueSchema = z.object({
  closed: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.closeSessionTerminal'>>>
