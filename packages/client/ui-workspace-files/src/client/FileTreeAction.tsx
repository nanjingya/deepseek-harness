import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { SessionFileEntry } from '@deepseek-ai/dsh-host-apiproxy/api/host'
import {
  IconChevronDownOutline14,
  IconFolderClose16,
  IconFolderOpenOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import css from './FileTreeAction.module.css'

/** Full props for the session-header workspace file tree action. */
export type FileTreeActionProps =
  PropsRuntime<'conversation.session.header.utilities'> & FileTreeInjected & PropsLocale<typeof NS>

type ListingState =
  | { kind: 'loading' }
  | { kind: 'ready'; relativePath: string; entries: readonly SessionFileEntry[] }
  | { kind: 'error' }

/** Business actions supplied by the slot registration. */
export interface FileTreeInjected {
  /** List one directory under the session cwd. */
  list(relativePath: string, signal: AbortSignal): Promise<ListingState>
  /** Open one absolute path with the host default application. */
  open(path: string, signal: AbortSignal): Promise<boolean>
}

function rowIcon(entry: SessionFileEntry) {
  return entry.kind === 'directory'
    ? <IconFolderOpenOutline16 className={css.icon} aria-hidden />
    : <IconFolderClose16 className={css.icon} aria-hidden />
}

/**
 * Session-header utility: browse the session project tree and open files in the OS default app.
 * @param props - runtime slot currency, injected host RPC helpers, and locale translator.
 */
export function FileTreeAction({ t, list, open }: FileTreeActionProps) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [relativePath, setRelativePath] = useState('')
  const [listing, setListing] = useState<ListingState>({ kind: 'loading' })
  const rootRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (path: string, signal: AbortSignal) => {
    setListing({ kind: 'loading' })
    try {
      setListing(await list(path, signal))
    } catch (error) {
      if (signal.aborted) return
      console.error('[ui-workspace-files] list failed:', error)
      setListing({ kind: 'error' })
    }
  }, [list])

  useEffect(() => {
    if (!panelOpen) return
    const abort = new AbortController()
    void load(relativePath, abort.signal)
    return () => { abort.abort() }
  }, [panelOpen, relativePath, load])

  useEffect(() => {
    if (!panelOpen) return
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node) !== true) setPanelOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => { document.removeEventListener('pointerdown', onPointer) }
  }, [panelOpen])

  const parentPath = relativePath.includes('/')
    ? relativePath.slice(0, relativePath.lastIndexOf('/'))
    : ''

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') setPanelOpen(false)
  }

  const onEntry = async (entry: SessionFileEntry) => {
    if (entry.kind === 'directory') {
      setRelativePath(entry.relativePath)
      return
    }
    const opened = await open(entry.path, AbortSignal.timeout(10_000))
    if (!opened) window.alert(t('tree.openFailed'))
  }

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
        <span>{t('tree.trigger')}</span>
        <IconChevronDownOutline14 aria-hidden />
      </button>
      {panelOpen ? (
        <div className={css.menu} role="dialog" aria-label={t('tree.title')}>
          <div className={css.header}>
            <span>{t('tree.title')}</span>
            {relativePath !== '' ? (
              <button type="button" className={css.up} onClick={() => { setRelativePath(parentPath) }}>
                {t('tree.up')}
              </button>
            ) : null}
          </div>
          <div className={css.body}>
            {listing.kind === 'loading' ? <div className={css.muted}>…</div> : null}
            {listing.kind === 'error' ? <div className={css.error}>{t('tree.error')}</div> : null}
            {listing.kind === 'ready' && listing.entries.length === 0 ? (
              <div className={css.muted}>{t('tree.empty')}</div>
            ) : null}
            {listing.kind === 'ready' && listing.entries.length > 0 ? (
              <ul className={css.list}>
                {listing.entries.map(entry => (
                  <li key={entry.relativePath} className={css.item}>
                    <button type="button" className={css.row} onClick={() => { void onEntry(entry) }}>
                      {rowIcon(entry)}
                      <span className={css.label}>{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
