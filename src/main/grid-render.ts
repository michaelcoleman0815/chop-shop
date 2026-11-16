import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import {
  cutawayClock,
  evenRect,
  gridAspect,
  gridHeard,
  gridLayout,
  gridPictures,
  pictureSpan,
  type Asset,
  type Cut,
  type GridLayout,
  type Resolved,
  type Source
} from '../shared/edit'
import { DEFAULT_THEME, gridGround, gridLabels, MOTION_FONTS, renderFrame, type MotionTheme } from '../shared/motion'
import type { Segment } from './cut-render'

/**
 * A grid of videos in the export (edit/grid). Each panel is its own input,
 * scaled to cover its box and laid on a plain frame; then the ground, drawn
 * here once on Skia with the editor's own drawing code (motion/grid-plate),
 * goes over them as a picture with the panels' rounded boxes cut out of it,
 * and the labels go over that, fading in. Every filter is one ffmpeg 6.0
 * has, and none of them is GPL: color, fps, scale, crop, overlay, fade.
 *
 * No Electron imports: the fonts folder and the work folder arrive as
 * arguments, so the tests render real grids.
 */

/** How far a panel's video reaches past its cut-out, in output pixels, so no seam shows at its edge. */
const BLEED = 2

let fontsFrom: string | null = null

/** The bundled faces, registered with Skia once, for the labels. */
function registerFonts(dir: string | null): void {
  if (!dir || fontsFrom === dir) return
  for (const f of MOTION_FONTS) {
    const file = join(dir, f.file)
    if (existsSync(file)) GlobalFonts.registerFromPath(file, f.family)
  }
  fontsFrom = dir
}

/** A grid's ground and labels as two PNGs the output's size; labels is null when no panel has one. */
export async function drawGridPlates(
  layout: GridLayout,
  labels: string[],
  opts: { design: { width: number; height: number }; width: number; height: number; theme: MotionTheme; dir: string; name: string }
): Promise<{ ground: string; labels: string | null }> {
  await fs.mkdir(opts.dir, { recursive: true })
  const pixels = { width: opts.width, height: opts.height }
  const paint = async (layers: ReturnType<typeof gridGround>, file: string): Promise<string> => {
    const canvas = createCanvas(opts.width, opts.height)
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
    // Drawn once the labels have fully come in: the export fades them itself.
    renderFrame(ctx, 1, layers, opts.design, pixels, {})
    const path = join(opts.dir, file)
    await fs.writeFile(path, canvas.toBuffer('image/png'))
    return path
  }
  const ground = await paint(gridGround(layout, opts.design, opts.theme), `${opts.name}-ground.png`)
  const words = gridLabels(layout, labels, opts.theme, 0)
  return { ground, labels: words.length ? await paint(words, `${opts.name}-labels.png`) : null }
}

export interface GridInput {
  cut: Cut
  resolved: Resolved
  sources: Source[]
  assets: Asset[]
  /** The output's pixels, and the full-size frame the layout is made in. */
  width: number
  height: number
  design: { width: number; height: number }
  theme?: MotionTheme | null
  fontsDir?: string | null
  workDir: string
}

/**
 * Gives every segment whose beat is shown as a grid what the export needs:
 * each panel's file and where it is read from, its box in output pixels, the
 * ground and labels, and the sound the grid asks for. Segments are the
 * resolved pieces, one for one and in order.
 */
export async function prepareGrids(segments: Segment[], input: GridInput): Promise<void> {
  const beats = new Map(input.cut.beats.map((b) => [b.id, b]))
  const plates = new Map<string, Promise<{ ground: string; labels: string | null }>>()
  const scale = input.width / input.design.width
  registerFonts(input.fontsDir ?? null)
  for (const [i, piece] of input.resolved.pieces.entries()) {
    const beat = beats.get(piece.beat)
    const grid = beat?.treatment.grid
    const s = segments[i]
    if (!beat || !grid || !s) continue
    const pictures = gridPictures(grid, { id: beat.source }, input)
    const layout = gridLayout(input.design, grid.panels.length, gridAspect(pictures))
    const labels = grid.panels.map((p) => p.label)
    // Drawn once a beat, however many pieces the beat plays in.
    if (!plates.has(beat.id))
      plates.set(
        beat.id,
        drawGridPlates(layout, labels, {
          design: input.design,
          width: input.width,
          height: input.height,
          theme: input.theme ?? DEFAULT_THEME,
          dir: join(input.workDir, 'grids'),
          name: beat.id
        })
      )
    const plate = await (plates.get(beat.id) as Promise<{ ground: string; labels: string | null }>)
    // Every other panel runs on the beat's cutaway clock, from its own in point.
    const clock = cutawayClock(input.resolved, beat.id, pictureSpan(piece).outStart)
    const offset = clock?.offset ?? 0
    const panels: NonNullable<Segment['grid']>['panels'] = []
    grid.panels.forEach((p, k) => {
      const picture = pictures[k]
      if (!picture) return
      const own = !p.show.trim() || p.show.trim() === beat.source
      panels.push({
        path: own ? null : picture.path,
        startSec: own || picture.still ? 0 : (p.inSec ?? 0) + offset,
        still: !own && picture.still,
        rect: evenRect(layout.panels[k], scale, BLEED)
      })
    })
    s.grid = { panels, ground: plate.ground, labels: plate.labels, since: offset }
    // The sound: the beat's own, a panel's, or none, leaving any music.
    const heard = gridHeard(grid)
    if (heard === 'none') {
      s.hasAudio = false
      s.audio = null
    } else if (heard !== 'own') {
      const picture = pictures[heard]
      if (picture?.sound) {
        const from = (grid.panels[heard].inSec ?? 0) + offset
        s.audio = { path: picture.path, offsetSec: from - s.startSec }
        s.hasAudio = true
      } else {
        s.hasAudio = false
        s.audio = null
      }
    }
  }
}
