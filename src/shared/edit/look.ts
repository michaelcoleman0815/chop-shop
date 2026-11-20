import { z } from 'zod'

/**
 * A look for the whole video: exposure, contrast, saturation, warmth, tint
 * and lifted blacks, plus a LUT, sharpening, a vignette and grain.
 *
 * The colour part is one matrix, worked out here once: the export applies it
 * with ffmpeg's colorchannelmixer and the preview with an SVG colour matrix,
 * on the same encoded values, so what the preview shows is what the export
 * gets. The vignette is the same curve in both. Captions and the logo are
 * drawn after the look, so they keep their own colours. A leaf module, like
 * timing.ts, so the schema can use it.
 */

const amount = z.number().min(-1).max(1)

/** A .cube LUT the person chose, and how much of it shows. */
export const LutSchema = z.object({ path: z.string().min(1), strength: z.number().min(0).max(1) })
export type Lut = z.infer<typeof LutSchema>

export const LookSchema = z.object({
  /** The named look it started from, if any: clean, warm, cool, cinematic, vintage. */
  name: z.string().max(40).optional(),
  /** Stops: +1 is twice as bright. */
  exposure: z.number().min(-2).max(2).optional(),
  contrast: amount.optional(),
  saturation: amount.optional(),
  /** Cooler below 0, warmer above. */
  temperature: amount.optional(),
  /** Greener below 0, more magenta above. */
  tint: amount.optional(),
  /** Blacks lifted toward grey, as faded film: 0 to 1. */
  lift: z.number().min(0).max(1).optional(),
  sharpen: z.number().min(0).max(1).optional(),
  vignette: z.number().min(0).max(1).optional(),
  grain: z.number().min(0).max(1).optional(),
  // Film, for an archival look (edit/film.ts): a sepia tone in the colour
  // matrix, the frame weaving in the gate, dust and scratches, light leaks
  // and the exposure flickering. Each 0 to 1.
  sepia: z.number().min(0).max(1).optional(),
  weave: z.number().min(0).max(1).optional(),
  dust: z.number().min(0).max(1).optional(),
  leak: z.number().min(0).max(1).optional(),
  flicker: z.number().min(0).max(1).optional(),
  lut: LutSchema.optional()
})
export type Look = z.infer<typeof LookSchema>

/** Changes to a look: any setting, and the LUT, which null takes out. */
export const LookPatchSchema = LookSchema.extend({ lut: LutSchema.nullable().optional() })
export type LookPatch = z.infer<typeof LookPatchSchema>

/** The settings a person can turn, in the order they are described. */
export const LOOK_SETTINGS = [
  'exposure',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'lift',
  'sharpen',
  'vignette',
  'grain',
  'sepia',
  'weave',
  'dust',
  'leak',
  'flicker'
] as const
export type LookSetting = (typeof LOOK_SETTINGS)[number]

/** Each setting's range, and how far "more" or "less" moves it. */
export const LOOK_RANGE: Record<LookSetting, { min: number; max: number; step: number }> = {
  exposure: { min: -2, max: 2, step: 0.25 },
  contrast: { min: -1, max: 1, step: 0.1 },
  saturation: { min: -1, max: 1, step: 0.1 },
  temperature: { min: -1, max: 1, step: 0.1 },
  tint: { min: -1, max: 1, step: 0.1 },
  lift: { min: 0, max: 1, step: 0.1 },
  sharpen: { min: 0, max: 1, step: 0.1 },
  vignette: { min: 0, max: 1, step: 0.1 },
  grain: { min: 0, max: 1, step: 0.1 },
  sepia: { min: 0, max: 1, step: 0.1 },
  weave: { min: 0, max: 1, step: 0.1 },
  dust: { min: 0, max: 1, step: 0.1 },
  leak: { min: 0, max: 1, step: 0.1 },
  flicker: { min: 0, max: 1, step: 0.1 }
}

/** The named looks, each a starting point the person can change. */
export const NAMED_LOOKS: Record<string, { title: string; summary: string; look: Look }> = {
  clean: {
    title: 'Clean',
    summary: 'True colour, a touch more contrast and crispness. Nothing tinted.',
    look: { name: 'clean', contrast: 0.08, saturation: 0.04, sharpen: 0.3 }
  },
  warm: {
    title: 'Warm',
    summary: 'A warmer, golden cast with a little more colour.',
    look: { name: 'warm', temperature: 0.4, saturation: 0.08, contrast: 0.05 }
  },
  cool: {
    title: 'Cool',
    summary: 'A cooler, bluer cast, slightly muted.',
    look: { name: 'cool', temperature: -0.4, saturation: -0.06, contrast: 0.05 }
  },
  cinematic: {
    title: 'Cinematic',
    summary: 'Deeper contrast, muted colour, a soft vignette and fine grain.',
    look: { name: 'cinematic', contrast: 0.18, saturation: -0.15, temperature: 0.08, vignette: 0.45, grain: 0.15 }
  },
  vintage: {
    title: 'Vintage',
    summary: 'Faded blacks, warm and muted, with grain and a vignette.',
    look: { name: 'vintage', lift: 0.5, contrast: -0.1, saturation: -0.3, temperature: 0.3, vignette: 0.5, grain: 0.4 }
  },
  archival: {
    title: 'Archival',
    summary: 'A warm sepia grade on old film: grain, a vignette, the frame weaving, dust, leaks and a flicker.',
    look: {
      name: 'archival',
      sepia: 0.6,
      saturation: -0.2,
      contrast: 0.14,
      lift: 0.16,
      temperature: 0.1,
      vignette: 0.55,
      grain: 0.35,
      weave: 0.5,
      dust: 0.4,
      leak: 0.25,
      flicker: 0.35
    }
  },
  newsreel: {
    title: 'Newsreel',
    summary: 'Black and white film with deep contrast, heavy grain, weave, dust and flicker.',
    look: {
      name: 'newsreel',
      saturation: -1,
      contrast: 0.22,
      lift: 0.1,
      vignette: 0.6,
      grain: 0.45,
      weave: 0.55,
      dust: 0.5,
      flicker: 0.45
    }
  },
  kodachrome: {
    title: 'Period colour',
    summary: 'Warm, saturated period colour film with fine grain, a soft vignette and a little weave.',
    look: {
      name: 'kodachrome',
      saturation: 0.08,
      contrast: 0.12,
      temperature: 0.22,
      lift: 0.08,
      vignette: 0.4,
      grain: 0.25,
      weave: 0.3,
      dust: 0.2,
      leak: 0.2,
      flicker: 0.15
    }
  },
  explainer: {
    title: 'Explainer',
    summary: 'Clean and bright: a lift in colour and contrast, crisp edges, nothing on top.',
    look: { name: 'explainer', saturation: 0.12, contrast: 0.06, exposure: 0.05 }
  }
}

/**
 * A look with changes made: on top of what it was, or from nothing when
 * `replace` is set, which keeps the LUT unless the changes name one, since a
 * LUT usually belongs to the camera rather than to the look. Settings at 0
 * and a LUT set to null drop out; a look left with nothing in it is null.
 */
export function mergeLook(was: Look | null | undefined, patch: LookPatch | null, replace = false): Look | null {
  if (patch === null) return null
  const base: Look = replace ? (was?.lut ? { lut: was.lut } : {}) : { ...(was ?? {}) }
  const next: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v === null || (typeof v === 'number' && Math.abs(v) < 1e-6)) delete next[k]
    else next[k] = v
  }
  const look = LookSchema.parse(next)
  const { name: _name, ...settings } = look
  return Object.keys(settings).length > 0 ? look : null
}

/** Whether a look changes the picture's colour at all. */
export function changesColour(look: Look): boolean {
  return [look.exposure, look.contrast, look.saturation, look.temperature, look.tint, look.lift, look.sepia].some(
    (v) => v !== undefined && Math.abs(v) > 1e-6
  )
}

/** Whether a look puts film on top of the picture: weave, dust, leaks or flicker (edit/film.ts). */
export function hasFilm(look: Look | null | undefined): boolean {
  return !!look && [look.weave, look.dust, look.leak, look.flicker].some((v) => v !== undefined && v > 1e-6)
}

/** A 3x4 colour matrix: each row is one output channel's red, green and blue weights, then its offset. */
export type ColourMatrix = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number
]

type Affine = { m: number[][]; o: number[] }
const apply = (outer: Affine, inner: Affine): Affine => ({
  m: outer.m.map((row) =>
    [0, 1, 2].map((j) => row[0] * inner.m[0][j] + row[1] * inner.m[1][j] + row[2] * inner.m[2][j])
  ),
  o: outer.m.map((row, i) => row[0] * inner.o[0] + row[1] * inner.o[1] + row[2] * inner.o[2] + outer.o[i])
})
const scale = (r: number, g: number, b: number): Affine => ({
  m: [
    [r, 0, 0],
    [0, g, 0],
    [0, 0, b]
  ],
  o: [0, 0, 0]
})

/** The classic sepia toning matrix: each channel a weighted mix of all three, warm browns from any colour. */
const SEPIA: Affine = {
  m: [
    [0.393, 0.769, 0.189],
    [0.349, 0.686, 0.168],
    [0.272, 0.534, 0.131]
  ],
  o: [0, 0, 0]
}

/** A share of the way from the identity to a toning matrix. */
const toward = (to: Affine, k: number): Affine => ({
  m: to.m.map((row, i) => row.map((v, j) => (i === j ? 1 : 0) * (1 - k) + v * k)),
  o: to.o.map((v) => v * k)
})

/**
 * The look's colour as one matrix on encoded values from 0 to 1: exposure,
 * then the sepia tone, then saturation around Rec. 709 luma, then warmth and
 * tint as channel gains, then contrast around mid grey, then lifted blacks.
 */
export function lookMatrix(look: Look): ColourMatrix {
  const e = 2 ** (look.exposure ?? 0)
  const s = 1 + (look.saturation ?? 0)
  const t = look.temperature ?? 0
  const tint = look.tint ?? 0
  const c = 1 + (look.contrast ?? 0)
  const lift = 0.12 * (look.lift ?? 0)
  const [lr, lg, lb] = [0.2126, 0.7152, 0.0722]
  const saturation: Affine = {
    m: [
      [lr * (1 - s) + s, lg * (1 - s), lb * (1 - s)],
      [lr * (1 - s), lg * (1 - s) + s, lb * (1 - s)],
      [lr * (1 - s), lg * (1 - s), lb * (1 - s) + s]
    ],
    o: [0, 0, 0]
  }
  const warmth = scale(1 + 0.12 * t + 0.03 * tint, 1 + 0.02 * t - 0.08 * tint, 1 - 0.12 * t + 0.03 * tint)
  const contrast: Affine = { ...scale(c, c, c), o: [0.5 * (1 - c), 0.5 * (1 - c), 0.5 * (1 - c)] }
  const lifted: Affine = { ...scale(1 - lift, 1 - lift, 1 - lift), o: [lift, lift, lift] }
  let a = scale(e, e, e)
  const sepia = look.sepia ?? 0
  const steps = sepia > 1e-6 ? [toward(SEPIA, Math.min(1, sepia)), saturation, warmth, contrast, lifted] : [saturation, warmth, contrast, lifted]
  for (const step of steps) a = apply(step, a)
  return [...a.m[0], a.o[0], ...a.m[1], a.o[1], ...a.m[2], a.o[2]] as ColourMatrix
}

/** A colour through the matrix, clipped as the export clips it: for tests and previews of single colours. */
export function throughMatrix(m: ColourMatrix, rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb
  const clip = (v: number): number => Math.min(1, Math.max(0, v))
  return [
    clip(m[0] * r + m[1] * g + m[2] * b + m[3]),
    clip(m[4] * r + m[5] * g + m[6] * b + m[7]),
    clip(m[8] * r + m[9] * g + m[10] * b + m[11])
  ]
}

/** The matrix as an SVG feColorMatrix wants it: four rows of five, alpha passed through. */
export function svgColourMatrix(m: ColourMatrix): string {
  const row = (i: number): number[] => [m[i], m[i + 1], m[i + 2], 0, m[i + 3]]
  return [...row(0), ...row(4), ...row(8), 0, 0, 0, 1, 0].map((v) => +v.toFixed(5)).join(' ')
}

/** The angle ffmpeg's vignette filter is given for an amount from 0 to 1. */
export const vignetteAngle = (amount: number): number => 0.9 * Math.min(1, Math.max(0, amount))

/**
 * How bright the picture stays at a distance from its centre, as a share of
 * the way to a corner: ffmpeg's vignette curve, cos(angle x d) to the fourth.
 */
export function vignetteAt(amount: number, d: number): number {
  const c = Math.cos(vignetteAngle(amount) * Math.min(1, Math.max(0, d)))
  return c * c * c * c
}

/** The vignette as darkness over the picture, at evenly spaced distances out to the corners. */
export function vignetteStops(amount: number, n = 12): { at: number; alpha: number }[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const at = i / n
    return { at, alpha: 1 - vignetteAt(amount, at) }
  })
}

/** ffmpeg's noise strength for an amount of grain: uniform noise over that many levels of luma. */
export const grainStrength = (amount: number): number => Math.round(24 * Math.min(1, Math.max(0, amount)))

/** How far grain moves a pixel each way, from 0 to 1: half the strength, out of video luma's 219 levels. */
export const grainSpread = (amount: number): number => grainStrength(amount) / 2 / 219

/** A look in a few plain words: "warm", "exposure +0.3, grain 0.2, a LUT at 80%". */
export function describeLook(look: Look | null | undefined): string {
  if (!look) return 'as recorded'
  const parts: string[] = []
  const named = look.name ? NAMED_LOOKS[look.name] : undefined
  const sign = (v: number): string => `${v > 0 ? '+' : ''}${+v.toFixed(2)}`
  for (const k of LOOK_SETTINGS) {
    const v = look[k]
    if (v === undefined) continue
    // A named look's own settings go without saying.
    if (named && named.look[k] !== undefined && Math.abs((named.look[k] as number) - v) < 1e-6) continue
    const label =
      k === 'temperature'
        ? 'warmth'
        : k === 'lift'
          ? 'faded blacks'
          : k === 'weave'
            ? 'gate weave'
            : k === 'dust'
              ? 'dust and scratches'
              : k === 'leak'
                ? 'light leaks'
                : k
    parts.push(`${label} ${LOOK_RANGE[k].min < 0 ? sign(v) : +v.toFixed(2)}`)
  }
  if (look.lut) parts.push(`a LUT at ${Math.round(look.lut.strength * 100)}%`)
  if (named) return parts.length ? `${look.name}, with ${parts.join(', ')}` : (look.name as string)
  return parts.join(', ') || 'as recorded'
}
