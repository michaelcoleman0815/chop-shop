import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import {
  gridAspect,
  gridLayout,
  gridPictures,
  type EditDoc,
  type Grid,
  type GridLayout,
  type GridPicture
} from '../../../../shared/edit'
import { gridGround, gridLabels, LABEL_FADE, renderFrame, type MotionTheme } from '../../../../shared/motion'
import { MEDIA_CORS, mediaUrlFor } from '../api'
import { loadMotionFonts } from '../graphics'

/**
 * A beat shown as a grid (edit/grid), as the export plays it: every panel but
 * the beat's own picture (the deck's own video, placed in its box by the
 * deck) plays in its box, kept on the grid's clock and moved only when it
 * drifts; over them the ground, with their boxes cut out, and the labels
 * fading in, drawn by the export's own code from the same layout.
 */

/** A grid as a beat shows it: where each panel goes, what it shows, and which one is the beat's own picture. */
export function gridViewFor(
  grid: Grid,
  beatSource: string,
  doc: EditDoc,
  design: { width: number; height: number }
): { layout: GridLayout; pictures: (GridPicture | null)[]; own: number } {
  const pictures = gridPictures(grid, { id: beatSource }, doc)
  return {
    layout: gridLayout(design, grid.panels.length, gridAspect(pictures)),
    pictures,
    own: grid.panels.findIndex((p) => !p.show.trim() || p.show.trim() === beatSource)
  }
}

/** A box as shares of the frame, for absolute placing inside the deck. */
export function boxStyle(r: { x: number; y: number; w: number; h: number }, design: { width: number; height: number }): CSSProperties {
  const pct = (n: number, of: number): string => `${(n / of) * 100}%`
  return { left: pct(r.x, design.width), top: pct(r.y, design.height), width: pct(r.w, design.width), height: pct(r.h, design.height) }
}

export function GridPanels({
  layout,
  design,
  panels,
  labels,
  theme,
  since,
  playing,
  heard
}: {
  layout: GridLayout
  design: { width: number; height: number }
  /** Each panel's picture and where it plays from now, or null for the beat's own picture and a missing one. */
  panels: ({ picture: GridPicture; at: number } | null)[]
  labels: string[]
  theme: MotionTheme
  /** Seconds since the grid came in, for the labels' fade. */
  since: number
  playing: boolean
  /** The panel whose sound plays, when it is not the beat's own. */
  heard: number | null
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [fonts, setFonts] = useState(0)
  useEffect(() => {
    void loadMotionFonts().then(() => setFonts((n) => n + 1))
  }, [])
  // Drawn at half the frame's size: plenty for the preview, light to redraw while the labels fade.
  const fade = Math.min(LABEL_FADE + 0.05, Math.max(0, since))
  useLayoutEffect(() => {
    const el = canvas.current
    if (!el) return
    const pixels = { width: Math.round(design.width / 2), height: Math.round(design.height / 2) }
    if (el.width !== pixels.width) el.width = pixels.width
    if (el.height !== pixels.height) el.height = pixels.height
    const ctx = el.getContext('2d')
    if (!ctx) return
    renderFrame(ctx, fade, [...gridGround(layout, design, theme), ...gridLabels(layout, labels, theme, 0)], design, pixels)
  }, [layout, design, labels, theme, fade, fonts])
  return (
    <div className="cl-grid" aria-hidden="true">
      {panels.map((p, i) =>
        p ? (
          <Panel
            key={`${i}-${p.picture.path}`}
            path={p.picture.path}
            still={p.picture.still}
            at={p.at}
            playing={playing}
            muted={heard !== i}
            style={boxStyle(layout.panels[i], design)}
          />
        ) : null
      )}
      <canvas ref={canvas} className="cl-grid-plate" />
    </div>
  )
}

/** One panel's video, on its own clock, put back in step only when it drifts. */
function Panel({
  path,
  still,
  at,
  playing,
  muted,
  style
}: {
  path: string
  still: boolean
  at: number
  playing: boolean
  muted: boolean
  style: CSSProperties
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    // Past its end it holds its last frame, as the export does.
    const end = Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.05) : Infinity
    const want = Math.min(Math.max(0, at), end)
    const runs = playing && at < end
    if (Math.abs(v.currentTime - want) > (runs ? 0.25 : 0.02)) v.currentTime = want
    if (runs && v.paused) void v.play().catch(() => undefined)
    if (!runs && !v.paused) v.pause()
  }, [at, playing])
  const src = mediaUrlFor(path)
  // Loaded as the decks are, with leave to read them, so scene effects on a grid read the panels too (fx-preview).
  const cors = src.startsWith('data:') ? undefined : MEDIA_CORS
  return (
    <div className="cl-grid-panel" style={style}>
      {still ? (
        <img src={src} alt="" crossOrigin={cors} />
      ) : (
        <video ref={ref} src={src} crossOrigin={cors} muted={muted} playsInline preload="auto" />
      )}
    </div>
  )
}
