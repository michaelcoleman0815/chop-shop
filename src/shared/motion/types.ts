import type { Chrome } from './chrome'
import type { ParticleSettings } from '../particles/presets'
/**
 * The motion layer model: what gets drawn over the picture, and how it moves.
 *
 * These are the engine's own types. Templates build them, the scene resolves
 * them to output time, and drawFrame paints them with the standard Canvas2D
 * API, so the editor's preview and the export draw the same thing from the
 * same numbers. Everything visual is keyframeable.
 *
 * Coordinates are design pixels: the full-size output frame (1080 x 1920 for
 * vertical), whatever the canvas actually is. Times on a layer are output
 * seconds; times on keyframes are seconds from the layer's start.
 */

import type { MapResources } from '../maps/paint'
import type { MapPaint } from '../maps/types'
import type { Scene3D } from '../three/spec'

/** After Effects-style curves, CSS-style curves, and physical ones. */
export const EASE_NAMES = [
  'linear',
  'hold',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'easy-ease',
  'easy-ease-in',
  'easy-ease-out',
  'snap',
  'smooth',
  // The standard power curves motion designers name, measured on creators' own moves: a fade or a small rise
  // eases out on a quad, a card slides in on a quint over most of a second, a row or a fill eases in and out.
  'out-quad',
  'out-cubic',
  'out-quart',
  'out-quint',
  'out-expo',
  'in-out-quad',
  'in-out-cubic',
  'in-out-quart',
  // Exits that leave faster and faster: a collage falling out of frame.
  'in-quad',
  'in-cubic',
  'back-out',
  'overshoot',
  'bounce',
  'spring',
  'elastic'
] as const
export type EaseName = (typeof EASE_NAMES)[number]

/** A named curve, a cubic-bezier like CSS, or a spring that settles inside its segment (bounce 0 to 0.95). */
export type Ease = EaseName | { bezier: [number, number, number, number] } | { spring: number }

/**
 * A keyframe. `ease` shapes the move from this key to the next, the way a
 * CSS animation-timing-function does; `hold` keeps this value until the next
 * key. `t` counts from the layer's start, or back from its end with `from: 'end'`.
 */
export interface Key<V> {
  t: number
  v: V
  ease?: Ease
  from?: 'start' | 'end'
}

/**
 * Where an expression runs (shared/anim/expr): the clip's place, and another
 * clip's setting `local` seconds into this one. Set when a clip becomes a
 * layer (tracks/layers); never saved.
 */
export interface ExprBinding {
  index: number
  clip?: (name: string, path: string, local: number) => number | number[] | null
}

/**
 * A value, or keyframes for it. An expression (shared/anim/expr) may ride on
 * the keys, or on no keys at all, and gives the value instead, reading the
 * keys' own as `value`.
 */
export type Anim<V> = V | { keys: Key<V>[]; expr?: string; bind?: ExprBinding }

/**
 * How a layer mixes with what is drawn under it, by Canvas2D's compositing names
 * (and so the same in the preview and the export). `add` is Canvas's `lighter`.
 */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'add'
] as const
export type BlendMode = (typeof BLEND_MODES)[number]

/** How much of a picture is cut from each side, as shares of its width or height, 0 to 1. */
export interface Crop {
  left?: Anim<number>
  top?: Anim<number>
  right?: Anim<number>
  bottom?: Anim<number>
}

/** #RRGGBB, #RRGGBBAA, or rgb()/rgba(). */
export type Color = string

/** What an adjustment layer grades with, and the box it grades inside. */
export interface Adjustment {
  exposure?: number
  contrast?: number
  saturation?: number
  temperature?: number
  tint?: number
  lift?: number
  vignette?: number
  /** Design pixels. */
  blur?: number
  w: number
  h: number
  crop?: Crop
}

export interface Gradient {
  gradient: 'linear' | 'radial'
  /** Degrees, 0 runs left to right, 90 top to bottom. Linear only. */
  angle?: number
  /** Offsets 0 to 1. */
  stops: [number, Color][]
}

export type Fill = Anim<Color> | Gradient

export interface Stroke {
  color: Anim<Color>
  width: Anim<number>
  cap?: 'butt' | 'round' | 'square'
  join?: 'miter' | 'round' | 'bevel'
  /** A dashed line: dash and gap lengths, repeating, in the layer's pixels. A dashed stroke draws whole (no trim). */
  dash?: number[]
}

export interface Shadow {
  color: Color
  blur: number
  x?: number
  y?: number
}

export interface Effects {
  /** A drop shadow under whatever the layer draws. */
  shadow?: Shadow
  /** A soft halo in a colour, drawn behind the layer. */
  glow?: { color: Color; blur: number; strength?: number }
  /** Gaussian blur over the whole layer, in design pixels. */
  blur?: Anim<number>
}

/**
 * Where a layer sits and how it is turned. Position places the layer's
 * origin in its parent; scale and rotation happen around the anchor, given in
 * the layer's own pixels (0, 0 is the origin), the way After Effects does it.
 */
export interface Transform {
  x?: Anim<number>
  y?: Anim<number>
  anchorX?: Anim<number>
  anchorY?: Anim<number>
  scale?: Anim<number>
  scaleX?: Anim<number>
  scaleY?: Anim<number>
  /** Degrees, clockwise. */
  rotation?: Anim<number>
  /** Degrees of slant: a card leaning back reads as a slight 3D tilt. */
  skewX?: Anim<number>
  skewY?: Anim<number>
  /** 0 to 1, multiplied through to children. */
  opacity?: Anim<number>
}

export type Point = [number, number]

/** Shapes in the layer's own pixels. Rects and ellipses are centred on (x, y), the origin by default. */
export type Geometry =
  | { type: 'rect'; w: number; h: number; radius?: number; x?: number; y?: number }
  | {
      type: 'ellipse'
      w: number
      h: number
      x?: number
      y?: number
      /** Where the outline starts, degrees from 3 o'clock. */ startAngle?: number
      /** Turns drawn: 1 closes it, 1.1 overlaps like a pen circle. */ sweep?: number
    }
  | { type: 'line'; points: Point[] }
  | { type: 'arrow'; points: Point[]; /** Length of each side of the head. */ head?: number }
  | { type: 'polygon'; points: Point[] }
  | { type: 'star'; points: number; outer: number; inner: number; x?: number; y?: number; rotation?: number }
  /** SVG path data. */
  | { type: 'path'; d: string }

/**
 * A mask a layer is cut to (shared/motion/roto): a closed Bezier path in the
 * layer's own pixels, softened, grown or shrunk, and combined with the masks
 * before it. Points are [x, y, inX, inY, outX, outY], handles as offsets.
 */
export interface LayerMask {
  path: Anim<number[][]>
  mode: 'add' | 'subtract' | 'intersect'
  invert?: boolean
  /** How soft its edge is, in design pixels. */
  feather?: Anim<number>
  /** Grown by this many design pixels, or shrunk below 0. */
  expand?: Anim<number>
  opacity?: Anim<number>
  /** Where the path's own origin is in the layer's pixels. */
  origin?: { x: number; y: number }
  /** Its own movement inside the layer's, from the origin. */
  transform?: Transform
}

/** A track matte: the layer shows only where it says (person, objects, object:<n>, clip:<id>), or everywhere but there. */
export interface LayerMatte {
  from: string
  mode: 'alpha' | 'luma'
  invert?: boolean
}

/** A colour taken out of a picture (shared/motion/chroma). Each setting is 0 to 1. */
export interface ChromaKey {
  colour: Color
  tolerance: number
  softness: number
  spill: number
}

/** A clip region in the layer's own pixels, with its own movement. */
export interface Mask {
  shape: Geometry
  transform?: Transform
  /** Show everything except the shape. */
  invert?: boolean
}

interface Base<T> {
  id?: string
  /** Output seconds the layer is on screen, start inclusive, end exclusive. */
  start: T
  end: T
  transform?: Transform
  effects?: Effects
  mask?: Mask
  /** Drawn under the person in the frame, once a person matte is available. */
  behind?: boolean
  /**
   * Animated at its own frame rate, held between: 12 is "on twos", the stop-motion step a collage title moves in
   * (Deep End with Lecrae's). Everything inside a group steps with it. Smooth when absent.
   */
  fps?: number
  /** Cut to these, in order (shared/motion/roto). */
  masks?: LayerMask[]
  /** Shown only where a matte says. */
  matte?: LayerMatte
  /** Only another layer's matte (its id named by a matte's clip:<id>): not drawn itself. */
  asMatte?: boolean
  /** How it mixes with what is under it; normal when absent. */
  blend?: BlendMode
  /**
   * An adjustment layer (shared/motion/adjust): it draws nothing of its own
   * and grades everything drawn under it instead, inside its box (w by h,
   * centred on its origin, cut by its crop), by its opacity.
   */
  adjust?: Adjustment
  /**
   * Real motion blur: while the layer moves, it is drawn at `samples` moments
   * across `shutter` seconds centred on the frame and averaged, so a fast move
   * streaks along its path. Needs DrawResources.createCanvas; without it the
   * layer is drawn sharp.
   */
  motionBlur?: { shutter: number; samples?: number }
}

/** A run of text with its own look and, for speech, its own time. */
export interface Span {
  text: string
  /** When this span is spoken, in seconds from the layer's start. */
  t?: number
  end?: number
  color?: Color
  /** Size relative to the layer's font. */
  scale?: number
  weight?: number
  /** Another face for this span's words (motion/fonts), instead of the layer's. */
  family?: string
  /** This span's words in capitals, or not, whatever the layer says. */
  uppercase?: boolean
  /** Lines that begin in this span sit this way inside the block, rather than as the layer aligns. */
  align?: 'left' | 'center' | 'right'
}

export interface Font {
  family: string
  /** Design pixels. */
  size: number
  weight?: number
  /** Multiple of the size; 1.15 by default. */
  lineHeight?: number
  /** Extra space between characters, in design pixels. */
  tracking?: number
  uppercase?: boolean
  /** Digits all as wide as a zero, so counting numbers do not jitter. */
  tabular?: boolean
  /**
   * Leaned forward by this much across for each pixel up, about each word's baseline: a face with no italic
   * of its own slanted, as libass slants one for a caption look set italic (0.2126, FreeType's oblique).
   */
  slant?: number
  /** Extra room between words, in design pixels: a slanted face leans into its spaces. */
  wordSpacing?: number
}

/** How far a unit of text is from rest. Rest is opacity 1, no offset, scale 1, no blur. */
export interface UnitState {
  opacity?: number
  x?: number
  y?: number
  scale?: number
  rotation?: number
  blur?: number
  /** Extra space between characters. */
  tracking?: number
  color?: Color
  /** How much of the unit shows, left to right, 0 to 1. */
  wipe?: number
}

/**
 * A text animator, like After Effects': units (characters, words or lines)
 * move from `from` to rest one after another (`stagger`) or each when it is
 * spoken (`spoken`, from the spans' times). An `out` animator runs the other
 * way at the end of the layer.
 */
export interface Animator {
  by: 'char' | 'word' | 'line'
  timing?: 'stagger' | 'spoken'
  /** Seconds after the layer starts (stagger) or after each word is said (spoken); negative leads. */
  delay?: number
  stagger?: number
  duration: number
  ease?: Ease
  order?: 'forward' | 'backward' | 'center' | 'random'
  from: UnitState
  out?: boolean
  /** Units only show inside their resting box, so offsets read as a reveal behind an edge. */
  clip?: boolean
  /** Only these spans move. */
  spans?: number[]
}

/** A box behind the text, sized to it. Its own scale and opacity animate around the block's centre. */
export interface Plate {
  color: Fill
  radius?: number
  padX?: number
  padY?: number
  /** One plate per line rather than one around the block; a line's plate shows once its line starts to appear. */
  perLine?: boolean
  /**
   * With perLine, each plate hugs its line's capitals rather than the line
   * box, with padY scaled to the line's size; line height makes the gaps.
   * Leave padY room for descenders.
   */
  hug?: boolean
  /**
   * With perLine, each line's plate runs its keys this many seconds after the
   * one above, and shows on that timing rather than its line's.
   */
  stagger?: number
  scaleX?: Anim<number>
  scaleY?: Anim<number>
  opacity?: Anim<number>
  /** Where scaleX grows from: 0 the left edge, 0.5 the centre. */
  originX?: number
  stroke?: Stroke
  /** A bar along one side of the plate, as tall as the plate: a lower third's accent. */
  edge?: { color: Color; width: number; side?: 'left' | 'right' }
  /** With perLine, each line's plate takes the colour of the span its first word belongs to. */
  spanColors?: Fill[]
}

/** The spoken word: its own colour and size, and a box that sweeps from word to word. */
export interface Active {
  color?: Color
  scale?: number
  box?: {
    color: Color
    radius?: number
    padX?: number
    padY?: number
    /** Seconds the box takes to move to the next word. */ move?: number
  }
}

/** A typing cursor after the last character showing. */
export interface Cursor {
  color: Color
  width: number
  /** Blinks once the typing is done. */
  blink?: boolean
}

/** A number that counts as it shows: the text is drawn from it every frame. */
export interface Count {
  from: number
  to: number
  decimals: number
  prefix?: string
  suffix?: string
  /** Thousands separators. */
  group?: boolean
  /** 0 shows `from`, 1 shows `to`. */
  progress: Anim<number>
}

export interface TextLayer<T = number> extends Base<T> {
  kind: 'text'
  text: string
  /** Replaces `text` with styled, optionally timed runs, one word each for speech. */
  spans?: Span[]
  font: Font
  fill?: Fill
  stroke?: Stroke
  /** Where the block sits on the origin. */
  align?: 'left' | 'center' | 'right'
  valign?: 'top' | 'middle' | 'bottom' | 'baseline'
  /** Wrap width in design pixels. */
  maxWidth?: number
  /** Wrap to lines of even length rather than filling each line, so no word is left alone on the last. */
  balance?: boolean
  plate?: Plate
  animators?: Animator[]
  active?: Active
  cursor?: Cursor
  count?: Count
  /** Set along a path instead of in lines, starting at `offset` pixels along it. */
  path?: { shape: Geometry; offset?: Anim<number> }
  /** Drawn as chrome lettering, with depth, a bevel, an outline and a glow (motion/chrome); fill and plate are not used. */
  chrome?: Chrome
}

export interface ShapeLayer<T = number> extends Base<T> {
  kind: 'shape'
  shape: Geometry
  fill?: Fill
  stroke?: Stroke
  /** Trim paths, as fractions of the outline's length: draw-on is end going 0 to 1. */
  trim?: { start?: Anim<number>; end?: Anim<number> }
  /** Becomes another shape as progress goes 0 to 1. */
  morph?: { to: Geometry; progress: Anim<number> }
}

/** An image from the edit's material, or a Lucide icon drawn as vectors. Centred on the origin, w by h. */
export interface ImageLayer<T = number> extends Base<T> {
  kind: 'image'
  /** A colour taken out of the picture. */
  key?: ChromaKey
  asset?: string
  icon?: string
  /** A brand mark from Simple Icons, by slug, in the brand's own colour. */
  logo?: string
  /** A picture on this computer by path: a logo the creator supplied on the brand page. */
  file?: string
  /** A tile it sits on: an app icon (square) or a coin (round). A logo's colour fills it; a picture is cut to it. */
  tile?: 'square' | 'round'
  /** Drawn instead when the logo or picture is not there: a letter or two, on the tile when there is one, in `color` (white when absent). */
  fallback?: { text: string; family: string; color?: string }
  w: number
  h: number
  /** Fill stretches the picture to the box (with a crop, or for a clip on a track). */
  fit?: 'contain' | 'cover' | 'fill'
  /** Icon stroke colour. */
  color?: Anim<Color>
  /** Icon stroke width, in the icon's 24-unit grid. */
  strokeWidth?: number
  /** Solid: an icon's closed outlines filled in its colour as well as stroked, as a filled heart. */
  iconFill?: boolean
  /** Icons draw on like strokes. */
  trim?: { start?: Anim<number>; end?: Anim<number> }
  /** Cut from a picture's sides before it is fitted. */
  crop?: Crop
  /** Drawn as a mosaic of square blocks this many of the layer's pixels across: a teaser that hides what it is. */
  pixelate?: number
}

/**
 * A video playing in the frame: a clip on one of the edit's layer tracks
 * (shared/tracks). Centred on the origin, w by h, fitted like an image. Its
 * frame at a moment comes from DrawResources.video: a <video> element in the
 * editor, frames decoded by ffmpeg in the export.
 */
export interface VideoLayer<T = number> extends Base<T> {
  kind: 'video'
  /** A colour taken out of the picture. */
  key?: ChromaKey
  /** The file, on this computer. */
  src: string
  /** Where in the file it starts, in seconds. */
  in: number
  /** 2 plays twice as fast; 1 when absent. */
  speed?: number
  w: number
  h: number
  fit?: 'contain' | 'cover' | 'fill'
  crop?: Crop
}

/**
 * A 3D scene playing in the frame: a 3D clip on one of the edit's layer
 * tracks (shared/three). three.js draws it to a canvas of its own, which is
 * laid in w by h around the origin like a video's frame, so it blends, fades
 * and stacks as any layer does. Its frame at a moment comes from
 * DrawResources.scene3d: a WebGL canvas in the editor, the export's 3D page.
 */
export interface Scene3DLayer<T = number> extends Base<T> {
  kind: '3d'
  scene: Scene3D
  w: number
  h: number
}

export interface GroupLayer<T = number> extends Base<T> {
  kind: 'group'
  children: Layer<T>[]
}

/** A map shot: its camera, the places it lights up, its lines, pins and labels (src/shared/maps). */
export interface MapLayer<T = number> extends Base<T> {
  kind: 'map'
  map: MapPaint
}

/** Snow, sparks, confetti: a particle system stepped from the layer's start over a frame w by h centred on the origin (shared/particles). */
export interface ParticlesLayer<T = number> extends Base<T> {
  kind: 'particles'
  /** Its settings, whole and scaled to the frame. */
  particles: ParticleSettings
  /** What the system is, so a frame carries on from the last one drawn of it. */
  key: string
  w: number
  h: number
  /** The picture each particle is, for the image sprite, by path (DrawResources.images, `file:` and the path). */
  file?: string
}

export type Layer<T = number> = TextLayer<T> | ShapeLayer<T> | ImageLayer<T> | GroupLayer<T> | MapLayer<T> | VideoLayer<T> | ParticlesLayer<T> | Scene3DLayer<T>

/** A Lucide icon: element name and attributes, as lucide-static ships them. */
export type IconNode = [string, Record<string, string | number>]

/** What drawing needs from the place it runs: decoded images and icon shapes. */
/** A brand mark from Simple Icons: an SVG path on a 24-unit grid, and the brand's colour without its #. */
export interface LogoMark {
  title: string
  hex: string
  path: string
}

export interface DrawResources {
  /** Pictures by asset id, and by `file:` and a path for the brand's own logos. */
  images?: Map<string, CanvasImageSource>
  icons?: (name: string) => IconNode[] | undefined
  logos?: (slug: string) => LogoMark | undefined
  /** A person matte for this frame, white where the person is, the frame's size. */
  matte?: CanvasImageSource | null
  /** Makes an offscreen canvas, for layers drawn behind the person. */
  createCanvas?: (width: number, height: number) => { getContext(kind: '2d'): CanvasRenderingContext2D | null }
  /** The map data and the satellite tiles loaded so far, for map layers. */
  map?: MapResources
  /** A video layer's frame, `local` seconds into the layer; null when it is not ready. */
  video?: (layer: VideoLayer, local: number) => CanvasImageSource | null
  /**
   * The edit's own picture at this moment, drawn first by renderFrame, so a
   * blend mode or an adjustment layer works on it too; the layers are a
   * see-through overlay when absent.
   */
  base?: CanvasImageSource | null
  /** Told when an adjustment layer cannot read the picture under it (a page reading media it may not), which leaves it ungraded. */
  unreadable?: (why: string) => void
  /**
   * A matte at output time t, at about this size, white where it is: the
   * person, every object, or one object (object:<n>), from the cut-outs;
   * null when there is none. A layer drawn behind the person uses the person's
   * when `matte` is not given.
   */
  mattes?: (from: string, t: number, width: number, height: number) => CanvasImageSource | null
  /** The longest side a chroma key is worked at, for a preview that must keep up; the picture's own size when absent. */
  keySize?: number
  /** A 3D layer's frame, drawn `local` seconds into the layer; null when it is not ready. */
  scene3d?: (layer: Scene3DLayer, local: number) => CanvasImageSource | null
  /**
   * The seconds a fast-moving layer's motion blur spans when it names none of its own (Layer.motionBlur): the
   * export gives half a frame, After Effects' 180-degree shutter, so a move across the frame (a push, a whip)
   * streaks as a camera sees it rather than jumping between frames; slower moves stay crisp, as creators keep
   * them. Absent, only layers that ask for it are blurred.
   */
  shutter?: number
}

export interface Size {
  width: number
  height: number
}
