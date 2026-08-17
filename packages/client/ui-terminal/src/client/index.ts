/**
 * Visual PTY tab plugin, browser half.
 */
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TerminalPanelAction, type TerminalPanelInjected } from './TerminalPanelAction.tsx'
import { en, NS, zh, type TerminalKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session-header terminal panel copy. */
    terminal: TerminalKey
  }
}

export type { TerminalPanelActionProps, TerminalPanelInjected } from './TerminalPanelAction.tsx'

export const inject = ['connection', 'slots', 'locale']

type PanelState = Awaited<ReturnType<TerminalPanelInjected['list']>>

function mapListError(sessionId: SessionId, code: string): PanelState {
  if (code === 'terminal-unavailable') return { kind: 'unavailable', reason: 'service' }
  if (code === 'internal') return { kind: 'unavailable', reason: 'agent' }
  void sessionId
  return { kind: 'error' }
}

/**
 * Client plugin body: register the session-header terminal utility.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-terminal: dictionaries')
  const host = (ctx.get('connection') as ConnectionHandle).api.host

  const terminalActions = (sessionId: SessionId): TerminalPanelInjected => ({
    async list(signal) {
      try {
        const { result } = await host.listSessionTerminals({ sessionId }, signal)
        if (!result.ok) return mapListError(sessionId, result.error.code)
        return { kind: 'ready', terminals: result.value.terminals, text: '' }
      } catch (error) {
        if (signal.aborted) throw error
        console.error('[ui-terminal] listSessionTerminals failed:', error)
        return { kind: 'error' }
      }
    },
    async open(signal) {
      try {
        const { result } = await host.openSessionTerminal({ sessionId, name: 'web' }, signal)
        if (!result.ok) return mapListError(sessionId, result.error.code)
        const listed = await host.listSessionTerminals({ sessionId }, signal)
        if (!listed.result.ok) return mapListError(sessionId, listed.result.error.code)
        return {
          kind: 'ready',
          terminals: listed.result.value.terminals,
          text: result.value.motd,
          spawnedId: result.value.sessionId,
        }
      } catch (error) {
        if (signal.aborted) throw error
        console.error('[ui-terminal] openSessionTerminal failed:', error)
        return { kind: 'error' }
      }
    },
    async read(terminalId, signal) {
      const { result } = await host.readSessionTerminal({ sessionId, terminalId }, signal)
      return result.ok ? result.value.text : null
    },
    async send(terminalId, text) {
      try {
        const { result } = await host.sendSessionTerminal(
          { sessionId, terminalId, text },
          AbortSignal.timeout(30_000),
        )
        return result.ok
      } catch (error) {
        console.error('[ui-terminal] sendSessionTerminal failed:', error)
        return false
      }
    },
    async close(terminalId) {
      const { result } = await host.closeSessionTerminal({ sessionId, terminalId })
      if (!result.ok) return mapListError(sessionId, result.error.code)
      const listed = await host.listSessionTerminals({ sessionId })
      if (!listed.result.ok) return mapListError(sessionId, listed.result.error.code)
      return { kind: 'ready', terminals: listed.result.value.terminals, text: '' }
    },
  })

  ctx.slots.inject(
    'conversation.session.header.utilities',
    () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'session-terminal',
      order: 10,
      locale: NS,
      inject: terminalActions,
    }, TerminalPanelAction),
  )
}
