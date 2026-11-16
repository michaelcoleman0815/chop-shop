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

/** A value, or keyframes for it. */
export type Anim<V> = V | { keys: Key<V>[] }

/** #RRGGBB, #RRGGBBAA, or rgb()/rgba(). */
export type Color = string

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
  /** One plate per line rather than one around the block. */
  perLine?: boolean
  scaleX?: Anim<number>
  scaleY?: Anim<number>
  opacity?: Anim<number>
  /** Where scaleX grows from: 0 the left edge, 0.5 the centre. */
  originX?: number
  stroke?: Stroke
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
  plate?: Plate
  animators?: Animator[]
  active?: Active
  cursor?: Cursor
  count?: Count
  /** Set along a path instead of in lines, starting at `offset` pixels along it. */
  path?: { shape: Geometry; offset?: Anim<number> }
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
  asset?: string
  icon?: string
  w: number
  h: number
  fit?: 'contain' | 'cover'
  /** Icon stroke colour. */
  color?: Anim<Color>
  /** Icon stroke width, in the icon's 24-unit grid. */
  strokeWidth?: number
  /** Icons draw on like strokes. */
  trim?: { start?: Anim<number>; end?: Anim<number> }
}

export interface GroupLayer<T = number> extends Base<T> {
  kind: 'group'
  children: Layer<T>[]
}

export type Layer<T = number> = TextLayer<T> | ShapeLayer<T> | ImageLayer<T> | GroupLayer<T>

/** A Lucide icon: element name and attributes, as lucide-static ships them. */
export type IconNode = [string, Record<string, string | number>]

/** What drawing needs from the place it runs: decoded images and icon shapes. */
export interface DrawResources {
  images?: Map<string, CanvasImageSource>
  icons?: (name: string) => IconNode[] | undefined
  /** A person matte for this frame, white where the person is, the frame's size. */
  matte?: CanvasImageSource | null
  /** Makes an offscreen canvas, for layers drawn behind the person. */
  createCanvas?: (width: number, height: number) => { getContext(kind: '2d'): CanvasRenderingContext2D | null }
}

export interface Size {
  width: number
  height: number
}
