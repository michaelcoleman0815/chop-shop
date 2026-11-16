import { z } from 'zod'
import { AspectSchema, CAPTION_POSITIONS, CaptionSpecSchema, TightenSpecSchema } from '../edit/schema'
import { CAMERA_INFO, type Camera } from '../edit/camera'
import { FadeSchema } from '../edit/transitions'
import { LookSchema, NAMED_LOOKS } from '../edit/look'

/**
 * Presets are slash commands. A built-in like /tighten and a style saved from
 * a video someone liked (/fieldnotes) are the same thing: a name and a style.
 *
 * A style holds only what can be measured or applied. Each field is optional,
 * and an absent field leaves that part of the edit alone, so /captions never
 * touches pacing and /tighten never touches captions.
 */
export const StyleSpecSchema = z.object({
  /**
   * Raw footage first: keep the best take of each line said more than once,
   * and drop false starts and set-up talk (src/shared/raw). Runs before
   * everything else, so the rest of the style lands on the kept takes.
   */
  takes: z.boolean().optional(),
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
  /** Room kept before and after each beat's words: small numbers make snappy cuts. */
  pad: z.object({ inSec: z.number().min(0).max(1), outSec: z.number().min(0).max(1) }).optional(),
  aspect: AspectSchema.optional(),
  maxLengthSec: z.number().positive().optional(),
  /** The whole video fading in at the start and out at the end. */
  fade: FadeSchema.optional(),
  /** A look over the whole picture; null takes any look off. A LUT stays when a look is set. */
  look: LookSchema.nullable().optional()
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
    command: 'takes',
    title: 'Takes',
    summary: 'Keeps the best take of each line, and drops false starts and set-up talk.',
    builtIn: true,
    style: { takes: true },
    inspiration: null
  },
  {
    command: 'tighten',
    title: 'Tighten',
    summary: 'Keeps the best takes, then cuts pauses longer than a third of a second, and the ums.',
    builtIn: true,
    style: { takes: true, tighten: { maxGapSec: 0.35, padSec: 0.06, fillers: true } },
    inspiration: null
  },
  {
    command: 'snappy',
    title: 'Snappy',
    summary: 'Keeps the best takes, and cuts land right on the words: pauses past 0.15 s go, and the ums.',
    builtIn: true,
    style: {
      takes: true,
      tighten: { maxGapSec: 0.15, padSec: 0.03, fillers: true },
      pad: { inSec: 0.04, outSec: 0.06 }
    },
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

/**
 * Built-in caption styles the graphics draw. They are listed after your
 * own /brand in the slash menu, and their names are taken like the built-ins.
 */
export const CAPTION_STYLE_PRESETS: Preset[] = [
  {
    command: 'hierarchy',
    title: 'Hierarchy captions',
    summary: 'Captions in two lines on your chest, the key words big, each word fading in as you say it.',
    builtIn: true,
    style: { captions: { on: true, preset: 'hierarchy', position: 'chest' } },
    inspiration: null
  },
  {
    command: 'boxed',
    title: 'Boxed captions',
    summary: 'Captions a few words at a time on your chest, the word you are saying in a box of your accent colour.',
    builtIn: true,
    style: { captions: { on: true, preset: 'boxed', position: 'chest', wordsPerScreen: 3 } },
    inspiration: null
  }
]

const POSITION_WORDS: Record<(typeof CAPTION_POSITIONS)[number], string> = {
  top: 'at the top',
  middle: 'in the middle',
  chest: 'at chest height',
  bottom: 'low in frame'
}

/**
 * Seconds in the app's register, exact without being fussy: two places under
 * a second (0.15 s, 0.4 s), one under ten (1.8 s), whole numbers above (12 s).
 */
export function seconds(sec: number): string {
  if (sec < 1) return `${Number((Math.round(sec * 100) / 100).toFixed(2))} s`
  return sec < 10 ? `${(Math.round(sec * 10) / 10).toFixed(1)} s` : `${Math.round(sec)} s`
}

/** A speed in words, with its ramp: "2x", "0.5x, easing in over 0.4 s and out over 0.4 s". */
export function describeSpeed(speed: number, ramp?: { inSec: number; outSec: number } | null): string {
  const x = `${Number(speed.toFixed(2))}x`
  const eases = [
    ramp && ramp.inSec > 0 ? `in over ${seconds(ramp.inSec)}` : null,
    ramp && ramp.outSec > 0 ? `out over ${seconds(ramp.outSec)}` : null
  ].filter(Boolean)
  return eases.length ? `${x}, easing ${eases.join(' and ')}` : x
}

/** A camera move in a few words, for the planner: "push-in to 1.15x", "punch-in to 1.2x on w31", "focus on 2 regions". */
export function describeCamera(move: Camera): string {
  if (move.kind === 'focus') {
    const n = move.regions?.length ?? 0
    return `focus on ${n} region${n === 1 ? '' : 's'}`
  }
  const zoom = `${Number((move.zoom ?? CAMERA_INFO[move.kind].zoom).toFixed(2))}x`
  return `${move.kind} to ${zoom}${move.word ? ` on ${move.word}` : ''}`
}

/** A running time as m:ss: 0:52, 1:04, 12:30. */
export function clock(sec: number): string {
  const total = Math.max(0, Math.round(sec))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * A style as short facts, most telling first. These are the chips under a
 * reply ("1.8 s per shot", "2-word captions", "B&W B-roll"); everything else
 * waits behind Details.
 */
export function describeStyle(style: StyleSpec): string[] {
  const facts: string[] = []
  if (style.takes) facts.push('Best takes kept')
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
  if (style.pad && style.pad.inSec <= 0.05) facts.push('Cuts tight to the words')
  if (style.aspect === 'vertical') facts.push('Vertical 9:16')
  else if (style.aspect === 'square') facts.push('Square 1:1')
  else if (style.aspect === 'wide') facts.push('Wide 16:9')
  if (style.maxLengthSec) facts.push(`Under ${seconds(style.maxLengthSec)}`)
  if (style.loudness) facts.push(`${style.loudness.lufs} LUFS`)
  if (style.fade && (style.fade.inSec > 0 || style.fade.outSec > 0)) facts.push(`Fades through ${style.fade.color}`)
  if (style.look)
    facts.push(
      style.look.name && NAMED_LOOKS[style.look.name] ? `${NAMED_LOOKS[style.look.name].title} look` : 'A colour look'
    )
  else if (style.look === null) facts.push('Colour as recorded')
  if (style.captions?.position && style.captions.on !== false)
    facts.push(`Captions ${POSITION_WORDS[style.captions.position]}`)
  return facts
}
