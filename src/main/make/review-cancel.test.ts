import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import type { Draft } from '../../shared/make/draft'
import type { Availability } from '../../shared/make/quote'
import { phrasesAndSections } from '../../shared/make/script'
import { callCost, type ParseCall } from './claude'
import type { LocalVoice } from './narrate'
import { makeVideo, quoteDraft, Stopped, type MakeRunDeps } from './run'
import type { MakeServices, TimedWord } from './services'

/**
 * Regression for the money review's fifth finding. Stop reaches Claude: no
 * later part of the shot list is asked for once it is pressed, and what
 * Claude cost is in what the stop says was spent. What a stop keeps (the
 * shot list, the narration, the pictures made) is kept on a draft to go on
 * from, so making the rest asks Claude for nothing and buys none of the
 * pictures again; "reuses" is said only when that is so.
 */

const can: Availability = { google: true, fal: false, elevenlabs: false, claude: true, localVoice: true }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const sentence = (i: number): string =>
  `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1} and the men worked through the night.`
const usage = { input_tokens: 6_000, output_tokens: 12_000 }
const settings = { cap: 100, autoUnder: null }

function setup(n: number): { draft: Draft; phrases: string[]; words: TimedWord[] } {
  const script = ['# Black Gold', '## One', Array.from({ length: n }, (_, i) => sentence(i)).join(' ')].join('\n\n')
  const { phrases, sections, headings } = phrasesAndSections(script)
  const brief = { ...readAsk('make a 10 minute documentary about the 1950s oil boom')!, seconds: Math.max(60, n * 6) }
  const draft: Draft = {
    id: 'review',
    brief,
    title: 'Black Gold',
    outline: headings.filter(Boolean),
    script,
    phrases,
    sections,
    scriptCost: 0,
    quote: null as never
  }
  draft.quote = quoteDraft(draft, { can, settings })
  const words: TimedWord[] = phrases.flatMap((p, i) =>
    p.split(/\s+/).map((w, k) => ({ text: w, startSec: i * 3 + k * 0.2, endSec: i * 3 + k * 0.2 + 0.18 }))
  )
  return { draft, phrases, words }
}

/** Claude's shot list, all stills, worded a little differently on each call as Claude's answers are. */
function planner(
  phrases: string[],
  onCall: (n: number, signal?: AbortSignal) => void
): { parse: ParseCall; calls: () => number } {
  let calls = 0
  const parse: ParseCall = async (params, opts) => {
    calls++
    onCall(calls, opts?.signal)
    await new Promise((r) => setTimeout(r, 20))
    const take = calls
    const asked = String((params.messages as { content: string }[])[0].content)
    const numbers = [...asked.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]))
    return {
      parsed_output: {
        style: 'Photoreal archival photograph.',
        palette: 'sepia',
        era: '1950s',
        characters: [],
        shots: numbers.map((i) => ({
          phrase: i,
          kind: 'still',
          prompt: take % 2 ? `A derrick at dusk, number ${i + 1}.` : `Derrick number ${i + 1} at dusk.`,
          move: 'push-in',
          motion: '',
          characters: [],
          place: '',
          titleBig: '',
          titleSmall: '',
          graphic: '',
          text: [],
          values: [],
          items: [],
          callouts: []
        }))
      },
      stop_reason: 'end_turn',
      usage
    }
  }
  return { parse, calls: () => calls }
}

function depsFor(o: {
  parse: ParseCall
  images: string[]
  words: TimedWord[]
  dir: string
  signal: AbortSignal
  onImage?: (n: number) => void
}): MakeRunDeps {
  const services = {
    open: () => ({ google: true, fal: false, elevenlabs: false }),
    models: { image: { google: 'g', fal: 'f' }, clip: { google: 'g', fal: 'f' } },
    image: async (_s: string, p: string) => {
      o.images.push(p)
      o.onImage?.(o.images.length)
      await new Promise((r) => setTimeout(r, 5))
      return { data: PNG, mime: 'image/png' }
    }
  } as unknown as MakeServices
  const local: LocalVoice = {
    ready: async () => true,
    prepare: async () => undefined,
    speak: async () => ({ samples: new Float32Array(2400), rate: 24_000 })
  }
  return {
    services,
    local,
    parse: o.parse,
    ffmpeg: 'ffmpeg',
    probe: async () => ({ durationSec: 1, width: 1920, height: 1080 }),
    transcribe: async () => o.words,
    maps: {
      make: async () => ({
        kind: 'still',
        path: '/nowhere.png',
        camera: { kind: 'push-in', zoom: 1.1, to: { x: 0.5, y: 0.5 } }
      })
    },
    dir: o.dir,
    findMusic: async () => null,
    progress: () => undefined,
    signal: o.signal
  }
}

describe('Stop, while a video is made', () => {
  it('stopped while the shots are planned: no later part is asked for, and what Claude cost is said', async () => {
    const { draft, phrases, words } = setup(100)
    const controller = new AbortController()
    const askedAfterStop: boolean[] = []
    const plan = planner(phrases, (n, signal) => {
      askedAfterStop.push(controller.signal.aborted)
      expect(signal).toBe(controller.signal)
      // The person presses Stop while the first part is being planned.
      if (n === 1) controller.abort()
    })
    const images: string[] = []
    const err = await makeVideo(
      draft,
      depsFor({
        parse: plan.parse,
        images,
        words,
        dir: mkdtempSync(join(tmpdir(), 'review-stop-')),
        signal: controller.signal
      })
    ).catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 200))
    expect(err).toBeInstanceOf(Stopped)
    const stopped = err as Stopped
    expect(plan.calls()).toBe(1)
    expect(askedAfterStop.filter(Boolean)).toHaveLength(0)
    expect(images).toHaveLength(0)
    // Claude's one answer is in what was spent, and the sentence says so.
    expect(stopped.spent).toBeCloseTo(callCost(usage))
    expect(stopped.message).toMatch(/^Stopped: \$0\.26 of the \$\d+\.\d\d quoted was spent\./)
    expect(stopped.message).not.toMatch(/nothing of the/)
    expect(stopped.resume.spentBefore).toBeCloseTo(callCost(usage))
  })

  it('stopped while the pictures are made: making the rest asks Claude for nothing and buys none of them again', async () => {
    const { draft, phrases, words } = setup(24)
    const dir = mkdtempSync(join(tmpdir(), 'review-stop-again-'))
    // First run: Stop once 8 pictures have been asked for.
    const first = new AbortController()
    const firstImages: string[] = []
    const plan1 = planner(phrases, () => undefined)
    const err = await makeVideo(
      draft,
      depsFor({
        parse: plan1.parse,
        images: firstImages,
        words,
        dir,
        signal: first.signal,
        onImage: (n) => n === 8 && first.abort()
      })
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Stopped)
    const stopped = err as Stopped
    expect(stopped.kept.plan).toBe(true)
    expect(stopped.kept.pictures).toBe(firstImages.length)
    expect(stopped.message).toBe(
      `Stopped: $${stopped.spent.toFixed(2)} of the $${draft.quote.total.toFixed(2)} quoted was spent. The shot list, the narration and the ${firstImages.length} pictures already made are kept, so making the rest reuses them.`
    )
    // What was spent counts Claude's shot list as well as the pictures.
    expect(stopped.spent).toBeCloseTo(callCost(usage) + firstImages.length * 0.0504, 3)

    // Made from what was kept: its quote is for the rest only, with no shot list to plan again.
    const rest: Draft = { ...stopped.resume, quote: quoteDraft(stopped.resume, { can, settings }) }
    expect(rest.quote.lines.some((l) => /shot list/i.test(l.what))).toBe(false)
    expect(rest.quote.counts.stills).toBe(phrases.length - firstImages.length)
    expect(rest.quote.total).toBeLessThan(draft.quote.total)
    const second = new AbortController()
    const secondImages: string[] = []
    const plan2 = planner(phrases, () => undefined)
    const r = await makeVideo(
      rest,
      depsFor({ parse: plan2.parse, images: secondImages, words, dir, signal: second.signal })
    )
    expect(plan2.calls()).toBe(0)
    expect(secondImages).toHaveLength(phrases.length - firstImages.length)
    expect(new Set([...firstImages, ...secondImages]).size).toBe(phrases.length)
    expect(r.doc.make?.shots.filter((s) => s.maker === 'google')).toHaveLength(phrases.length)
    // The whole video's cost is what the stopped run spent and what this one did.
    expect(r.doc.make?.spent).toBeCloseTo(stopped.spent + r.spent, 3)
  })
})
