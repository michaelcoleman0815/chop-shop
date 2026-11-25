import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return { app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() }, ipcMain: { handle: () => undefined } }
})

import { commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc, type Source } from '../shared/edit'
import { bareLines, bareStretches, LONGEST_BARE, talkLines, talkStretches } from '../shared/plan-talk'
import { inItsRoom, withoutUninvitedCaptions } from './plan-tidy'
import { redoAsk } from './plan-critic'
import { renderRequest, type PlannerOp } from './planner-prompt'

/** A talk of a minute, its speaker on screen but for a cutaway from 20 to 30 seconds. */
function talk(size = { width: 1920, height: 1080 }): EditDoc {
  const words = Array.from({ length: 180 }, (_, i) => ({ text: i % 12 === 11 ? `word${i}.` : `word${i}`, startSec: i / 3, endSec: i / 3 + 0.3 }))
  const source = {
    id: 's1', path: '/talk.mov', durationSec: 61, ...size, fps: 30,
    faces: { everySec: 2, samples: Array.from({ length: 31 }, (_, i) => ({ t: i * 2, faces: i * 2 >= 20 && i * 2 < 30 ? [] : [[0.4, 0.2, 0.2, 0.35]] })) }
  } as unknown as Source
  return createDoc({ id: 'd', title: 'Talk', source, words: wordsFromTranscript(words, 's1') })
}
const ops = (list: unknown[]): PlannerOp[] => list as PlannerOp[]
const on = { op: 'captions', set: { on: true, preset: 'hierarchy' } }

describe('captions nobody asked for', () => {
  it('are left out of a wide video', () => {
    const doc = talk()
    const plan = ops([{ op: 'direction', accent: '#E8692C' }, on])
    expect(withoutUninvitedCaptions(doc, 'make it punchy and engaging with graphics', [], plan).map((o) => o.op)).toEqual(['direction'])
    // Turning them off is always taken.
    expect(withoutUninvitedCaptions(doc, 'x', [], ops([{ op: 'captions', set: { on: false } }]))).toHaveLength(1)
  })

  it('are kept where they are asked for, in the words or a note, on an upright video, and where they are on already', () => {
    const doc = talk()
    const plan = ops([on])
    for (const said of ['add captions', 'with subtitles please', 'put the words on screen', 'karaoke style'])
      expect(withoutUninvitedCaptions(doc, said, [], plan), said).toHaveLength(1)
    expect(withoutUninvitedCaptions(doc, '', [{ text: 'captions here' }], plan)).toHaveLength(1)
    expect(withoutUninvitedCaptions(talk({ width: 1080, height: 1920 }), 'make it pop', [], plan)).toHaveLength(1)
    expect(withoutUninvitedCaptions(doc, 'make it pop', [], ops([{ op: 'aspect', aspect: 'vertical' }, on]))).toHaveLength(2)
    const captioned = commit(doc, [{ op: 'captions', set: { on: true } }] as never, 'x').doc
    expect(withoutUninvitedCaptions(captioned, 'make it pop', [], plan)).toHaveLength(1)
  })
})

describe('a designed graphic', () => {
  const W = 1920
  const H = 1080
  const card = (x: number, w = 700, h = 500) => ({ kind: 'shape', shape: { type: 'rect', w, h, radius: 20 }, fill: '#FFFFFF', transform: { x, y: 540 } }) as never
  const wash = { kind: 'shape', shape: { type: 'rect', w: 1150, h: 1080 }, fill: '#000000', transform: { x: 575, y: 540 } } as never

  it('is left as it was where it fits its room', () => {
    const layers = [wash, card(500)]
    expect(inItsRoom(layers, 'left', W, H)).toBe(layers)
  })

  it('is moved over, and drawn smaller when it must be, when it runs past it', () => {
    // Over the speaker: moved to its own half, its wash left where it is.
    const [ground, held] = inItsRoom([wash, card(800)], 'left', W, H) as unknown as { kind: string; transform: { x: number; scale: number }; children: unknown[] }[]
    expect(ground).toBe(wash)
    expect(held.kind).toBe('group')
    expect(held.transform.x + 350 * held.transform.scale).toBeLessThanOrEqual(W * 0.485 + 1)
    expect(held.transform.scale).toBe(1)
    // A note off the edge of the frame: the whole is drawn small enough to be read.
    const note = { kind: 'text', text: 'no search engine of its own', font: { family: 'Instrument Serif Italic', size: 120 }, fill: '#000000', align: 'left', valign: 'middle', transform: { x: 1400, y: 300 } } as never
    const fitted = inItsRoom([card(1400), note], 'right', W, H) as unknown as { transform: { scale: number } }[]
    expect(fitted[0].transform.scale).toBeLessThan(1)
    expect(fitted[0].transform.scale).toBeGreaterThan(0.4)
  })

  it('is measured where it comes to rest, not where it sets off', () => {
    const drifting = { kind: 'shape', shape: { type: 'rect', w: 400, h: 300 }, fill: '#FFFFFF', transform: { x: 480, y: { keys: [{ t: 0, v: 1500, ease: 'out-quint' }, { t: 1.5, v: 540 }, { t: 0.3, v: 540, from: 'end' }, { t: 0, v: 2000, from: 'end' }] } } } as never
    const layers = [drifting]
    expect(inItsRoom(layers, 'left', W, H)).toBe(layers)
  })
})

describe('plain talk', () => {
  const read = (doc: EditDoc) => {
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    return { resolved, stretches: talkStretches(resolved, doc.sources) }
  }

  it('is where only the speaker is on screen, broken by footage that shows something else', () => {
    const { stretches } = read(talk())
    expect(stretches).toHaveLength(2)
    expect(stretches[0].end).toBeLessThan(22)
    expect(stretches[1].start).toBeGreaterThan(26)
    expect(talkLines(stretches).join('\n')).toMatch(/^w1 to w\d+: \d+\.\d s of plain talk\nw\d+ to w180/)
    // None is said where no faces have been read.
    const blind = { ...talk(), sources: [{ ...talk().sources[0], faces: undefined }] } as EditDoc
    expect(read(blind).stretches).toEqual([])
  })

  it('is told to the planner', () => {
    expect(renderRequest(talk(), 'make it punchy', [])).toMatch(/<talk>\nw1 to w\d+: [\d.]+ s of plain talk\n/)
  })

  it('is bare where nothing is up in it for too long', () => {
    const doc = talk()
    const { resolved, stretches } = read(doc)
    const all = bareStretches(stretches, [], resolved.words)
    expect(all).toHaveLength(2)
    expect(all.every((b) => b.end - b.start > LONGEST_BARE)).toBe(true)
    // A graphic in the middle of each leaves nothing long enough to say.
    const up = stretches.map((s) => ({ start: (s.start + s.end) / 2 - 3, end: (s.start + s.end) / 2 + 3 }))
    expect(bareStretches(stretches, up, resolved.words).every((b) => b.start > 25)).toBe(true)
    const fuller = [...up, { start: stretches[1].start + 4, end: stretches[1].start + 9 }, { start: stretches[1].end - 9, end: stretches[1].end - 4 }]
    expect(bareStretches(stretches, fuller, resolved.words)).toEqual([])
    const lines = bareLines(all, doc.words)
    expect(lines[0]).toMatch(/^w1 to w\d+, \d+ seconds with nothing new on screen: “word0 word1/)
    // The planner is asked to fill it, even when everything it made has passed.
    const asked = redoAsk([], '', [], lines)
    expect(asked).toContain('Left bare')
    expect(asked).toContain(lines[0])
    expect(asked).not.toContain('Not passed')
    expect(asked).toMatch(/Then call the plan tool/)
  })
})
