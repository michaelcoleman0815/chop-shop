import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { readApiKey } from './apikey'
import type { SuggestedClip, Transcript } from '../shared/types'
import { normaliseClips, transcriptLines } from './clip-shape'


const ClipsSchema = z.object({
  clips: z.array(
    z.object({
      startSec: z.number().describe('Start time in seconds, on a sentence boundary'),
      endSec: z.number().describe('End time in seconds, on a sentence boundary'),
      title: z.string().describe('Five words or fewer, no punctuation at the end'),
      hook: z.string().describe('The opening line as spoken, quoted from the transcript'),
      reason: z.string().describe('One sentence on why this stands alone'),
      score: z.number().describe('0 to 100 confidence that this holds attention')
    })
  )
})

const SYSTEM = `You find the moments in a long recording that work as standalone
short vertical clips, judging from the transcript alone.

Work in this order.

FIRST, the gate. Discard anything that fails these rather than trying to fix it:
- Cold-open test. Reading only the words inside the clip, would a stranger who
  has never heard this recording know who is speaking about what, and why it
  matters? If not, discard it. Do not extend the window to rescue it.
- Closed loop. A question asked, a problem set up, or a story begun inside the
  clip must also be answered, solved or finished inside it. An open loop that
  resolves later is a failed clip, not a teaser.
- Thought boundaries, not sentence boundaries. A grammatically complete last
  sentence that leaves the idea unfinished is a failure. Check the final words
  for pivots: "so anyway", "which brings me to", "but the thing is", "now, the
  second thing".

Disqualify outright:
- Opening on a pronoun with no antecedent inside the clip: it, that, this, he,
  they, "that was when".
- Backreference: "like we talked about earlier", "as I said", "last week",
  "in verse 3 we saw".
- A premise that is off-screen: laughter or a punchline whose setup is missing,
  or pointing at something visual ("look at this", "the slide behind me").
- Throat-clearing openers: greetings, housekeeping, "before I get into it",
  "turn with me to chapter four".
- Sponsor reads, subscribe asks, announcements, event dates, sign-up
  instructions, room directions.
- Names, books or passages referenced as though already known.
- Agreement between speakers with no new information and no friction.
- An extreme line that ends immediately before the speaker qualifies or
  reverses it. Never select for shock by cutting away the qualifier.

SECOND, the hook. Score the first sentence on its own; it must carry weight
without what follows, ideally inside about twelve words. Strongest openings,
roughly in order: a claim that contradicts something the viewer assumes; an
admission that cost the speaker something; a specific question aimed at a real
pain, not a generic one; a hard number, date or superlative; the middle of an
action ("I was nineteen with forty dollars left"). Begin on the strongest line
even if that means starting mid-sentence, and leave out the run-up. A hook with
nothing after it is still a bad clip: at least one further beat of substance
must follow.

THIRD, the shape. Roughly two thirds setup, one third payoff, with the payoff
landing before the end rather than on the last word. The strongest line opens
and the second strongest closes; a clip that ends on its weakest sentence loses
the replay. One clip, one idea: split a window holding two thoughts and judge
each separately.

What is worth clipping, in rough order: a personal story with concrete stakes;
a candid admission of failure or struggle; a claim that contradicts consensus;
a specific number, date or figure; a reframe that makes a familiar idea land
differently; a direct challenge to the viewer; genuine disagreement between two
speakers. Prefer the concrete to the abstract, and a problem a stranger already
has to one that assumes membership of the room.

For a sermon or talk: testimony and disclosed struggle travel furthest, then a
hard truth, then a story with stakes told whole, then a familiar passage
reframed with one line of application. A story starts at its first concrete
detail and ends at its stated meaning, and both must be inside the clip. What
does not travel: announcements, giving appeals, series recaps, worship, doctrine
with no story, and anything addressed to the room ("those of you visiting").
Where a moment states a human problem in plain words rather than in-house
vocabulary, rank it higher.

For an interview or podcast: a guest's surprising admission, a concrete war
story with numbers, a contrarian claim, or real disagreement. Include the host's
question only when the answer is unintelligible without it, and prefer questions
punchy enough to be the hook themselves; if more than one sentence of question
is needed first, the moment is weaker. Skip banter, warm-up, plugs and inside
references.

Length: aim for 30 to 60 seconds. Go up to 90 only when a complete story
genuinely needs the room, and under 30 only for a single devastating line or a
sharp exchange that fully resolves. Never pad to reach a length, and never
truncate a resolved arc to hit one. Find the natural boundary of the thought
first, then check it against the range.

Spread the selection across the recording and across these kinds of moment
rather than returning variations of one idea from a single stretch. Score
honestly: a long recording rarely holds more than a handful of genuinely strong
moments, and a low score on a weak one is more useful than a flattering one.
Return fewer clips rather than padding the list. Never overlap clips. Order them
best first.`

/** Models the key can actually reach, newest first, as the API reports them. */
export async function listModels(): Promise<{ id: string; name: string }[]> {
  const apiKey = readApiKey()
  if (!apiKey) return []
  const client = new Anthropic({ apiKey })
  const models: { id: string; name: string }[] = []
  for await (const model of client.models.list()) {
    models.push({ id: model.id, name: model.display_name ?? model.id })
  }
  return models
}

export async function suggestClips(
  transcript: Transcript,
  durationSec: number,
  maxClips: number,
  model: string,
  length?: { minSec: number; maxSec: number },
  lookFor?: string
): Promise<SuggestedClip[]> {
  const apiKey = readApiKey()
  if (!apiKey) {
    throw new Error('Add an Anthropic API key in Settings to find clips.')
  }

  const client = new Anthropic({ apiKey })

  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    messages: [
      {
        role: 'user',
        content: `Transcript of a ${Math.round(durationSec)} second video. Each line is prefixed with its start time in seconds.

${transcriptLines(transcript.words)}

Return at most ${maxClips} clips.${
          length ? `\nEach clip should run between ${length.minSec} and ${length.maxSec} seconds.` : ''
        }${
          // Tagged rather than run together with the transcript: a recording
          // that happens to contain instructions must not read as one.
          lookFor && lookFor.trim()
            ? `\n\n<asked-for>\n${lookFor.trim()}\n</asked-for>`
            : ''
        }`
      }
    ],
    output_config: { format: zodOutputFormat(ClipsSchema) }
  })

  if (response.stop_reason === 'refusal') {
    throw new Error(
      `Claude declined to analyse this transcript${
        response.stop_details?.category ? ` (${response.stop_details.category})` : ''
      }. Mark clips by hand for this one.`
    )
  }

  const parsed = response.parsed_output
  if (!parsed) throw new Error('Claude returned a response that did not match the expected shape.')

  return normaliseClips(parsed.clips, transcript.words, durationSec)
}
