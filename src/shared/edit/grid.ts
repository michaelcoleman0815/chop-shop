import { z } from 'zod'

/**
 * Several videos at once: a beat shown as a grid of two to four panels on a
 * soft ground, each with rounded corners and a small label in its top-left
 * corner, the way a showcase of four edits plays them side by side.
 *
 * It is a treatment of a beat, as a cutaway is, not a layout of the whole
 * cut, so it works at any size: a whole video of finished edits is one beat
 * shown as a grid, and a grid of cutaways can come in for one line of a
 * talking edit and go again. A panel shows the beat's own picture, another
 * recording in the edit, or material (an exported edit brought in, footage,
 * a picture). The beat's own picture plays as the beat plays; every other
 * panel runs on the beat's cutaway clock from its in point, held on its last
 * frame if it runs out. The sound is the beat's own unless the grid takes it
 * from a panel, or from none, leaving the music.
 *
 * This file stands alone (zod only), so the edit schema can include it.
 */

export const GridPanelSchema = z.object({
  /** What plays in it: '' for the beat's own picture, a recording by id (s2), or material by id (a3). */
  show: z.string().max(40),
  /** The small label in its top-left corner; empty shows none. */
  label: z.string().max(40),
  /** Where in its own footage it starts, in seconds. Not for the beat's own picture. */
  inSec: z.number().nonnegative().optional()
})
export type GridPanel = z.infer<typeof GridPanelSchema>

/** Whose sound plays: the beat's own, as always; a panel's, by its place in the list; or none, for the music alone. */
export const GridSoundSchema = z.union([z.literal('own'), z.literal('none'), z.number().int().min(0).max(3)])
export type GridSound = z.infer<typeof GridSoundSchema>

export const GridSchema = z.object({
  panels: z.array(GridPanelSchema).min(2).max(4),
  sound: GridSoundSchema.optional()
})
export type Grid = z.infer<typeof GridSchema>

export interface GridRect {
  x: number
  y: number
  w: number
  h: number
}

export interface GridLayout {
  /** Each panel's box, in order, in the frame's pixels. */
  panels: GridRect[]
  /** The panels' corner radius. */
  radius: number
  /** Each label's pill: its left edge, its middle, and the size of its words. */
  labels: { x: number; y: number; size: number }[]
}

/** Rows of panels, by how many: the arrangements tried for each count. */
const ARRANGEMENTS: Record<number, number[][]> = {
  2: [[2], [1, 1]],
  3: [[2, 1], [3], [1, 1, 1], [1, 2]],
  4: [[2, 2], [4], [1, 1, 1, 1], [3, 1]]
}

/**
 * Where two to four panels of one shape (width over height) go in a frame:
 * the arrangement that gives each the most room, with a margin round the
 * edge and a gutter between, centred, each row centred under the one above.
 * A short last row sits in the middle: three panels are two over one.
 */
export function gridLayout(frame: { width: number; height: number }, count: number, aspect: number): GridLayout {
  const n = Math.max(2, Math.min(4, Math.round(count)))
  const a = Number.isFinite(aspect) && aspect > 0.2 && aspect < 5 ? aspect : 16 / 9
  const W = frame.width
  const H = frame.height
  const short = Math.min(W, H)
  const margin = short * 0.045
  const gutter = short * 0.03
  let best: { rows: number[]; pw: number; ph: number } | null = null
  for (const rows of ARRANGEMENTS[n]) {
    const cols = Math.max(...rows)
    const pw = Math.min((W - margin * 2 - gutter * (cols - 1)) / cols, ((H - margin * 2 - gutter * (rows.length - 1)) / rows.length) * a)
    const ph = pw / a
    if (!best || pw * ph > best.pw * best.ph + 1e-6) best = { rows, pw, ph }
  }
  const { rows, pw, ph } = best as { rows: number[]; pw: number; ph: number }
  const blockH = rows.length * ph + (rows.length - 1) * gutter
  const top = (H - blockH) / 2
  const panels: GridRect[] = []
  rows.forEach((count, r) => {
    const rowW = count * pw + (count - 1) * gutter
    const left = (W - rowW) / 2
    for (let c = 0; c < count; c++) panels.push({ x: left + c * (pw + gutter), y: top + r * (ph + gutter), w: pw, h: ph })
  })
  const size = Math.max(short * 0.016, Math.min(short * 0.034, ph * 0.055))
  const inset = Math.min(pw, ph) * 0.045
  return {
    panels,
    radius: Math.min(pw, ph) * 0.05,
    labels: panels.map((p) => ({ x: p.x + inset, y: p.y + inset + size * 0.86, size }))
  }
}

/** A box on whole even pixels, grown by `bleed` each side: what a video can be scaled to and laid on exactly. */
export function evenRect(r: GridRect, scale = 1, bleed = 0): GridRect {
  const even = (v: number): number => 2 * Math.round(v / 2)
  const x = even(r.x * scale - bleed)
  const y = even(r.y * scale - bleed)
  return { x, y, w: Math.max(2, even(r.x * scale + r.w * scale + bleed) - x), h: Math.max(2, even(r.y * scale + r.h * scale + bleed) - y) }
}

/** A picture a panel can show: a recording or material, with its shape. */
export interface GridPicture {
  path: string
  width: number
  height: number
  /** A picture rather than footage: shown still for as long as the panel is up. */
  still: boolean
  /** Has a sound of its own to hear. */
  sound: boolean
}

const STILL = /\.(png|jpe?g|webp|bmp|gif|avif)$/i

/**
 * What each panel shows: the beat's own recording for '', another recording
 * or material by id. Null for an id the edit does not have.
 */
export function gridPictures(
  grid: Grid,
  own: { id: string },
  doc: {
    sources: { id: string; path: string; width: number; height: number }[]
    assets: { id: string; kind: string; path: string; width: number | null; height: number | null }[]
  }
): (GridPicture | null)[] {
  return grid.panels.map((p) => {
    const id = p.show.trim() || own.id
    const source = doc.sources.find((s) => s.id === id)
    if (source)
      return { path: source.path, width: source.width, height: source.height, still: false, sound: true }
    const asset = doc.assets.find((a) => a.id === id && (a.kind === 'video' || a.kind === 'image'))
    if (!asset) return null
    return {
      path: asset.path,
      width: asset.width ?? 0,
      height: asset.height ?? 0,
      still: asset.kind === 'image' || STILL.test(asset.path),
      sound: asset.kind === 'video'
    }
  })
}

/** The panels' shared shape: the middle of their own, so one odd one out is cropped rather than shrinking all. */
export function gridAspect(pictures: (GridPicture | null)[]): number {
  const shapes = pictures
    .filter((p): p is GridPicture => p !== null && p.width > 0 && p.height > 0)
    .map((p) => p.width / p.height)
    .sort((a, b) => a - b)
  if (shapes.length === 0) return 16 / 9
  return shapes[Math.floor((shapes.length - 1) / 2)]
}

/** The panel whose sound is heard, or 'own' or 'none'. A panel showing the beat's own picture is heard as 'own'. */
export function gridHeard(grid: Grid): 'own' | 'none' | number {
  const sound = grid.sound ?? 'own'
  if (sound === 'own' || sound === 'none') return sound
  const panel = grid.panels[sound]
  if (!panel || !panel.show.trim()) return 'own'
  return sound
}

/**
 * The cut as the preview hears it: the pieces of a grid that plays another
 * panel's sound, or none, are silent on their own picture's deck.
 */
export function silenceGrids<R extends { pieces: { beat: string; silent?: boolean }[] }>(
  cut: { beats: { id: string; treatment: { grid?: Grid | null } }[] },
  resolved: R
): R {
  const quiet = new Set(
    cut.beats.filter((b) => b.treatment.grid && gridHeard(b.treatment.grid) !== 'own').map((b) => b.id)
  )
  if (quiet.size === 0) return resolved
  return { ...resolved, pieces: resolved.pieces.map((p) => (quiet.has(p.beat) ? { ...p, silent: true } : p)) }
}

/** A grid in a few words, for the planner and the beat strip: "a grid of 4 with labels". */
export function describeGrid(grid: Grid): string {
  const labels = grid.panels.map((p) => p.label.trim()).filter(Boolean)
  const heard = gridHeard(grid)
  const sound =
    heard === 'own' ? '' : heard === 'none' ? ', no sound but the music' : `, sound from panel ${heard + 1}`
  return `a grid of ${grid.panels.length}${labels.length ? ` labelled ${labels.join(', ')}` : ''}${sound}`
}

/**
 * A grid as the planner writes it, every slot filled ('' and 0 the usual,
 * "music" for no sound but the music, "1" to "4" a panel's sound), as the
 * edit takes it. No panels takes the grid away.
 */
export function plannedGrid(op: { panels: { show: string; label: string; inSec: number }[]; sound: string }): Grid | null {
  if (op.panels.length === 0) return null
  const sound: GridSound = op.sound === 'music' ? 'none' : /^[1-4]$/.test(op.sound) ? Number(op.sound) - 1 : 'own'
  return {
    panels: op.panels.slice(0, 4).map((p) => ({
      show: p.show.trim(),
      label: p.label.trim().slice(0, 40),
      ...(p.inSec > 0 ? { inSec: p.inSec } : {})
    })),
    ...(sound === 'own' ? {} : { sound })
  }
}

/** A grid in the planner's line for its beat, with what each panel shows: grid own "Raw", a2 "Edited" from 3.0 s, sound from panel 2. */
export function gridLine(grid: Grid): string {
  const panels = grid.panels.map((p) => {
    const label = p.label.trim() ? ` "${p.label.trim()}"` : ''
    return `${p.show.trim() || 'own'}${label}${p.inSec ? ` from ${p.inSec.toFixed(1)} s` : ''}`
  })
  const heard = gridHeard(grid)
  const sound = heard === 'own' ? '' : heard === 'none' ? ', music only' : `, sound from panel ${heard + 1}`
  return `grid ${panels.join(', ')}${sound}`
}
