import { describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc, type Source } from '../edit'
import { directed, themeFrom } from './theme'
import { buildScene } from './scene'
import type { Layer, TextLayer } from './types'

/**
 * Graphics beside and under the speaker (templates/aside, templates/band): they move as the creators they were
 * measured from do, land on their words, and leave the face alone.
 */

const SAID = 'Famously Google has paid Apple billions of dollars over the years to be the default search engine in Safari. Obviously Apple does not make one but its users do search and need one.'

function talk(gap = 0.2): EditDoc {
  let t = 0.4
  const words = SAID.split(' ').map((text) => {
    const w = { text, startSec: t, endSec: t + 0.3 }
    t += /\.$/.test(text) ? 0.36 + gap : 0.36
    return w
  })
  const source = {
    id: 's1', path: '/talk.mov', durationSec: t + 1, width: 1920, height: 1080, fps: 30,
    faces: { everySec: 2, samples: Array.from({ length: Math.ceil(t) }, (_, i) => ({ t: i, faces: [[0.41, 0.18, 0.18, 0.34]] as [number, number, number, number][] })) }
  } as Source
  return createDoc({ id: 'd', title: 'Talk', source, words: wordsFromTranscript(words, 's1') })
}
const call = (over: Record<string, unknown>): Record<string, unknown> => ({ op: 'motion-add', text: [], items: [], values: [], box: [], icon: '', style: '', place: '', color: '', fx: [], layers: [], ...over })
function sceneOf(doc: EditDoc, over: Record<string, unknown>) {
  const d = commit(doc, [call(over)] as never, 'x').doc
  const cut = currentCut(d)
  const resolved = resolveCut(cut, d.words, d.sources)
  return { scene: buildScene({ cut, resolved, words: d.words, sources: d.sources, size: { width: 1920, height: 1080 }, theme: themeFrom(null), pictures: d.sources } as never), resolved }
}
const flat = (layers: Layer[]): Layer[] => layers.flatMap((l) => (l.kind === 'group' ? [l, ...flat(l.children)] : [l]))
const keysOf = (v: unknown): { t: number; v: number; from?: string }[] => ((v as { keys?: { t: number; v: number; from?: string }[] })?.keys ?? [])
const words = (doc: EditDoc, text: string): string => doc.words.find((w) => w.text.replace(/\W/g, '') === text)!.id
const FLOW = (doc: EditDoc) => ({
  kind: 'band', style: 'flow', from: words(doc, 'Google'), to: `${words(doc, 'Safari')}.end`, text: ['Billions', 'to be Safari’s default'],
  items: [{ label: 'Google', value: 'si:google', note: '', at: words(doc, 'Google') }, { label: 'Apple', value: 'si:apple', note: '', at: words(doc, 'Apple') }]
})

describe('along the foot and beside the speaker', () => {
  it('darkens the foot from under the chin, never the face', () => {
    const doc = talk()
    const { scene } = sceneOf(doc, FLOW(doc))
    const foot = scene.items[0].layers.find((l) => l.kind === 'shape' && typeof l.fill === 'object' && 'gradient' in (l.fill as object)) as Layer & { shape: { h: number }; transform: { y: number } }
    const top = foot.transform.y - foot.shape.h / 2
    expect(top).toBeGreaterThanOrEqual((0.18 + 0.34) * 1080)
  })

  it('lands an amount as it is said, after the things it goes between', () => {
    const doc = talk()
    const { scene, resolved } = sceneOf(doc, FLOW(doc))
    const item = scene.items[0]
    const amount = flat(item.layers).find((l) => l.kind === 'text' && (l as TextLayer).text === 'Billions') as TextLayer
    const said = resolved.words.find((w) => w.id === words(doc, 'billions'))!.outStart
    const comesIn = item.start + keysOf(amount.transform?.opacity)[0].t
    expect(comesIn).toBeGreaterThan(said - 0.7)
    expect(comesIn).toBeLessThan(said + 0.4)
  })

  it('comes in softly: a fade of a third of a second or more, on a settle of over a second, and nothing that overshoots', () => {
    const doc = talk()
    const shown = [
      FLOW(doc),
      { kind: 'band', style: 'figure', from: words(doc, 'billions'), to: `${words(doc, 'years')}.end`, text: ['$4 trillion', 'worth'] },
      { kind: 'band', style: 'line', from: words(doc, 'billions'), to: `${words(doc, 'Safari')}.end`, text: ['the *default* engine', 'for years'] },
      { kind: 'aside', style: 'stat', place: 'left', from: words(doc, 'billions'), to: `${words(doc, 'Safari')}.end`, text: ['Google pays', '$20B', 'a year'] },
      { kind: 'aside', style: 'list', place: 'left', from: words(doc, 'Obviously'), to: `${words(doc, 'users')}.end`, text: ['Apple'], items: [{ label: 'no search engine', value: 'x', note: '', at: '' }, { label: 'users who search', value: 'search', note: '', at: '' }] }
    ]
    for (const over of shown) {
      const { scene } = sceneOf(doc, over)
      expect(scene.items, JSON.stringify(scene.hidden)).toHaveLength(1)
      for (const l of flat(scene.items[0].layers)) {
        const fade = keysOf(l.transform?.opacity).filter((k) => k.from !== 'end')
        for (let i = 1; i < fade.length; i++) if (fade[i].v > fade[i - 1].v + 0.5) expect(fade[i].t - fade[i - 1].t, `${over.kind} ${over.style} fade`).toBeGreaterThanOrEqual(0.23)
        const scale = keysOf(l.transform?.scale)
        for (const k of scale) expect(k.v, `${over.kind} ${over.style} scale`).toBeLessThanOrEqual(1.3)
        const y = keysOf(l.transform?.y)
        if (y.length >= 2 && Math.abs(y[0].v - y[1].v) > 20) expect(y[1].t - y[0].t, `${over.kind} ${over.style} rise`).toBeGreaterThanOrEqual(1.2)
      }
    }
  })

  it('goes with its shot where a cut that shows comes next, and runs on where the take does', () => {
    const over = (doc: EditDoc) => ({ kind: 'aside', style: 'build', place: 'left', from: words(doc, 'Google'), to: `${words(doc, 'Safari')}.end+0.6`, text: ['Paid *billions*'] })
    const cutAway = talk(1.2)
    const a = sceneOf(cutAway, over(cutAway))
    const second = a.resolved.beats[1]
    expect(a.scene.items[0].end).toBeLessThanOrEqual(second.outStart + 1e-6)
    const runsOn = talk(0.2)
    const b = sceneOf(runsOn, over(runsOn))
    expect(b.scene.items[0].end).toBeGreaterThan(b.resolved.beats[1].outStart)
  })

  it('is out of the way before the next one comes in, where the two would only cross', () => {
    const doc = talk()
    const list = { kind: 'aside', style: 'list', place: 'left', from: words(doc, 'Safari'), to: `${words(doc, 'users')}.end`, text: ['Apple'], items: [{ label: 'no search engine', value: 'x', note: '', at: '' }, { label: 'users who search', value: 'search', note: '', at: '' }] }
    const d = commit(doc, [call(FLOW(doc)), call(list)] as never, 'x').doc
    const cut = currentCut(d)
    const scene = buildScene({ cut, resolved: resolveCut(cut, d.words, d.sources), words: d.words, sources: d.sources, size: { width: 1920, height: 1080 }, theme: themeFrom(null), pictures: d.sources } as never)
    const [flow, beside] = scene.items
    expect(flow.end).toBeLessThanOrEqual(beside.start + 0.11)
    // And it still leaves by moving.
    expect(flow.leaves).toBeDefined()
  })

  it('wears the video’s own direction, and a brand’s choices over it', () => {
    const house = themeFrom(null)
    const worn = directed(house, { accent: '#E8692C', display: 'Archivo Expanded Black', script: 'Instrument Serif Italic', ground: 'light' })
    expect(worn).toMatchObject({ accent: '#E8692C', display: 'Archivo Expanded Black', script: 'Instrument Serif Italic', ground: 'light' })
    const brand = { ...house, accent: '#123456', display: 'Anton' }
    expect(directed(brand, { accent: '#E8692C', display: 'Archivo Expanded Black' })).toMatchObject({ accent: '#123456', display: 'Anton' })
    // A colour or a face that is not one is left alone.
    expect(directed(house, { accent: 'red', display: 'Comic Sans MS' })).toMatchObject({ accent: house.accent, display: house.display })
  })
})
