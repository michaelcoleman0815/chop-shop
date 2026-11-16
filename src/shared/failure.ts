import { sentence } from './edit/plain'

/**
 * A failure as the chat says it. A sentence the app wrote ("I can't find
 * MVI_9293.MP4. It was at …") reads as it is. A tool's own output, such as
 * the last lines ffmpeg printed before it stopped, is not a sentence anyone
 * can act on: it becomes a plain one, and what the tool said is kept behind
 * Details for whoever wants it.
 */
export function failureOf(message: string): { text: string; details?: { label: string; value: string }[] } {
  const lines = message
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return { text: 'Something stopped it partway.' }
  if (lines.length === 1 && lines[0].length <= 240) return { text: sentence(lines[0]) }
  return {
    text: 'The renderer stopped partway, so nothing was saved.',
    details: [{ label: 'What ffmpeg said', value: lines.slice(-6).join('\n') }]
  }
}
