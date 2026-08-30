import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { readApiKey } from './apikey'
import type { SuggestedClip, Transcript } from '../shared/types'
import { normaliseClips, transcriptLines } from './clip-shape'

const MODEL = 'claude-opus-5'

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

const SYSTEM = `You find the moments in a long video that work as standalone short clips.

A clip earns its place when:
- It opens on something that makes a viewer stop scrolling, in the first two seconds.
- It resolves. A setup with no payoff is not a clip.
- It is understandable with no knowledge of the rest of the video.
- It runs between 15 and 90 seconds.

Reject:
- Moments that need earlier context to land.
- Long stretches of setup before anything happens.
- Anything that trails off rather than ending.

Start and end on sentence boundaries from the transcript. Never overlap clips.
Order them best first. Return fewer clips rather than padding the list: a video
with two good moments should return two.`

export async function suggestClips(
  transcript: Transcript,
  durationSec: number,
  maxClips: number
): Promise<SuggestedClip[]> {
  const apiKey = readApiKey()
  if (!apiKey) {
    throw new Error('Add an Anthropic API key in Settings to find clips.')
  }

  const client = new Anthropic({ apiKey })

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    messages: [
      {
        role: 'user',
        content: `Transcript of a ${Math.round(durationSec)} second video. Each line is prefixed with its start time in seconds.

${transcriptLines(transcript.words)}

Return at most ${maxClips} clips.`
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
