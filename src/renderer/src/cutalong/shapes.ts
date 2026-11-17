/**
 * Shapes with character: organic blobs, soft stars and scalloped badges, for
 * stickers (a version's badge, "new") and for each brand's own avatar, picked
 * on the Brand page as a shape and a colour.
 *
 * Each shape is a curve around a centre, its radius a function of the angle,
 * drawn as one smooth closed path in a 100 × 100 box. The colours are the
 * revision colours as tokens (tokens.css): a deeper bloom for the shape, a
 * pastel block for the page or card around it.
 */

export const SHAPES = [
  'blob',
  'pebble',
  'squircle',
  'clover',
  'flower',
  'star',
  'scallop',
  'burst',
  'wave',
  'spark',
  'leaf',
  'pill',
  'circle'
] as const
export type ShapeName = (typeof SHAPES)[number]

/** What each shape is called, for the picker's labels. */
export const SHAPE_NAMES: Record<ShapeName, string> = {
  blob: 'Blob',
  pebble: 'Pebble',
  squircle: 'Soft square',
  clover: 'Clover',
  flower: 'Flower',
  star: 'Soft star',
  scallop: 'Badge',
  burst: 'Burst',
  wave: 'Cloud',
  spark: 'Spark',
  leaf: 'Leaf',
  pill: 'Pill',
  circle: 'Circle'
}

export const COLOURS = ['blue', 'pink', 'yellow', 'green', 'gold', 'salmon', 'lavender'] as const
export type ColourName = (typeof COLOURS)[number]

export const COLOUR_NAMES: Record<ColourName, string> = {
  blue: 'Blue',
  pink: 'Pink',
  yellow: 'Yellow',
  green: 'Green',
  gold: 'Goldenrod',
  salmon: 'Salmon',
  lavender: 'Lavender'
}

/** The deeper tone, for the shape itself. */
export const bloom = (c: ColourName): string => `var(--bloom-${c})`
/** The pastel block, for the card or page around it. */
export const block = (c: ColourName): string => `var(--block-${c})`

type Radius = (a: number) => number

const sharpen = (v: number, k: number): number => Math.sign(v) * Math.abs(v) ** k

/** Each shape's radius at an angle, measured from straight up. */
const RADIUS: Record<ShapeName, Radius> = {
  circle: () => 1,
  blob: (a) => 1 + 0.075 * Math.sin(2 * a + 0.4) + 0.055 * Math.sin(3 * a + 2.2) + 0.03 * Math.sin(5 * a + 1.1),
  pebble: (a) => {
    const t = a + 0.35
    return 1 / Math.sqrt((Math.cos(t) / 1) ** 2 + (Math.sin(t) / 0.8) ** 2) + 0.025 * Math.sin(3 * a + 0.7)
  },
  squircle: (a) => (Math.abs(Math.cos(a)) ** 4 + Math.abs(Math.sin(a)) ** 4) ** -0.25,
  clover: (a) => 1 + 0.14 * Math.cos(4 * a),
  flower: (a) => 1 + 0.11 * Math.cos(6 * a),
  star: (a) => 1 + 0.2 * Math.cos(5 * a),
  scallop: (a) => 0.93 + 0.07 * Math.abs(Math.cos(6 * a)),
  burst: (a) => 1 + 0.13 * sharpen(Math.cos(10 * a), 0.7),
  // Soft and a little wide, with a wave along its edge.
  wave: (a) => (1 / Math.sqrt((Math.cos(a) / 0.88) ** 2 + Math.sin(a) ** 2)) * (1 + 0.05 * Math.cos(7 * a)),
  // Round sides that meet in four crisp points, like a star at the corners.
  spark: (a) => 1 - 0.22 * Math.abs(Math.cos(2 * a)) ** 0.6,
  // Pointed at both ends, leaning to the right.
  leaf: (a) => 1 - 0.36 * Math.abs(Math.sin(a - 0.55)) ** 0.7,
  // Wider than tall, with round ends.
  pill: (a) => (Math.abs(Math.cos(a) / 0.78) ** 3 + Math.abs(Math.sin(a) / 1.18) ** 3) ** (-1 / 3)
}

/** How many points each curve is drawn through: more where it turns often. */
const POINTS: Record<ShapeName, number> = {
  circle: 32,
  blob: 48,
  pebble: 48,
  squircle: 64,
  clover: 64,
  flower: 72,
  star: 80,
  scallop: 144,
  burst: 120,
  wave: 108,
  spark: 120,
  leaf: 96,
  pill: 64
}

const drawn = new Map<ShapeName, string>()

/** A shape as an SVG path in a 100 × 100 box: centred, and reaching to within a hair of the edge. */
export function shapePath(shape: ShapeName): string {
  const known = drawn.get(shape)
  if (known) return known
  const r = RADIUS[shape]
  const n = POINTS[shape]
  const radii = Array.from({ length: n }, (_, i) => r((i / n) * Math.PI * 2))
  const scale = 48 / Math.max(...radii)
  // Measured from straight up, clockwise, so a star stands on two points.
  const pts = radii.map((rad, i) => {
    const a = (i / n) * Math.PI * 2
    return [50 + Math.sin(a) * rad * scale, 50 - Math.cos(a) * rad * scale]
  })
  const f = (v: number): string => (Math.round(v * 10) / 10).toString()
  const at = (i: number): number[] => pts[(i + n) % n]
  // A closed Catmull-Rom curve through every point, as cubic Béziers.
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`
  }
  d += 'Z'
  drawn.set(shape, d)
  return d
}

export interface Avatar {
  shape: ShapeName
  colour: ColourName
}

const isShape = (s: unknown): s is ShapeName => SHAPES.includes(s as ShapeName)
const isColour = (c: unknown): c is ColourName => COLOURS.includes(c as ColourName)

/** A small, steady number from a string, so a brand keeps the same avatar until one is picked. */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * A brand's avatar: the shape and colour picked for it, or, until then, one
 * chosen from its id, so every brand already has its own. A shape or colour
 * this version does not know falls back the same way.
 */
export function avatarOf(brand: { id: string; avatar?: { shape: string; colour: string } | null }): Avatar {
  const h = hash(brand.id || 'brand')
  const shape = brand.avatar && isShape(brand.avatar.shape) ? brand.avatar.shape : SHAPES[h % (SHAPES.length - 1)]
  const colour =
    brand.avatar && isColour(brand.avatar.colour) ? brand.avatar.colour : COLOURS[(h >>> 8) % COLOURS.length]
  return { shape, colour }
}
