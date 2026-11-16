import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript } from '../edit'
import { planTakes } from './plan'
import { normWord } from './text'
import lab from './lab-transcripts.json'

/**
 * Takes on what Whisper really wrote. Three transcripts of the same
 * synthetic session (docs/research/raw-footage.md, "The lab"), each scored
 * word by word against the splice log of what was planted. The transcripts
 * are recorded, so this runs anywhere, with no Whisper and no speech engine.
 */

interface Piece {
  kind: string
  text: string
  start: number
  end: number
  id?: string
  take?: number | string
}

interface Timed {
  text: string
  startSec: number
  endSec: number
}

const pieces = lab.pieces as Piece[]

/**
 * The planted piece a transcript word belongs to: the one it overlaps most.
 * Whisper stretches words over the silence beside them, so a word's middle
 * can sit in a gap; its overlap with the speech it stands for does not.
 */
function pieceOf(w: Timed): Piece | undefined {
  let best: Piece | undefined
  let top = 0
  for (const p of pieces) {
    const overlap = Math.min(w.endSec, p.end) - Math.max(w.startSec, p.start)
    if (overlap > top) {
      top = overlap
      best = p
    }
  }
  if (best) return best
  // No overlap at all: the nearest piece within half a second.
  const mid = (w.startSec + w.endSec) / 2
  const near = pieces.map((p) => ({ p, d: Math.max(p.start - mid, mid - p.end, 0) })).sort((a, b) => a.d - b.d)[0]
  return near && near.d <= 0.5 ? near.p : undefined
}

/** Whether a transcript word should be cut, from the piece it falls in and the words Whisper wrote after it there. */
function shouldCut(w: Timed, piece: Piece | undefined, laterInPiece: string[]): boolean {
  if (!piece) return false
  const { id, take, kind, start } = piece
  const plain = normWord(w.text)
  // The opening line was redone, reworded, at the end of the session.
  if (kind === 'line' && start < 1) return true
  if (id === 'L1') return take !== 3
  if (id === 'L2' && take === 1) return !['ive', 'been', 'using', 'this', 'phone'].includes(plain)
  if (id === 'L3' && take === 1) return plain !== 'so'
  if (id === 'L4') return take !== 5
  if (id === 'L5') return take === 1
  // "The the the screen": every "the" but the last one Whisper wrote goes.
  if (piece.text.startsWith('The the the')) return plain === 'the' && laterInPiece.includes('the')
  return false
}

describe('takes on recorded Whisper transcripts', () => {
  for (const [name, raw] of Object.entries(lab.transcripts)) {
    it(`finds the planted takes: ${name}`, () => {
      const words = wordsFromTranscript(
        (raw as { text: string; start: number; end: number }[]).map((w) => ({
          text: w.text,
          startSec: w.start,
          endSec: w.end
        })),
        's1'
      )
      const doc = createDoc({
        id: 'lab',
        title: 'Lab session',
        source: { id: 's1', path: '/lab/session.wav', durationSec: 85, width: 1920, height: 1080, fps: 30 },
        words
      })
      const plan = planTakes(doc)
      const cut = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources }).cut
      const struck = new Set(cut.removed)

      const placed = words.map((w) => ({ w, piece: pieceOf(w) }))
      let tp = 0
      let fp = 0
      let fn = 0
      const wrong: string[] = []
      const missed: string[] = []
      placed.forEach(({ w, piece }, k) => {
        const later = placed
          .slice(k + 1)
          .filter((x) => x.piece === piece)
          .map((x) => normWord(x.w.text))
        const truth = shouldCut(w, piece, later)
        if (struck.has(w.id) && truth) tp++
        else if (struck.has(w.id)) {
          fp++
          wrong.push(`${w.text}@${w.startSec.toFixed(1)}`)
        } else if (truth) {
          fn++
          missed.push(`${w.text}@${w.startSec.toFixed(1)}`)
        }
      })
      const precision = tp / Math.max(1, tp + fp)
      const recall = tp / Math.max(1, tp + fn)
      console.log(
        `${name}: precision ${(precision * 100).toFixed(1)}%, recall ${(recall * 100).toFixed(1)}%` +
          (wrong.length ? `; cut wrongly: ${wrong.join(' ')}` : '') +
          (missed.length ? `; missed: ${missed.join(' ')}` : '') +
          `\n  ${plan.summary} ${plan.offerText}`
      )
      // What plays now opens on the intro that was redone at the end.
      const spoken = resolveCut(cut, doc.words, doc.sources).words.map((w) => normWord(w.text))
      expect(spoken.slice(0, 5)).toEqual(['hey', 'everyone', 'welcome', 'back', 'today'])
      expect(precision).toBeGreaterThanOrEqual(0.95)
      // In the swallowed run Whisper wrote nothing for the 5th take of the
      // graphics card line, so keeping the 4th, which the splice log marks
      // as cut, is the best the words allow: its 13 words count as missed.
      expect(recall).toBeGreaterThanOrEqual(name.includes('swallowed') ? 0.8 : 0.95)
    })
  }
})
