import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { BACKDROP_LEVEL, BACKDROP_SIGMA, backdropSize } from '../../../../shared/edit'

/** Room around the small copy, three of its blur wide, so the blur reads past its edges as the export's does. */
const MARGIN = BACKDROP_SIGMA * 3

/**
 * The blurred copy behind a picture shown whole (edit/fill), made the way
 * the export makes it: the frame on screen drawn small, cropped to cover the
 * box, its edges carried out into a margin, blurred and darkened there, and
 * scaled up to fill the box with the margin left outside it. It is drawn
 * again for every new frame the element shows, which costs one small canvas
 * rather than a second video.
 */
export function Backdrop({
  of,
  aspect,
  bw,
  transform
}: {
  /** The element showing the picture. */
  of: RefObject<HTMLVideoElement | HTMLImageElement>
  /** The box's width over its height. */
  aspect: number
  bw: boolean
  /** A punch-in, which takes the copy with the picture. */
  transform?: string
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const small = useMemo(() => backdropSize({ width: aspect, height: 1 }), [aspect])
  const width = small.width + 2 * MARGIN
  const height = small.height + 2 * MARGIN

  useEffect(() => {
    const el = of.current
    const out = canvas.current
    if (!el || !out) return
    const pad = document.createElement('canvas')
    pad.width = width
    pad.height = height
    const p = pad.getContext('2d')
    const o = out.getContext('2d')
    if (!p || !o) return
    const draw = (): void => {
      const video = el instanceof HTMLVideoElement
      const vw = video ? el.videoWidth : el.naturalWidth
      const vh = video ? el.videoHeight : el.naturalHeight
      if (!vw || !vh || (video && el.readyState < 2)) return
      // The middle of the picture, cropped to cover the box, drawn small.
      const k = Math.max(small.width / vw, small.height / vh)
      const cw = small.width / k
      const ch = small.height / k
      p.imageSmoothingEnabled = true
      p.imageSmoothingQuality = 'high'
      p.drawImage(el, (vw - cw) / 2, (vh - ch) / 2, cw, ch, MARGIN, MARGIN, small.width, small.height)
      // Its edges carried out into the margin, so the blur does not darken them.
      p.imageSmoothingEnabled = false
      p.drawImage(pad, MARGIN, MARGIN, 1, small.height, 0, MARGIN, MARGIN, small.height)
      p.drawImage(pad, MARGIN + small.width - 1, MARGIN, 1, small.height, MARGIN + small.width, MARGIN, MARGIN, small.height)
      p.drawImage(pad, 0, MARGIN, width, 1, 0, 0, width, MARGIN)
      p.drawImage(pad, 0, MARGIN + small.height - 1, width, 1, 0, MARGIN + small.height, width, MARGIN)
      o.clearRect(0, 0, width, height)
      o.filter = `blur(${BACKDROP_SIGMA}px) brightness(${BACKDROP_LEVEL})${bw ? ' grayscale(1)' : ''}`
      o.drawImage(pad, 0, 0)
      o.filter = 'none'
    }
    draw()
    const events = ['loadeddata', 'seeked', 'load']
    for (const e of events) el.addEventListener(e, draw)
    // A video draws again with every frame it shows, playing or stepped to; a still once.
    let frame = 0
    let stopped = false
    const video = el instanceof HTMLVideoElement ? el : null
    const each = (): void => {
      if (stopped || !video) return
      draw()
      frame = video.requestVideoFrameCallback(each)
    }
    if (video && typeof video.requestVideoFrameCallback === 'function') frame = video.requestVideoFrameCallback(each)
    return () => {
      stopped = true
      for (const e of events) el.removeEventListener(e, draw)
      if (video && frame && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frame)
    }
  }, [of, small, width, height, bw])

  const pct = (n: number): string => `${(n * 100).toFixed(4)}%`
  return (
    <canvas
      ref={canvas}
      className="cl-backdrop"
      width={width}
      height={height}
      aria-hidden="true"
      style={{
        left: pct(-MARGIN / small.width),
        top: pct(-MARGIN / small.height),
        width: pct(width / small.width),
        height: pct(height / small.height),
        transform
      }}
    />
  )
}
