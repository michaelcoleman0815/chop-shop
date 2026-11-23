import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { renderFrame, type DrawResources, type IconNode, type Layer, type LogoMark, type MotionScene } from '../../../../shared/motion'
import type { Asset } from '../../../../shared/edit'
import { mediaUrlFor } from '../api'
import { loadIconNodes, loadLogoMarks, loadMotionFonts, loadPicture } from '../graphics'
import { useMapResources } from '../map-resources'

/**
 * The cut's graphics over the preview: a canvas the size of the frame, drawn
 * with the export's own drawing code at the player's output time on every
 * animation frame the player gives. It sits over the picture and the
 * captions and never takes the pointer.
 */

/** A scratch canvas for drawing that needs one, such as motion blur. */
function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

function walk(layers: Layer[], visit: (l: Layer) => void): void {
  for (const l of layers) {
    visit(l)
    if (l.kind === 'group') walk(l.children, visit)
  }
}

export function MotionCanvas({
  scene,
  assets,
  time,
  width,
  height,
  video,
  redraw = 0,
  className = 'cl-motion'
}: {
  scene: MotionScene
  assets: Asset[]
  time: number
  width: number
  height: number
  /** Video layers' frames (the layer tracks' clips, from useClipMedia). */
  video?: DrawResources['video']
  /** Changes when a video frame arrives, so the frame is drawn again with it. */
  redraw?: number
  className?: string
}): JSX.Element | null {
  const canvas = useRef<HTMLCanvasElement>(null)
  // Bumped when a face, the icons or an image finishes loading, so the frame redraws with it.
  const [loaded, setLoaded] = useState(0)
  const [icons, setIcons] = useState<((name: string) => IconNode[] | undefined) | null>(null)
  const [logos, setLogos] = useState<((slug: string) => LogoMark | undefined) | null>(null)
  const [pictures, setPictures] = useState<Map<string, CanvasImageSource>>(new Map())
  // Map data and satellite tiles, at the canvas's own scale, for map graphics.
  const map = useMapResources(scene, time, (width * (window.devicePixelRatio || 1)) / Math.max(1, scene.size.width))

  useEffect(() => {
    void loadMotionFonts().then(() => setLoaded((n) => n + 1))
  }, [])

  const needs = useMemo(() => {
    let icon = false
    let logo = false
    const ids = new Set<string>()
    walk(scene.layers, (l) => {
      if (l.kind === 'image' && l.icon) icon = true
      if (l.kind === 'image' && l.logo) logo = true
      if (l.kind === 'image' && l.asset) ids.add(l.asset)
      // The brand's own logos are files on this computer, keyed by their path.
      if (l.kind === 'image' && l.file) ids.add(`file:${l.file}`)
      // A particle sprite's picture, the same way.
      if (l.kind === 'particles' && l.file) ids.add(`file:${l.file}`)
    })
    return { icon, logo, ids: [...ids].sort().join('\n') }
  }, [scene])

  useEffect(() => {
    if (!needs.icon || icons) return
    void loadIconNodes().then((lookup) => setIcons(() => lookup))
  }, [needs.icon, icons])

  useEffect(() => {
    if (!needs.logo || logos) return
    void loadLogoMarks().then((lookup) => setLogos(() => lookup))
  }, [needs.logo, logos])

  useEffect(() => {
    if (!needs.ids) return
    let live = true
    const byId = new Map(assets.map((a) => [a.id, a]))
    void Promise.all(
      needs.ids.split('\n').map(async (id) => {
        const path = id.startsWith('file:') ? id.slice(5) : byId.get(id)?.path
        const img = path ? await loadPicture(mediaUrlFor(path)) : null
        return [id, img] as const
      })
    ).then((pairs) => {
      if (!live) return
      setPictures(new Map(pairs.filter((p): p is readonly [string, HTMLImageElement] => p[1] !== null)))
    })
    return () => {
      live = false
    }
  }, [needs.ids, assets])

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
    renderFrame(
      ctx,
      time,
      scene.layers,
      scene.size,
      { width: pw, height: ph },
      { icons: icons ?? undefined, logos: logos ?? undefined, images: pictures, createCanvas: makeCanvas, map, video }
    )
    // The moment drawn, for anyone checking the preview against the export.
    el.dataset.time = time.toFixed(4)
  }, [scene, time, width, height, loaded, icons, logos, pictures, map, video, redraw])

  if (scene.layers.length === 0) return null
  return <canvas ref={canvas} className={className} style={{ width, height }} aria-hidden="true" />
}
