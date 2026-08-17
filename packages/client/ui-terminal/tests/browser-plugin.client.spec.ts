/**
 * ui-terminal browser half HMR-safety and registration smoke tests.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import * as TerminalInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

function utilityEntryIds(ctx: Context): (string | undefined)[] {
  return ctx.slots.entries('conversation.session.header.utilities').map(entry => entry.options.id)
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  ctx.provide('connection', {
    api: {
      host: {
        listSessionTerminals: async () => ({ result: { ok: true, value: { terminals: [] } } }),
        openSessionTerminal: async () => ({ result: { ok: true, value: { sessionId: 'pty-1', type: 'shell', status: { kind: 'running' }, motd: '' } } }),
        readSessionTerminal: async () => ({ result: { ok: true, value: { text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false } } }),
        sendSessionTerminal: async () => ({ result: { ok: true, value: { accepted: true as const } } }),
        closeSessionTerminal: async () => ({ result: { ok: true, value: { closed: true } } }),
      },
      settings: {},
    },
    isLoopback: false,
  } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('ui-terminal browser half', () => {
  it('declares inject services', () => {
    expect(inject).toEqual(['connection', 'slots', 'locale'])
  })

  it('registers the terminal utility slot, and teardown removes it', async () => {
    const { ctx, fiber } = await bench()
    expect(utilityEntryIds(ctx)).toContain('session-terminal')
    await fiber.dispose()
    expect(utilityEntryIds(ctx)).not.toContain('session-terminal')
  })

  it('registers locale dictionaries', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('panel.trigger')).toBe(zh['panel.trigger'])
    ctx.locale.setLocale('en')
    expect(translate('panel.trigger')).toBe(en['panel.trigger'])
    await fiber.dispose()
  })

  it('node apply is inert', () => {
    expect(applyNode).not.toThrow()
  })
})

describe('ui-terminal invariant companion', () => {
  it('reserves package ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(TerminalInvariant)
    await fiber.await()
    await fiber.dispose()
  })
})
