import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { currentCut, currentVersion, type EditDoc, type Resolved } from '../../../shared/edit'
import {
  buildFxScene,
  cutoutFor,
  cutoutsDuring,
  cutoutView,
  drawOverlay,
  effectsOf,
  NO_CUTOUTS,
  outputRate,
  runProgram,
  type CutoutTrack,
  type CutoutView,
  type FxFrame,
  type FxScene,
  type LoadedMasks,
  type Mask,
  type Pixels
} from '../../../shared/fx'
import { designSize, type Size } from '../../../shared/motion'
import { api } from './api'

/**
 * Scene effects in the editor's preview, drawn by the code the export runs
 * (shared/fx): the picture under the effect is read from the decks as they
 * show it, worked on by the same program, and laid back over them inside
 * the look; what an effect draws over the picture goes on a canvas above the
 * look and under the captions and graphics, as in the export.
 */

/**
 * A mask PNG as one value per pixel, decoded without colour management so it
 * is the file's own grey. Loaded as a picture, which the page's content
 * security policy lets come from the media server (img-src), where a fetch
 * would be refused (it allows connections to the page's own origin only).
 */
export async function loadMask(url: string): Promise<Mask | null> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      if (!url.startsWith('data:')) i.crossOrigin = 'anonymous'
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error(`could not load ${url}`))
      i.src = url
    })
    const bitmap = await createImageBitmap(img, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    const data = new Uint8Array(bitmap.width * bitmap.height)
    for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4]
    return { data, width: bitmap.width, height: bitmap.height }
  } catch {
    return null
  }
}

/**
 * An edit's effects as the preview draws them: its scene, and the cut-outs
 * this computer made for it (none off a Mac), asked for again when the
 * effects change.
 */
export function useFxScene(doc: EditDoc, resolved: Resolved): { scene: FxScene | null; view: CutoutView; design: Size } {
  const cut = currentCut(doc)
  const items = effectsOf(cut)
  const wants = items.some((x) => cutoutFor(x) !== null)
  // Asked again when the effects, the shape or the version change.
  const key = items.length ? `${currentVersion(doc).n} ${cut.aspect} ${JSON.stringify(items)}` : ''
  const [cutouts, setCutouts] = useState<{ key: string; tracks: CutoutTrack[]; loaded: LoadedMasks } | null>(null)
  const docRef = useRef(doc)
  docRef.current = doc
  useEffect(() => {
    if (!key || !wants) return
    let live = true
    void api
      .fxCutouts(docRef.current)
      .then(async ({ tracks }) => {
        const loaded: LoadedMasks = new Map()
        const files = tracks.flatMap((t) => t.samples.flatMap((s) => s.masks.map((m) => m.file)))
        const masks = await Promise.all(files.map(loadMask))
        files.forEach((f, i) => {
          const m = masks[i]
          if (m) loaded.set(f, m)
        })
        if (live) setCutouts({ key, tracks, loaded })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key, wants])

  const first = doc.sources.find((s) => s.id === resolved.pieces[0]?.source) ?? doc.sources[0]
  const design = useMemo(() => designSize(cut.aspect, first ?? { width: 1920, height: 1080 }), [cut.aspect, first])
  const tracks = cutouts && cutouts.key === key ? cutouts.tracks : null
  const scene = useMemo(() => {
    if (items.length === 0 || !first) return null
    return buildFxScene({
      cut,
      resolved,
      words: doc.words,
      sources: doc.sources,
      size: design,
      fps: outputRate(first.fps ?? 30),
      cutouts: (a, b) => cutoutsDuring(cut, resolved, doc.sources, tracks ?? [], a, b)
    })
    // The cut's effects, the cut-outs and the timing are what the scene is made of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, resolved, tracks, design])
  const view = useMemo(
    () =>
      tracks && cutouts
        ? cutoutView({ cut, resolved, sources: doc.sources, frame: design, tracks, loaded: cutouts.loaded })
        : NO_CUTOUTS,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracks, resolved, design]
  )
  return { scene, view, design }
}

/** What CSS sets an object at, as shares of the room left: "37.5% 50%", "left top", "10px 20px". */
function objectPosition(value: string, roomX: number, roomY: number): [number, number] {
  const parts = value.trim().split(/\s+/)
  const one = (v: string | undefined, room: number, words: Record<string, number>): number => {
    if (!v) return room * 0.5
    if (v in words) return room * words[v]
    if (v.endsWith('%')) return (room * parseFloat(v)) / 100
    if (v.endsWith('px')) return parseFloat(v)
    return room * 0.5
  }
  return [
    one(parts[0], roomX, { left: 0, center: 0.5, right: 1 }),
    one(parts[1], roomY, { top: 0, center: 0.5, bottom: 1 })
  ]
}

const clear = (colour: string): boolean => colour === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(colour)

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const meet = (a: Box, b: Box): Box => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) }
}

/**
 * The decks as they show now, drawn into `ctx` at its own size: every
 * picture in them (video, still, canvas) where it sits, as large as it shows,
 * cropped as it is cropped and as see-through as it is, over the colours
 * behind them. False when there is nothing to draw yet.
 */
export function captureDecks(root: HTMLElement, ctx: CanvasRenderingContext2D, skip: Set<Element>): boolean {
  const base = root.getBoundingClientRect()
  if (base.width <= 0 || base.height <= 0) return false
  const { width: w, height: h } = ctx.canvas
  const sx = w / base.width
  const sy = h / base.height
  const toCanvas = (b: Box): Box => ({ x: (b.x - base.left) * sx, y: (b.y - base.top) * sy, w: b.w * sx, h: b.h * sy })
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, w, h)
  let drew = false
  const walk = (el: Element, alpha: number, filter: string, clip: Box): void => {
    // Stacked as the page stacks them: a higher z-index draws later.
    const children = [...el.children]
      .map((c, i) => ({ c, i, z: Number(getComputedStyle(c).zIndex) || 0 }))
      .sort((a, b) => a.z - b.z || a.i - b.i)
    for (const { c } of children) {
      if (skip.has(c)) continue
      const cs = getComputedStyle(c)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      const a = alpha * Number(cs.opacity || 1)
      if (a <= 0.002) continue
      const r = c.getBoundingClientRect()
      const box = { x: r.left, y: r.top, w: r.width, h: r.height }
      const f = [filter, cs.filter && cs.filter !== 'none' ? cs.filter : ''].filter(Boolean).join(' ')
      const inside = cs.overflow !== 'visible' ? meet(clip, box) : clip
      if (inside.w <= 0 || inside.h <= 0) continue
      const k = toCanvas(inside)
      ctx.save()
      ctx.beginPath()
      ctx.rect(k.x, k.y, k.w, k.h)
      ctx.clip()
      ctx.globalAlpha = a
      ctx.filter = f || 'none'
      if (!clear(cs.backgroundColor)) {
        ctx.fillStyle = cs.backgroundColor
        const b = toCanvas(box)
        ctx.fillRect(b.x, b.y, b.w, b.h)
      }
      const media = c instanceof HTMLVideoElement || c instanceof HTMLImageElement || c instanceof HTMLCanvasElement
      if (media) {
        const iw = c instanceof HTMLVideoElement ? c.videoWidth : c instanceof HTMLImageElement ? c.naturalWidth : c.width
        const ih = c instanceof HTMLVideoElement ? c.videoHeight : c instanceof HTMLImageElement ? c.naturalHeight : c.height
        const ready = c instanceof HTMLVideoElement ? c.readyState >= 2 : c instanceof HTMLImageElement ? c.complete : true
        const lw = (c as HTMLElement).offsetWidth
        const lh = (c as HTMLElement).offsetHeight
        if (iw > 0 && ih > 0 && lw > 0 && lh > 0 && ready) {
          // Where its picture sits in its own box, then in the box it shows at, moved and scaled.
          const fit = c instanceof HTMLCanvasElement ? 'fill' : cs.objectFit
          let cw = lw
          let ch = lh
          if (fit === 'cover' || fit === 'contain' || fit === 'scale-down') {
            const s = fit === 'cover' ? Math.max(lw / iw, lh / ih) : Math.min(lw / iw, lh / ih, fit === 'scale-down' ? 1 : Infinity)
            cw = iw * s
            ch = ih * s
          } else if (fit === 'none') {
            cw = iw
            ch = ih
          }
          const [ox, oy] = fit === 'fill' ? [0, 0] : objectPosition(cs.objectPosition, lw - cw, lh - ch)
          const kx = r.width / lw
          const ky = r.height / lh
          const d = toCanvas({ x: r.left + ox * kx, y: r.top + oy * ky, w: cw * kx, h: ch * ky })
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = 'medium'
          ctx.drawImage(c, d.x, d.y, d.w, d.h)
          drew = true
        }
      }
      ctx.restore()
      walk(c, a, f, inside)
    }
  }
  walk(root, 1, '', { x: base.left, y: base.top, w: base.width, h: base.height })
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  return drew
}

const make = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/**
 * Draws the effects at the playhead: the picture's under the look, inside
 * the decks, at a working size that keeps up with playback; what they draw
 * over the picture at the frame's own size. Each canvas hides while no
 * effect needs it.
 */
export function useFxRender(opts: {
  scene: FxScene | null
  view: CutoutView
  design: Size
  time: number
  playing: boolean
  box: { w: number; h: number }
  decks: RefObject<HTMLElement>
  picture: RefObject<HTMLCanvasElement>
  overlay: RefObject<HTMLCanvasElement>
}): void {
  const { scene, view, design, time, playing, box, decks, picture, overlay } = opts
  // The working size as a share of the design, eased down when a frame takes too long.
  const share = useRef(0.5)
  const work = useRef<HTMLCanvasElement | null>(null)
  const tainted = useRef(false)
  const draw = useRef<() => void>(() => undefined)

  draw.current = () => {
    const pic = picture.current
    const over = overlay.current
    const root = decks.current
    if (!pic || !over || !root) return
    const active = scene ? scene.plans.filter((p) => time >= p.start && time < p.end) : []
    const needsPicture = !tainted.current && active.some((p) => p.program.length > 0)
    if (active.length === 0) {
      pic.style.visibility = 'hidden'
      over.style.visibility = 'hidden'
      return
    }
    const began = performance.now()
    const dpr = window.devicePixelRatio || 1
    const fit = Math.min(1, (box.w * dpr) / design.width)
    const k = Math.max(0.12, Math.min(fit, share.current))
    const w = Math.max(16, Math.round(design.width * k))
    const h = Math.max(16, Math.round(design.height * k))
    const frames: FxFrame[] = active.map((p) => p.frame(time, w, h, view))

    if (needsPicture) {
      const canvas = (work.current ??= document.createElement('canvas'))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const wctx = canvas.getContext('2d', { willReadFrequently: true })
      let drawn = false
      if (wctx && captureDecks(root, wctx, new Set([pic]))) {
        try {
          let pixels: Pixels = { data: wctx.getImageData(0, 0, w, h).data, width: w, height: h }
          active.forEach((p, i) => {
            if (p.program.length > 0) pixels = runProgram(p.program, pixels, frames[i], w / design.width)
          })
          if (pic.width !== w || pic.height !== h) {
            pic.width = w
            pic.height = h
          }
          const pctx = pic.getContext('2d')
          pctx?.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), w, h), 0, 0)
          drawn = true
        } catch (err) {
          // A picture the page may not read (served without leave to): the effects draw over it alone.
          tainted.current = true
          console.warn('[fx] the preview cannot read the picture:', err instanceof Error ? err.message : err)
        }
      }
      pic.style.visibility = drawn ? 'visible' : 'hidden'
    } else pic.style.visibility = 'hidden'

    const ow = Math.max(1, Math.round(box.w * dpr))
    const oh = Math.max(1, Math.round(box.h * dpr))
    if (over.width !== ow || over.height !== oh) {
      over.width = ow
      over.height = oh
    }
    const octx = over.getContext('2d')
    if (octx) {
      octx.setTransform(1, 0, 0, 1, 0, 0)
      octx.clearRect(0, 0, ow, oh)
      let any = false
      for (const f of frames) {
        if (f.overlay.length === 0) continue
        octx.setTransform(ow / w, 0, 0, oh / h, 0, 0)
        drawOverlay(octx, f.overlay, make)
        any = true
      }
      octx.setTransform(1, 0, 0, 1, 0, 0)
      over.style.visibility = any ? 'visible' : 'hidden'
    }
    // Keeping up with playback: a frame over 40 ms works smaller next time, one well under it larger.
    const took = performance.now() - began
    if (playing && took > 40) share.current = Math.max(0.12, k * 0.8)
    else if (took < 14) share.current = Math.min(0.5, share.current * 1.1)
  }

  useEffect(() => {
    draw.current()
  }, [scene, view, time, playing, box.w, box.h])

  // A deck that finishes seeking or loading shows a new frame with the same playhead: draw it again.
  useEffect(() => {
    const root = decks.current
    if (!root) return
    const again = (): void => draw.current()
    for (const e of ['seeked', 'loadeddata']) root.addEventListener(e, again, true)
    return () => {
      for (const e of ['seeked', 'loadeddata']) root.removeEventListener(e, again, true)
    }
  }, [decks])
}
