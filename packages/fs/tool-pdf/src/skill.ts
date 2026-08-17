/**
 * Optional bundled `read-pdf` skill provider. Registered only when `ctx.skills`
 * is mounted so deployments without the skill seam still get the tool.
 * @module @deepseek-ai/dsh-tool-pdf/skill
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'read-pdf'
const SKILL_BODY_URL = new URL('../assets/read-pdf.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = 'Required as soon as a PDF path is known: read, summarize, quote, or convert it via read_pdf. Output is Markdown plus an editable Word file. Do not use bash, WPS, pandoc, or pdftotext.'
const WHEN_TO_USE = 'The moment a .pdf path is known, including convert-to-Word or summarize requests.'
/* jscpd:ignore-start */
const CANDIDATE: SkillCandidate = {
  name: 'read-pdf',
  description: DESCRIPTION,
  whenToUse: WHEN_TO_USE,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      whenToUse: WHEN_TO_USE,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}
/* jscpd:ignore-end */

/**
 * Register the bundled skill when the skill registry is present.
 * @param ctx - plugin context; uses opportunistic `ctx.get('skills')`.
 */
export function applyReadPdfSkill(ctx: Context): void {
  const skills = ctx.get('skills')
  if (skills === undefined) return
  skills.registerProvider(() => provider)
}
