import { readFileSync } from 'fs'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
    ipcMain: { handle: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./apikey', () => ({ readApiKey: () => null, hasApiKey: () => false }))

import { createDoc, wordsFromTranscript, type Source } from '../shared/edit'
import { motionCommandEntries } from '../shared/motion'
import { BUILT_IN_PRESETS, CAPTION_STYLE_PRESETS, SKILL_PRESETS } from '../shared/presets'
import { costLine, planCost, TYPICAL_PLAN } from '../shared/setup'
import { PLANNER_SYSTEM, PlanSchema, renderCommands, renderRequest, renderTranscript } from './planner-prompt'
import { TRIAGE_SYSTEM, triageRequest, TriageSchema } from './triage'

/**
 * The cost line on the setup screen (shared/setup/cost.ts) is worked out from
 * the size of a typical plan request, measured once and written down there.
 * This measures it again: when the planner's instructions, its schema, the
 * commands or the way a cut is written out grow or shrink by more than a
 * quarter, the line is no longer honest, and this fails with the new sizes.
 */

/** A 10-minute talking head, 1,500 words, as the cost line describes. */
function tenMinutes(): ReturnType<typeof createDoc> {
  const sentences = [
    'So today I want to show you the camera I have been using for the last month.',
    'The battery lasts about two days, which honestly surprised me.',
    'Let me walk you through the settings I change first on every new phone.',
    'Um, the low light shots are where it really pulls ahead of last year.',
    'If you only care about video, the stabilisation alone is worth the upgrade.',
    'Here is the thing nobody tells you about the zoom lens.'
  ]
  const words: { text: string; startSec: number; endSec: number }[] = []
  let t = 0.5
  while (words.length < 1500) {
    for (const w of sentences[words.length % sentences.length].split(' ')) {
      words.push({ text: w, startSec: t, endSec: t + 0.3 })
      t += 0.36
    }
    t += 0.6
  }
  const source: Source = { id: 's1', path: '/footage/A001_review.mov', durationSec: t + 1, width: 3840, height: 2160, fps: 30 }
  return createDoc({ id: 'd', title: 'Review', source, words: wordsFromTranscript(words, 's1') })
}

/** The slash menu as the planner sees it: every preset and style, the motion commands and the app's own. */
function commands(): { command: string; summary: string }[] {
  // The app's own commands, written out in useCutalong.ts as objects and as [command, title, summary] rows.
  const app = readFileSync('src/renderer/src/cutalong/useCutalong.ts', 'utf8')
  const own = [
    ...app.matchAll(/command: '([a-z]+)',\n\s+title: '[^']+',\n\s+summary: '([^']+)'/g),
    ...app.matchAll(/\['([a-z]+)', '[^']+', '([^']+)'\]/g)
  ].map((m) => ({ command: m[1], summary: m[2] }))
  return [
    ...[...BUILT_IN_PRESETS, ...CAPTION_STYLE_PRESETS, ...SKILL_PRESETS].map((p) => ({ command: p.command, summary: p.summary })),
    ...own,
    ...motionCommandEntries().map((m) => ({ command: m.command, summary: m.summary }))
  ]
}

const schemaChars = (format: unknown): number => JSON.stringify((format as { schema: unknown }).schema).length

const ASK =
  'make this an 8 minute review, start with the strongest line, cut the rambling, captions, upbeat music, chapters, and B-roll of the phone when I mention it'

describe('what a plan costs', () => {
  const doc = tenMinutes()
  const menu = commands()
  const measured = {
    instructions: PLANNER_SYSTEM.length + schemaChars(betaZodOutputFormat(PlanSchema)),
    commands: renderCommands(menu).length,
    transcript: renderTranscript(doc).length,
    request: renderRequest(doc, ASK, []).length,
    triage:
      TRIAGE_SYSTEM.length +
      schemaChars(betaZodOutputFormat(TriageSchema)) +
      triageRequest({
        request: ASK,
        files: [{ name: 'A001_review.mov', durationSec: 640, video: true, audio: true }],
        link: null,
        hasEdit: false,
        commands: menu
      }).length
  }

  it('is reckoned from a request the size this app sends', () => {
    // The sizes written down in cost.ts, within a quarter either way of what is sent now.
    const drifted = (Object.entries(measured) as [keyof typeof measured, number][])
      .filter(([part, chars]) => {
        const ratio = chars / TYPICAL_PLAN.chars[part]
        return !(ratio > 0.75 && ratio < 1.25)
      })
      .map(([part]) => part)
    expect(drifted, `Sizes now: ${JSON.stringify(measured)}; write them into TYPICAL_PLAN in shared/setup/cost.ts`).toEqual([])
    expect(Math.abs(doc.sources[0].durationSec / 60 - TYPICAL_PLAN.minutes)).toBeLessThanOrEqual(1)
  })

  it('says a range in cents, with the date the prices were read and where to see the spend', () => {
    const { low, high } = planCost()
    expect(low).toBeGreaterThan(0.01)
    expect(high).toBeGreaterThan(low)
    expect(high).toBeLessThan(1)
    expect(costLine()).toMatch(
      /^A plan on a 10-minute video costs about \d+ to \d+ cents at Anthropic’s prices on 16 November 2026\. The Console’s Usage page shows what you actually spend\.$/
    )
  })
})
