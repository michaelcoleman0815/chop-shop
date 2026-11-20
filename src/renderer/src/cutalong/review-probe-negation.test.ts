import { describe, expect, it, vi } from 'vitest'

/**
 * Re-review of e11324f, claim 1: "Negations and hedges anywhere in a reply read as no or wait", and
 * "only an option's words, a style or a length answers on its own". An option, a style or a length is
 * found anywhere in what was typed, so a reply that names one to turn it down ("not 10 min, more
 * like 5") answers with the very thing it turned down, and Claude writes that script, with no read-back.
 */

const fake = vi.hoisted(() => ({ api: {} as Record<string, unknown> }))

vi.mock('react', () => ({
  useRef: <T,>(v: T) => ({ current: v }),
  useState: <T,>(v: T | (() => T)) => [typeof v === 'function' ? (v as () => T)() : v, () => undefined],
  useCallback: <T,>(f: T) => f,
  useMemo: <T,>(f: () => T) => f()
}))
vi.mock('./api', () => ({ api: fake.api }))

import { readAsk } from '../../../shared/make/brief'
import { questionsFor, readAnswer } from '../../../shared/make/questions'
import { quoteReply, type Availability } from '../../../shared/make/quote'
import type { ParseCall } from '../../../main/make/claude'
import { draftFor } from '../../../main/make/run'
import { useMake } from './useMake'
import type { Msg } from './components/Message'

const can: Availability = { google: true, fal: false, elevenlabs: false, openai: false, claude: true, localVoice: true }

function harness() {
  const msgs = new Map<string, Partial<Msg>>()
  let n = 0
  let claude = 0
  const parse: ParseCall = async (params) => {
    claude++
    const asked = JSON.stringify(params.messages).match(/(\d+:\d\d|\d+ (?:minutes?|seconds?))/)?.[0] ?? '?'
    return {
      parsed_output: { title: `Trip (${asked})`, sections: [{ heading: 'North', paragraphs: ['We drove north at dawn.', 'The lake was still.'] }] },
      stop_reason: 'end_turn',
      usage: { input_tokens: 4000, output_tokens: 3000 }
    }
  }
  const starts: { text: string; seconds: number | null; format: string | null }[] = []
  fake.api.onCutProgress = () => () => undefined
  fake.api.makeStart = async (req: { text: string; recording?: string | null; answered?: boolean; quoteFirst?: boolean; reading?: string }) => {
    // As index.ts at f2e7518: the brief read from `reading` when the reply was read back; Claude gets `text`.
    const read = readAsk(req.reading?.trim() ? req.reading : String(req.text ?? ''), { niche: null, recording: req.recording ?? null })
    const brief = read && req.reading?.trim() ? { ...read, ask: String(req.text ?? '') } : read
    starts.push({ text: req.text, seconds: brief?.seconds ?? null, format: brief?.format ?? null })
    if (!brief) return { ok: false, message: 'Tell me what the video is about.' }
    const questions = req.answered ? [] : questionsFor(brief)
    if (questions.length) return { ok: true, kind: 'ask', questions }
    const drafted = await draftFor(brief, `new-${n}`, { parse, can, brand: {}, settings: { cap: null, autoUnder: null } })
    if (!drafted.ok) return { ok: false, message: drafted.message }
    const d = drafted.draft
    return { ok: true, kind: 'quote', draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }) }
  }
  const makes = useMake({
    docRef: { current: null },
    setDoc: () => undefined,
    setMediaUrl: () => undefined,
    push: (m) => {
      const id = `m${++n}`
      msgs.set(id, { ...m })
      return id
    },
    patch: (id, p) => msgs.set(id, { ...msgs.get(id), ...p }),
    applyAsVersion: () => null,
    during: (work) => work(),
    findBroll: async () => undefined,
    brand: () => 'default'
  })
  return { msgs, makes, starts, claude: () => claude }
}

describe('a reply that turns an option, a style or a length down', () => {
  it('is read as that option, style or length', () => {
    const qs = questionsFor(readAsk('make a video about my trip')!)
    console.log(`questions: ${JSON.stringify(qs.map((q) => ({ id: q.id, options: q.options.map((o) => o.label) })))}`)
    const replies = [
      'not 10 min, more like 5',
      'not 10 min',
      'anything but 10 min',
      'definitely not 10 minutes',
      'not a documentary',
      'anything but an animated explainer',
      'no map documentary please',
      'not the best moments',
      'the best moments, but nothing about the food',
      'not about what I learned'
    ]
    for (const r of replies) console.log(`readAnswer(${JSON.stringify(r)}) -> ${JSON.stringify(readAnswer(r, qs))}`)
    expect(qs.map((q) => q.id)).toEqual(['topic', 'style', 'length'])
  })

  it('"not 10 min, more like 5": Claude writes the script it turned down, with no read-back', async () => {
    const h = harness()
    await h.makes.handle('make a video about my trip', null, [])
    await h.makes.handle('not 10 min, more like 5', null, [])
    const back = [...h.msgs.values()].find((m) => /^Make it about/.test(m.text ?? ''))
    const typed = h.claude()
    const yes = back?.actions?.find((a) => a.label === 'Yes')
    if (yes) await h.makes.onAction(yes as never)
    const last = h.starts[h.starts.length - 1]
    console.log(
      `after "not 10 min, more like 5": read back: ${back ? `"${back.text}"` : 'none'}; typed -> Claude ${typed}; tapped -> make:start ${JSON.stringify(last?.text)} -> ${last?.seconds} s, ${last?.format}; Claude calls ${h.claude()}`
    )
    expect(typed).toBe(0)
    expect(last?.seconds).toBe(300)
  })

  it('a yes to the read-back with a length added updates it; tapped, Claude writes Lisbon at that length', async () => {
    for (const reply of ['yes, 5 minutes', 'yes please, 10 min', 'sure, as a documentary', 'yep, about 5 minutes long']) {
      const h = harness()
      await h.makes.handle('make a video about my trip', null, [])
      await h.makes.handle('Lisbon', null, [])
      const back = [...h.msgs.values()].find((m) => /^Make it about/.test(m.text ?? ''))?.text
      await h.makes.handle(reply, null, [])
      const typed = h.claude()
      const newest = [...h.msgs.values()].filter((m) => (m.actions ?? []).some((a) => a.label === 'Yes')).pop()
      const yes = newest?.actions?.find((a) => a.label === 'Yes')
      if (yes) await h.makes.onAction(yes as never)
      const last = h.starts[h.starts.length - 1]
      console.log(`read back ${JSON.stringify(back)}, then ${JSON.stringify(reply)}: now "${newest?.text}"; typed -> Claude ${typed}; tapped -> make:start ${JSON.stringify(last?.text)} (${last?.seconds} s, ${last?.format}); Claude ${h.claude()}`)
      expect(typed).toBe(0)
      expect(last?.text ?? '').toMatch(/Lisbon/)
    }
  })

  it('"not a documentary": the same', async () => {
    const h = harness()
    await h.makes.handle('make a video about my trip', null, [])
    await h.makes.handle('not a documentary', null, [])
    const back = [...h.msgs.values()].find((m) => /^Make it about/.test(m.text ?? ''))
    const typed = h.claude()
    const yes = back?.actions?.find((a) => a.label === 'Yes')
    if (yes) await h.makes.onAction(yes as never)
    const last = h.starts[h.starts.length - 1]
    console.log(`after "not a documentary": read back "${back?.text}"; typed -> Claude ${typed}; tapped -> make:start ${JSON.stringify(last?.text)} -> ${last?.format}; Claude calls ${h.claude()}`)
    expect(typed).toBe(0)
    expect(last?.format).not.toBe('documentary')
  })
})
