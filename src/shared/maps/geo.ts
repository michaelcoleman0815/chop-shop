import { project } from './mercator'

/**
 * The map's shapes, as the drawing reads them: countries, US states, lakes,
 * rivers and the plates, decoded once from the compact files under data/
 * (written by scripts/make-map-data.mjs) and projected into world units.
 *
 * The files are TopoJSON cut down: shared arcs, each a run of quantized
 * deltas written as text the way encoded polylines are, and shapes as rings
 * of arc numbers (a negative number, ~i, is arc i backwards). An arc two
 * countries share is a border; one only a single country uses is a coast.
 */

export interface TopoFile {
  source: string
  transform: { scale: [number, number]; translate: [number, number] }
  arcs: string[]
}

export interface ShapesFile extends TopoFile {
  countries?: { id: string; p: number[][][] }[]
  states?: { id: string; p: number[][][] }[]
}

export interface WaterFile extends TopoFile {
  lakes: number[][][][]
  rivers: number[][][]
}

/** A box in world units: left, top, right, bottom. */
export type WorldBox = [number, number, number, number]

/** Arcs as projected points, x then y, with each arc's box and how many shapes share it. */
export interface Topo {
  arcs: Float64Array[]
  boxes: WorldBox[]
  uses: Uint8Array
}

/** A filled shape: polygons, each rings of arc numbers. */
export interface Shape {
  id: string
  polys: number[][][]
  box: WorldBox
}

export interface ShapeSet {
  topo: Topo
  shapes: Map<string, Shape>
  /** Arcs that edge only one shape (coasts), and those between two (borders). */
  coasts: number[]
  borders: number[]
}

export interface Water {
  topo: Topo
  lakes: Shape[]
  rivers: { arcs: number[][]; box: WorldBox }[]
}

/** A plate boundary from PB2002: the plates either side, and whether one goes under the other. */
export interface Boundary {
  a: string
  b: string
  /** "-" for no subduction; "/" or "\\" for which side goes under, as PB2002 writes it. */
  kind: string
  pts: Float64Array
  box: WorldBox
}

export interface Plate {
  code: string
  name: string
  /** Rings of projected points. */
  rings: Float64Array[]
  box: WorldBox
}

export interface Plates {
  source: string
  boundaries: Boundary[]
  plates: Map<string, Plate>
}

/** The compact plates file the app writes when it downloads PB2002 (see plates.ts). */
export interface PlatesFile {
  source: string
  precision: number
  boundaries: { a: string; b: string; kind: string; pts: string }[]
  plates: { code: string; name: string; rings: string[] }[]
}

/** Everything the map draws from, at three levels of detail for the world. */
export interface MapGeo {
  world: { '110m': ShapeSet; '50m': ShapeSet; '10m': ShapeSet }
  states: ShapeSet | null
  water: Water | null
  plates: Plates | null
}

// ---------- Decoding ----------

/** The integers written by encodeInts in scripts/make-map-data.mjs. */
export function decodeInts(s: string): number[] {
  const out: number[] = []
  let n = 0
  let shift = 1
  for (let i = 0; i < s.length; i++) {
    const b = s.charCodeAt(i) - 63
    n += (b & 0x1f) * shift
    if (b >= 0x20) {
      shift *= 32
      continue
    }
    out.push(n % 2 === 1 ? -(n + 1) / 2 : n / 2)
    n = 0
    shift = 1
  }
  return out
}

/** Integers as printable characters, the other way from decodeInts. */
export function encodeInts(values: number[]): string {
  let out = ''
  for (const v of values) {
    let n = v < 0 ? -2 * v - 1 : 2 * v
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63)
      n = Math.floor(n / 32)
    }
    out += String.fromCharCode(n + 63)
  }
  return out
}

function boxOf(pts: Float64Array): WorldBox {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i]
    const y = pts[i + 1]
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

function joinBoxes(boxes: WorldBox[]): WorldBox {
  let b: WorldBox = [Infinity, Infinity, -Infinity, -Infinity]
  for (const c of boxes) b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[2]), Math.max(b[3], c[3])]
  return b
}

/** A file's arcs, decoded and projected. */
export function decodeTopo(file: TopoFile): Topo {
  const [sx, sy] = file.transform.scale
  const [tx, ty] = file.transform.translate
  const arcs = file.arcs.map((s) => {
    const ints = decodeInts(s)
    const pts = new Float64Array(ints.length)
    let qx = 0
    let qy = 0
    for (let i = 0; i + 1 < ints.length; i += 2) {
      qx += ints[i]
      qy += ints[i + 1]
      const [x, y] = project(qx * sx + tx, qy * sy + ty)
      pts[i] = x
      pts[i + 1] = y
    }
    return pts
  })
  return { arcs, boxes: arcs.map(boxOf), uses: new Uint8Array(arcs.length) }
}

const arcIndex = (i: number): number => (i < 0 ? ~i : i)

function shapeBox(topo: Topo, polys: number[][][]): WorldBox {
  // A shape's outer rings make its box; holes are inside them.
  return joinBoxes(polys.flatMap((rings) => (rings[0] ?? []).map((i) => topo.boxes[arcIndex(i)])))
}

/** Arcs drawn along the cut at the date line or the bottom of the map are no one's coast. */
function isCut(pts: Float64Array): boolean {
  let atEdge = true
  let atBottom = true
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] > 1e-6 && pts[i] < 1 - 1e-6) atEdge = false
    if (pts[i + 1] < 0.995) atBottom = false
  }
  return atEdge || atBottom
}

export function decodeShapes(file: ShapesFile): ShapeSet {
  const topo = decodeTopo(file)
  const list = file.countries ?? file.states ?? []
  const shapes = new Map<string, Shape>()
  for (const s of list) {
    // A country Natural Earth draws in parts under one id is one shape.
    const prev = shapes.get(s.id)
    const polys = prev ? [...prev.polys, ...s.p] : s.p
    shapes.set(s.id, { id: s.id, polys, box: shapeBox(topo, polys) })
    for (const rings of s.p) for (const ring of rings) for (const i of ring) topo.uses[arcIndex(i)]++
  }
  const coasts: number[] = []
  const borders: number[] = []
  topo.uses.forEach((n, i) => {
    if (n >= 2) borders.push(i)
    else if (n === 1 && !isCut(topo.arcs[i])) coasts.push(i)
  })
  return { topo, shapes, coasts, borders }
}

export function decodeWater(file: WaterFile): Water {
  const topo = decodeTopo(file)
  return {
    topo,
    lakes: file.lakes.map((polys, i) => ({ id: `lake${i}`, polys, box: shapeBox(topo, polys) })),
    rivers: file.rivers.map((lines) => ({
      arcs: lines,
      box: joinBoxes(lines.flatMap((line) => line.map((i) => topo.boxes[arcIndex(i)])))
    }))
  }
}

/** Points in degrees, a thousandth of a degree apart at most, as the plates file writes them. */
function decodeDegrees(s: string, precision: number): Float64Array {
  const ints = decodeInts(s)
  const pts = new Float64Array(ints.length)
  let qx = 0
  let qy = 0
  for (let i = 0; i + 1 < ints.length; i += 2) {
    qx += ints[i]
    qy += ints[i + 1]
    const [x, y] = project(qx / precision, qy / precision)
    pts[i] = x
    pts[i + 1] = y
  }
  return pts
}

export function decodePlates(file: PlatesFile): Plates {
  const boundaries = file.boundaries.map((b) => {
    const pts = decodeDegrees(b.pts, file.precision)
    return { a: b.a, b: b.b, kind: b.kind, pts, box: boxOf(pts) }
  })
  const plates = new Map<string, Plate>()
  for (const p of file.plates) {
    const rings = p.rings.map((r) => decodeDegrees(r, file.precision))
    plates.set(p.code, { code: p.code, name: p.name, rings, box: joinBoxes(rings.map(boxOf)) })
  }
  return { source: file.source, boundaries, plates }
}

// ---------- Reading ----------

/** The points of a ring in order, arcs joined end to end. */
export function ringPoints(topo: Topo, ring: number[]): Float64Array {
  let n = 0
  for (const i of ring) n += topo.arcs[arcIndex(i)].length
  const out = new Float64Array(n)
  let at = 0
  for (const i of ring) {
    const arc = topo.arcs[arcIndex(i)]
    const m = arc.length / 2
    // Each arc after the first starts where the last ended.
    const skip = at > 0 ? 1 : 0
    for (let k = skip; k < m; k++) {
      const j = i < 0 ? m - 1 - k : k
      out[at++] = arc[2 * j]
      out[at++] = arc[2 * j + 1]
    }
  }
  return out.subarray(0, at)
}

/** Which detail to draw the world at for a zoom: finer early, so outlines never jump as the camera closes in. */
export function detailFor(zoom: number): '110m' | '50m' | '10m' {
  if (zoom < 1.6) return '110m'
  if (zoom < 3.6) return '50m'
  return '10m'
}

/** Whether two world boxes overlap, the second moved a whole turn east or west by `turn`. */
export function overlaps(a: WorldBox, b: WorldBox, turn = 0): boolean {
  return a[0] <= b[2] + turn && a[2] >= b[0] + turn && a[1] <= b[3] && a[3] >= b[1]
}
