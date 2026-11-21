import { describe, expect, it } from 'vitest'
import { listenForFillers } from './filler-listen'
import type { HeardWord } from './whisper-parse'

/**
 * The two votes on each stretch no word accounts for, with the sound and
 * Whisper's answer standing in: what the owner's footage held (a breath, a
 * word's edge, a throat clear) is left alone, a held "uhhh" is written from
 * the sound, and a lone "Hmm." Whisper hears alone is written as itself.
 */

const RATE = 16000

/** A held vowel at one pitch, or noise. */
function sound(kind: 'vowel' | 'moving' | 'noise', sec: number): Float32Array {
  const out = new Float32Array(Math.round(sec * RATE))
  let seed = 3
  // The pitch's phase, carried sample to sample, so a moving pitch stays one voice.
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE
    const fade = Math.min(1, t / 0.02, (sec - t) / 0.02)
    if (kind === 'noise') {
      seed = (seed * 1103515245 + 12345) % 2147483648
      out[i] = (seed / 2147483648 - 0.5) * 0.3 * fade
      continue
    }
    const f0 = kind === 'vowel' ? 120 : 110 + 70 * Math.sin(2 * Math.PI * 3 * t)
    phase += (2 * Math.PI * f0) / RATE
    const f1 = kind === 'vowel' ? 620 : 400 + 350 * Math.abs(Math.sin(2 * Math.PI * 4 * t))
    let s = 0
    for (let k = 1; k * f0 < 4000; k++) s += (Math.exp(-(((k * f0 - f1) / 220) ** 2)) + 0.05) * Math.sin(k * phase)
    out[i] = 0.08 * s * fade
  }
  return out
}

const word = (text: string, startSec: number, endSec: number): HeardWord => ({ text, startSec, endSec, p: 0.9 })

describe('listening for the fillers Whisper left out', () => {
  // Words, and between them four voiced stretches with nothing written.
  const words = [word('So', 0, 0.4), word('today', 1.6, 2.0), word('we', 3.2, 3.4), word('start.', 4.6, 5.0), word('Okay', 6.2, 6.6)]
  const voiced = [{ startSec: 0, endSec: 6.6 }]
  // What each stretch sounds like, and what Whisper hears in it alone.
  const at = (s: number): { kind: 'vowel' | 'moving' | 'noise'; heard: string[] } =>
    s < 1.5
      ? { kind: 'noise', heard: ['Yeah.'] } // a breath, which Whisper calls "Yeah"
      : s < 3
        ? { kind: 'vowel', heard: [] } // a long "uhhh" Whisper writes nothing for
        : s < 4.5
          ? { kind: 'moving', heard: ['Hmm.'] } // a "hmm" that rises and falls
          : { kind: 'moving', heard: ['Okay.'] } // the edge of "Okay", already written

  it('writes the held vowel from its sound and the lone hmm from Whisper, and nothing else', async () => {
    const listened: number[] = []
    const found = await listenForFillers(words, voiced, {
      samples: async (s) => sound(at(s.startSec).kind, s.endSec - s.startSec),
      listen: async (span) => {
        listened.push(span.startSec)
        const mid = (span.startSec + span.endSec) / 2
        return at(mid).heard.map((text) => word(text, span.startSec + 0.1, span.endSec - 0.1))
      }
    })
    expect(found.map((w) => w.text)).toEqual(['uh', 'hmm'])
    // The uh is timed to its held sound, between the words around it.
    expect(found[0].startSec).toBeGreaterThan(2.0)
    expect(found[0].endSec).toBeLessThan(3.2)
    expect(found[1].startSec).toBeGreaterThan(3.4)
    // Breath is never sent to Whisper, nor a vowel the sound has already settled.
    expect(listened.every((s) => s > 3)).toBe(true)
    expect(listened).toHaveLength(2)
  })

  it('takes nothing where Whisper hears a real word or more than one sound', async () => {
    const found = await listenForFillers([word('So', 0, 0.4), word('then', 1.6, 2.0)], [{ startSec: 0, endSec: 2.1 }], {
      samples: async (s) => sound('moving', s.endSec - s.startSec),
      listen: async (span) => [word('um', span.startSec, span.startSec + 0.2), word('so', span.startSec + 0.3, span.endSec)]
    })
    expect(found).toEqual([])
  })
})
