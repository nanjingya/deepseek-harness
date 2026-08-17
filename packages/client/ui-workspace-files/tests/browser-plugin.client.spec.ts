/**
 * ui-workspace-files browser half HMR-safety and registration smoke tests.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import * as WorkspaceFilesInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

function utilityEntryIds(ctx: Context): (string | undefined)[] {
  return ctx.slots.entries('conversation.session.header.utilities').map(entry => entry.options.id)
}

async function bench(captured: { source?: InputTriggerSource }) {
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
        listSessionDirectory: async () => ({ result: { ok: true, value: { relativePath: '', entries: [] } } }),
        openPath: async () => ({ result: { ok: true, value: { opened: true as const } } }),
        searchSessionFiles: async () => ({ result: { ok: true, value: { matches: [], truncated: false } } }),
      },
      settings: {},
    },
    isLoopback: false,
  } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('inputTriggers', {
    registerSource: (source: InputTriggerSource) => {
      captured.source = source
      return () => {}
    },
  })
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('ui-workspace-files browser half', () => {
  it('declares inject services', () => {
    expect(inject).toEqual(['connection', 'inputTriggers', 'slots', 'locale'])
  })

  it('registers the utility slot and @ file source, and teardown removes the slot', async () => {
    const captured: { source?: InputTriggerSource } = {}
    const { ctx, fiber } = await bench(captured)
    expect(utilityEntryIds(ctx)).toContain('workspace-files')
    expect(captured.source?.trigger).toBe('@')
    expect(captured.source?.name).toBe('file')
    await fiber.dispose()
    expect(utilityEntryIds(ctx)).not.toContain('workspace-files')
  })

  it('registers locale dictionaries', async () => {
    const { ctx, fiber } = await bench({})
    const translate = ctx.locale.bind(NS)
    expect(translate('tree.trigger')).toBe(zh['tree.trigger'])
    ctx.locale.setLocale('en')
    expect(translate('tree.trigger')).toBe(en['tree.trigger'])
    await fiber.dispose()
  })

  it('node apply is inert', () => {
    expect(applyNode).not.toThrow()
  })
})

describe('ui-workspace-files invariant companion', () => {
  it('reserves package ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(WorkspaceFilesInvariant)
    await fiber.await()
    await fiber.dispose()
  })
})
