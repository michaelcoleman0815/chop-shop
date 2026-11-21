import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import type { Draft } from '../../shared/make/draft'
import type { Availability } from '../../shared/make/quote'
import { phrasesAndSections } from '../../shared/make/script'
import { callCost, type ParseCall } from './claude'
import type { LocalVoice } from './narrate'
import { makeVideo, quoteDraft, Stopped, type MakeRunDeps } from './run'
import type { MakeServices, TimedWord } from './services'

/** Folders this file makes for what it writes, taken away once it is done. */
const scratchDirs: string[] = []
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true })
})

/**
 * Review probe at 376360e: the Stop the builder added (make:cancel aborts the
 * run's signal; makeVideo answers with a Stopped sentence).
 *
 * 1. Stopped while Claude plans a long video's shots: the sentence says nothing
 *    was spent, but planShots has no signal and asks Claude for every part left.
 * 2. Stopped while the pictures are made: the sentence says the pictures made
 *    "are kept, so asking again reuses them". Made again from the very same
 *    draft, Claude plans the shots again in new words (as it does), every
 *    cache key misses, and every picture is bought again. The "$X spent"
 *    also leaves out what Claude cost.
 */

const can: Availability = { google: true, fal: false, elevenlabs: false, claude: true, localVoice: true }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const sentence = (i: number): string => `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1} and the men worked through the night.`
// Within the answer cap the hold sets (the stand-in planner does not read max_tokens).
const usage = { input_tokens: 6_000, output_tokens: 9_000 }

function setup(n: number) {
  const script = ['# Black Gold', '## One', Array.from({ length: n }, (_, i) => sentence(i)).join(' ')].join('\n\n')
  const { phrases, sections, headings } = phrasesAndSections(script)
  const brief = { ...readAsk('make a 10 minute documentary about the 1950s oil boom')!, seconds: Math.max(60, n * 6) }
  const draft: Draft = { id: 'probe', brief, title: 'Black Gold', outline: headings.filter(Boolean), script, phrases, sections, scriptCost: 0, quote: null as never }
  draft.quote = quoteDraft(draft, { can, settings: { cap: 100, autoUnder: null } })
  const words: TimedWord[] = phrases.flatMap((p, i) => p.split(/\s+/).map((w, k) => ({ text: w, startSec: i * 3 + k * 0.2, endSec: i * 3 + k * 0.2 + 0.18 })))
  return { draft, phrases, words }
}

/** Claude's shot list, all stills, worded a little differently on each call as Claude's answers are. */
function planner(phrases: string[], onCall: (n: number) => void): { parse: ParseCall; calls: () => number } {
  let calls = 0
  const parse: ParseCall = async () => {
    calls++
    onCall(calls)
    await new Promise((r) => setTimeout(r, 20))
    const take = calls
    return {
      parsed_output: {
        style: 'Photoreal archival photograph.',
        palette: 'sepia',
        era: '1950s',
        characters: [],
        shots: phrases.map((_, i) => ({
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

function depsFor(o: { parse: ParseCall; images: string[]; words: TimedWord[]; dir: string; signal: AbortSignal; onImage?: (n: number) => void }): MakeRunDeps {
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
  const local: LocalVoice = { ready: async () => true, prepare: async () => undefined, speak: async () => ({ samples: new Float32Array(2400), rate: 24_000 }) }
  return {
    services,
    local,
    parse: o.parse,
    ffmpeg: 'ffmpeg',
    probe: async () => ({ durationSec: 1, width: 1920, height: 1080 }),
    transcribe: async () => o.words,
    maps: { make: async () => ({ kind: 'still', path: '/nowhere.png', camera: { kind: 'push-in', zoom: 1.1, to: { x: 0.5, y: 0.5 } } }) },
    dir: o.dir,
    findMusic: async () => null,
    progress: () => undefined,
    signal: o.signal
  }
}

describe('Stop, as added in 376360e', () => {
  it('stopped while the shots are planned: "nothing was spent", while Claude is still asked for every part', async () => {
    const { draft, phrases, words } = setup(100)
    const controller = new AbortController()
    const aborted: boolean[] = []
    const plan = planner(phrases, (n) => {
      aborted.push(controller.signal.aborted)
      // The person presses Stop while the first part is being planned.
      if (n === 1) controller.abort()
    })
    const images: string[] = []
    let said = ''
    try {
      await makeVideo(draft, depsFor({ parse: plan.parse, images, words, dir: scratch('probe-stop-'), signal: controller.signal }))
    } catch (err) {
      said = `${err instanceof Stopped ? 'Stopped' : 'Error'}: "${(err as Error).message}"`
    }
    const atStop = plan.calls()
    await new Promise((r) => setTimeout(r, 400))
    const after = aborted.filter(Boolean).length
    console.log(`${phrases.length} phrases; make:go answers ${said}`)
    console.log(`Claude requests when it stopped: ${atStop}; asked after the stop: ${after}; pictures asked: ${images.length}`)
    // Fixed at b732576: no part is asked for after a Stop, and the cut-short call is said as spent.
    expect(after).toBe(0)
    expect(said).not.toMatch(/nothing of the .* quoted was spent/)
    expect(said).toMatch(/^Stopped: "Stopped: \$\d+\.\d\d of the/)
  })

  it('stopped while the pictures are made: "kept, so asking again reuses them", but asking again buys them all again', async () => {
    const { draft, phrases, words } = setup(24)
    const dir = scratch('probe-stop-again-')
    // First run: Stop once 8 pictures have been asked for.
    const first = new AbortController()
    const firstImages: string[] = []
    const plan1 = planner(phrases, () => undefined)
    let said = ''
    let stopped: Stopped | null = null
    try {
      await makeVideo(
        draft,
        depsFor({ parse: plan1.parse, images: firstImages, words, dir, signal: first.signal, onImage: (n) => n === 8 && first.abort() })
      )
    } catch (err) {
      said = (err as Error).message
      if (err instanceof Stopped) stopped = err
    }
    if (!stopped) throw new Error(`expected a Stopped, got "${said}"`)
    // Made from the draft the Stop hands back, quoted again as make:go quotes it.
    const rest: Draft = { ...stopped.resume, quote: quoteDraft(stopped.resume, { can, settings: { cap: 100, autoUnder: null } }) }
    const second = new AbortController()
    const secondImages: string[] = []
    const plan2 = planner(phrases, () => undefined)
    const r = await makeVideo(rest, depsFor({ parse: plan2.parse, images: secondImages, words, dir, signal: second.signal }))
    const again = secondImages.filter((p) => firstImages.includes(p)).length
    console.log(`first run: ${firstImages.length} pictures bought, then: "${said}" (spent $${stopped.spent.toFixed(4)}, Claude's $${callCost(usage).toFixed(4)} among it)`)
    console.log(`the rest: quoted $${rest.quote.total.toFixed(4)} (lines: ${rest.quote.lines.map((l) => l.what).join('; ')}); Claude asked ${plan2.calls()} time(s); ${secondImages.length} pictures bought, ${again} of them bought before`)
    console.log(`in all: ${new Set([...firstImages, ...secondImages]).size} distinct pictures for ${phrases.length} shots; recorded spent $${r.doc.make?.spent.toFixed(4)}`)
    expect(plan2.calls()).toBe(0)
    expect(again).toBe(0)
    expect(firstImages.length + secondImages.length).toBe(phrases.length)
    expect(stopped.spent).toBeGreaterThanOrEqual(callCost(usage))
  })
})
