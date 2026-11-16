import { sentence } from './edit/plain'

/** A line behind Details: what it is, and its value. */
export type Detail = { label: string; value: string }

/**
 * A failure as the chat says it. A sentence the app wrote ("I can't find
 * MVI_9293.MP4. It was at …") reads as it is. A tool's own output, such as
 * the last lines ffmpeg printed before it stopped, is not a sentence anyone
 * can act on: it becomes a plain one, and what the tool said is kept behind
 * Details for whoever wants it.
 */
export function failureOf(message: string): { text: string; details?: Detail[] } {
  const lines = message
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return { text: 'Something stopped it partway.' }
  if (lines.length === 1 && lines[0].length <= 240) return { text: sentence(lines[0]) }
  return {
    text: 'The renderer stopped partway, so nothing was saved.',
    details: saidDetails({ tool: 'ffmpeg', said: lines.join('\n') })
  }
}

/**
 * What a tool printed before it stopped, kept on the error that says so in a
 * sentence (main/transcribe's WhisperFailed): the person reads the sentence,
 * and the lines wait behind Details.
 */
export interface ToolSaid {
  tool: string
  said: string
}

/** The lines a tool printed that an error carries, when it carries any. */
export function toolSaid(err: unknown): ToolSaid | null {
  if (typeof err !== 'object' || err === null) return null
  const { tool, said } = err as Partial<ToolSaid>
  return typeof tool === 'string' && typeof said === 'string' && said.trim() ? { tool, said } : null
}

/** What a tool said, for Details: "What whisper said", its last lines one to a line. None when it said nothing. */
export function saidDetails(said: ToolSaid | null, about?: string): Detail[] {
  if (!said) return []
  const lines = said.said
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return []
  return [{ label: `What ${said.tool} said${about ? ` about ${about}` : ''}`, value: lines.slice(-6).join('\n') }]
}
