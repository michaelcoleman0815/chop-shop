import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript } from '../edit'
import { scoreLab, type LabPiece } from './eval'
import { planTakes } from './plan'
import { normWord } from './text'
import lab from './lab-transcripts.json'

/**
 * Takes on what Whisper really wrote. Three transcripts of the same
 * synthetic session (docs/research/raw-footage.md, "The lab"), each scored
 * word by word against the splice log of what was planted. The transcripts
 * are recorded, so this runs anywhere, with no Whisper and no speech engine.
 */

const pieces = lab.pieces as LabPiece[]

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
      const score = scoreLab(words, new Set(cut.removed), pieces)
      console.log(
        `${name}: precision ${(score.precision * 100).toFixed(1)}%, recall ${(score.recall * 100).toFixed(1)}%` +
          (score.wrong.length ? `; cut wrongly: ${score.wrong.join(' ')}` : '') +
          (score.missed.length ? `; missed: ${score.missed.join(' ')}` : '') +
          `\n  ${plan.summary} ${plan.offerText}`
      )
      // What plays now opens on the intro that was redone at the end.
      const spoken = resolveCut(cut, doc.words, doc.sources).words.map((w) => normWord(w.text))
      expect(spoken.slice(0, 5)).toEqual(['hey', 'everyone', 'welcome', 'back', 'today'])
      expect(score.precision).toBeGreaterThanOrEqual(0.95)
      // In the swallowed run Whisper wrote nothing for the 5th take of the
      // graphics card line, so keeping the 4th, which the splice log marks
      // as cut, is the best the words allow: its 13 words count as missed.
      // The second listen (main/whisper-parse.test.ts) brings the take back.
      expect(score.recall).toBeGreaterThanOrEqual(name.includes('swallowed') ? 0.8 : 0.95)
    })
  }
})
