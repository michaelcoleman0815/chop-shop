import { CAPTION_PRESETS } from './caption-presets'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { fileURLToPath } from 'url'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, DEFAULT_CAPTIONS, resolveCut, wordsFromTranscript } from './edit'
import { fontInfo, MOTION_FONTS } from './motion'
import {
  captionStyleFor,
  drawSubtitle,
  layoutSubtitle,
  SHADOW_ALPHA,
  subtitleAt,
  subtitleCues,
  subtitleWords,
  type SubtitleCue,
  type TextMeasurer, fitFontPx, plainWords, buildGroups, BUILD_HOLD_SEC, shownWords, landedGroups, styleCues, landsLine, CAPTION_HOLD_SEC } from './subtitles'
import type { TranscriptWord } from './types'

/**
 * Burned-in captions as the export draws them and the preview copies: the
 * cues, the layout by libass's rules and the drawing. Where libass really
 * puts them is checked against ffmpeg in main/subtitles-render.test.ts.
 */

const FONTS = fileURLToPath(new URL('../../resources/fonts/', import.meta.url))

beforeAll(() => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(FONTS + f.file, f.family)
})

const said = (texts: string[], from = 1, step = 0.4, each = 0.3): TranscriptWord[] =>
  texts.map((text, i) => ({ text, startSec: from + i * step, endSec: from + i * step + each }))

/**
 * A measurer with round numbers: every character half the em wide, ink from
 * the pen to the advance, 0.7 em up and 0.2 em down. Records what it was set to.
 */
function fakeMeasurer(): TextMeasurer & { fonts: string[] } {
  const m = {
    font: '',
    fontKerning: 'normal',
    fonts: [] as string[],
    measureText(text: string) {
      const em = Number(/([\d.]+)px/.exec(m.font)?.[1] ?? 10)
      m.fonts.push(m.font)
      const width = text.length * em * 0.5
      return {
        width,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: text.trim() ? width : 0,
        actualBoundingBoxAscent: 0.7 * em,
        actualBoundingBoxDescent: 0.2 * em
      }
    }
  }
  return m
}

const cueOf = (texts: string[], active = 0): SubtitleCue => ({
  start: 1,
  end: 2,
  words: said(texts),
  active
})

describe('subtitle cues', () => {
  it('shows each group with one word picked out, held until the next word starts', () => {
    const cues = subtitleCues(said(['one', 'two', 'three', 'four.', 'five']), 3)
    expect(cues.map((c) => [c.words.map((w) => w.text).join(' '), c.active])).toEqual([
      ['one two three', 0],
      ['one two three', 1],
      ['one two three', 2],
      ['four.', 0],
      ['five', 0]
    ])
    // Held to the next word's start, the group's last word too, so nothing blinks off between groups.
    expect(cues[0]).toMatchObject({ start: 1, end: 1.4 })
    expect(cues[2].end).toBeCloseTo(2.2)
    // The last word stays a moment after it is said.
    expect(cues[4].end).toBeCloseTo(cues[4].words[0].endSec + CAPTION_HOLD_SEC)
    // A pause of more than CAPTION_JOIN_SEC clears the screen, CAPTION_HOLD_SEC after the word.
    const paused = subtitleCues([...said(['Amen.']), { text: 'Next', startSec: 3, endSec: 3.3 }], 3)
    expect(paused[0].end).toBeCloseTo(1.3 + CAPTION_HOLD_SEC)
    // Before a card or a beat without captions, the caption ends with its word.
    const before = shownWords(
      [{ id: 'w1', text: 'Grace.', outStart: 1, outEnd: 1.3 }],
      {},
      [{ id: 'w1' }, { id: 'w2' }]
    )
    expect(subtitleCues([...before, ...said(['After'], 1.5)], 3)[0].end).toBeCloseTo(1.3)
    // A word too short to show still shows for a twentieth of a second, and stays its moment after.
    const blink = subtitleCues([{ text: 'a', startSec: 1, endSec: 1.01 }], 3)
    expect(blink[0].end).toBeCloseTo(1.01 + CAPTION_HOLD_SEC)
  })

  it('picks the cue on screen as libass does, to the hundredth: from its start, up to its end', () => {
    const cues = subtitleCues(said(['one', 'two', 'three.', 'four'], 1, 0.4), 3)
    expect(subtitleAt(cues, 0.99)).toBeNull()
    expect(subtitleAt(cues, 1)?.active).toBe(0)
    expect(subtitleAt(cues, 1.399)?.active).toBe(0)
    expect(subtitleAt(cues, 1.4)?.active).toBe(1)
    // Between "three." (out at 2.1) and "four" (in at 2.2) "three." stays: no blink.
    expect(subtitleAt(cues, 2.15)?.words[0].text).toBe('one')
    expect(subtitleAt(cues, 2.2)?.words[0].text).toBe('four')
  })

  it('leaves out the words of beats whose captions are off, and gives back the same cut when none are', () => {
    const words = wordsFromTranscript(said(['One', 'two.', 'Three', 'four.']), 's1')
    const source = { id: 's1', path: '/a.mov', durationSec: 4, width: 1920, height: 1080, fps: 30 }
    const doc = createDoc({ id: 'd', title: 't', source, words })
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    expect(subtitleWords(cut, resolved, { items: [] })).toBe(resolved)
    const off = applyOps(cut, [{ op: 'treat', beats: [cut.beats[0].id], set: { captions: false } }], {
      words: doc.words,
      sources: doc.sources
    }).cut
    const kept = subtitleWords(off, resolveCut(off, doc.words, doc.sources), { items: [] }).words.map((w) => w.text)
    expect(kept).not.toContain(resolved.words[0].text)
    expect(kept.length).toBeLessThan(resolved.words.length)
  })
})

describe('subtitle layout', () => {
  const wide = { width: 1920, height: 1080 }
  const tall = { width: 1080, height: 1920 }

  it("sizes a caption by the face's cell and stands its line on MarginV, centred between the margins", () => {
    const style = captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'clean', position: 'chest' }, wide.width)
    const m = fakeMeasurer()
    const layout = layoutSubtitle(cueOf(['Bright', 'colours']), style, wide, m)
    const sora = fontInfo('Sora')
    // Clean is Sora 70 at 1080 wide, so 124 at 1920: a cell 124 tall, an em of 124 / 1.54.
    expect(style.fontSizePx).toBe(124)
    const em = 124 / (sora.winAscent + sora.winDescent)
    expect(m.fonts[0]).toBe(`400 ${em.toFixed(2)}px "Sora"`)
    // libass does not kern, and neither does the measuring.
    expect(m.fontKerning).toBe('none')
    const [line] = layout.blocks[0].lines
    // MarginV is 1080 * (1 - 0.66), rounded: the cell's foot is 367 up from the bottom.
    expect(line.baseline + em * sora.winDescent).toBeCloseTo(1080 - 367)
    const first = line.runs[0]
    const last = line.runs[line.runs.length - 1]
    expect((first.x + last.x + last.width) / 2).toBeCloseTo(960)
    expect(line.runs.map((r) => r.text)).toEqual(['Bright', ' ', 'colours'])
    // The outline and the shadow are around and below the ink.
    expect(layout.bounds.x).toBeCloseTo(first.x - style.outlinePx)
    expect(layout.bounds.y + layout.bounds.h).toBeCloseTo(line.baseline + 0.2 * em + style.outlinePx + style.shadowPx)
  })

  it('scales the word being said from its pen, which makes its line a taller cell', () => {
    const style = captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'punch', position: 'bottom' }, tall.width)
    const flat = layoutSubtitle(cueOf(['Big', 'jump']), { ...style, activeScale: 1 }, tall, fakeMeasurer())
    const layout = layoutSubtitle(cueOf(['Big', 'jump'], 1), style, tall, fakeMeasurer())
    const [line] = layout.blocks[0].lines
    const big = line.runs[2]
    expect(big.font).toContain(`${((style.fontSizePx / 1.347) * 1.16).toFixed(2)}px`)
    expect(big.color).toBe(style.activeColor)
    expect(line.runs[0].color).toBe(style.textColor)
    // The foot stays where it was; the baseline rises by the scaled descent.
    const d = (style.fontSizePx / 1.347) * 0.312
    expect(line.baseline).toBeCloseTo(flat.blocks[0].lines[0].baseline - d * 0.16)
  })

  it('breaks a line too wide for the margins at a space, then evens the lines out with the top one wider', () => {
    const style = { ...captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'stack', position: 'middle' }, tall.width) }
    // The margins leave 1080 - 2 * 86 = 908 pixels; each character is half an em of 54.9 here.
    const layout = layoutSubtitle(
      cueOf(['AAAAAAAA', 'BBBBBBBB', 'CC', 'DDDD', 'EEEEEEEEE']),
      { ...style, activeScale: 1 },
      tall,
      fakeMeasurer()
    )
    const lines = layout.blocks[0].lines.map((l) =>
      l.runs
        .filter((r) => r.text.trim())
        .map((r) => r.text)
        .join(' ')
    )
    // Greedily only the last word goes down; moving DDDD and then CC down after it evens the lines out.
    expect(lines).toEqual(['AAAAAAAA BBBBBBBB', 'CC DDDD EEEEEEEEE'])
    const [top, bottom] = layout.blocks[0].lines
    const em = style.fontSizePx / 1.347
    // Stacked cell on cell, the last cell's foot on MarginV.
    expect(bottom.baseline - top.baseline).toBeCloseTo(style.fontSizePx)
    expect(bottom.baseline + em * 0.312).toBeCloseTo(1920 - Math.round(1920 * 0.48))
    // A word wider than the margins stays whole on its own line.
    const long = layoutSubtitle(cueOf(['W'.repeat(40), 'x']), style, tall, fakeMeasurer())
    expect(long.blocks[0].lines.map((l) => l.runs.length)).toEqual([1, 1])
  })

  it('draws the second tier under the word being said, gapPx below its foot', () => {
    const style = captionStyleFor(
      { ...DEFAULT_CAPTIONS, preset: 'feature', position: 'middle', wordsPerScreen: 5 },
      wide.width
    )
    const layout = layoutSubtitle(cueOf(['one', 'two', 'three'], 1), style, wide, fakeMeasurer())
    expect(layout.blocks).toHaveLength(2)
    const [big, rest] = layout.blocks
    expect(big.lines[0].runs.map((r) => r.text)).toEqual(['two'])
    expect(big.lines[0].runs[0].color).toBe(style.textColor)
    expect(rest.lines[0].runs.filter((r) => r.text.trim()).map((r) => r.text)).toEqual(['one', 'three'])
    const tier = style.second as NonNullable<typeof style.second>
    const marginV = Math.round(1080 * (1 - 0.52))
    const sora = fontInfo('Sora')
    const em2 = tier.fontSizePx / (sora.winAscent + sora.winDescent)
    expect(rest.lines[0].baseline + em2 * sora.winDescent).toBeCloseTo(1080 - (marginV - tier.gapPx))
    // The tier is bold: libass draws it a 64th of its em wider.
    expect(rest.embolden).toBeCloseTo(em2 / 64)
    expect(big.embolden).toBe(0)
  })

  it('puts a boxed style on a plate of its cells, the outline width out on every side', () => {
    const style = captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'marker', position: 'top' }, wide.width, {
      text: '#101010',
      accent: '#202020'
    })
    const layout = layoutSubtitle(cueOf(['one', 'two']), style, wide, fakeMeasurer())
    const [line] = layout.blocks[0].lines
    expect(layout.blocks[0].box).toBe('#c8f04a')
    // The brand's colours reach the words.
    expect(line.runs[0].color).toBe('#202020')
    expect(line.runs[2].color).toBe('#101010')
    const first = line.runs[0]
    const last = line.runs[2]
    const b = layout.bounds
    expect(b.x).toBeCloseTo(first.x - style.outlinePx)
    expect(b.y).toBeCloseTo(line.baseline - first.ascent - style.outlinePx)
    expect(b.w).toBeCloseTo(last.x + last.width - first.x + 2 * style.outlinePx)
    expect(b.h).toBeCloseTo(style.fontSizePx + 2 * style.outlinePx)
  })
})

describe('subtitle drawing', () => {
  /** The box of every pixel drawn. */
  function inked(data: Uint8ClampedArray, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = w
    let y0 = h
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (data[(y * w + x) * 4 + 3] > 24) {
          x0 = Math.min(x0, x)
          y0 = Math.min(y0, y)
          x1 = Math.max(x1, x + 1)
          y1 = Math.max(y1, y + 1)
        }
    return { x0, y0, x1, y1 }
  }

  it('draws inside the laid-out bounds, at any scale, with the shadow laid down once', () => {
    const style = captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'clean', position: 'chest' }, 1920)
    for (const scale of [1, 0.5]) {
      const w = 1920 * scale
      const h = 1080 * scale
      const canvas = createCanvas(w, h)
      const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
      const layout = layoutSubtitle(cueOf(['Bright', 'colours'], 1), style, { width: 1920, height: 1080 }, ctx)
      drawSubtitle(ctx, layout, scale, (cw, ch) => createCanvas(cw, ch) as unknown as HTMLCanvasElement)
      const got = inked(ctx.getImageData(0, 0, w, h).data, w, h)
      const b = layout.bounds
      expect(Math.abs(got.x0 - b.x * scale)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(got.y0 - b.y * scale)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(got.x1 - (b.x + b.w) * scale)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(got.y1 - (b.y + b.h) * scale)).toBeLessThanOrEqual(1.5)
      if (scale === 1) {
        // Just below and right of the outline at the line's last letter: shadow only, at its one alpha.
        const line = layout.blocks[0].lines[0]
        const last = line.runs[line.runs.length - 1]
        const data = ctx.getImageData(0, 0, w, h).data
        const x = Math.round(last.x + last.ink.right + style.outlinePx + style.shadowPx / 2)
        let alpha = 0
        for (let y = Math.round(line.baseline - 20); y < Math.round(line.baseline + 10); y++)
          alpha = Math.max(alpha, data[(y * w + x) * 4 + 3])
        expect(alpha / 255).toBeCloseTo(SHADOW_ALPHA, 1)
      }
    }
  })
})

describe('the sermon serif look', () => {
  const sermon = CAPTION_PRESETS.find((p) => p.id === 'sermon-serif')!.style
  it('sets a long word smaller so it stays inside the frame, and a short one at full size', () => {
    expect(fitFontPx(['whenever'], sermon, 1080)).toBe(sermon.fontSizePx)
    const long = fitFontPx(['understanding'], sermon, 1080)
    expect(long).toBeLessThan(sermon.fontSizePx)
    // Thirteen letters at the face's width fill no more than the frame less its margins.
    expect(13 * (sermon.letterEm ?? 0) * long).toBeLessThanOrEqual(1080 * 0.84)
  })

  it('stays white under a brand with a yellow accent: a look with no highlight keeps none', () => {
    const style = captionStyleFor(
      { on: true, wordsPerScreen: 1, position: 'middle', preset: 'sermon-serif', uppercase: false },
      1080,
      { text: '#FFFFFF', accent: '#FFD84D' }
    )
    expect(style.activeColor).toBe('#FFFFFF')
    const marker = captionStyleFor(
      { on: true, wordsPerScreen: 3, position: 'chest', preset: 'stack', uppercase: true },
      1080,
      { text: '#FFFFFF', accent: '#FFD84D' }
    )
    expect(marker.activeColor).toBe('#FFD84D')
  })
})

describe('plain one-word captions', () => {
  it('shows each word bare, lower-casing only a capital a sentence gave it', () => {
    const said = ['So', 'religion', 'kills', 'people,', 'and', 'God', 'saves', 'people.', 'Religion', 'never', 'says?"', 'I', 'know.', '"And', 'Jesus', 'wept."']
    const shown = plainWords(said.map((text) => ({ text, startSec: 0, endSec: 0 }))).map((w) => w.text)
    expect(shown).toEqual(['so', 'religion', 'kills', 'people', 'and', 'God', 'saves', 'people', 'religion', 'never', 'says', 'I', 'know', 'and', 'Jesus', 'wept'])
  })
})

describe('built captions', () => {
  const sermon = captionStyleFor(
    { on: true, wordsPerScreen: 8, position: 'chest', preset: 'sermon-build', uppercase: true },
    1080,
    { text: '#FFFFFF', accent: '#FFD84D' }
  )

  it('breaks a sentence where the speaker does: at its end, at a pause, at a comma once it has words, at eight', () => {
    const words = said(['Even', 'if', 'you', 'were', 'the', 'one', 'who', 'let', 'go.', 'God', 'is', 'not', 'done,', 'and', 'he', 'restores.'])
    expect(buildGroups(words, 8).map((g) => g.map((w) => w.text).join(' '))).toEqual([
      'Even if you were the one who let',
      'go.',
      'God is not done, and he restores.'
    ])
    // A pause of more than six tenths of a second clears the screen.
    const paused = [...said(['When', 'I', 'pray']), { text: 'everything', startSec: 3, endSec: 3.4 }]
    expect(buildGroups(paused, 8).map((g) => g.length)).toEqual([3, 1])
  })

  it('never shows a dash or a stray mark as a word', () => {
    const cues = subtitleCues(said(['-', 'I', 'was', 'preaching', '...', 'there.']), 8, true, true)
    expect(cues.map((c) => c.words[c.active].text)).toEqual(['I', 'was', 'preaching', 'there'])
  })

  it('shows each word from when it is said and holds the sentence a moment after its last', () => {
    const words = [...said(['We', 'are', 'more', 'than', 'conquerors.']), ...said(['Amen.'], 6)]
    const cues = subtitleCues(words, 8, true, true)
    expect(cues.map((c) => c.active)).toEqual([0, 1, 2, 3, 4, 0])
    const last = cues[4]
    expect(last.end).toBeCloseTo(words[4].endSec + BUILD_HOLD_SEC, 5)
    // Plain: no punctuation on screen, and no capital a sentence gave.
    expect(last.words.map((w) => w.text)).toEqual(['we', 'are', 'more', 'than', 'conquerors'])
    // The next sentence starting sooner than the hold cuts it short.
    const close = [...said(['He', 'is', 'risen.']), ...said(['Amen.'], 2.15)]
    const held = subtitleCues(close, 8, true, true)[2]
    expect(held.end).toBeCloseTo(2.15, 5)
  })

  it('lays the sentence out whole and draws only the words said, the key ones in the accent', () => {
    expect(sermon.build).toBe(true)
    expect(sermon.keyColor).toBe('#FFD84D')
    expect(sermon.activeColor).toBe('#FFFFFF')
    const words = shownWords(
      [
        { id: 'w1', text: 'More', outStart: 1, outEnd: 1.3 },
        { id: 'w2', text: 'than', outStart: 1.4, outEnd: 1.6 },
        { id: 'w3', text: 'conquerors', outStart: 1.7, outEnd: 2.2 },
        { id: 'w4', text: 'through', outStart: 2.3, outEnd: 2.5 },
        { id: 'w5', text: 'him', outStart: 2.6, outEnd: 2.8 }
      ],
      { keys: ['w1', 'w2', 'w3'] }
    )
    const cues = subtitleCues(words, sermon.wordsPerGroup, true, true)
    const frame = { width: 1080, height: 1920 }
    const early = layoutSubtitle(cues[1], sermon, frame, fakeMeasurer())
    const late = layoutSubtitle(cues[4], sermon, frame, fakeMeasurer())
    const runs = (l: typeof early): { text: string; x: number; color: string; hidden?: boolean }[] =>
      l.blocks[0].lines.flatMap((line) => line.runs).filter((r) => r.text.trim())
    // Every word has its place from the first, so nothing moves as the sentence fills in.
    expect(runs(early).map((r) => r.x)).toEqual(runs(late).map((r) => r.x))
    expect(runs(early).map((r) => !!r.hidden)).toEqual([false, false, true, true, true])
    expect(runs(late).map((r) => r.color)).toEqual(['#FFD84D', '#FFD84D', '#FFD84D', '#FFFFFF', '#FFFFFF'])
    // What is drawn is what is said: the words not said yet are outside the bounds.
    expect(early.bounds.w).toBeLessThan(late.bounds.w)
  })
})

describe('landed lines', () => {
  const sermon = captionStyleFor(
    { on: true, wordsPerScreen: 3, position: 'middle', preset: 'sermon', uppercase: false },
    1080,
    { text: '#FFFFFF', accent: '#FFD84D' }
  )
  const words = (texts: string[], keys: number[] = []): TranscriptWord[] =>
    said(texts).map((w, i) => (keys.includes(i) ? { ...w, key: true } : w))

  it('shows three words at a time, as said, and lets a key run finish its screen', () => {
    const w = words(['Look', 'at', 'the', 'flag', 'and', 'he', 'still', 'sits', 'down.', 'Every', 'week.'], [7, 8])
    // The landed line starts two words before its key run, so it reads as a phrase: "he still / sits down."
    expect(landedGroups(w, 3).map((g) => g.map((x) => x.text).join(' '))).toEqual([
      'Look at the',
      'flag and',
      'he still sits down.',
      'Every week.'
    ])
    // Never across a sentence's end.
    const after = words(['Amen.', 'Religion', 'kills', 'people.'], [2])
    expect(landedGroups(after, 3).map((g) => g.map((x) => x.text).join(' '))).toEqual(['Amen.', 'Religion kills', 'people.'])
  })

  it('keeps a look’s own red under a brand with a yellow accent', () => {
    const red = captionStyleFor(
      { on: true, wordsPerScreen: 3, position: 'middle', preset: 'sermon-red', uppercase: false },
      1080,
      { text: '#FFFFFF', accent: '#FFD84D' }
    )
    expect(red.keyColor).toBe('#FF3B30')
  })

  it('sets one word at a time in clean heavy capitals, no punctuation', () => {
    const word = captionStyleFor({ on: true, wordsPerScreen: 1, position: 'middle', preset: 'sermon-word', uppercase: true }, 1080)
    const cues = styleCues(words(['Just', 'be', 'a', 'good', 'believer.']), word)
    // Shown in capitals, so a sentence's own capital is let go with its punctuation.
    expect(cues.map((c) => c.words.map((w) => w.text))).toEqual([['just'], ['be'], ['a'], ['good'], ['believer']])
    expect(word.fontFamily).toBe('Inter ExtraBold')
    // The tall condensed version stays a look of its own.
    expect(captionStyleFor({ on: true, wordsPerScreen: 1, position: 'middle', preset: 'sermon-word-tall', uppercase: true }, 1080).fontFamily).toBe('Bebas Neue')
    // A long word still fits between the margins.
    expect(fitFontPx(['GLORIFYING'], word, 1080)).toBe(word.fontSizePx)
  })

  it('never picks out the word being said, whatever accent the brand brings', () => {
    expect(sermon.activeColor).toBe('#FFFFFF')
    expect(sermon.keyColor).toBe('#FFD84D')
  })

  it('sets a screen with a key word big in the heavy face, the key words in yellow on their own line', () => {
    const cues = styleCues(words(['He', 'still', 'sits', 'down.'], [2, 3]), sermon)
    expect(cues.every((c) => landsLine(c, sermon))).toBe(true)
    const layout = layoutSubtitle(cues[3], sermon, { width: 1080, height: 1920 }, fakeMeasurer())
    const lines = layout.blocks[0].lines.map((l) => l.runs.filter((r) => r.text.trim()))
    expect(lines.map((l) => l.map((r) => r.text).join(' '))).toEqual(['He still', 'sits down.'])
    expect(lines[1].every((r) => r.color === '#FFD84D')).toBe(true)
    expect(lines[0].every((r) => r.color === '#FFFFFF')).toBe(true)
    expect(lines[0][0].font).toContain('Inter ExtraBold')
    // A screen with no key word stays small and white.
    const plain = styleCues(words(['and', 'he', 'said']), sermon)
    expect(landsLine(plain[0], sermon)).toBe(false)
  })

  it('never shows a dash Whisper wrote at a turn, punctuation kept or not', () => {
    expect(styleCues(words(['-', 'I', 'was', 'preaching.']), sermon).map((c) => c.words[c.active].text)).toEqual([
      'I',
      'was',
      'preaching.'
    ])
  })

  it('writes a quiet look in lower case', () => {
    const quiet = captionStyleFor({ on: true, wordsPerScreen: 3, position: 'middle', preset: 'sermon-quiet', uppercase: false }, 1080)
    expect(styleCues(words(['She', 'Was', 'healed.']), quiet)[0].words.map((w) => w.text)).toEqual(['she', 'was', 'healed.'])
  })
})
