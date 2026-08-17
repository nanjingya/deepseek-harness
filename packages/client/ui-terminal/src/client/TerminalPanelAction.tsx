import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { SessionTerminalSnapshot } from '@deepseek-ai/dsh-host-apiproxy/api/host'
import { IconChevronDownOutline14, IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import css from './TerminalPanelAction.module.css'

/** Full props for the session-header terminal utility. */
export type TerminalPanelActionProps =
  PropsRuntime<'conversation.session.header.utilities'> & TerminalPanelInjected & PropsLocale<typeof NS>

type PanelState =
  | { kind: 'loading' }
  | { kind: 'ready'; terminals: readonly SessionTerminalSnapshot[]; text: string; spawnedId?: string }
  | { kind: 'unavailable'; reason: 'service' | 'agent' }
  | { kind: 'error' }

/** Host RPC helpers bound to one session. */
export interface TerminalPanelInjected {
  list(signal: AbortSignal): Promise<PanelState>
  open(signal: AbortSignal): Promise<PanelState>
  read(terminalId: string, signal: AbortSignal): Promise<string | null>
  send(terminalId: string, text: string): Promise<boolean>
  close(terminalId: string): Promise<PanelState>
}

function tabLabel(terminal: SessionTerminalSnapshot, index: number): string {
  return terminal.name ?? terminal.sessionId.slice(-6) ?? `pty-${index + 1}`
}

/** Backend-owned prompt from `@deepseek-ai/dsh-terminal-bash`; kept here so the live draft sits on that line. */
const LIVE_PROMPT = 'dsh> '

function splitLivePrompt(text: string): { history: string; prompt: string } {
  if (text.endsWith(LIVE_PROMPT)) {
    return { history: text.slice(0, -LIVE_PROMPT.length), prompt: LIVE_PROMPT }
  }
  if (text.endsWith('\n')) return { history: text, prompt: LIVE_PROMPT }
  return { history: text === '' ? '' : `${text}\n`, prompt: LIVE_PROMPT }
}

function selectTerminalId(
  terminals: readonly SessionTerminalSnapshot[],
  preferred: string | undefined,
  current: string | undefined,
): string | undefined {
  if (preferred !== undefined && terminals.some(row => row.sessionId === preferred)) return preferred
  if (current !== undefined && terminals.some(row => row.sessionId === current)) return current
  return terminals[0]?.sessionId
}

function applyReady(
  next: PanelState,
  preferred: string | undefined,
  current: string | undefined,
  setState: (state: PanelState) => void,
  setActiveId: (id: string | undefined) => void,
): string | undefined {
  setState(next)
  if (next.kind !== 'ready') return undefined
  const selected = selectTerminalId(next.terminals, preferred, current)
  setActiveId(selected)
  return selected
}

/**
 * Session-header utility: list, open, read, and send on agent-owned PTY sessions.
 * @param props - runtime slot currency, injected host RPC helpers, and locale translator.
 */
export function TerminalPanelAction({ t, list, open, read, send, close }: TerminalPanelActionProps) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  const [activeId, setActiveId] = useState<string | undefined>()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeIdRef = useRef<string | undefined>()
  activeIdRef.current = activeId

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const listed = await list(signal)
      if (signal.aborted) return
      const next = listed.kind === 'ready' && listed.terminals.length === 0
        ? await open(signal)
        : listed
      if (signal.aborted) return
      const selected = applyReady(
        next,
        next.kind === 'ready' ? next.spawnedId : undefined,
        activeIdRef.current,
        setState,
        setActiveId,
      )
      if (next.kind === 'ready' && selected !== undefined) {
        const text = next.text !== '' ? next.text : await read(selected, signal)
        if (!signal.aborted && text !== null && text !== '') {
          setState(current => current.kind === 'ready' ? { ...current, text } : current)
        }
      }
    } catch (error) {
      if (signal.aborted) return
      console.error('[ui-terminal] list failed:', error)
      setState({ kind: 'error' })
    }
  }, [list, open, read])

  useEffect(() => {
    if (!panelOpen) return
    setState({ kind: 'loading' })
    const abort = new AbortController()
    void refresh(abort.signal)
    return () => { abort.abort() }
  }, [panelOpen, refresh])

  useEffect(() => {
    if (!panelOpen || activeId === undefined) return
    const abort = new AbortController()
    const timer = window.setInterval(() => {
      void read(activeId, abort.signal).then((text) => {
        if (text === null || abort.signal.aborted) return
        setState(current => current.kind === 'ready' ? { ...current, text } : current)
      })
    }, 400)
    return () => {
      abort.abort()
      window.clearInterval(timer)
    }
  }, [panelOpen, activeId, read])

  useEffect(() => {
    if (!panelOpen) return
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node) !== true) setPanelOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => { document.removeEventListener('pointerdown', onPointer) }
  }, [panelOpen])

  useEffect(() => {
    const node = outputRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [state.kind === 'ready' ? state.text : ''])

  useEffect(() => {
    if (panelOpen && activeId !== undefined) inputRef.current?.focus()
  }, [panelOpen, activeId])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') setPanelOpen(false)
  }

  const submitLine = async (): Promise<void> => {
    const line = draft
    if (activeId === undefined || sending) return
    setSending(true)
    setDraft('')
    setState(current => current.kind === 'ready'
      ? { ...current, text: `${current.text}${line}\n` }
      : current)
    const ok = await send(activeId, line)
    if (!ok) {
      window.alert(t('panel.sendFailed'))
      setDraft(line)
    }
    const text = await read(activeId, AbortSignal.timeout(5_000))
    if (text !== null) setState(current => current.kind === 'ready' ? { ...current, text } : current)
    setSending(false)
    inputRef.current?.focus()
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    event.stopPropagation()
    void submitLine()
  }

  const onOpen = () => {
    void open(AbortSignal.timeout(15_000)).then((next) => {
      const selected = applyReady(
        next,
        next.kind === 'ready' ? next.spawnedId : undefined,
        activeIdRef.current,
        setState,
        setActiveId,
      )
      if (next.kind === 'ready' && selected !== undefined && next.text === '') {
        void read(selected, AbortSignal.timeout(5_000)).then((text) => {
          if (text !== null) setState(current => current.kind === 'ready' ? { ...current, text } : current)
        })
      }
    })
  }

  const terminals = state.kind === 'ready' ? state.terminals : []
  const live = state.kind === 'ready' && terminals.length > 0 && !sending
    ? splitLivePrompt(state.text)
    : state.kind === 'ready'
      ? { history: state.text, prompt: '' }
      : { history: '', prompt: '' }

  return (
    <div className={css.root} ref={rootRef}>
      <button
        type="button"
        className={`${css.trigger}${panelOpen ? ` ${css.triggerOpen}` : ''}`}
        aria-expanded={panelOpen}
        aria-haspopup="dialog"
        onClick={() => { setPanelOpen(value => !value) }}
        onKeyDown={onKeyDown}
      >
        <IconCodeOutline16 aria-hidden />
        <span>{t('panel.trigger')}</span>
        <IconChevronDownOutline14 aria-hidden />
      </button>
      {panelOpen ? (
        <div className={css.panel} role="dialog" aria-label={t('panel.title')}>
          <div className={css.header}>
            <span>{t('panel.title')}</span>
            <div className={css.toolbar}>
              <button
                type="button"
                className={css.toolButton}
                onClick={onOpen}
              >
                {t('panel.open')}
              </button>
              {activeId !== undefined ? (
                <button
                  type="button"
                  className={css.toolButton}
                  onClick={() => {
                    void close(activeId).then((next) => {
                      applyReady(next, undefined, undefined, setState, setActiveId)
                    })
                  }}
                >
                  {t('panel.close')}
                </button>
              ) : null}
            </div>
          </div>
          {state.kind === 'loading' ? <div className={css.muted}>…</div> : null}
          {state.kind === 'unavailable' ? (
            <div className={css.error}>
              {state.reason === 'service' ? t('panel.unavailable') : t('panel.noAgent')}
            </div>
          ) : null}
          {state.kind === 'error' ? <div className={css.error}>{t('panel.unavailable')}</div> : null}
          {state.kind === 'ready' ? (
            <div className={css.body} onClick={() => { inputRef.current?.focus() }}>
              {terminals.length === 0 ? <div className={css.muted}>{t('panel.empty')}</div> : null}
              {terminals.length > 1 ? (
                <div className={css.tabs} role="tablist">
                  {terminals.map((terminal, index) => (
                    <button
                      key={terminal.sessionId}
                      type="button"
                      role="tab"
                      className={`${css.tab}${terminal.sessionId === activeId ? ` ${css.tabActive}` : ''}`}
                      aria-selected={terminal.sessionId === activeId}
                      onClick={() => {
                        setActiveId(terminal.sessionId)
                        void read(terminal.sessionId, AbortSignal.timeout(5_000)).then((text) => {
                          if (text === null) return
                          setState(current => current.kind === 'ready' ? { ...current, text } : current)
                        })
                      }}
                    >
                      {tabLabel(terminal, index)}
                    </button>
                  ))}
                </div>
              ) : null}
              {terminals.length > 0 ? (
                <div ref={outputRef} className={css.screen}>
                  {live.history !== '' ? <pre className={css.output}>{live.history}</pre> : null}
                  {live.prompt !== '' ? (
                    <form className={css.promptRow} onSubmit={onSubmit}>
                      <span className={css.prompt}>{live.prompt}</span>
                      <input
                        ref={inputRef}
                        className={css.input}
                        value={draft}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-label={t('panel.input.placeholder')}
                        onChange={(event) => { setDraft(event.target.value) }}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            event.preventDefault()
                            void submitLine()
                          }
                        }}
                        disabled={activeId === undefined || sending}
                      />
                    </form>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
