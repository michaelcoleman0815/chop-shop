import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { fileURLToPath } from 'url'
import { beforeAll, describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../edit'
import { buildScene, DEFAULT_THEME, designSize, layerTravel, MOTION_FONTS, renderFrame, templates, type MotionScene } from '.'
import { leaveOf } from './leave'

/**
 * Every graphic leaves by moving: a fade alone is not an exit. Looked at as it is drawn, in its last half second.
 */

const FONTS = fileURLToPath(new URL('../../../resources/fonts/', import.meta.url))
beforeAll(() => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(FONTS + f.file, f.family)
})

const SCRIPT =
  'Most people never open the settings. The main camera is 48 megapixels and it costs $999 with a 120 Hz screen. Bitcoin then Ethereum and Solana. First lock the exposure, second set the white balance, third turn off stabilisation. That is all, so subscribe.'
function doc(aspect: 'vertical' | 'wide' = 'wide'): EditDoc {
  let t = 0.5
  const words = SCRIPT.split(' ').map((text) => {
    const w = { text, startSec: t, endSec: t + 0.3 }
    t += 0.4
    return w
  })
  const vertical = aspect === 'vertical'
  return createDoc({ id: 'd', title: 't', source: { id: 's1', path: '/t.mov', durationSec: t + 1, width: vertical ? 1080 : 1920, height: vertical ? 1920 : 1080, fps: 30 }, words: wordsFromTranscript(words, 's1') })
}
function sceneOf(d: EditDoc, call: Record<string, unknown>): MotionScene | null {
  const made = commit(d, [{ op: 'motion-add', text: [], items: [], values: [], box: [], icon: '', style: '', place: '', color: '', fx: [], layers: [], ...call }] as never, 'x')
  if (made.rejected.length) return null
  const cut = currentCut(made.doc)
  return buildScene({ cut, resolved: resolveCut(cut, made.doc.words, made.doc.sources), words: made.doc.words, size: designSize(cut.aspect, made.doc.sources[0]), theme: DEFAULT_THEME })
}
/** How far anything of a graphic moves in its last half second, in shares of the frame's width. */
function moved(scene: MotionScene): number {
  const item = scene.items[0]
  const ctx = createCanvas(scene.size.width, scene.size.height).getContext('2d') as unknown as CanvasRenderingContext2D
  let most = 0
  for (const layer of scene.layers) {
    let m = 0
    for (let t = item.end - 0.5; t < item.end - 0.01; t += 1 / 30) m += layerTravel(ctx, layer, t, 1 / 30, scene.size)
    most = Math.max(most, m)
  }
  return most / scene.size.width
}
/** The lit pixels of a scene at a moment: how many, and where they are centred. */
function seen(scene: MotionScene, t: number): { n: number; x: number; y: number } {
  const { width: W, height: H } = scene.size
  const c = createCanvas(W, H)
  const ctx = c.getContext('2d')
  renderFrame(ctx as unknown as CanvasRenderingContext2D, t, scene.layers, scene.size, scene.size, { createCanvas: (w: number, h: number) => createCanvas(w, h) as never } as never)
  const d = ctx.getImageData(0, 0, W, H).data
  let n = 0
  let x = 0
  let y = 0
  for (let j = 0; j < H; j += 6)
    for (let i = 0; i < W; i += 6) {
      // Bright: the words and figures, not the washes under them.
      const p = (j * W + i) * 4
      if (d[p + 3] > 150 && d[p] + d[p + 1] + d[p + 2] > 380) {
        n++
        x += i
        y += j
      }
    }
  return { n, x: n ? x / n : 0, y: n ? y / n : 0 }
}

describe('how graphics leave', () => {
  it('moves everything that is meant to leave, in both shapes', () => {
    for (const aspect of ['wide', 'vertical'] as const) {
      const d = commit(doc(aspect), [{ op: 'aspect', aspect }] as never, 'x').doc
      const still: string[] = []
      let checked = 0
      for (const tpl of templates())
        for (const style of tpl.styles?.length ? tpl.styles : ['']) {
          const call = { ...tpl.example.call, kind: tpl.kind, ...(style ? { style } : {}) }
          const way = leaveOf({ place: '', style: '', ...call } as never)?.way
          // Pushed through, a map is measured by its size, not its travel.
          if (!way || way === 'through') continue
          const scene = sceneOf(d, call)
          if (!scene?.items.length || !scene.items[0].leaves) continue
          checked++
          if (moved(scene) < 0.012) still.push(`${tpl.kind} ${style}`)
        }
      expect(checked).toBeGreaterThan(25)
      expect(still, aspect).toEqual([])
    }
  }, 200000)

  it('slides what stands beside the speaker off to its own side, line by line, opaque until it is nearly gone', () => {
    const d = doc()
    for (const [place, way] of [['left', -1], ['right', 1]] as const) {
      const scene = sceneOf(d, { kind: 'aside', style: 'build', place, from: 'w7', to: 'w16.end', text: ['The main camera', '*is 48*', 'and it costs'] })!
      const { end } = scene.items[0]
      const settled = seen(scene, end - 1)
      const going = seen(scene, end - 0.36)
      expect((going.x - settled.x) * way, place).toBeGreaterThan(20)
      expect(going.n).toBeGreaterThan(settled.n * 0.4)
      // Off the frame, not gone pale in it.
      expect(seen(scene, end - 0.06).n).toBeLessThan(settled.n * 0.1)
      expect(seen(scene, end + 0.01).n).toBe(0)
      // The first line goes before the last.
      const children = scene.items[0].leaves!.filter((l) => l.kind === 'group').map((l) => ((l.transform?.x as { keys: { t: number; from?: string }[] })?.keys ?? []).filter((k) => k.from === 'end')[0]?.t ?? 0)
      expect(new Set(children).size).toBeGreaterThan(1)
    }
  })

  it('sinks what lies along the foot down out of it', () => {
    const scene = sceneOf(doc(), { kind: 'band', style: 'figure', from: 'w7', to: 'w16.end', text: ['$4 trillion', 'worth'] })!
    const { end } = scene.items[0]
    expect(seen(scene, end - 0.15).y).toBeGreaterThan(seen(scene, end - 1).y + 60)
    expect(seen(scene, end + 0.01).n).toBe(0)
  })

  it('undraws a line that was drawn on', () => {
    const scene = sceneOf(doc(), { kind: 'callout', style: 'underline', from: 'w7', to: 'w14.end', text: [], box: [0.3, 0.4, 0.3, 0.1] })!
    expect(JSON.stringify(scene.layers)).toContain('"start":{"keys":[{"t":0,"v":0}')
  })

  it('leaves alone what ends on a cut, and what is up too briefly to be seen to go', () => {
    for (const call of [{ kind: 'title', style: 'behind', place: '' }, { kind: 'title', style: 'stair', place: '' }, { kind: 'board', style: 'plain', place: '' }, { kind: 'end-card', style: '', place: '' }, { kind: 'screenshot', style: 'slide', place: '' }])
      expect(leaveOf(call as never), `${call.kind} ${call.style}`).toBeNull()
    const brief = sceneOf(doc(), { kind: 'band', style: 'figure', from: 'w7', to: 'w7.end+0.4', text: ['$4', 'x'] })!
    expect(brief.items[0].leaves).toBeUndefined()
  })
})
