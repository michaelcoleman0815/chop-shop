import { z } from 'zod'
import type { Cut, Op } from '../edit/schema'

/**
 * What Cutalong notices as someone edits, kept as small events on their own
 * computer: what they asked for and the version it made, what they undid,
 * their notes and what became of them, the slash commands they used, the
 * version they kept, and changes to their brand's voice notes.
 *
 * Nothing here is footage or a transcript. The words kept are the person's
 * own requests and notes, which already go to Claude when they are sent.
 */

const at = z.string()
const doc = z.string().max(200)
const text = z.string().max(2000)

export const SignalSchema = z.discriminatedUnion('kind', [
  /** A typed request, the version it made (null when nothing changed) and what that version did. */
  z.object({
    kind: z.literal('request'),
    at,
    doc,
    text,
    version: z.number().int().nullable(),
    tags: z.array(z.string().max(60)).max(40)
  }),
  /** A slash command, and the same. */
  z.object({
    kind: z.literal('command'),
    at,
    doc,
    command: z.string().max(40),
    version: z.number().int().nullable(),
    tags: z.array(z.string().max(60)).max(40)
  }),
  /** Going back from one version to an earlier one. */
  z.object({ kind: z.literal('undo'), at, doc, from: z.number().int(), to: z.number().int() }),
  /** A note: written, carried out (in which version, doing what), or taken away. */
  z.object({
    kind: z.literal('note'),
    at,
    doc,
    text,
    status: z.enum(['added', 'applied', 'dismissed']),
    version: z.number().int().nullable().optional(),
    tags: z.array(z.string().max(60)).max(40).optional()
  }),
  /** The version someone kept: exported, or the one they left the edit on. */
  z.object({
    kind: z.literal('keep'),
    at,
    doc,
    version: z.number().int(),
    captions: z.object({ on: z.boolean(), position: z.string().max(20), wordsPerScreen: z.number().int() }),
    aspect: z.string().max(20)
  }),
  /** The brand's voice notes, as they now read. */
  z.object({ kind: z.literal('voice'), at, text: z.string().max(4000) })
])
export type Signal = z.infer<typeof SignalSchema>
type WithoutTime<T> = T extends unknown ? Omit<T, 'at'> : never
/** A signal before it is stamped with the time. */
export type SignalInput = WithoutTime<Signal>

/**
 * What a version did, as tags the rules can count: punch-ins, black and
 * white, big words, captions moved, pauses cut tight, words cut, lines moved.
 */
export function opTags(ops: Op[]): string[] {
  const tags = new Set<string>()
  for (const op of ops) {
    switch (op.op) {
      case 'treat':
        if (op.set.zoom !== undefined && op.set.zoom > 1.001) tags.add('punch-in')
        if (op.set.bw === true) tags.add('bw')
        if (op.set.bigWord) tags.add('big-word')
        if (op.set.frame === 'broll' || op.set.frame === 'split') tags.add('broll')
        break
      case 'captions':
        if (op.set.on === false) tags.add('captions-off')
        if (op.set.on === true) tags.add('captions-on')
        if (op.set.position) tags.add(`captions-position:${op.set.position}`)
        if (op.set.wordsPerScreen) tags.add(`captions-words:${op.set.wordsPerScreen}`)
        break
      case 'tighten':
        if (op.set === null) tags.add('pauses-kept')
        else {
          if (op.set.maxGapSec <= 0.2) tags.add('tight-cuts')
          if (op.set.fillers) tags.add('fillers-cut')
        }
        break
      case 'strike':
        tags.add('cut-words')
        break
      case 'unstrike':
        tags.add('restore-words')
        break
      case 'move':
        tags.add('reorder')
        break
      case 'remove':
        tags.add('remove-beats')
        break
      case 'aspect':
        tags.add(`aspect:${op.aspect}`)
        break
    }
  }
  return [...tags]
}

/** The settings a kept version shows, for a keep signal. */
export function keptSettings(cut: Cut): {
  captions: { on: boolean; position: string; wordsPerScreen: number }
  aspect: string
} {
  return {
    captions: { on: cut.captions.on, position: cut.captions.position, wordsPerScreen: cut.captions.wordsPerScreen },
    aspect: cut.aspect
  }
}

/** A correction someone typed or wrote: what it is about, and which way it goes. */
export interface Said {
  topic: string
  value: string
}

const POSITION = {
  top: 'top',
  middle: 'middle',
  center: 'middle',
  centre: 'middle',
  chest: 'chest',
  bottom: 'bottom',
  low: 'bottom'
}

/**
 * The plain-language rules. Within a topic the first rule that matches wins,
 * so "don't cut the pause" is about keeping it, never about cutting it.
 */
const RULES: { topic: string; value: string | ((m: RegExpMatchArray) => string); re: RegExp }[] = [
  {
    topic: 'pauses',
    value: 'keep',
    re: /\b(keep|leave|don'?t cut|do not cut|put back|bring back)\b[^.!?]{0,20}\b(pauses?|breaths?|beats?|silences?|gaps?)\b|\b(put|bring) (the |that |my )?(pause|breath|beat|silence)s? back\b|\btoo (tight|choppy|rushed|jumpy)\b|\bmore (breathing )?room\b/i
  },
  {
    topic: 'pauses',
    value: 'cut',
    re: /\b(cut|remove|kill|lose|trim|shorten|tighten)\b[^.!?]{0,20}\b(pauses?|dead air|silences?|gaps?)\b|\b(tighter|snappier)\b/i
  },
  { topic: 'pace', value: 'slower', re: /\btoo fast\b|\bslow (it |this )?down\b|\bslower\b/i },
  {
    topic: 'pace',
    value: 'faster',
    re: /\btoo slow\b|\bspeed (it |this )?up\b|\bfaster\b|\bpick up the pace\b|\b(drags|dragging)\b/i
  },
  {
    topic: 'caption-size',
    value: 'bigger',
    re: /\b(bigger|larger)\b[^.!?]{0,15}\bcaptions?\b|\bcaptions?\b[^.!?]{0,15}\b(bigger|larger|too small)\b/i
  },
  {
    topic: 'caption-size',
    value: 'smaller',
    re: /\bsmaller\b[^.!?]{0,15}\bcaptions?\b|\bcaptions?\b[^.!?]{0,15}\b(smaller|too (big|large))\b/i
  },
  {
    topic: 'captions-position',
    value: (m) => POSITION[m[1].toLowerCase() as keyof typeof POSITION],
    re: /\bcaptions?\b[^.!?]{0,25}\b(?:at|to|on|near|by)\b (?:the )?(?:\w+ )?(top|middle|center|centre|chest|bottom|low)\b/i
  },
  {
    topic: 'laughs',
    value: 'keep',
    re: /\b(keep|leave|don'?t cut|do not cut|put back|bring back)\b[^.!?]{0,20}\blaugh/i
  },
  { topic: 'laughs', value: 'cut', re: /\b(cut|remove|lose|trim)\b[^.!?]{0,20}\blaugh/i },
  {
    topic: 'zoom',
    value: 'less',
    re: /\bno (more )?(zooms?|zooming|punch[- ]?ins?)\b|\b(stop|less|too much|fewer|without)\b[^.!?]{0,15}\b(zooms?|zooming|punch[- ]?ins?)\b|\b(don'?t|do not|never)\b[^.!?]{0,10}\b(zoom|punch in)/i
  },
  { topic: 'zoom', value: 'more', re: /\bmore (zooms?|punch[- ]?ins?)\b|\bpunch in\b|\bzoom in\b/i },
  {
    topic: 'bw',
    value: 'less',
    re: /\bno (more )?black and white\b|\b(keep|leave) (it|this|that) in colou?r\b|\bless black and white\b|\bback (in)?to colou?r\b/i
  },
  { topic: 'bw', value: 'more', re: /\bmore black and white\b|\b(make|go|turn)\b[^.!?]{0,15}\bblack and white\b/i },
  {
    topic: 'fillers',
    value: 'keep',
    re: /\b(keep|leave|don'?t cut|do not cut)\b[^.!?]{0,15}\b(ums?|uhs?|fillers?)\b/i
  },
  {
    topic: 'fillers',
    value: 'cut',
    re: /\b(cut|remove|lose|kill)\b[^.!?]{0,15}\b(ums?|uhs?|fillers?)\b|\bno (more )?ums\b/i
  },
  {
    topic: 'take',
    value: 'earlier',
    re: /\b(use|take|go with|swap (to|for)|switch to|want)\b[^.!?]{0,15}\b((first|earlier|previous|original) (take|one)|take (one|1)\b)/i
  },
  {
    topic: 'take',
    value: 'later',
    re: /\b(use|take|go with|swap (to|for)|switch to|want)\b[^.!?]{0,15}\b((second|third|last|later|final|next) (take|one)|take (two|three|four|[2-9])\b)/i
  },
  {
    topic: 'captions',
    value: 'off',
    re: /\bno captions\b|\bcaptions off\b|\b(turn|take) (the )?captions off\b|\bremove (the )?captions\b/i
  },
  { topic: 'captions', value: 'on', re: /\badd captions\b|\bcaptions on\b|\bturn (the )?captions on\b/i }
]

/** The corrections in a request, a note or the voice notes. */
export function classify(text: string): Said[] {
  const out: Said[] = []
  const seen = new Set<string>()
  for (const rule of RULES) {
    if (seen.has(rule.topic)) continue
    const m = text.match(rule.re)
    if (!m) continue
    const value = typeof rule.value === 'string' ? rule.value : rule.value(m)
    if (!value) continue
    seen.add(rule.topic)
    out.push({ topic: rule.topic, value })
  }
  return out
}
