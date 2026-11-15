import { z } from 'zod'
import { AspectSchema, CAPTION_POSITIONS, CaptionSpecSchema, TightenSpecSchema } from '../edit/schema'

/**
 * Presets are slash commands. A built-in like /tighten and a style saved from
 * a video someone liked (/fieldnotes) are the same thing: a name and a style.
 *
 * A style holds only what can be measured or applied. Each field is optional,
 * and an absent field leaves that part of the edit alone, so /captions never
 * touches pacing and /tighten never touches captions.
 */
export const StyleSpecSchema = z.object({
  /** Average time between visual changes: cuts, punch-ins and cutaways. */
  pace: z.object({ secondsPerShot: z.number().min(0.3).max(30) }).optional(),
  tighten: TightenSpecSchema.optional(),
  captions: CaptionSpecSchema.partial().optional(),
  hook: z
    .object({
      /** The first visual change lands by this time. */
      firstCutSec: z.number().min(0).max(10),
      /** Open on the strongest line rather than the first one. A judgment call, left to the planner. */
      strongestFirst: z.boolean()
    })
    .optional(),
  /** Share of cutaways shown in black and white. */
  bw: z.object({ share: z.number().min(0).max(1) }).optional(),
  /** One word per beat lands big on screen. */
  bigWords: z.object({ perBeat: z.boolean() }).optional(),
  /** Zoom punched in on alternate shots, which is how a single camera keeps changing. */
  punchIn: z.object({ scale: z.number().min(1).max(1.5) }).optional(),
  loudness: z.object({ lufs: z.number().min(-30).max(-6) }).optional(),
  aspect: AspectSchema.optional(),
  maxLengthSec: z.number().positive().optional()
})
export type StyleSpec = z.infer<typeof StyleSpecSchema>

export const COMMAND_PATTERN = /^[a-z0-9][a-z0-9-]{1,23}$/

export const PresetSchema = z.object({
  /** The command without its slash. */
  command: z.string().regex(COMMAND_PATTERN),
  title: z.string().min(1),
  /** One sentence, shown in the slash menu. */
  summary: z.string(),
  builtIn: z.boolean(),
  style: StyleSpecSchema,
  /** Where a saved style came from. Pattern only: the video itself is never used. */
  inspiration: z
    .object({
      url: z.string().nullable(),
      title: z.string().nullable(),
      channel: z.string().nullable(),
      measuredAt: z.string()
    })
    .nullable()
})
export type Preset = z.infer<typeof PresetSchema>

export const BUILT_IN_PRESETS: Preset[] = [
  {
    command: 'tighten',
    title: 'Tighten',
    summary: 'Cuts pauses longer than a third of a second, and the ums.',
    builtIn: true,
    style: { tighten: { maxGapSec: 0.35, padSec: 0.06, fillers: true } },
    inspiration: null
  },
  {
    command: 'shorts',
    title: 'Shorts',
    summary: 'Vertical, under a minute, opens fast, two words of caption at a time.',
    builtIn: true,
    style: {
      aspect: 'vertical',
      maxLengthSec: 60,
      hook: { firstCutSec: 1, strongestFirst: true },
      tighten: { maxGapSec: 0.4, padSec: 0.06, fillers: true },
      captions: { on: true, wordsPerScreen: 2, position: 'chest' },
      pace: { secondsPerShot: 2.5 },
      punchIn: { scale: 1.12 },
      loudness: { lufs: -14 }
    },
    inspiration: null
  },
  {
    command: 'captions',
    title: 'Captions',
    summary: 'Captions on, two words at a time, at chest height.',
    builtIn: true,
    style: { captions: { on: true, wordsPerScreen: 2, position: 'chest' } },
    inspiration: null
  },
  {
    command: 'hook',
    title: 'Hook',
    summary: 'Opens on the strongest line, with the first change inside a second.',
    builtIn: true,
    style: { hook: { firstCutSec: 1, strongestFirst: true }, punchIn: { scale: 1.12 } },
    inspiration: null
  }
]

const POSITION_WORDS: Record<(typeof CAPTION_POSITIONS)[number], string> = {
  top: 'at the top',
  middle: 'in the middle',
  chest: 'at chest height',
  bottom: 'low in frame'
}

/** Seconds in the app's register: one decimal under ten, whole numbers above. */
export function seconds(sec: number): string {
  return sec < 10 ? `${(Math.round(sec * 10) / 10).toFixed(1)} s` : `${Math.round(sec)} s`
}

/**
 * A style as short facts, most telling first. These are the chips under a
 * reply ("1.8 s per shot", "2-word captions", "B&W B-roll"); everything else
 * waits behind Details.
 */
export function describeStyle(style: StyleSpec): string[] {
  const facts: string[] = []
  if (style.pace) facts.push(`${seconds(style.pace.secondsPerShot)} per shot`)
  if (style.captions?.on === false) facts.push('No captions')
  else if (style.captions?.wordsPerScreen) {
    const n = style.captions.wordsPerScreen
    facts.push(n === 1 ? 'One word at a time' : `${n}-word captions`)
  }
  if (style.bw && style.bw.share >= 0.15) facts.push('B&W B-roll')
  if (style.bigWords?.perBeat) facts.push('A big word per beat')
  if (style.hook) facts.push(`First change by ${seconds(style.hook.firstCutSec)}`)
  if (style.tighten) facts.push(`Pauses cut past ${seconds(style.tighten.maxGapSec)}`)
  if (style.punchIn) facts.push('Punch-ins between shots')
  if (style.aspect === 'vertical') facts.push('Vertical 9:16')
  else if (style.aspect === 'square') facts.push('Square 1:1')
  else if (style.aspect === 'wide') facts.push('Wide 16:9')
  if (style.maxLengthSec) facts.push(`Under ${seconds(style.maxLengthSec)}`)
  if (style.loudness) facts.push(`${style.loudness.lufs} LUFS`)
  if (style.captions?.position && style.captions.on !== false) facts.push(`Captions ${POSITION_WORDS[style.captions.position]}`)
  return facts
}
