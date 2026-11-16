import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { drawSubtitle, layoutSubtitle, type SubtitleCue } from '../../../../shared/subtitles'
import type { CaptionStyle } from '../../../../shared/types'
import { loadMotionFonts } from '../graphics'

/**
 * The burned-in captions over the preview, as the export burns them: the cue
 * libass shows at this moment, laid out at the export's size by libass's
 * rules (shared/subtitles) and drawn scaled to the frame on screen, in the
 * faces the export draws them in. It never takes the pointer.
 */

/** A scratch canvas for the shadow, which is drawn whole and then laid down once. */
function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

export function Subtitles({
  cue,
  style,
  frame,
  time,
  width,
  height
}: {
  cue: SubtitleCue | null
  /** Sized for the export's frame, as the export sizes it. */
  style: CaptionStyle
  /** The export's frame, in pixels. */
  frame: { width: number; height: number }
  time: number
  /** The preview frame on screen, in CSS pixels. */
  width: number
  height: number
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  // Bumped when the faces finish loading, so a caption measured before then is laid out again.
  const [loaded, setLoaded] = useState(0)
  useEffect(() => {
    void loadMotionFonts().then(() => setLoaded((n) => n + 1))
  }, [])

  useLayoutEffect(() => {
    const el = canvas.current
    if (!el || width <= 0 || height <= 0) return
    const dpr = window.devicePixelRatio || 1
    const pw = Math.max(1, Math.round(width * dpr))
    const ph = Math.max(1, Math.round(height * dpr))
    if (el.width !== pw) el.width = pw
    if (el.height !== ph) el.height = ph
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, pw, ph)
    if (!cue) {
      for (const key of ['text', 'start', 'end', 'box']) delete el.dataset[key]
      return
    }
    const layout = layoutSubtitle(cue, style, frame, ctx)
    drawSubtitle(ctx, layout, pw / frame.width, makeCanvas)
    // What was drawn, for anyone checking the preview against the export.
    const b = layout.bounds
    el.dataset.text = cue.words.map((w) => w.text).join(' ')
    el.dataset.start = cue.start.toFixed(3)
    el.dataset.end = cue.end.toFixed(3)
    el.dataset.box = [b.x, b.y, b.w, b.h].map((v) => v.toFixed(1)).join(',')
  }, [cue, style, frame, width, height, loaded])

  useLayoutEffect(() => {
    if (canvas.current) canvas.current.dataset.time = time.toFixed(4)
  }, [time])

  return <canvas ref={canvas} className="cl-subtitles" style={{ width, height }} aria-hidden="true" />
}
