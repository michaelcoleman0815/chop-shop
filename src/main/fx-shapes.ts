import { createCanvas } from '@napi-rs/canvas'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { followObjects, type CutoutKind, type CutoutSample, type CutoutTrack } from '../shared/fx/masks'
import { makeClip } from './test-media'

/**
 * Footage made of simple shapes, and the cut-outs of those shapes, for
 * testing the effects without Vision: a field of soft colour with a
 * "person" (an upright oval that sways) and three "objects" (a square, a
 * circle and a diamond on the ground). The masks are drawn from the same
 * numbers the footage is, so they line up with it as Vision's would.
 *
 * Only tests and the stand-in helper import this.
 */

export const SHAPE_CLIP = { width: 360, height: 640, fps: 30, sec: 4 }

/** Where the person is at t, as fractions: centre and radii. */
export function personAt(t: number): { cx: number; cy: number; rx: number; ry: number } {
  return { cx: 0.5 + 0.06 * Math.sin(t * 2), cy: 0.62, rx: 0.17, ry: 0.27 }
}

/** The objects, as fractions: centre and half size. */
export const OBJECTS = [
  { id: 1, shape: 'square', cx: 0.22, cy: 0.3, r: 0.08, colour: [230, 60, 60] },
  { id: 2, shape: 'circle', cx: 0.75, cy: 0.24, r: 0.09, colour: [60, 120, 240] },
  { id: 3, shape: 'diamond', cx: 0.7, cy: 0.88, r: 0.07, colour: [250, 200, 40] }
] as const

/** The footage: a lavfi graph, shapes drawn with geq. */
export function makeShapeClip(ffmpeg: string, path: string): string {
  const { width: W, height: H, fps, sec } = SHAPE_CLIP
  const p = personAt(0)
  const ground = `(64+90*Y/H+20*sin(X/9)*sin(Y/7))`
  const inPerson = `lte(pow((X/W-(${p.cx}+0.06*sin(T*2)))/${p.rx},2)+pow((Y/H-${p.cy})/${p.ry},2),1)`
  const shape = (o: (typeof OBJECTS)[number]): string => {
    const dx = `abs(X/W-${o.cx})`
    const dy = `abs(Y/H-${o.cy})*${H / W}`
    const r = o.r
    if (o.shape === 'square') return `lte(max(${dx},${dy}),${r})`
    if (o.shape === 'circle') return `lte(hypot(${dx},${dy}),${r})`
    return `lte(${dx}+${dy},${r})`
  }
  const channel = (c: 0 | 1 | 2): string => {
    let e = c === 0 ? `${ground}*0.8` : c === 1 ? `${ground}*1.1` : `${ground}*0.7`
    for (const o of OBJECTS) e = `if(${shape(o)},${o.colour[c]},${e})`
    e = `if(${inPerson},${[200, 150, 120][c]},${e})`
    return e
  }
  return makeClip(
    ffmpeg,
    path,
    `color=black:s=${W}x${H}:r=${fps}:d=${sec},format=rgb24,geq=r='${channel(0)}':g='${channel(1)}':b='${channel(2)}'`,
    `sine=frequency=330:sample_rate=48000:duration=${sec}`
  )
}

/** A mask PNG of the person or an object at t, w by h, grey. */
function drawMask(kind: 'person' | number, t: number, w: number, h: number): Buffer {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#FFFFFF'
  ctx.beginPath()
  if (kind === 'person') {
    const p = personAt(t)
    ctx.ellipse(p.cx * w, p.cy * h, p.rx * w, p.ry * h, 0, 0, Math.PI * 2)
  } else {
    const o = OBJECTS.find((x) => x.id === kind)
    if (!o) throw new Error(`No object ${kind}.`)
    const cx = o.cx * w
    const cy = o.cy * h
    const r = o.r * w
    if (o.shape === 'square') ctx.rect(cx - r, cy - r, 2 * r, 2 * r)
    else if (o.shape === 'circle') ctx.arc(cx, cy, r, 0, Math.PI * 2)
    else {
      ctx.moveTo(cx, cy - r)
      ctx.lineTo(cx + r, cy)
      ctx.lineTo(cx, cy + r)
      ctx.lineTo(cx - r, cy)
      ctx.closePath()
    }
  }
  ctx.fill()
  return canvas.toBuffer('image/png')
}

/**
 * Cut-outs of the shape footage, as Vision would leave them: masks a few
 * times a second, `size` pixels on the long side, written into `dir`.
 * Objects come numbered afresh in each sample, as Vision numbers them, and
 * are followed into steady ids.
 */
export function shapeTrack(
  path: string,
  kind: CutoutKind,
  dir: string,
  opts: { from?: number; to?: number; rate?: number; size?: number } = {}
): CutoutTrack {
  const { width: W, height: H, sec } = SHAPE_CLIP
  const from = opts.from ?? 0
  const to = opts.to ?? sec
  const rate = opts.rate ?? 10
  const long = opts.size ?? 160
  const w = Math.round((W / Math.max(W, H)) * long)
  const h = Math.round((H / Math.max(W, H)) * long)
  mkdirSync(dir, { recursive: true })
  const samples: CutoutSample[] = []
  for (let n = 0; from + n / rate <= to + 1e-9; n++) {
    const t = from + n / rate
    if (kind === 'person') {
      const file = join(dir, `person-${n}.png`)
      writeFileSync(file, drawMask('person', t, w, h))
      const p = personAt(t)
      samples.push({ t, masks: [{ id: 1, file, box: [p.cx - p.rx, p.cy - p.ry, 2 * p.rx, 2 * p.ry] }] })
    } else {
      // Vision's own numbering changes from picture to picture.
      const order = n % 2 === 0 ? [...OBJECTS] : [...OBJECTS].reverse()
      samples.push({
        t,
        masks: order.map((o, k) => {
          const file = join(dir, `object-${n}-${o.id}.png`)
          writeFileSync(file, drawMask(o.id, t, w, h))
          const rh = (o.r * W) / H
          return { id: k + 1, file, box: [o.cx - o.r, o.cy - rh, 2 * o.r, 2 * rh] as [number, number, number, number] }
        })
      })
    }
  }
  return { path, kind, width: w, height: h, samples: kind === 'objects' ? followObjects(samples) : samples }
}
