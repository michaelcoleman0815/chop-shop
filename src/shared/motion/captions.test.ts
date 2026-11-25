import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { fileURLToPath } from 'url'
import { beforeAll, describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../edit'
import { describePlan, CAPTION_STYLE_PRESETS, planStyle } from '../presets'
import {
  buildScene,
  captionLayers,
  DEFAULT_THEME,
  designSize,
  drawsCaptions,
  frameFor,
  hierarchyPages,
  MOTION_FONTS,
  OTHER_VOICE,
  POP_LIT,
  renderFrame,
  splitPage,
  textUnits,
  type FaceSample,
  type MotionScene,
  type TextLayer
} from '.'

/**
 * Hierarchy captions: pages of two lines, a small one and a big one, each
 * word fading up as it is said, on the speaker's chest and off every face.
 * Checked on the export's canvas.
 */

const FONTS = fileURLToPath(new URL('../../../resources/fonts/', import.meta.url))

beforeAll(() => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(FONTS + f.file, f.family)
})

const SCRIPT =
  'Then once after you buy, you will be able to hold that asset. It costs $999 today. ' +
  'Most people never open the settings, and that is where the good stuff is.'

function docWith(aspect: 'vertical' | 'wide', ops: unknown[] = [], script = SCRIPT): EditDoc {
  let t = 0.5
  const words = script.split(' ').map((text) => {
    const w = { text, startSec: t, endSec: t + 0.3 }
    t += /[.,]$/.test(text) ? 0.55 : 0.36
    return w
  })
  const vertical = aspect === 'vertical'
  const source = {
    id: 's1',
    path: '/take.mov',
    durationSec: t + 1,
    width: vertical ? 1080 : 1920,
    height: vertical ? 1920 : 1080,
    fps: 30
  }
  const doc = createDoc({ id: 'd', title: 't', source, words: wordsFromTranscript(words, 's1') })
  const r = commit(
    doc,
    [{ op: 'aspect', aspect }, { op: 'captions', set: { on: true, preset: 'hierarchy', position: 'chest' } }, ...ops],
    'x'
  )
  expect(r.rejected).toEqual([])
  return r.doc
}

function sceneOf(doc: EditDoc, faces?: FaceSample[], emphasis?: Record<string, number>): MotionScene {
  const cut = currentCut(doc)
  return buildScene({
    cut,
    resolved: resolveCut(cut, doc.words, doc.sources),
    words: doc.words,
    size: designSize(cut.aspect, doc.sources[0]),
    theme: DEFAULT_THEME,
    faces,
    emphasis
  })
}

function draw(scene: MotionScene, t: number) {
  const { width, height } = scene.size
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
  renderFrame(ctx, t, scene.layers, scene.size, scene.size)
  const data = ctx.getImageData(0, 0, width, height).data
  /** Bright pixels: the white letters, not their shadow. */
  const lit = (x0: number, y0: number, w: number, h: number): number => {
    let n = 0
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(height, y0 + h); y++)
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(width, x0 + w); x++) {
        const i = (y * width + x) * 4
        if (data[i + 3] > 160 && data[i] > 200) n++
      }
    return n
  }
  return { ctx, lit }
}

const captionsIn = (scene: MotionScene): TextLayer[] =>
  scene.layers.filter(
    (l): l is TextLayer => l.kind === 'text' && (l.animators ?? []).some((a) => a.timing === 'spoken')
  )

/** Where a page's word sits on the frame, from the layout the drawing uses. */
function wordBox(layer: TextLayer, index: number, t: number) {
  const ctx = createCanvas(8, 8).getContext('2d') as unknown as CanvasRenderingContext2D
  const { block } = textUnits(ctx, layer, t)
  const w = block.words[index]
  const x = (layer.transform?.x as number) ?? 0
  const y = (layer.transform?.y as number) ?? 0
  return { x: x + w.x, y: y + w.baseline - w.cap, w: w.w, h: w.cap, size: w.size }
}

describe('hierarchy captions', () => {
  it('opens on a caption: the first page’s first word is in on the first frame, the rest as they are said', () => {
    // The first word, "Then", is said at 0.5 s.
    const scene = sceneOf(docWith('vertical'))
    const first = captionsIn(scene)[0]
    expect(first.start).toBeLessThan(0)
    const { lit } = draw(scene, 0)
    const { size } = scene
    expect(lit(0, 0, size.width, size.height)).toBeGreaterThan(200)
    // Only "Then": the next word, said at 0.86 s, is not up yet.
    const second = wordBox(first, 1, 0 - first.start)
    expect(draw(scene, 0).lit(second.x, second.y, second.w, second.h)).toBeLessThan(20)
    expect(draw(scene, 1.4).lit(second.x, second.y, second.w, second.h)).toBeGreaterThan(20)
  })

  it('pages at sentence ends, cuts and pauses, sharing a long sentence out evenly at good breaks', () => {
    const doc = docWith('vertical')
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    const pages = hierarchyPages(resolved.words, 6).map((p) => p.map((w) => w.text).join(' '))
    expect(pages.slice(0, 4)).toEqual([
      'Then once after you buy,',
      'you will be able',
      'to hold that asset.',
      'It costs $999 today.'
    ])
    for (const p of pages) {
      expect(p.split(' ').length).toBeLessThanOrEqual(6)
      expect(p.split(' ').length).toBeGreaterThan(1)
    }
    // A pause ends a page too.
    const paused = resolved.words.map((w, i) => (i === 1 ? { ...w, outEnd: w.outEnd - 0.4 } : w))
    expect(hierarchyPages(paused, 6)[0].map((w) => w.text)).toEqual(['Then', 'once'])
    // A page too quick to read joins the next: "Yes." said in a quarter second.
    const quick = [
      { id: 'a', text: 'Yes.', beat: 'b1', outStart: 0, outEnd: 0.2 },
      { id: 'b', text: 'Lock', beat: 'b1', outStart: 0.25, outEnd: 0.5 },
      { id: 'c', text: 'it.', beat: 'b1', outStart: 0.55, outEnd: 0.8 }
    ]
    expect(hierarchyPages(quick, 6).map((p) => p.map((w) => w.text))).toEqual([['Yes.', 'Lock', 'it.']])
  })

  it('puts the key words on the big line: the voice’s stress when known, the words themselves otherwise', () => {
    const words = ['It', 'costs', '$999', 'today.'].map((text, i) => ({ id: `w${i + 1}`, text }))
    // The number carries the page.
    expect(splitPage(words)).toMatchObject({ big: 'second', at: 2 })
    // Stress moves it.
    const stressed = splitPage(words, { w1: 0.1, w2: 0.9, w3: 0.2, w4: 0.1 })
    expect(stressed.big === 'first' ? words.slice(0, stressed.at) : words.slice(stressed.at)).toContainEqual(words[1])
    // One word is one big line.
    expect(splitPage([words[2]])).toEqual({ at: 1, big: 'first' })
    // The big line stays short enough to be one line.
    const long = ['you', 'will', 'be', 'able', 'to', 'transparently', 'self-custody'].map((text, i) => ({
      id: `x${i}`,
      text
    }))
    const s = splitPage(long, undefined, 16)
    const big = s.big === 'first' ? long.slice(0, s.at) : long.slice(s.at)
    expect(big.map((w) => w.text).join(' ').length).toBeLessThanOrEqual(16)
  })

  it('sets big only the key words the edit chose, and the pages without one as one small centred line', () => {
    const doc = docWith('vertical')
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const asset = resolved.words.find((w) => w.text.startsWith('asset'))!
    const chosen = commit(doc, [{ op: 'captions', set: { keys: [asset.id] } }], 'x').doc
    const pages = captionsIn(sceneOf(chosen))
    const withKey = pages.find((p) => p.spans!.some((s) => s.text.includes('asset')))!
    expect(withKey.spans!.filter((s) => s.scale === 1).map((s) => s.text.trim())).toEqual(['asset'])
    // The first page has no chosen word: every word small and centred, on one line.
    const first = pages[0]
    expect(new Set(first.spans!.map((s) => s.scale))).toEqual(new Set([0.6]))
    expect(first.spans!.every((s) => s.align === 'center' && !s.text.includes('\n'))).toBe(true)
  })

  it('sets a key word in the look its meaning asks for: serif, red serif or heavy capitals', () => {
    const doc = docWith('vertical')
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    const id = (t: string) => resolved.words.find((w) => w.text.startsWith(t))!.id
    const looked = commit(
      doc,
      [{ op: 'captions', set: { keyLooks: { [id('asset')]: 'dark', [id('$999')]: 'punch', [id('settings')]: 'serif' } } }],
      'x'
    ).doc
    const spans = captionsIn(sceneOf(looked)).flatMap((p) => p.spans!)
    const span = (t: string) => spans.find((s) => s.text.trim().startsWith(t))!
    expect(span('asset')).toMatchObject({ family: 'Instrument Serif', color: '#E5322D', scale: 1.6 })
    expect(span('$999')).toMatchObject({ family: 'Inter ExtraBold', uppercase: true })
    expect(span('settings')).toMatchObject({ family: 'Instrument Serif' })
    expect(span('settings').color).toBeUndefined()
    // A chosen word mid-sentence closes its page, so it alone takes the big line.
    const mid = commit(doc, [{ op: 'captions', set: { keyLooks: { [id('people')]: 'serif' } } }], 'x').doc
    const people = captionsIn(sceneOf(mid)).find((p) => p.spans!.some((s) => s.text.trim() === 'people'))!
    expect(people.spans!.map((s) => s.text.trim()).join(' ')).toBe('Most people')
    expect(people.spans!.filter((s) => s.scale! > 1).map((s) => s.text.trim())).toEqual(['people'])
    // A run of key words stays together on its page.
    const run = commit(doc, [{ op: 'captions', set: { keys: [id('Most'), id('people')] } }], 'x').doc
    expect(captionsIn(sceneOf(run)).some((p) => p.spans!.map((s) => s.text.trim()).join(' ') === 'Most')).toBe(false)
    // A word with a look is a chosen key word: it goes big without being listed in keys.
    expect(span('asset').scale).toBeGreaterThan(1)
    // And it draws in its own face.
    const scene = sceneOf(looked)
    const page = captionsIn(scene).find((p) => p.spans!.some((s) => s.text.includes('asset')))!
    expect(() => draw(scene, page.start + 0.9)).not.toThrow()
  })

  it('sets a page said by the other voice in yellow, and the voice heard most in white', () => {
    const doc = docWith('vertical')
    // The last sentence is the host's.
    const host = doc.words.findIndex((w) => w.text === 'Most')
    const told = { ...doc, words: doc.words.map((w, i) => ({ ...w, speaker: i >= host ? 1 : 0 })) }
    const pages = captionsIn(sceneOf(told))
    const fills = pages.map((p) => [p.spans!.map((s) => s.text.trim()).join(' '), p.fill])
    expect(fills.filter(([, f]) => f === OTHER_VOICE).map(([t]) => t).join(' ')).toMatch(/^Most people never open/)
    expect(fills[0][1]).toBe(DEFAULT_THEME.text)
    // One voice, or voices not told apart: every page in the text colour.
    expect(captionsIn(sceneOf(doc)).every((p) => p.fill === DEFAULT_THEME.text)).toBe(true)
    // A voice heard in only a word or two is the finder slipping, not someone else: no yellow.
    const slip = { ...doc, words: doc.words.map((w) => ({ ...w, speaker: w.text === 'Most' ? 2 : 0 })) }
    expect(captionsIn(sceneOf(slip)).every((p) => p.fill === DEFAULT_THEME.text)).toBe(true)
  })

  it('fades each word up as it is said, the big line bigger, and changes page when the next begins', () => {
    const doc = docWith('vertical')
    const scene = sceneOf(doc)
    const pages = captionsIn(scene)
    expect(pages.length).toBeGreaterThan(3)
    const first = pages[0]
    const sizes = new Set(first.spans!.map((s) => s.scale))
    expect(sizes).toEqual(new Set([1, 0.68]))
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    const w2 = resolved.words[1]
    const box = wordBox(first, 1, w2.outStart + 0.5)
    const ink = (t: number) => draw(scene, t).lit(box.x, box.y, box.w, box.h)
    const settled = ink(w2.outStart + 0.5)
    expect(settled).toBeGreaterThan(150)
    // Not before it is said; part way in just after.
    expect(ink(w2.outStart - 0.08)).toBe(0)
    expect(ink(w2.outStart + 0.08)).toBeLessThan(settled * 0.8)
    // The next page replaces it: never two pages at once.
    for (let i = 1; i < pages.length; i++) expect(pages[i].start).toBeGreaterThanOrEqual(pages[i - 1].end - 1e-9)
    // The big words are bigger on the page.
    const bigWord = first.spans!.findIndex((s) => s.scale === 1)
    const smallWord = first.spans!.findIndex((s) => s.scale === 0.68)
    expect(wordBox(first, bigWord, w2.outStart + 1).size).toBeCloseTo(86)
    expect(wordBox(first, smallWord, w2.outStart + 1).size).toBeCloseTo(86 * 0.68)
    // Shown without the comma it was transcribed with.
    expect(first.spans!.map((s) => s.text.trim()).join(' ')).toBe('Then once after you buy')
  })

  it('sits low in the middle without faces, inside the safe area, in both shapes', () => {
    for (const aspect of ['vertical', 'wide'] as const) {
      const scene = sceneOf(docWith(aspect))
      const frame = frameFor(scene.size)
      for (const page of captionsIn(scene)) {
        expect(page.transform?.x).toBeCloseTo(scene.size.width / 2)
        expect(page.transform?.y as number).toBeCloseTo(scene.size.height * (aspect === 'vertical' ? 0.6 : 0.62))
      }
      // Drawn at a moment every word of a page is in: nothing outside the safe area.
      const page = captionsIn(scene)[1]
      const { lit } = draw(scene, page.end - 0.2)
      const { width, height } = scene.size
      const inside = lit(
        frame.safe.left,
        frame.safe.top,
        width - frame.safe.left - frame.safe.right,
        height - frame.safe.top - frame.safe.bottom
      )
      expect(inside, aspect).toBeGreaterThan(500)
      expect(lit(0, 0, width, height), aspect).toBe(inside)
    }
  })

  it('goes on the speaker’s chest, under their face, and keeps off every face', () => {
    const doc = docWith('wide')
    const speaker = { x: 0.32, y: 0.12, w: 0.12, h: 0.24 }
    const other = { x: 0.52, y: 0.42, w: 0.1, h: 0.2 }
    const faces: FaceSample[] = [{ t: 0, faces: [speaker, other] }]
    const scene = sceneOf(doc, faces)
    const pages = captionsIn(scene)
    const { width: W, height: H } = scene.size
    for (const page of pages) {
      // Under the speaker's chin, and below the other face it would otherwise cross.
      expect(page.transform?.y as number).toBeGreaterThanOrEqual((other.y + other.h) * H)
    }
    for (const page of pages.slice(0, 4)) {
      const { lit } = draw(scene, page.end - 0.15)
      for (const f of [speaker, other]) expect(lit(f.x * W, f.y * H, f.w * W, f.h * H)).toBe(0)
      expect(lit(0, 0, W, H)).toBeGreaterThan(300)
    }
  })

  it('never runs under a keyword pop: it steps over one when the face is clear of it, else waits for it', () => {
    // The pager Short: "PAGED" on a plate with a bell, low in a vertical frame, and the captions at the chest.
    const base = docWith('vertical')
    const said = base.words.find((w) => w.text === '$999')!.id
    const doc = commit(
      base,
      [{ op: 'motion-add', kind: 'keyword', from: said, text: ['$999'], icon: 'tag', style: 'plate', place: 'bottom' }],
      'x'
    ).doc
    const words = (page: TextLayer, t: number) => page.spans!.map((_, i) => wordBox(page, i, t))
    const under = (scene: MotionScene) => {
      const pop = scene.items[0]
      expect(pop.band).toBeDefined()
      const { top, bottom } = pop.band!
      return captionsIn(scene)
        .filter((p) => p.start < pop.end && p.end > pop.start)
        .filter((p) => words(p, Math.max(p.start, pop.start) + 0.01).some((w) => w.y < bottom && w.y + w.h > top))
    }
    // No faces known, as in an export: over the pop may be over the mouth, and there is no room under it.
    const blind = sceneOf(doc)
    expect(under(blind)).toEqual([])
    const pop = blind.items[0]
    const during = captionsIn(blind).filter((p) => p.start < pop.end && p.end > pop.start)
    expect(during).toEqual([])
    // The page before it stops as it comes, and the one after waits for it to go.
    expect(captionsIn(blind).some((p) => Math.abs(p.end - pop.start) < 1e-6)).toBe(true)
    // A close-up whose face ends well above the pop: the page goes just over the pop, off the face.
    const face = { x: 0.3, y: 0.12, w: 0.4, h: 0.26 }
    const seen = sceneOf(
      doc,
      Array.from({ length: 40 }, (_, i) => ({ t: i * 0.5, faces: [face] }))
    )
    expect(under(seen)).toEqual([])
    const over = captionsIn(seen).filter((p) => p.start < seen.items[0].end && p.end > seen.items[0].start)
    expect(over.length).toBeGreaterThan(0)
    for (const p of over) {
      const y = p.transform?.y as number
      expect(y).toBeLessThan(seen.items[0].band!.top)
      expect(y).toBeGreaterThan((face.y + face.h) * seen.size.height)
    }
  })

  it('pops each word up as it is said, slanted, the word being said lit yellow and the key words kept yellow', () => {
    const base = docWith('vertical')
    const id = (text: string) => base.words.find((w) => w.text === text)!.id
    const doc = commit(base, [{ op: 'captions', set: { preset: 'pop', wordsPerScreen: 3, keys: [id('asset.')] } }], 'x').doc
    const scene = sceneOf(doc)
    const pages = captionsIn(scene)
    expect(pages.length).toBeGreaterThan(5)
    for (const p of pages) expect(p.font.slant).toBeCloseTo(0.2126)
    // The second word of a page past the opening, with a word after it on the page.
    const page = pages.slice(1).find((p) => p.spans!.length >= 3)!
    const at = 1
    const said = page.start + page.spans![at].t!
    const yellow = (t: number) => {
      const { ctx } = draw(scene, t)
      const box = wordBox(page, at, t)
      const data = ctx.getImageData(box.x, box.y, box.w, box.h).data
      let lit = 0
      let white = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 200) continue
        if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] < 90) lit++
        else if (data[i] > 220 && data[i + 1] > 220 && data[i + 2] > 220) white++
      }
      return { lit, white }
    }
    // Not up before it is said; up and yellow while it is; white once the next word is said.
    expect(yellow(Math.max(page.start + 0.02, said - 0.1))).toEqual({ lit: 0, white: 0 })
    expect(yellow(said + 0.12).lit).toBeGreaterThan(200)
    const next = page.start + page.spans![at + 1].t! + 0.15
    expect(yellow(next).white).toBeGreaterThan(200)
    expect(yellow(next).lit).toBeLessThan(20)
    // Room between slanted words: the lean of one never closes the gap to the next.
    const settled = page.end - 0.2
    const first = wordBox(page, 0, settled)
    const second = wordBox(page, 1, settled)
    expect(second.x - (first.x + first.w)).toBeGreaterThan(page.font.size * 0.35)
    // A key word stays yellow after it is said.
    const keyPage = pages.find((p) => p.spans!.some((s) => s.text === 'asset'))!
    expect(keyPage.spans!.find((s) => s.text === 'asset')!.color).toBe(POP_LIT)
  })

  it('never leaves a word said quickly on a page of its own, where it would blink: "I did / save"', () => {
    // Quick speech, the key word "did" mid-sentence: it ends its page, and "save" follows in 0.16 s.
    const timed = [
      ['I', 4.0, 4.12], ['did', 4.14, 4.4], ['save', 4.46, 4.62], ['Rey', 4.68, 4.9], ['Mysterio.', 4.92, 5.5]
    ] as const
    const words = wordsFromTranscript(timed.map(([text, startSec, endSec]) => ({ text, startSec, endSec })), 's1')
    const source = { id: 's1', path: '/take.mov', durationSec: 7, width: 1080, height: 1920, fps: 30 }
    let doc = createDoc({ id: 'd', title: 't', source, words })
    const did = doc.words.find((w) => w.text === 'did')!.id
    doc = commit(doc, [{ op: 'captions', set: { on: true, preset: 'pop', wordsPerScreen: 3, keys: [did] } }], 'x').doc
    const pages = captionsIn(sceneOf(doc))
    const shown = pages.flatMap((p) => p.spans!.map((s) => s.text))
    expect(shown).toEqual(['I', 'did', 'save', 'Rey', 'Mysterio'])
    for (const p of pages) expect(p.end - p.start).toBeGreaterThan(0.3)
  })

  it('sits drawn captions on a split’s seam, as the burned-in ones sit', () => {
    const base = docWith('vertical')
    const beat = currentCut(base).beats[1].id
    const doc = commit(
      base,
      [
        { op: 'captions', set: { preset: 'pop' } },
        { op: 'treat', beats: [beat], set: { frame: 'split', broll: { path: '/match.mp4', inSec: 0, muted: true } } }
      ],
      'x'
    )
    expect(doc.rejected).toEqual([])
    const scene = sceneOf(doc.doc)
    const resolved = resolveCut(currentCut(doc.doc), doc.doc.words, doc.doc.sources)
    const over = new Set(resolved.words.filter((w) => w.beat === beat).map((w) => w.text.replace(/[.,]$/, '')))
    const pages = captionsIn(scene)
    const onSplit = pages.filter((p) => p.spans!.some((s) => over.has(s.text)))
    expect(onSplit.length).toBeGreaterThan(0)
    for (const p of onSplit) {
      // Anchored by its foot, however many lines its words take.
      expect(p.valign).toBe('bottom')
      expect(p.transform?.y as number).toBeCloseTo(0.488 * scene.size.height, 3)
      // Its foot just above the seam: the page's top is its height above 0.488 of the frame.
      const box = wordBox(p, 0, p.end - p.start - 0.05)
      expect(box.y + box.h).toBeLessThan(0.488 * scene.size.height + 4)
      expect(box.y + box.h).toBeGreaterThan(0.488 * scene.size.height - 60)
    }
    // Pages elsewhere stay on the chest.
    const rest = pages.filter((p) => !onSplit.includes(p))
    for (const p of rest) expect(p.transform?.y as number).toBeGreaterThan(0.55 * scene.size.height)
  })

  it('waits while a card holds the screen, and comes back over a backdrop in the middle', () => {
    const doc = docWith('vertical', [
      { op: 'motion-add', kind: 'end-card', from: 'end-3', to: 'end', text: ['Thanks'] }
    ])
    const scene = sceneOf(doc)
    const card = scene.items[0]
    for (const page of captionsIn(scene)) expect(page.end <= card.start + 1e-9 || page.start >= card.end).toBe(true)
    // A backdrop: the picture is gone, so a page goes in the middle of the frame.
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const frame = frameFor(designSize('vertical', doc.sources[0]))
    const over = captionLayers({
      spec: cut.captions,
      resolved,
      frame,
      theme: DEFAULT_THEME,
      duration: resolved.durationSec,
      covers: [{ start: 0, end: 4, kind: 'backdrop' }]
    }) as TextLayer[]
    const inMiddle = over.filter((l) => l.start < 4)
    expect(inMiddle.length).toBeGreaterThan(0)
    for (const l of inMiddle) expect(l.transform?.y as number).toBeLessThan(960)
  })

  it('turns on with /hierarchy, and says what it did', () => {
    const doc = createDoc({
      id: 'd',
      title: 't',
      source: { id: 's1', path: '/x.mov', durationSec: 5, width: 1080, height: 1920, fps: 30 },
      words: wordsFromTranscript([{ text: 'Hello', startSec: 0.5, endSec: 0.9 }], 's1')
    })
    const preset = CAPTION_STYLE_PRESETS.find((p) => p.command === 'hierarchy')!
    const plan = planStyle(doc, preset.style)
    expect(plan.ops).toEqual([{ op: 'captions', set: { on: true, preset: 'hierarchy', position: 'chest' } }])
    const after = commit(doc, plan.ops, 'x').doc
    const resolve = (d: EditDoc) => resolveCut(currentCut(d), d.words, d.sources)
    expect(describePlan(plan.ops, resolve(doc), resolve(after))).toBe(
      'Captions come in word by word, in two lines with the key words big.'
    )
  })

  it('leaves subtitles to the subtitle pass: only the hierarchy look is drawn', () => {
    const plain = createDoc({
      id: 'd',
      title: 't',
      source: { id: 's1', path: '/x.mov', durationSec: 5, width: 1080, height: 1920, fps: 30 },
      words: wordsFromTranscript([{ text: 'Hello', startSec: 0.5, endSec: 0.9 }], 's1')
    })
    const cut = currentCut(plain)
    expect(drawsCaptions(cut.captions)).toBe(false)
    expect(captionsIn(sceneOf(plain))).toEqual([])
    expect(drawsCaptions({ on: true, preset: 'hierarchy' })).toBe(true)
    expect(drawsCaptions({ on: false, preset: 'hierarchy' })).toBe(false)
  })
})
