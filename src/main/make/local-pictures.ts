import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import { createHash } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { hash01 } from '../../shared/edit/film'
import type { MakeFormat } from '../../shared/make/schema'
import type { MapCutaway, MapShotRequest, MapShots } from '../../shared/make/map'
import { MAP_PUSH } from '../../shared/make/map'
import { registerMotionFonts } from '../motion-render'

/**
 * Pictures made on this Mac, for nothing: the plain ground a title card or
 * a graphic sits on, and a placeholder map for a map shot until the map
 * documentary's own kind is in (shared/make/map.ts). Drawn with Skia, the
 * renderer the export already uses, in the bundled fonts.
 */

const sizeOf = (aspect: 'wide' | 'vertical'): { w: number; h: number } =>
  aspect === 'vertical' ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 }

function grain(ctx: SKRSContext2D, w: number, h: number, seed: number, strength: number): void {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const n = (hash01(seed + i) - 0.5) * strength
    d[i] = Math.max(0, Math.min(255, d[i] + n))
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n))
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n))
  }
  ctx.putImageData(img, 0, 0)
}

async function save(dir: string, name: string, draw: (ctx: SKRSContext2D, w: number, h: number) => void, aspect: 'wide' | 'vertical'): Promise<string> {
  const path = join(dir, name)
  if (existsSync(path)) return path
  const { w, h } = sizeOf(aspect)
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  draw(ctx, w, h)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path, canvas.toBuffer('image/png'))
  return path
}

/** The ground cards and graphics sit on: dark warm paper for a documentary, a deep friendly blue for an explainer. */
export function groundFor(format: MakeFormat, aspect: 'wide' | 'vertical', dir: string): Promise<string> {
  return save(
    dir,
    `ground-${format}-${aspect}.png`,
    (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2)
      if (format === 'documentary') {
        g.addColorStop(0, '#3a2c1f')
        g.addColorStop(0.65, '#241a11')
        g.addColorStop(1, '#120c07')
      } else {
        g.addColorStop(0, '#2f5fa8')
        g.addColorStop(1, '#1b3566')
      }
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      grain(ctx, w, h, format === 'documentary' ? 17 : 29, format === 'documentary' ? 18 : 6)
    },
    aspect
  )
}

/** A map shot as a still made here: an old map for a documentary, a flat bright one for an explainer, the place named on it. */
export async function placeholderMap(req: MapShotRequest, dir: string, fontsDir: string | null): Promise<string> {
  registerMotionFonts(fontsDir)
  const seed = parseInt(createHash('sha256').update(req.place).digest('hex').slice(0, 8), 16)
  const name = `map-${req.style}-${req.aspect}-${seed.toString(16)}.png`
  return save(
    dir,
    name,
    (ctx, w, h) => {
      const doc = req.style === 'documentary'
      const r = (k: number): number => hash01(seed + k * 101)
      // Land and water.
      ctx.fillStyle = doc ? '#d9c8a2' : '#8fd0f0'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = doc ? '#c9b385' : '#9ad48a'
      ctx.beginPath()
      const cx = w * (0.45 + r(1) * 0.1)
      const cy = h * (0.5 + r(2) * 0.1)
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2
        const rad = Math.min(w, h) * (0.42 + 0.12 * Math.sin(a * 3 + r(3) * 6) + 0.06 * Math.sin(a * 7 + r(4) * 6))
        const x = cx + Math.cos(a) * rad * 1.5
        const y = cy + Math.sin(a) * rad
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.fill()
      // Contours or roads, then a graticule.
      ctx.strokeStyle = doc ? 'rgba(110, 82, 45, 0.35)' : 'rgba(255, 255, 255, 0.7)'
      ctx.lineWidth = doc ? 1.5 : 5
      for (let k = 0; k < 6; k++) {
        ctx.beginPath()
        const y0 = h * (0.15 + k * 0.14)
        ctx.moveTo(0, y0)
        for (let x = 0; x <= w; x += w / 24) ctx.lineTo(x, y0 + Math.sin(x / (120 + r(10 + k) * 80) + k) * 26)
        ctx.stroke()
      }
      if (doc) {
        ctx.strokeStyle = 'rgba(90, 64, 34, 0.25)'
        ctx.lineWidth = 1
        for (let x = 0; x <= w; x += w / 12) {
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x, h)
          ctx.stroke()
        }
        for (let y = 0; y <= h; y += h / 7) {
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(w, y)
          ctx.stroke()
        }
      }
      // The pin, a little off centre where the push-in ends.
      const px = w * 0.5
      const py = h * 0.48
      ctx.fillStyle = doc ? '#7a1f12' : '#ff5a4f'
      ctx.beginPath()
      ctx.arc(px, py, doc ? 14 : 22, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = doc ? 'rgba(122, 31, 18, 0.6)' : '#ffffff'
      ctx.lineWidth = doc ? 3 : 6
      ctx.beginPath()
      ctx.arc(px, py, doc ? 34 : 40, 0, Math.PI * 2)
      ctx.stroke()
      // The place, set under the pin.
      const label = req.place.length > 40 ? `${req.place.slice(0, 39)}…` : req.place
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = doc ? '#3b2a17' : '#14213d'
      ctx.font = doc ? `600 ${Math.round(h * 0.05)}px "Cinzel"` : `700 ${Math.round(h * 0.05)}px "Sora"`
      ctx.fillText(doc ? label.toUpperCase() : label, px, py + h * 0.06)
      // Age at the edges.
      if (doc) {
        const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2)
        v.addColorStop(0, 'rgba(60, 40, 15, 0)')
        v.addColorStop(1, 'rgba(60, 40, 15, 0.55)')
        ctx.fillStyle = v
        ctx.fillRect(0, 0, w, h)
        grain(ctx, w, h, seed, 22)
      }
    },
    req.aspect
  )
}

/** Map shots made here, until the `map` motion kind is in: the shape its provider will keep. */
export function placeholderMaps(dir: string, fontsDir: string | null): MapShots {
  return {
    make: async (req: MapShotRequest): Promise<MapCutaway> => ({
      kind: 'still',
      path: await placeholderMap(req, dir, fontsDir),
      camera: MAP_PUSH
    })
  }
}
