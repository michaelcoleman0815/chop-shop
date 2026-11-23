/**
 * Block capitals as strokes, for a text emitter: particles are born along the
 * letters' lines, so a word appears in sparks or snow. Drawn here rather than
 * read from a face, so the editor and the export place every particle on the
 * same point with no font to load and no rasterising to differ.
 *
 * Each letter sits on a grid 4 wide and 6 tall, y down; a stroke is a run of
 * points. Lower case reads as upper case; anything not here is a space.
 */

type Strokes = [number, number][][]

const arc = (cx: number, cy: number, rx: number, ry: number, from: number, to: number, n = 8): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / n) * Math.PI) / 180
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as [number, number]
  })

const GLYPHS: Record<string, Strokes> = {
  A: [[[0, 6], [2, 0], [4, 6]], [[0.7, 4], [3.3, 4]]],
  B: [[[0, 0], [0, 6], [2.8, 6]], [...arc(2.8, 4.5, 1.2, 1.5, 90, -90)], [[2.8, 3], [0, 3]], [[0, 0], [2.6, 0]], [...arc(2.6, 1.5, 1.1, 1.5, -90, 90)]],
  C: [arc(2.2, 3, 2.2, 3, -50, -310, 12)],
  D: [[[0, 0], [0, 6], [1.8, 6]], arc(1.8, 3, 2.2, 3, 90, -90, 10), [[1.8, 0], [0, 0]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
  G: [[...arc(2.2, 3, 2.2, 3, -50, -360, 12), [2.2, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[2, 0], [2, 6]], [[1, 0], [3, 0]], [[1, 6], [3, 6]]],
  J: [[[4, 0], [4, 4.4]], arc(2.2, 4.2, 1.8, 1.8, 0, 160, 8)],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 3.6]], [[1.4, 2.4], [4, 6]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3.5], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  O: [arc(2, 3, 2, 3, 0, 360, 16)],
  P: [[[0, 6], [0, 0], [2.6, 0]], arc(2.6, 1.6, 1.4, 1.6, -90, 90, 8), [[2.6, 3.2], [0, 3.2]]],
  Q: [arc(2, 3, 2, 3, 0, 360, 16), [[2.6, 4.4], [4.2, 6.2]]],
  R: [[[0, 6], [0, 0], [2.6, 0]], arc(2.6, 1.6, 1.4, 1.6, -90, 90, 8), [[2.6, 3.2], [0, 3.2]], [[2, 3.2], [4, 6]]],
  S: [[...arc(2, 1.5, 2, 1.5, -20, -270, 8), ...arc(2, 4.5, 2, 1.5, -90, 160, 8)]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 4], ...arc(2, 4, 2, 2, 180, 0, 8).slice(1), [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 2.5], [3, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
  Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  '0': [arc(2, 3, 2, 3, 0, 360, 16), [[3.4, 0.8], [0.6, 5.2]]],
  '1': [[[0.8, 1.2], [2, 0], [2, 6]], [[0.8, 6], [3.2, 6]]],
  '2': [[...arc(2, 1.8, 2, 1.8, -170, 20, 8), [0, 6], [4, 6]]],
  '3': [arc(2, 1.5, 1.8, 1.5, -160, 90, 8), arc(2, 4.5, 2, 1.5, -90, 160, 8)],
  '4': [[[3, 6], [3, 0], [0, 4.2], [4, 4.2]]],
  '5': [[[4, 0], [0.4, 0], [0, 2.8], ...arc(2, 4.2, 2, 1.8, -120, 160, 9).slice(1)]],
  '6': [[...arc(2, 3, 2, 3, -60, -180, 5), ...arc(2, 4.2, 2, 1.8, 180, 540, 12)]],
  '7': [[[0, 0], [4, 0], [1.4, 6]]],
  '8': [arc(2, 1.5, 1.7, 1.5, 0, 360, 12), arc(2, 4.5, 2, 1.5, 0, 360, 12)],
  '9': [[...arc(2, 1.8, 2, 1.8, 0, 360, 12), ...arc(2, 3, 2, 3, 0, 120, 6)]],
  '!': [[[2, 0], [2, 4.2]], [[2, 5.5], [2, 6]]],
  '?': [[...arc(2, 1.6, 2, 1.6, -170, 90, 8), [2, 4.2]], [[2, 5.5], [2, 6]]],
  '.': [[[2, 5.5], [2, 6]]],
  ',': [[[2.2, 5.4], [1.6, 6.6]]],
  "'": [[[2, 0], [2, 1.4]]],
  '’': [[[2, 0], [2, 1.4]]],
  '-': [[[0.8, 3.2], [3.2, 3.2]]],
  '+': [[[2, 1.2], [2, 4.8]], [[0.2, 3], [3.8, 3]]]
}

/** Advance from one letter to the next, and the letters' height, in grid units. */
const ADVANCE = 5.4
const HEIGHT = 6

export interface Segment {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * The words' strokes as line segments, centred in a box and as large as fits
 * it (the text kept to one line), with the total length, for choosing a point
 * along them evenly.
 */
export function letterSegments(text: string, box: { x: number; y: number; w: number; h: number }): { segments: Segment[]; cum: number[]; total: number } {
  const chars = [...text.toUpperCase()]
  const width = Math.max(1, chars.length * ADVANCE - (ADVANCE - 4))
  const k = Math.max(0.01, Math.min(box.w / width, box.h / HEIGHT))
  const ox = box.x + (box.w - width * k) / 2
  const oy = box.y + (box.h - HEIGHT * k) / 2
  const segments: Segment[] = []
  chars.forEach((c, i) => {
    for (const stroke of GLYPHS[c] ?? []) {
      for (let j = 1; j < stroke.length; j++) {
        const [ax, ay] = stroke[j - 1]
        const [bx, by] = stroke[j]
        segments.push({ x0: ox + (i * ADVANCE + ax) * k, y0: oy + ay * k, x1: ox + (i * ADVANCE + bx) * k, y1: oy + by * k })
      }
    }
  })
  const cum: number[] = []
  let total = 0
  for (const s of segments) {
    total += Math.max(1e-6, Math.hypot(s.x1 - s.x0, s.y1 - s.y0))
    cum.push(total)
  }
  return { segments, cum, total }
}

/** The point a share of the way along the strokes. */
export function pointAlong(path: { segments: Segment[]; cum: number[]; total: number }, share: number): [number, number] | null {
  if (path.segments.length === 0) return null
  const want = Math.min(0.999999, Math.max(0, share)) * path.total
  let lo = 0
  let hi = path.cum.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (path.cum[mid] < want) lo = mid + 1
    else hi = mid
  }
  const s = path.segments[lo]
  const start = lo === 0 ? 0 : path.cum[lo - 1]
  const len = path.cum[lo] - start
  const f = len > 0 ? (want - start) / len : 0
  return [s.x0 + (s.x1 - s.x0) * f, s.y0 + (s.y1 - s.y0) * f]
}
