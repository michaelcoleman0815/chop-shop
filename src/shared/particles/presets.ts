import type { Anim } from '../anim'
import { MAX_PARTICLES, type Edge, type Emitter, type ParticlePreset, type ParticleSpec, type Sprite } from './schema'

/**
 * The presets, and a clip's spec made whole: its preset's settings with what
 * the spec changes laid over them, and its lengths scaled to the frame.
 * Lengths in a preset and a spec are pixels of a frame whose short side is
 * 1080, so snow looks the same in a vertical short and a 4K wide.
 */

export interface ParticleSettings {
  emitter: Emitter
  area: [number, number, number, number]
  edge: Edge
  text: string
  rate: Anim<number>
  burst: number
  life: number
  speed: number
  direction: number
  spread: number
  gravity: number
  wind: number
  turbulence: number
  /** How large the swirls of the turbulence are, in pixels. */
  swirl: number
  /** How hard each particle sways on its own, side to side, in pixels a second, a second. */
  sway: number
  drag: number
  spin: number
  size: number
  sizeEnd: number
  colors: string[]
  colorEnd: string | null
  alpha: number
  fadeIn: number
  fadeOut: number
  flicker: number
  sprite: Sprite
  soft: number
  stretch: number
  flip: number
  variance: number
  blend: 'add' | 'normal'
  prerun: number
  max: number
  seed: number
}

type Look = Omit<ParticleSettings, 'text' | 'colorEnd' | 'area' | 'edge'> & {
  area?: [number, number, number, number]
  edge?: Edge
  colorEnd?: string
  /** The preset's title, for the clip panel and the lanes. */
  title: string
  /** What it is for, in a few words. */
  summary: string
}

const FULL: [number, number, number, number] = [0, 0, 1, 1]

export const PRESETS: Record<ParticlePreset, Look> = {
  snow: {
    title: 'Snow',
    summary: 'Soft flakes drifting down',
    emitter: 'edge',
    edge: 'top',
    rate: 60,
    burst: 0,
    life: 20,
    speed: 60,
    direction: 90,
    spread: 30,
    gravity: 70,
    wind: 12,
    turbulence: 8,
    swirl: 260,
    sway: 55,
    drag: 0.45,
    spin: 0,
    size: 12,
    sizeEnd: 11,
    colors: ['#FFFFFF'],
    alpha: 0.9,
    fadeIn: 0.05,
    fadeOut: 0.15,
    flicker: 0,
    sprite: 'dot',
    soft: 0.55,
    stretch: 0,
    flip: 0,
    variance: 0.6,
    blend: 'normal',
    prerun: 12,
    max: 1000,
    seed: 1
  },
  confetti: {
    title: 'Confetti',
    summary: 'Coloured paper tumbling down',
    emitter: 'edge',
    edge: 'top',
    rate: 55,
    burst: 60,
    life: 8,
    speed: 260,
    direction: 90,
    spread: 30,
    gravity: 320,
    wind: 0,
    turbulence: 20,
    swirl: 220,
    sway: 120,
    drag: 1.3,
    spin: 220,
    size: 22,
    sizeEnd: 18,
    colors: ['#F94144', '#F8961E', '#F9C74F', '#90BE6D', '#43AA8B', '#577590', '#F9A1BC'],
    alpha: 1,
    fadeIn: 0,
    fadeOut: 0.08,
    flicker: 0,
    sprite: 'square',
    soft: 0,
    stretch: 0,
    flip: 1.6,
    variance: 0.45,
    blend: 'normal',
    prerun: 0,
    max: 500,
    seed: 1
  },
  sparks: {
    title: 'Sparks',
    summary: 'Hot streaks thrown up and falling',
    emitter: 'point',
    area: [0.5, 0.7, 0.5, 0.7],
    rate: 140,
    burst: 0,
    life: 1.1,
    speed: 950,
    direction: -90,
    spread: 110,
    gravity: 1500,
    wind: 0,
    turbulence: 0,
    swirl: 200,
    sway: 0,
    drag: 0.7,
    spin: 0,
    size: 5,
    sizeEnd: 1.5,
    colors: ['#FFF4CC', '#FFC94D'],
    colorEnd: '#FF5A1F',
    alpha: 1,
    fadeIn: 0,
    fadeOut: 0.45,
    flicker: 0.2,
    sprite: 'streak',
    soft: 0,
    stretch: 0.035,
    flip: 0,
    variance: 0.55,
    blend: 'add',
    prerun: 0,
    max: 400,
    seed: 1
  },
  dust: {
    title: 'Dust',
    summary: 'Specks floating in the light',
    emitter: 'box',
    rate: 30,
    burst: 0,
    life: 10,
    speed: 10,
    direction: 0,
    spread: 360,
    gravity: 2,
    wind: 0,
    turbulence: 14,
    swirl: 320,
    sway: 6,
    drag: 0.5,
    spin: 0,
    size: 6,
    sizeEnd: 6,
    colors: ['#FFF6E0'],
    alpha: 0.6,
    fadeIn: 0.3,
    fadeOut: 0.4,
    flicker: 0.15,
    sprite: 'dot',
    soft: 0.6,
    stretch: 0,
    flip: 0,
    variance: 0.7,
    blend: 'add',
    prerun: 10,
    max: 300,
    seed: 1
  },
  embers: {
    title: 'Embers',
    summary: 'Glowing bits rising from below',
    emitter: 'edge',
    edge: 'bottom',
    rate: 50,
    burst: 0,
    life: 6,
    speed: 200,
    direction: -90,
    spread: 40,
    gravity: -90,
    wind: 0,
    turbulence: 130,
    swirl: 180,
    sway: 0,
    drag: 0.3,
    spin: 0,
    size: 14,
    sizeEnd: 4,
    colors: ['#FFD27A', '#FF9A3C'],
    colorEnd: '#D9341A',
    alpha: 1,
    fadeIn: 0.05,
    fadeOut: 0.5,
    flicker: 0.5,
    sprite: 'dot',
    soft: 0.45,
    stretch: 0,
    flip: 0,
    variance: 0.5,
    blend: 'add',
    prerun: 6,
    max: 300,
    seed: 1
  },
  rain: {
    title: 'Rain',
    summary: 'Fine streaks falling fast',
    emitter: 'edge',
    edge: 'top',
    rate: 320,
    burst: 0,
    life: 1.2,
    speed: 2300,
    direction: 100,
    spread: 2,
    gravity: 0,
    wind: 0,
    turbulence: 0,
    swirl: 200,
    sway: 0,
    drag: 0,
    spin: 0,
    size: 2,
    sizeEnd: 2,
    colors: ['#D3DEE8'],
    alpha: 0.45,
    fadeIn: 0,
    fadeOut: 0,
    flicker: 0,
    sprite: 'streak',
    soft: 0,
    stretch: 0.03,
    flip: 0,
    variance: 0.3,
    blend: 'normal',
    prerun: 1.5,
    max: 500,
    seed: 1
  },
  bokeh: {
    title: 'Bokeh',
    summary: 'Large soft lights drifting',
    emitter: 'box',
    rate: 4,
    burst: 0,
    life: 9,
    speed: 14,
    direction: 0,
    spread: 360,
    gravity: 0,
    wind: 0,
    turbulence: 6,
    swirl: 500,
    sway: 4,
    drag: 0.2,
    spin: 0,
    size: 90,
    sizeEnd: 90,
    colors: ['#FFE3B0', '#FFC48A', '#BFD8FF'],
    alpha: 0.32,
    fadeIn: 0.3,
    fadeOut: 0.35,
    flicker: 0,
    sprite: 'dot',
    soft: 0.3,
    stretch: 0,
    flip: 0,
    variance: 0.6,
    blend: 'add',
    prerun: 9,
    max: 60,
    seed: 1
  },
  smoke: {
    title: 'Smoke',
    summary: 'Slow grey haze rising',
    emitter: 'box',
    area: [-0.1, 0.82, 1.1, 1.08],
    rate: 10,
    burst: 0,
    life: 8,
    speed: 45,
    direction: -90,
    spread: 25,
    gravity: -18,
    wind: 0,
    turbulence: 30,
    swirl: 420,
    sway: 0,
    drag: 0.3,
    spin: 0,
    size: 220,
    sizeEnd: 560,
    colors: ['#C4C8CE'],
    alpha: 0.32,
    fadeIn: 0.25,
    fadeOut: 0.6,
    flicker: 0,
    sprite: 'dot',
    soft: 1,
    stretch: 0,
    flip: 0,
    variance: 0.35,
    blend: 'normal',
    prerun: 6,
    max: 120,
    seed: 1
  }
}

/** The preset a clip starts from when it names none. */
export const DEFAULT_PRESET: ParticlePreset = 'snow'

const LENGTHS = ['speed', 'gravity', 'wind', 'turbulence', 'swirl', 'sway', 'size', 'sizeEnd'] as const

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * A clip's spec made whole for a frame: the preset, what the spec changes,
 * the lengths scaled to the frame's short side, and the cap held.
 */
export function particleSettings(spec: ParticleSpec | undefined, frame: { width: number; height: number }): ParticleSettings {
  const preset = PRESETS[spec?.preset ?? DEFAULT_PRESET]
  const { title: _t, summary: _s, ...look } = preset
  const said = Object.fromEntries(Object.entries(spec ?? {}).filter(([k, v]) => k !== 'preset' && v !== undefined))
  const merged = { ...look, ...said } as Omit<ParticleSettings, 'text' | 'area' | 'edge' | 'colorEnd'> & Partial<ParticleSettings>
  const k = Math.min(frame.width, frame.height) / 1080
  const out: ParticleSettings = {
    ...merged,
    area: (merged.area as ParticleSettings['area'] | undefined) ?? (merged.emitter === 'point' ? [0.5, 0.5, 0.5, 0.5] : FULL),
    edge: merged.edge ?? 'top',
    text: merged.text ?? '',
    colorEnd: merged.colorEnd ?? null,
    // An edge emitter's size sets nothing else; a size end not said follows the size said.
    sizeEnd: said.size !== undefined && said.sizeEnd === undefined ? (said.size as number) * (look.sizeEnd / look.size) : merged.sizeEnd,
    max: clamp(Math.round(merged.max), 1, MAX_PARTICLES),
    burst: clamp(Math.round(merged.burst), 0, MAX_PARTICLES)
  }
  for (const key of LENGTHS) out[key] = out[key] * k
  return out
}

/** A spec's preset's title, for the lanes and the panel: "Snow". */
export function particleTitle(spec: ParticleSpec | undefined): string {
  return PRESETS[spec?.preset ?? DEFAULT_PRESET].title
}

/** The second half of a split system: run on as long as the first had played, with no second burst, so it carries on unbroken. */
export function continuedParticles(spec: ParticleSpec | undefined, by: number): ParticleSpec {
  const prerun = spec?.prerun ?? PRESETS[spec?.preset ?? DEFAULT_PRESET].prerun
  return { ...spec, prerun: Math.min(30, Math.round((prerun + by) * 1000) / 1000), burst: 0 }
}
