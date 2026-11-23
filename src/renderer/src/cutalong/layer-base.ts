import { useEffect, useState, type RefObject } from 'react'
import { vignetteStops, type Look } from '../../../shared/edit/look'
import { captureDecks } from './fx-preview'

/**
 * The picture under the layer tracks in the preview, for the stretches where
 * a clip blends with it or grades it (shared/tracks/compositing): the frame
 * as it shows now under the layers canvas (the decks through the look, the
 * film and the effects' drawing over them), read the way the scene effects
 * read it (fx-preview captureDecks), with the look's vignette laid on as the
 * export lays it. The layers canvas draws it first, at the bottom, and so
 * covers the frame under it for as long as such a clip plays.
 */

let scratch: HTMLCanvasElement | null = null

/** The frame under the layers at `width` by `height`, or null when there is nothing to draw yet. */
export function captureLayerBase(frame: HTMLElement | null, width: number, height: number, look: Look | null): CanvasImageSource | null {
  if (!frame || width < 1 || height < 1) return null
  const layers = frame.querySelector('.cl-layers')
  // The layers canvas and everything over it (captions, graphics) are not part of the picture under it.
  const skip = new Set<Element>()
  let after = false
  for (const el of [...frame.children]) {
    if (el === layers) after = true
    if (after) skip.add(el)
  }
  const canvas = (scratch ??= document.createElement('canvas'))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx || !captureDecks(frame, ctx, skip)) return null
  const vignette = look?.vignette ?? 0
  if (vignette > 0) {
    // The vignette's darkness on ffmpeg's curve, out to the corners, as LookOver draws it.
    const g = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.hypot(width / 2, height / 2))
    for (const s of vignetteStops(vignette)) g.addColorStop(s.at, `rgba(0, 0, 0, ${s.alpha.toFixed(3)})`)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, width, height)
  }
  return canvas
}

/**
 * Counts each time a deck has a new frame to show after a seek or a load, so
 * the layers canvas draws again over it: right after the playhead moves the
 * deck has no frame yet, and the picture under a blend would stay missing
 * until the next moment.
 */
export function useDeckFrames(decks: RefObject<HTMLVideoElement>[], wanted: boolean): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!wanted) return
    const els = decks.map((d) => d.current).filter((v): v is HTMLVideoElement => v !== null)
    const bump = (): void => setN((k) => k + 1)
    for (const v of els) {
      v.addEventListener('seeked', bump)
      v.addEventListener('loadeddata', bump)
    }
    return () => {
      for (const v of els) {
        v.removeEventListener('seeked', bump)
        v.removeEventListener('loadeddata', bump)
      }
    }
  }, [decks, wanted])
  return n
}
