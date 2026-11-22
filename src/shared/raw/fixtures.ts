import { wordsFromTranscript, type Word } from '../edit'

/**
 * Hand-timed transcripts for testing takes, written the way people retake.
 *
 * A script is text with marks:
 *   [words]   should be cut (ground truth)
 *   {words}   may be offered for cutting but must not be cut outright
 *   |0.8|     a pause of 0.8 s
 * Words are timed at a talking pace: about 0.32 s for a short word plus
 * 0.045 s a letter, 0.06 s between words, longer after commas and full stops.
 * Text is kept as Whisper would write it, cut-off stems and lone "-" included.
 */

export interface Fixture {
  name: string
  script: string
  /** Meant repetition: nothing may be cut outright. */
  nearMiss?: boolean
  /**
   * Words and timing alone cannot settle it; only the sound can. Reported,
   * but left out of precision and recall.
   */
  ambiguous?: string
}

export interface Built {
  words: Word[]
  /** Word ids that should be cut. */
  cut: Set<string>
  /** Word ids that may be offered but not cut. */
  soft: Set<string>
}

export interface BuildOptions {
  /** Each word edge moves by up to this many seconds, from a fixed seed. */
  jitter?: number
  seed?: number
  /** Every word runs on to the next one, as when Whisper's fallback closes the pauses. */
  closeGaps?: boolean
}

/** A small seeded random source, so a jittered fixture is the same every run. */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export function build(script: string, source = 's1', start = 0.6, opts: BuildOptions = {}): Built {
  const raw: { text: string; startSec: number; endSec: number; mark: 'cut' | 'soft' | null }[] = []
  const rand = seeded(opts.seed ?? 7)
  const wobble = (): number => (opts.jitter ? (rand() * 2 - 1) * opts.jitter : 0)
  let t = start
  let mark: 'cut' | 'soft' | null = null
  const tokens = script.match(/\|[\d.]+\||\[|\]|\{|\}|[^\s[\]{}|]+/g) ?? []
  for (const tok of tokens) {
    if (tok === '[') mark = 'cut'
    else if (tok === '{') mark = 'soft'
    else if (tok === ']' || tok === '}') mark = null
    else if (/^\|[\d.]+\|$/.test(tok)) t += Number(tok.slice(1, -1))
    else {
      const letters = tok.replace(/[^\p{L}\p{N}]/gu, '').length
      const dur = letters === 0 ? 0.08 : 0.12 + 0.045 * Math.min(letters, 10)
      const s = Math.max(raw.length ? raw[raw.length - 1].endSec + 0.01 : 0, t + wobble())
      raw.push({ text: tok, startSec: s, endSec: Math.max(s + 0.05, t + dur + wobble()), mark })
      t += dur + (/[.!?]$/.test(tok) ? 0.32 : /,$/.test(tok) ? 0.14 : 0.06)
    }
  }
  if (opts.closeGaps) for (let i = 0; i + 1 < raw.length; i++) raw[i].endSec = raw[i + 1].startSec
  const words = wordsFromTranscript(
    raw.map(({ text, startSec, endSec }) => ({ text, startSec, endSec })),
    source
  )
  const cut = new Set<string>()
  const soft = new Set<string>()
  raw.forEach((r, i) => {
    if (r.mark === 'cut') cut.add(words[i].id)
    if (r.mark === 'soft') soft.add(words[i].id)
  })
  return { words, cut, soft }
}

/**
 * The same fixture written the other ways Whisper and people vary: numbers
 * as digits, sentence punctuation missing, pauses shorter or longer, a
 * cut-off stem with its dash apart or with none, and every word edge moved.
 */
export const VARIANTS: { name: string; script: (s: string) => string; opts?: BuildOptions }[] = [
  { name: 'as written', script: (s) => s },
  {
    name: 'numbers as digits',
    script: (s) =>
      s.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (w) =>
        String(
          ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].indexOf(w.toLowerCase()) + 1
        )
      )
  },
  { name: 'no full stops', script: (s) => s.replace(/(\p{L}|\d)[.!?](?=\s|\]|\}|$)/gu, '$1') },
  {
    name: 'pauses 0.7 times',
    script: (s) => s.replace(/\|([\d.]+)\|/g, (_, x) => `|${(Number(x) * 0.7).toFixed(2)}|`)
  },
  {
    name: 'pauses 1.5 times',
    script: (s) => s.replace(/\|([\d.]+)\|/g, (_, x) => `|${(Number(x) * 1.5).toFixed(2)}|`)
  },
  { name: 'dash apart', script: (s) => s.replace(/(\p{L})-(?=\s|\])/gu, '$1 -') },
  { name: 'no dash', script: (s) => s.replace(/(\p{L})-(?=\s|\])/gu, '$1') },
  { name: 'edges jittered 40 ms', script: (s) => s, opts: { jitter: 0.04, seed: 11 } },
  {
    // What a fallback window writes: lower case, no punctuation, no pauses.
    name: 'run-on, no pauses',
    script: (s) =>
      s
        .replace(/(\p{L}|\d)[.!?,](?=\s|\]|\}|$)/gu, '$1')
        .replace(/(^|\s|\[|\{)(\p{Lu})(?=\p{Ll})/gu, (_, a, b) => a + b.toLowerCase()),
    opts: { closeGaps: true }
  }
]

/**
 * The fixture set: the owner's patterns first (whole lines again, backing up
 * mid-sentence, many takes, reworded takes), then breaks by laughs and groans,
 * cues, set-up talk, and the near-misses where repetition is meant.
 */
export const FIXTURES: Fixture[] = [
  {
    name: 'whole line said twice',
    script:
      "[Today I'm reviewing the Pixel 9 Pro.] |1.2| Today I'm reviewing the Pixel 9 Pro. Let's start with the camera."
  },
  {
    name: 'whole line, long silence between',
    script: "[The battery lasts two full days.] |4.0| The battery lasts two full days. That's the headline."
  },
  {
    name: 'whole line said again and taken further',
    script:
      "[Today I'm reviewing the Pixel 9 Pro.] |1.2| Today I'm reviewing the Pixel 9 Pro and the Watch. Let's start."
  },
  {
    name: 'back up a few words, cut-off stem',
    script:
      "I've been using this phone [for three ye- |0.45|] for three years now, and the battery still lasts all day."
  },
  {
    name: 'back up a few words, lone dash after the stem',
    script: "I've been using this phone [for three ye - |0.4|] for three years now."
  },
  {
    name: 'back up a few words, cut-off word missing',
    script: 'So [the best camera for |0.35|] the best camera for beginners is the Sony ZV-E10.'
  },
  {
    name: 'back up, Whisper completed the cut-off word',
    script: "I've been using this phone [for 3 years. |0.1|] For 3 years now, and it still feels new."
  },
  {
    name: 'back up with a filler',
    script: '[The battery lasts, uh, |0.2|] the battery lasts two days on a charge.'
  },
  {
    name: 'many takes, broken off, a groan, two complete',
    script:
      '[The RTX 5090 is the fastest graphics ca- |0.9| The RTX 5090 is the fa- |0.6| ugh. |1.1| The RTX 5090 is the fastest graphics card you can b- |1.0| The RTX 5090 is the fastest graphics card you can buy right now.] |1.3| The RTX 5090 is the fastest graphics card you can buy right now.'
  },
  {
    name: 'ten takes of one line',
    script:
      '[The M4 MacBook Air |0.8| The M4 MacBook Air is |0.7| The M4 MacBook Air is the |0.9| The M4 MacBook Air is the laptop |0.8| The M4 MacBook Air is the laptop I would |0.7| The M4 MacBook |0.6| The M4 MacBook Air is the laptop I would buy |0.9| The M4 MacBook Air is the |0.8| The M4 MacBook Air is the laptop I would buy today. |1.2|] The M4 MacBook Air is the laptop I would buy today.'
  },
  {
    name: 'reworded take',
    script:
      "[This laptop has the best battery I've tested this year.] |1.1| This laptop has the best battery life I've tested all year."
  },
  {
    name: 'retake spanning two sentences',
    script:
      '[Okay so this is the new iPhone. It has a titanium frame.] |1.0| Okay so this is the new iPhone. It has a titanium frame and a new button.'
  },
  {
    name: 'broken off by a laugh',
    script: '[The battery life is honestly kind of ha ha |0.8|] The battery life is honestly kind of amazing.'
  },
  {
    name: 'broken off by a sigh word',
    script: '[The screen is bright but the, ugh. |1.0|] The screen is bright, but the colours are a little cold.'
  },
  {
    name: 'spoken cue between takes',
    script:
      '[The speakers are loud. Sorry, let me say that again. |0.8|] The speakers are loud and clear, even at full volume.'
  },
  {
    name: 'set-up talk at the head',
    script: "[Is it recording? Okay. |1.5|] Hey everyone, welcome back to the channel. Today it's the Pixel 9 Pro."
  },
  {
    name: 'set-up talk at the tail',
    script: "That's it for today, I'll see you in the next one. |1.6| [Okay, cut.]"
  },
  {
    name: 'stutter on a function word',
    script: '[The the] the screen is really bright and it is easy to read outside.'
  },
  {
    name: 'the intro redone after a run of other lines',
    script:
      "[Hey everyone, welcome back. Today I'm reviewing the Pixel 9 Pro.] |0.8| Let's start with the camera. The main camera is a big step up. Low light is where it shines. |2.0| Hey everyone, welcome back. Today I'm reviewing the Pixel 9 Pro."
  },
  {
    name: 'two clean takes, the earlier one clearly better',
    script:
      "Today I'm reviewing the Pixel 9 Pro and the Watch. |1.2| [Today I'm, um, reviewing the, uh, uh, Pixel 9 |0.9| Pro and the Watch.]"
  },
  // Near-misses: repetition people mean. Nothing may be cut.
  {
    name: 'emphasis: never, never',
    script: 'Never, never buy a laptop with eight gigabytes of memory.',
    nearMiss: true
  },
  {
    name: 'emphasis: again and again',
    script: 'I tested it again and again and again, and it never failed.',
    nearMiss: true
  },
  {
    name: 'parallel lines that say different things',
    script: 'We tested the battery. We tested the screen. We tested the speakers.',
    nearMiss: true
  },
  {
    name: 'anaphora with different endings',
    script: 'We shall fight on the beaches, we shall fight on the landing grounds.',
    nearMiss: true
  },
  {
    name: 'a list with repeated articles',
    script: 'You get the phone, the charger, the case and the cable.',
    nearMiss: true
  },
  { name: 'grammatical that that', script: 'I know that that is the problem with this phone.', nearMiss: true },
  { name: 'contrast without a break', script: "It's not good, it's great.", nearMiss: true },
  {
    name: 'a refrain said on purpose, no break',
    script: 'One more time. One more time. We gonna celebrate.',
    nearMiss: true
  },
  {
    name: 'dramatic pause between repeated words',
    script: 'And the winner is |0.6| the winner is the Pixel.',
    ambiguous:
      'A held pause for drama and a restart look the same in words and timing; a loudness drop at "is" would say restart.'
  },
  {
    name: 'same start, different statement, after a pause',
    script: 'The camera is great in daylight. |0.9| The camera struggles at night, though.',
    nearMiss: true
  },
  {
    name: 'a near-identical line that swaps the last word',
    script: '{I love this phone because it is fast.} |0.6| I love this phone because it is light.',
    nearMiss: true
  }
]
