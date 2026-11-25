import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from './edit'
import { faceLine, facesThrough } from './faces'
import { buildScene } from './motion'
import { DEFAULT_THEME, designSize } from './motion/theme'
import type { TextLayer } from './motion/types'

const FACE: [number, number, number, number] = [0.4, 0.06, 0.18, 0.4]

/** A talking head shot wide, close up, his face high in the middle; nobody in it after 8 s. */
function talk(face = FACE): EditDoc {
  const words = Array.from({ length: 24 }, (_, i) => ({ text: i % 4 === 3 ? `word${i}.` : `word${i}`, startSec: 0.5 + i * 0.5, endSec: 0.9 + i * 0.5 }))
  const faces = { everySec: 1, samples: Array.from({ length: 14 }, (_, t) => ({ t, faces: t < 8 ? [face] : [] })) }
  const source = { id: 's1', path: '/talk.mov', durationSec: 14, width: 1920, height: 1080, fps: 30, faces }
  return createDoc({ id: 'd', title: 't', source, words: wordsFromTranscript(words, 's1') })
}
const through = (doc: EditDoc, ops: unknown[] = []) => {
  const cut = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources, assets: doc.assets }).cut
  return facesThrough(cut, resolveCut(cut, doc.words, doc.sources), doc.sources, designSize(cut.aspect, doc.sources[0]))
}

describe('faces through an edit', () => {
  it('puts each recording’s faces where they fall in the frame, as it is framed', () => {
    const plain = through(talk(), [{ op: 'aspect', aspect: 'wide' }])
    expect(plain[2].faces[0].x).toBeCloseTo(0.4, 2)
    // Punched in, the face is bigger and further out from the middle.
    const doc = talk()
    const close = through(doc, [{ op: 'aspect', aspect: 'wide' }, { op: 'treat', beats: currentCut(doc).beats.map((b) => b.id), set: { zoom: 1.25 } }])
    expect(close[2].faces[0].w).toBeCloseTo(0.18 * 1.25, 2)
    // Cropped upright, it fills far more of the width.
    const upright = through(doc, [{ op: 'aspect', aspect: 'vertical' }])
    expect(upright[2].faces[0].w).toBeGreaterThan(0.5)
    // Where no one is in the picture, no faces; with nothing read, nothing at all.
    expect(plain[plain.length - 1].faces).toEqual([])
    const unread = { ...doc, sources: doc.sources.map(({ faces: _faces, ...s }) => s) }
    expect(through(unread as EditDoc)).toEqual([])
  })

  it('tells the planner where the face is and the room round it', () => {
    const line = faceLine(through(talk(), [{ op: 'aspect', aspect: 'wide' }]), 1, 4)!
    expect(line).toBe("the speaker's face is at [0.40, 0.06, 0.18, 0.40]; room: left of it to 0.40, right of it from 0.58, above it to 0.06, below it from 0.46")
    expect(faceLine([], 0, 4)).toBeNull()
    expect(faceLine([{ t: 1, faces: [] }], 0, 4)).toBeNull()
  })

  it('keeps a title off the face: at the bottom when the face is in its way, where it was asked when it is clear', () => {
    const titleAt = (face: [number, number, number, number], place: string) => {
      const doc = talk(face)
      const cut = applyOps(
        currentCut(doc),
        [
          { op: 'aspect', aspect: 'wide' },
          { op: 'motion-add', kind: 'title', from: 'w5', to: '3s', text: ['They are', 'losing the AI race'], style: 'punch', place }
        ],
        { words: doc.words, sources: doc.sources, assets: doc.assets }
      ).cut
      const scene = buildScene({ cut, resolved: resolveCut(cut, doc.words, doc.sources), words: doc.words, size: designSize(cut.aspect, doc.sources[0]), theme: DEFAULT_THEME, pictures: doc.sources })
      const words = scene.items[0].layers.filter((l): l is TextLayer => l.kind === 'text')
      const xs = words.map((l) => Number(l.transform?.x ?? 960))
      return { align: words[0].align, x: Math.min(...xs), y: Math.max(...words.map((l) => Number(l.transform?.y ?? 540))) }
    }
    // His face high in the middle, as a close-up is: the title goes to the bottom, over the chest.
    for (const face of [FACE, [0.46, 0.06, 0.2, 0.4], [0.32, 0.06, 0.36, 0.5]] as [number, number, number, number][]) {
      for (const place of ['top', '']) {
        const low = titleAt(face, place)
        expect(low.align).toBe('center')
        expect(low.y).toBeGreaterThan(700)
      }
    }
    // A face that is nowhere near: where it was asked for.
    expect(titleAt([0.02, 0.5, 0.15, 0.3], 'top').y).toBeLessThan(400)
    expect(titleAt(FACE, 'left').align).toBe('left')
  })

  it('keeps a pop off the face: low, under the chin, without its icon when there is no room for both', () => {
    const at = (face: [number, number, number, number], place: string): { top: number; icon: boolean } => {
      const doc = talk(face)
      const cut = applyOps(
        currentCut(doc),
        [{ op: 'aspect', aspect: 'wide' }, { op: 'motion-add', kind: 'keyword', from: 'w5', text: ['Billions', 'to be the default'], icon: 'search', style: 'plate', place }],
        { words: doc.words, sources: doc.sources, assets: doc.assets }
      ).cut
      const scene = buildScene({ cut, resolved: resolveCut(cut, doc.words, doc.sources), words: doc.words, size: designSize(cut.aspect, doc.sources[0]), theme: DEFAULT_THEME, pictures: doc.sources })
      return { top: scene.items[0].band?.top ?? 0, icon: JSON.stringify(scene.items[0].layers).includes('"search"') }
    }
    for (const place of ['top', 'center', 'bottom']) {
      // His chin at 0.46 of the height: the pop is all under it.
      expect(at(FACE, place).top).toBeGreaterThan(0.46 * 1080)
      // A close-up down to 0.72: still under the chin, its icon gone.
      const close = at([0.32, 0.12, 0.34, 0.6], place)
      expect(close.top).toBeGreaterThan(0.7 * 1080)
      expect(close.icon).toBe(false)
      expect(at(FACE, place).icon).toBe(true)
    }
    // A face out at the side: where it was asked for.
    expect(at([0.8, 0.1, 0.15, 0.3], 'top').top).toBeLessThan(300)
  })
})
