import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { readApiKey } from './apikey'
import { BED_MOODS, type BedMood } from './pads'
import { claude, MODEL } from './planner'

/**
 * The words a preacher leans on, picked by Claude for each clip of a set, so
 * the sermon captions can set them in the accent while the sentence builds
 * (shared/caption-presets 'sermon'): "EVEN IF YOU WERE THE ONE WHO LET GO",
 * with EVEN IF and LET GO in yellow. One call for the whole set. Without a
 * key, or when the call fails, no word is picked out and the captions are
 * all white, which still reads.
 */

export const KEY_WORDS_SYSTEM = `You mark the words a preacher leans on in short sermon clips, so the captions can set them in a highlight colour while the sentence builds on screen, as the big churches' Shorts do.

Each clip is given as numbered words. For each clip, return the numbers of the words to highlight.

What to mark: the clip's two to four strongest lines, and in each only the word or short phrase it lands on, the one the preacher hits hardest: the claim's key noun or verb ("sits down", "let go"), a contrast ("not by might"), a promise, the turn of the story. Each is set big on screen as its own moment, so they must be few and far apart: at most four in a clip, at least ten seconds between them, each one to three words. Mark a phrase as all its words ("more than a conqueror" is four numbers). Never mark filler, pronouns, articles, names of people, or words like "just", "really", "so", "yeah".

Also choose where each clip opens ("open", a word number): the first word of the strongest line in its first few sentences that a stranger can follow cold, the claim itself rather than the run-up to it. For "And, but if you will study religion, religion kills people, God saves people" that is the second "religion". 0 when the clip already opens on that line. It must start a sentence or a clause (after a full stop or a comma), within the first quarter of the clip, and never leave out what the rest of the clip needs.

Also write each clip's hook: the line on screen that makes a stranger stop scrolling, from what the clip itself says: the promise, the turn, the claim, the moment of the story ("The Doctors Said She'd Never Recover", "Religion Never Points You To God"). Title case, at most eight words, no emoji, no quotation marks, no full stop. Never a question to the viewer, never clickbait the clip does not pay off.

Also choose each clip's mood, for the music under it: "tense" for a warning, a confrontation or a hard truth said hard ("Religion kills people"); "hopeful" for a promise or a victory that lands, or comfort; "curious" for everything else: a story building, a question opened, teaching. Most clips are curious. Never hopeful under a clip that is fierce.`

export const KeyWordsSchema = z.object({
  clips: z.array(
    z.object({
      clip: z.number().int(),
      words: z.array(z.number().int()),
      hook: z.string(),
      open: z.number().int(),
      mood: z.enum(BED_MOODS)
    })
  )
})
export type KeyWords = z.infer<typeof KeyWordsSchema>

/** What Claude is sent: each clip's words, numbered from 0. */
export function keyWordsRequest(clips: string[][]): string {
  return clips
    .map((words, n) => `<clip n="${n}">\n${words.map((w, i) => `${i}:${w.replace(/[<>]/g, '')}`).join(' ')}\n</clip>`)
    .join('\n\n')
}

/** What Claude marked in each clip: its key words, by index into its words, and its hook ('' for none). */
export interface ClipMarks {
  keys: number[][]
  hooks: string[]
  /** The word each clip opens on, by index; 0 keeps its start. */
  opens: number[]
  /** What each clip's music should feel like. */
  moods: BedMood[]
}

/** A hook as it goes on screen: one line, no quotes or closing full stop, eight words at most. */
export function cleanHook(hook: string): string {
  const words = hook
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '')
    .split(' ')
    .filter(Boolean)
  return words.slice(0, 8).join(' ')
}

/** Key runs a clip may land, and words in each. */
const MOST_RUNS = 4
const RUN_WORDS = 4

/**
 * Claude's marks held to the rules: real words only, in order, in runs of at most four words, four runs at
 * most, the first four kept; hooks cleaned.
 */
export function readKeyWords(answer: KeyWords, clips: string[][]): ClipMarks {
  const keys = clips.map((words, n) => {
    const said = answer.clips.find((c) => c.clip === n)?.words ?? []
    const valid = [...new Set(said)].filter((i) => i >= 0 && i < words.length).sort((a, b) => a - b)
    const runs: number[][] = []
    let last = -2
    for (const i of valid) {
      const run = runs[runs.length - 1]
      // A run goes on while the words follow one another; past four words the rest of it is left plain.
      if (run && i === last + 1) {
        if (run.length < RUN_WORDS) run.push(i)
      } else runs.push([i])
      last = i
    }
    return runs.slice(0, MOST_RUNS).flat()
  })
  const hooks = clips.map((_, n) => cleanHook(answer.clips.find((c) => c.clip === n)?.hook ?? ''))
  // Within the first quarter, or kept where it was.
  const opens = clips.map((words, n) => {
    const open = answer.clips.find((c) => c.clip === n)?.open ?? 0
    return open > 0 && open < Math.floor(words.length / 4) ? open : 0
  })
  const moods = clips.map((_, n): BedMood => answer.clips.find((c) => c.clip === n)?.mood ?? 'curious')
  return { keys, hooks, opens, moods }
}

/** The key words and hook of each clip; none when there is no Claude to ask. */
export async function keyWordsFor(clips: string[][]): Promise<ClipMarks> {
  const none: ClipMarks = {
    keys: clips.map(() => []),
    hooks: clips.map(() => ''),
    opens: clips.map(() => 0),
    moods: clips.map((): BedMood => 'curious')
  }
  const apiKey = readApiKey()
  if (!apiKey || clips.length === 0) return none
  try {
    const response = await claude(apiKey).beta.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: KEY_WORDS_SYSTEM }],
      messages: [{ role: 'user', content: keyWordsRequest(clips) }],
      output_config: { effort: 'low', format: betaZodOutputFormat(KeyWordsSchema) }
    })
    const parsed = response.parsed_output
    return parsed ? readKeyWords(parsed, clips) : none
  } catch {
    return none
  }
}
