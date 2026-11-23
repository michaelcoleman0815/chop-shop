import { parseColor } from '../motion/anim'
import { rand, wiggle } from '../fx/noise'
import type { ParticlesLayer } from '../motion/types'
import { AGE, ID, LIFE, R, simFor, STRIDE } from './sim'

/**
 * Particles drawn with the standard Canvas2D API, inside the layer's own
 * transform, by the compositor the editor and the export share
 * (shared/motion draw): the system at this moment, each particle at its
 * size, colour and opacity for its age.
 */

type Ctx = CanvasRenderingContext2D
type RGB = [number, number, number]

const PI2 = Math.PI * 2
/** Colour on its way to the end colour, in this many steps, so a few gradients serve every particle. */
const SHADES = 24

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export function drawParticles(ctx: Ctx, layer: ParticlesLayer, local: number, length: number, opacity: number, images?: Map<string, CanvasImageSource>): void {
  const s = layer.particles
  const sim = simFor(layer.key, s, { width: layer.w, height: layer.h }, length)
  const frame = sim.at(local)
  if (frame.count === 0) return
  const img = s.sprite === 'image' && layer.file ? (images?.get(`file:${layer.file}`) ?? null) : null
  const dims = img as { naturalWidth?: number; naturalHeight?: number; width?: unknown; height?: unknown } | null
  const iw = dims ? dims.naturalWidth || (typeof dims.width === 'number' ? dims.width : 0) : 0
  const ih = dims ? dims.naturalHeight || (typeof dims.height === 'number' ? dims.height : 0) : 0
  // A picture not loaded yet draws as dots, so the system still shows.
  const sprite = s.sprite === 'image' && !(iw > 0 && ih > 0) ? 'dot' : s.sprite

  const base = ctx.getTransform()
  const { a, b, c, d, e, f } = base
  // The layer's box is the frame, centred on its origin.
  const ox = -layer.w / 2
  const oy = -layer.h / 2
  const palette: RGB[] = s.colors.map((col) => parseColor(col).slice(0, 3) as RGB)
  const end: RGB | null = s.colorEnd ? (parseColor(s.colorEnd).slice(0, 3) as RGB) : null
  const styles = new Map<number, string>()
  const gradients = new Map<number, CanvasGradient>()
  const styleOf = (ci: number, shade: number, dim: number): string => {
    const key = (ci * (SHADES + 1) + shade) * 2 + (dim < 1 ? 1 : 0)
    let st = styles.get(key)
    if (!st) {
      const [r, g, bl] = mixed(palette[ci], end, shade / SHADES, dim)
      st = `rgb(${r},${g},${bl})`
      styles.set(key, st)
    }
    return st
  }
  // A soft dot: one gradient per colour, at the origin with a radius of one, moved to each particle by the transform.
  const gradientOf = (ci: number, shade: number): CanvasGradient => {
    const key = ci * (SHADES + 1) + shade
    let g = gradients.get(key)
    if (!g) {
      const [r, gr, bl] = mixed(palette[ci], end, shade / SHADES, 1)
      g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
      const core = clamp01(1 - s.soft)
      g.addColorStop(0, `rgba(${r},${gr},${bl},1)`)
      if (core > 0.02) g.addColorStop(core * 0.98, `rgba(${r},${gr},${bl},1)`)
      g.addColorStop(core + (1 - core) * 0.5, `rgba(${r},${gr},${bl},0.35)`)
      g.addColorStop(1, `rgba(${r},${gr},${bl},0)`)
      gradients.set(key, g)
    }
    return g
  }
  /** Moves drawing to a point, turned and scaled, under the layer's transform. */
  const place = (x: number, y: number, rot: number, sx: number, sy: number): void => {
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const m11 = cos * sx
    const m12 = sin * sx
    const m21 = -sin * sy
    const m22 = cos * sy
    const px = x + ox
    const py = y + oy
    ctx.setTransform(a * m11 + c * m12, b * m11 + d * m12, a * m21 + c * m22, b * m21 + d * m22, a * px + c * py + e, b * px + d * py + f)
  }

  const data = frame.data
  const ahead = frame.ahead
  for (let i = 0; i < frame.count; i++) {
    const o = i * STRIDE
    const id = data[o + ID]
    const age = data[o + AGE] + ahead
    const life = data[o + LIFE]
    const u = clamp01(age / life)
    const r = (slot: number): number => rand(s.seed, id, slot)
    let alpha = s.alpha
    if (s.fadeIn > 0) alpha *= clamp01(u / s.fadeIn)
    if (s.fadeOut > 0) alpha *= clamp01((1 - u) / s.fadeOut)
    if (s.flicker > 0) alpha *= 1 - s.flicker * (0.5 + 0.5 * wiggle(age, 7, Math.floor(r(R.flicker) * 1e9)))
    alpha *= opacity
    if (alpha <= 0.003) continue
    const size = (s.size + (s.sizeEnd - s.size) * u) * (1 + s.variance * (r(R.size) * 2 - 1) * 0.6)
    if (size <= 0.05) continue
    const vx = data[o + 2]
    const vy = data[o + 3]
    const x = data[o] + vx * ahead
    const y = data[o + 1] + vy * ahead
    const ci = Math.min(palette.length - 1, Math.floor(r(R.colour) * palette.length))
    const shade = end ? Math.round(u * SHADES) : 0
    const way = r(R.spinWay) < 0.5 ? -1 : 1
    const rot = ((r(R.phase) * 360 + way * s.spin * (0.5 + r(R.spin)) * age) * Math.PI) / 180
    ctx.globalAlpha = Math.min(1, alpha)

    switch (sprite) {
      case 'dot': {
        const radius = size / 2
        if (s.soft > 0.02) {
          place(x, y, 0, radius, radius)
          ctx.fillStyle = gradientOf(ci, shade)
          ctx.fillRect(-1, -1, 2, 2)
        } else {
          place(x, y, 0, radius, radius)
          ctx.fillStyle = styleOf(ci, shade, 1)
          ctx.beginPath()
          ctx.arc(0, 0, 1, 0, PI2)
          ctx.fill()
        }
        break
      }
      case 'square': {
        // Tumbling over: its height turns through a flip, and its back shows a shade darker.
        const turn = s.flip > 0 ? Math.cos(PI2 * (s.flip * (0.6 + 0.8 * r(R.spin)) * age + r(R.phase))) : 1
        place(x, y, rot, size, size * 0.6 * (Math.abs(turn) < 0.08 ? 0.08 : Math.abs(turn)))
        ctx.fillStyle = styleOf(ci, shade, turn < 0 ? 0.72 : 1)
        ctx.fillRect(-0.5, -0.5, 1, 1)
        break
      }
      case 'streak': {
        // Along its path: from where it was `stretch` seconds ago to where it is.
        const len = Math.hypot(vx, vy) * s.stretch
        const angle = Math.atan2(vy, vx)
        place(x, y, angle, 1, 1)
        ctx.strokeStyle = styleOf(ci, shade, 1)
        ctx.lineWidth = size
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(-Math.max(len, 0.01), 0)
        ctx.lineTo(0, 0)
        ctx.stroke()
        break
      }
      case 'star': {
        place(x, y, rot, size / 2, size / 2)
        ctx.fillStyle = styleOf(ci, shade, 1)
        ctx.beginPath()
        for (let k = 0; k < 10; k++) {
          const ang = -Math.PI / 2 + (k * Math.PI) / 5
          const rr = k % 2 === 0 ? 1 : 0.42
          if (k === 0) ctx.moveTo(Math.cos(ang) * rr, Math.sin(ang) * rr)
          else ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr)
        }
        ctx.closePath()
        ctx.fill()
        break
      }
      case 'image': {
        const k = 1 / Math.max(iw, ih)
        place(x, y, rot, size, size)
        ctx.drawImage(img as CanvasImageSource, -iw * k * 0.5, -ih * k * 0.5, iw * k, ih * k)
        break
      }
    }
  }
  ctx.setTransform(a, b, c, d, e, f)
  ctx.globalAlpha = 1
}

function mixed(from: RGB, to: RGB | null, p: number, dim: number): RGB {
  const out: RGB = to ? [from[0] + (to[0] - from[0]) * p, from[1] + (to[1] - from[1]) * p, from[2] + (to[2] - from[2]) * p] : [from[0], from[1], from[2]]
  return out.map((v) => Math.round(Math.min(255, Math.max(0, v * dim)))) as RGB
}
