import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, JUMP_PUNCH, resolveCut, type Op, type Word } from '../shared/edit'
import { buildRenderArgs, segmentsFor, type RenderSource } from './cut-render'

/**
 * The export shows a punched jump cut as the preview does: the piece after
 * the jump carries the punch as its zoom, and the picture is cropped in by it.
 */

const SOURCE = { id: 's1', path: '/footage/review.mp4', durationSec: 30, width: 1080, height: 1920, fps: 30 }
const SOURCES: RenderSource[] = [{ ...SOURCE, hasAudio: true }]

function said(text: string, from: number, prefix: string): Word[] {
  return text.split(' ').map((w, i) => ({ id: `${prefix}${i}`, source: 's1', text: w, startSec: from + i * 0.32, endSec: from + i * 0.32 + 0.26 }))
}

const kept = said('It feels like a really expensive Chromebook.', 1, 'a')
const retake = said('Like the Chromebook you had in school.', 3.6, 'b')
const take = said('Like the Chromebook you had in school was maybe three hundred bucks.', 6.2, 'c')
const WORDS = [...kept, ...retake, ...take]

describe('a punched jump cut in the export', () => {
  it('crops the piece after the jump in by the punch, and leaves the one before as it was', () => {
    const doc = createDoc({ id: 'd', title: 'Review', source: SOURCE, words: WORDS })
    const ops: Op[] = [
      { op: 'aspect', aspect: 'vertical' },
      { op: 'strike', from: retake[0].id, to: retake[retake.length - 1].id },
      { op: 'punch-jumps', on: true }
    ]
    const cut = applyOps(currentCut(doc), ops, { words: WORDS, sources: [SOURCE] }).cut
    const resolved = resolveCut(cut, WORDS, [SOURCE])
    const segments = segmentsFor(cut, resolved, SOURCES)
    const before = segments.find((s) => s.startSec < 3)
    const after = segments.find((s) => s.startSec > 5)
    expect(before?.treatment?.zoom).toBe(1)
    expect(after?.treatment?.zoom).toBeCloseTo(JUMP_PUNCH)
    const args = buildRenderArgs(segments, {
      width: 1080,
      height: 1920,
      fps: 30,
      assPath: null,
      fontsDir: null,
      loudness: null,
      quality: 'final',
      outputPath: '/tmp/out.mp4'
    })
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain(`crop=trunc(iw/${JUMP_PUNCH.toFixed(4)}/2)*2`)
  })
})
