import { z } from 'zod'

/**
 * Transitions between beats.
 *
 * A hard cut is the default and stays the default: the research found the
 * measured creators cut hard almost everywhere and keep transitions for section
 * changes and accents. Everything else is one of ffmpeg's xfade transitions,
 * named the way an editor says them, with a matching audio crossfade.
 *
 * A transition belongs to the beat it brings in, the way the classic timeline
 * keeps one on the clip it runs into, so moving a beat moves how it comes in.
 *
 * This module is a leaf: it imports nothing from the rest of the edit, so the
 * schema can use it without a cycle.
 */

/** How each transition renders, and how the preview approximates it. */
export interface TransitionInfo {
  /**
   * The ffmpeg xfade transition. Dips use a plain fade between two pictures
   * already faded to the colour: xfade's own fadeblack lets the new picture in
   * before the midpoint, so it never reaches black.
   */
  xfade: string
  /** A plain name for sentences: "a dissolve", "a whip pan". */
  label: string
  /** Seconds when nobody says how long. */
  defaultSec: number
  /**
   * What the preview draws: a cross-fade by opacity, a dip through a colour,
   * a wipe or slide as a clip or a move from one side, an iris, a zoom, or a
   * blur. Exact shapes are the export's job.
   */
  preview: 'fade' | 'dip' | 'wipe' | 'slide' | 'cover' | 'iris' | 'zoom' | 'blur' | 'whip' | 'glitch' | 'rgb' | 'vhs'
  /** For dips: the colour passed through. */
  color?: 'black' | 'white'
  /** For wipes, slides, covers and whips: where the new picture comes from. */
  from?: 'left' | 'right' | 'top' | 'bottom'
}

export const TRANSITION_INFO = {
  dissolve: { xfade: 'fade', label: 'a dissolve', defaultSec: 0.5, preview: 'fade' },
  'dip-to-black': { xfade: 'fade', label: 'a dip to black', defaultSec: 0.6, preview: 'dip', color: 'black' },
  'dip-to-white': { xfade: 'fade', label: 'a dip to white', defaultSec: 0.6, preview: 'dip', color: 'white' },
  flash: { xfade: 'fade', label: 'a white flash', defaultSec: 0.16, preview: 'dip', color: 'white' },
  'whip-left': { xfade: 'slideleft', label: 'a whip pan', defaultSec: 0.3, preview: 'whip', from: 'right' },
  'whip-right': { xfade: 'slideright', label: 'a whip pan', defaultSec: 0.3, preview: 'whip', from: 'left' },
  'push-left': { xfade: 'slideleft', label: 'a push', defaultSec: 0.4, preview: 'slide', from: 'right' },
  'push-right': { xfade: 'slideright', label: 'a push', defaultSec: 0.4, preview: 'slide', from: 'left' },
  'push-up': { xfade: 'slideup', label: 'a push', defaultSec: 0.4, preview: 'slide', from: 'bottom' },
  'push-down': { xfade: 'slidedown', label: 'a push', defaultSec: 0.4, preview: 'slide', from: 'top' },
  'slide-left': { xfade: 'coverleft', label: 'a slide', defaultSec: 0.4, preview: 'cover', from: 'right' },
  'slide-right': { xfade: 'coverright', label: 'a slide', defaultSec: 0.4, preview: 'cover', from: 'left' },
  'slide-up': { xfade: 'coverup', label: 'a slide', defaultSec: 0.4, preview: 'cover', from: 'bottom' },
  'slide-down': { xfade: 'coverdown', label: 'a slide', defaultSec: 0.4, preview: 'cover', from: 'top' },
  'wipe-left': { xfade: 'wipeleft', label: 'a wipe', defaultSec: 0.5, preview: 'wipe', from: 'right' },
  'wipe-right': { xfade: 'wiperight', label: 'a wipe', defaultSec: 0.5, preview: 'wipe', from: 'left' },
  'wipe-up': { xfade: 'wipeup', label: 'a wipe', defaultSec: 0.5, preview: 'wipe', from: 'bottom' },
  'wipe-down': { xfade: 'wipedown', label: 'a wipe', defaultSec: 0.5, preview: 'wipe', from: 'top' },
  'smooth-left': { xfade: 'smoothleft', label: 'a smooth wipe', defaultSec: 0.6, preview: 'wipe', from: 'right' },
  'smooth-right': { xfade: 'smoothright', label: 'a smooth wipe', defaultSec: 0.6, preview: 'wipe', from: 'left' },
  'smooth-up': { xfade: 'smoothup', label: 'a smooth wipe', defaultSec: 0.6, preview: 'wipe', from: 'bottom' },
  'smooth-down': { xfade: 'smoothdown', label: 'a smooth wipe', defaultSec: 0.6, preview: 'wipe', from: 'top' },
  zoom: { xfade: 'zoomin', label: 'a zoom', defaultSec: 0.5, preview: 'zoom' },
  'circle-open': { xfade: 'circleopen', label: 'a circle opening', defaultSec: 0.6, preview: 'iris' },
  'circle-close': { xfade: 'circleclose', label: 'a circle closing', defaultSec: 0.6, preview: 'iris' },
  clock: { xfade: 'radial', label: 'a clock wipe', defaultSec: 0.6, preview: 'wipe', from: 'top' },
  'doors-open': { xfade: 'vertopen', label: 'doors opening', defaultSec: 0.6, preview: 'iris' },
  pixelate: { xfade: 'pixelize', label: 'a pixelate', defaultSec: 0.5, preview: 'blur' },
  blur: { xfade: 'hblur', label: 'a blur', defaultSec: 0.5, preview: 'blur' },
  squeeze: { xfade: 'squeezeh', label: 'a squeeze', defaultSec: 0.5, preview: 'zoom' },
  // The looks (TRANSITION_LOOKS): each is a dissolve under its own damage, drawn over the meeting.
  glitch: { xfade: 'fade', label: 'a glitch', defaultSec: 0.3, preview: 'glitch' },
  'rgb-split': { xfade: 'fade', label: 'an RGB split', defaultSec: 0.4, preview: 'rgb' },
  vhs: { xfade: 'fade', label: 'a VHS glitch', defaultSec: 0.5, preview: 'vhs' }
} as const satisfies Record<string, TransitionInfo>

/** Every transition the edit can show, the looks included. */
export type TransitionKind = keyof typeof TRANSITION_INFO

/**
 * Transitions Cutalong 0.2.13 does not know. An edit keeps one as a
 * dissolve with the look beside it (TransitionSchema.look), so 0.2.13, which
 * drops a field it does not know, opens the edit and shows a dissolve there,
 * and a version never keeps the op that set one (edit/doc savedOps).
 */
export const TRANSITION_LOOKS = ['glitch', 'rgb-split', 'vhs'] as const
export type TransitionLook = (typeof TRANSITION_LOOKS)[number]

export const isTransitionLook = (kind: string): kind is TransitionLook =>
  (TRANSITION_LOOKS as readonly string[]).includes(kind)

/** The transitions an edit saves by name: every one but the looks, as 0.2.13 knows them. */
export const TRANSITION_KINDS = Object.keys(TRANSITION_INFO).filter((k) => !isTransitionLook(k)) as [
  Exclude<TransitionKind, TransitionLook>,
  ...Exclude<TransitionKind, TransitionLook>[]
]

/** Every transition an op or the planner may name, the looks included. */
export const ALL_TRANSITION_KINDS = Object.keys(TRANSITION_INFO) as [TransitionKind, ...TransitionKind[]]

/** A frame at 25 fps, the shortest a transition can be and still be seen. */
export const MIN_TRANSITION_SEC = 0.04
export const MAX_TRANSITION_SEC = 3

export const TransitionSchema = z.object({
  kind: z.enum(TRANSITION_KINDS),
  /** How long the two beats overlap, in seconds. */
  sec: z.number().min(MIN_TRANSITION_SEC).max(MAX_TRANSITION_SEC),
  /** A look over the dissolve `kind` names (TRANSITION_LOOKS): what shows, where it is set. */
  look: z.enum(TRANSITION_LOOKS).optional()
})
export type Transition = z.infer<typeof TransitionSchema>

/** What a beat's transition shows: its look, or the transition it names. */
export function shownTransition(t: Transition): TransitionKind {
  return t.look ?? t.kind
}

/** A transition as a beat keeps it: a look is kept as a dissolve with the look beside it. */
export function keptTransition(kind: TransitionKind, sec: number): Transition {
  return isTransitionLook(kind) ? { kind: 'dissolve', sec, look: kind } : { kind, sec }
}

/** The longest a J or L cut moves the picture's edit point off the sound's. */
export const MAX_SPLIT_EDIT_SEC = 3
/** Seconds when nobody says how far: about nine frames, a beat a listener feels rather than notices. */
export const DEFAULT_SPLIT_EDIT_SEC = 0.3

/**
 * A split edit, kept on the beat it brings in. The words stay where the cut
 * puts them and only the picture's edit point moves: a J cut keeps the
 * picture before running `sec` into this beat's sound (you hear the next line
 * before you see it); an L cut brings this beat's picture in `sec` early,
 * under the end of the sound before.
 */
export const SplitEditSchema = z.object({
  kind: z.enum(['j', 'l']),
  sec: z.number().min(MIN_TRANSITION_SEC).max(MAX_SPLIT_EDIT_SEC)
})
export type SplitEdit = z.infer<typeof SplitEditSchema>

/** Fading the whole video in at the start and out at the end. */
export const FadeSchema = z.object({
  inSec: z.number().min(0).max(5),
  outSec: z.number().min(0).max(5),
  color: z.enum(['black', 'white'])
})
export type Fade = z.infer<typeof FadeSchema>

export function transitionInfo(kind: TransitionKind): TransitionInfo {
  return TRANSITION_INFO[kind]
}

const ALIASES: Record<string, TransitionKind> = {
  dissolve: 'dissolve',
  crossfade: 'dissolve',
  'cross-dissolve': 'dissolve',
  fade: 'dissolve',
  mix: 'dissolve',
  dip: 'dip-to-black',
  black: 'dip-to-black',
  'fade-to-black': 'dip-to-black',
  'dip-black': 'dip-to-black',
  white: 'dip-to-white',
  'dip-white': 'dip-to-white',
  'fade-to-white': 'dip-to-white',
  flash: 'flash',
  'white-flash': 'flash',
  'flash-white': 'flash',
  whip: 'whip-left',
  'whip-pan': 'whip-left',
  swish: 'whip-left',
  push: 'push-left',
  slide: 'slide-left',
  wipe: 'wipe-left',
  smooth: 'smooth-left',
  zoom: 'zoom',
  'zoom-in': 'zoom',
  circle: 'circle-open',
  iris: 'circle-open',
  clock: 'clock',
  radial: 'clock',
  doors: 'doors-open',
  'barn-doors': 'doors-open',
  pixel: 'pixelate',
  pixelate: 'pixelate',
  pixelize: 'pixelate',
  blur: 'blur',
  squeeze: 'squeeze',
  glitch: 'glitch',
  glitchy: 'glitch',
  digital: 'glitch',
  datamosh: 'glitch',
  rgb: 'rgb-split',
  'rgb-split': 'rgb-split',
  'colour-split': 'rgb-split',
  'color-split': 'rgb-split',
  chromatic: 'rgb-split',
  'chromatic-aberration': 'rgb-split',
  vhs: 'vhs',
  tape: 'vhs',
  'vhs-glitch': 'vhs',
  retro: 'vhs'
}

/**
 * Reads a transition from a few words: "whip", "dip to white", "slide up",
 * "wipe right". "cut", "hard cut" and "none" read as 'cut', a hard cut. Null
 * when the words name nothing, so a command can say so.
 */
export function parseTransition(words: string): TransitionKind | 'cut' | null {
  const key = words
    .toLowerCase()
    .replace(/\b(a|an|the|transitions?|please|use|with|into)\b/g, ' ')
    .trim()
    .replace(/[^a-z]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!key) return null
  if (/^(hard-)?cuts?$|^none$|^no$|^off$/.test(key)) return 'cut'
  if (key in TRANSITION_INFO) return key as TransitionKind
  if (ALIASES[key]) return ALIASES[key]
  // A family word with a direction: "slide up", "wipe-right", "push down".
  const m = /^(whip|push|slide|wipe|smooth)(?:-pan)?-(left|right|up|down)$/.exec(key)
  if (m) {
    const kind = `${m[1]}-${m[2]}`
    if (kind in TRANSITION_INFO) return kind as TransitionKind
    // Whips only go sideways.
    return m[1] === 'whip' ? 'whip-left' : null
  }
  const first = key.split('-')[0]
  return ALIASES[first] ?? null
}
