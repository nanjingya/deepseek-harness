/**
 * Workspace file tree and `@` file reference plugin, browser half.
 */
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { FileTreeAction, type FileTreeInjected } from './FileTreeAction.tsx'
import { en, NS, zh, type WorkspaceFilesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace file tree and `@` file source copy. */
    'workspace-files': WorkspaceFilesKey
  }
}

export type { FileTreeActionProps, FileTreeInjected } from './FileTreeAction.tsx'

/** Required services for RPC, `@` registration, locale, and header utilities. */
export const inject = ['connection', 'inputTriggers', 'slots', 'locale']

/**
 * Client plugin body: register the file tree utility and `@` file source.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace-files: dictionaries')
  const host = (ctx.get('connection') as ConnectionHandle).api.host

  const fileActions = (sessionId: SessionId): FileTreeInjected => ({
    async list(relativePath, signal) {
      try {
        const { result } = await host.listSessionDirectory({
          sessionId,
          ...relativePath === '' ? {} : { relativePath },
        }, signal)
        if (!result.ok) return { kind: 'error' }
        return { kind: 'ready', relativePath: result.value.relativePath, entries: result.value.entries }
      } catch (error) {
        if (signal.aborted) throw error
        console.error('[ui-workspace-files] listSessionDirectory failed:', error)
        return { kind: 'error' }
      }
    },
    async open(path, signal) {
      const { result } = await host.openPath({ path }, signal)
      return result.ok
    },
  })

  ctx.slots.inject(
    'conversation.session.header.utilities',
    () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'workspace-files',
      order: 5,
      locale: NS,
      inject: fileActions,
    }, FileTreeAction),
  )

  const source: InputTriggerSource = {
    trigger: '@',
    name: 'file',
    order: 1,
    async candidates(session, { query, signal }) {
      try {
        const { result } = await host.searchSessionFiles({ sessionId: session.sessionId, query }, signal)
        if (!result.ok || signal.aborted) return []
        return result.value.matches.map(match => ({
          name: match.relativePath,
          description: match.name,
        }))
      } catch (error) {
        if (signal.aborted) return []
        console.error('[ui-workspace-files] searchSessionFiles failed:', error)
        return []
      }
    },
    onPick({ candidate }) {
      return { text: `${candidate.name} ` }
    },
  }

  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(source), 'ui-workspace-files: @ file source')
}
