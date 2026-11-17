import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { addRun } from './paint'

/**
 * The map's path builder leaves out what is off screen. That has to be
 * invisible: the same pixels in the frame, filled or stroked, for far fewer
 * points handed to the canvas.
 */

const size = { width: 400, height: 300 }

/** A coast-like ring: a jagged loop that runs far off the left, top and right of the frame and back. */
function jaggedRing(): Float64Array {
  const pts: number[] = []
  const n = 4000
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const r = 520 + 60 * Math.sin(i * 1.7) + 25 * Math.sin(i * 0.31)
    pts.push(200 + Math.cos(a) * r * 1.4, 330 + Math.sin(a) * r)
  }
  return new Float64Array(pts)
}

function draw(cull: boolean, mode: 'fill' | 'stroke'): { pixels: Uint8ClampedArray; points: number } {
  const canvas = createCanvas(size.width, size.height)
  const ctx = canvas.getContext('2d')
  let points = 0
  const counting = new Proxy(ctx, {
    get(target, key) {
      const v = Reflect.get(target, key) as unknown
      if (key === 'lineTo' || key === 'moveTo') {
        return (x: number, y: number) => {
          points++
          ;(v as (x: number, y: number) => void).call(target, x, y)
        }
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    }
  }) as unknown as CanvasRenderingContext2D
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, size.width, size.height)
  ctx.beginPath()
  const ring = jaggedRing()
  addRun(counting, ring, ring.length, 1, 0, 0, size, cull, false)
  ctx.closePath()
  if (mode === 'fill') {
    ctx.fillStyle = '#123456'
    ctx.fill('evenodd')
  } else {
    ctx.strokeStyle = '#123456'
    ctx.lineWidth = 34
    ctx.lineJoin = 'round'
    ctx.stroke()
  }
  return { pixels: ctx.getImageData(0, 0, size.width, size.height).data, points }
}

describe('drawing only what is in the frame', () => {
  for (const mode of ['fill', 'stroke'] as const) {
    it(`${mode}s the same pixels with the off-screen stretches cut down to their ends`, () => {
      const all = draw(false, mode)
      const culled = draw(true, mode)
      let differ = 0
      for (let i = 0; i < all.pixels.length; i++) if (all.pixels[i] !== culled.pixels[i]) differ++
      expect(differ).toBe(0)
      // Most of the ring is off screen, and goes in as a handful of points.
      expect(culled.points).toBeLessThan(all.points / 3)
    })
  }

  it('leaves out points closer than half a pixel', () => {
    const canvas = createCanvas(10, 10)
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
    let points = 0
    const counting = { moveTo: () => points++, lineTo: () => points++ } as unknown as CanvasRenderingContext2D
    const dense = new Float64Array(Array.from({ length: 200 }, (_, i) => [i * 0.05, 5]).flat())
    addRun(counting, dense, dense.length, 1, 0, 0, { width: 10, height: 10 }, true, false)
    // 10 pixels of line at a point every half pixel or more, and its end.
    expect(points).toBeGreaterThanOrEqual(19)
    expect(points).toBeLessThanOrEqual(22)
    expect(ctx).toBeTruthy()
  })
})
