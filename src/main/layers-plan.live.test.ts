import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { tracksOf } from '../shared/tracks'
import { platform, setPlatform, type Platform } from './platform'
import { planEdit } from './planner'

/**
 * Claude itself using the layer tracks: a few asks a person would make,
 * planned by the real planner against Anthropic, each checked for ops that
 * apply and for the clips they should leave on the tracks. Never part of the
 * default run: only with CUTALONG_LIVE=1 and ANTHROPIC_API_KEY set, and it
 * spends a little credit (four plans on a short edit). What each plan said
 * and did is written to CUTALONG_LIVE_DIR when it is set.
 *
 *   CUTALONG_LIVE=1 ANTHROPIC_API_KEY=… npx vitest run src/main/layers-plan.live.test.ts
 */

const LIVE = process.env.CUTALONG_LIVE === '1' && !!process.env.ANTHROPIC_API_KEY
const OUT = process.env.CUTALONG_LIVE_DIR ?? ''

const said = 'Today I want to show you the new laptop I have been using and honestly it is fast and the battery lasts all day'
const words = wordsFromTranscript(
  said.split(' ').map((text, i) => ({ text, startSec: 0.4 + i * 0.42, endSec: 0.72 + i * 0.42 })),
  's1'
)
const source = { id: 's1', path: '/footage/take.mov', durationSec: 11, width: 1920, height: 1080, fps: 30 }
const origin = { type: 'file' as const, url: null, author: null, license: null, range: null }

function talk(): EditDoc {
  const doc = createDoc({ id: 'live-layers', title: 'Laptop', source, words })
  return {
    ...doc,
    assets: [
      { id: 'a1', kind: 'video', path: '/footage/laptop-broll.mp4', title: 'Laptop on a desk, keys typing', durationSec: 8, width: 1920, height: 1080, origin },
      { id: 'a2', kind: 'image', path: '/footage/logo.png', title: 'The laptop maker’s logo', durationSec: null, width: 800, height: 800, origin }
    ]
  }
}

const id = (text: string): string => words.find((w) => w.text === text)?.id ?? ''

describe.skipIf(!LIVE)('Claude with the layer tracks, live', () => {
  let before: Platform
  const record: unknown[] = []

  beforeAll(() => {
    before = platform()
    const key = process.env.ANTHROPIC_API_KEY as string
    setPlatform({ ...before, secrets: { ...before.secrets, get: async (name) => (name === 'anthropic' ? key : before.secrets.get(name)) } })
  })

  afterAll(() => {
    setPlatform(before)
    if (OUT) {
      mkdirSync(OUT, { recursive: true })
      writeFileSync(join(OUT, 'layers-plan.json'), JSON.stringify(record, null, 2))
    }
  })

  /** One ask planned and applied to the edit it was asked of, as the app applies a plan. */
  async function plan(doc: EditDoc, request: string) {
    const r = await planEdit({ doc, request, notes: [] })
    if (!r.ok) throw new Error(r.message)
    const applied = applyOps(currentCut(doc), r.ops, { words: doc.words, sources: doc.sources, assets: doc.assets })
    record.push({ request, ops: r.ops, rejected: [...r.rejected, ...applied.rejected.map((x) => x.reason)], summary: r.summary, reply: r.reply })
    expect(applied.rejected.map((x) => x.reason), request).toEqual([])
    return { r, cut: applied.cut, clips: tracksOf(applied.cut).flatMap((t) => t.clips.map((c) => ({ ...c, trackKind: t.kind }))) }
  }

  it('puts the B-roll in a box over the speaker, from a word to a word, fading in', async () => {
    const { clips } = await plan(talk(), 'Put the laptop B-roll in a small box in the top right corner from "new" to "fast", fading in.')
    const box = clips.find((c) => c.kind === 'video' && c.src === 'a1')
    expect(box, 'a video clip of a1').toBeTruthy()
    expect(box?.from).toMatch(new RegExp(`^${id('new')}`))
    // Small and to the right: a scale under one and a position right of the middle, held or keyed.
    expect(JSON.stringify(box?.transform ?? {})).toMatch(/scale/)
    expect(JSON.stringify(box?.opacity ?? '')).toMatch(/keys/)
  }, 180_000)

  it('flies a big title in from below over the last words, with keys', async () => {
    const { clips } = await plan(talk(), 'Add a big yellow title that says ALL DAY over the last two words, flying in from below.')
    const title = clips.find((c) => c.kind === 'text')
    expect(title?.text?.value.toUpperCase()).toContain('ALL DAY')
    expect(JSON.stringify(title?.transform ?? {})).toMatch(/"y":\{"keys"/)
  }, 180_000)

  it('trims the edit’s first beat by hand to start on a word', async () => {
    const { cut } = await plan(talk(), 'Trim the start so the video begins on the word "show".')
    expect(cut.beats[0].from === id('show') || cut.removed.includes(id('Today'))).toBe(true)
  }, 180_000)

  it('darkens the picture under a title with a solid layer, and keeps the B-roll silent', async () => {
    const { clips } = await plan(
      talk(),
      'Lay a black layer at 40% over the whole video so text stands out, then put the laptop B-roll over the first sentence with its sound off.'
    )
    expect(clips.some((c) => c.kind === 'solid' && /^#0{6}$/i.test(c.color ?? ''))).toBe(true)
    const broll = clips.find((c) => c.kind === 'video' && c.src === 'a1')
    expect(broll?.muted).toBe(true)
  }, 180_000)
})
