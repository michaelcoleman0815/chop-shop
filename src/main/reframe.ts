import type { ZoomKeyframe } from '../shared/types'

/**
 * Builds a piecewise-linear ffmpeg expression through a set of points.
 *
 * Nested if() rather than a sum of between() terms: between() is inclusive at
 * both ends, so adjacent segments would both fire on their shared boundary and
 * the values would add.
 */
export function lerpExpr(points: { t: number; v: number }[], timeVar = 't'): string {
  if (points.length === 0) return '0'
  const sorted = [...points].sort((a, b) => a.t - b.t)
  if (sorted.length === 1) return sorted[0].v.toFixed(5)

  const build = (i: number): string => {
    if (i >= sorted.length - 1) return sorted[sorted.length - 1].v.toFixed(5)
    const a = sorted[i]
    const b = sorted[i + 1]
    const span = Math.max(1e-4, b.t - a.t)
    const segment = `${a.v.toFixed(5)}+(${(b.v - a.v).toFixed(5)})*(${timeVar}-${a.t.toFixed(3)})/${span.toFixed(4)}`
    return `if(lt(${timeVar},${b.t.toFixed(3)}),${segment},${build(i + 1)})`
  }

  return `if(lt(${timeVar},${sorted[0].t.toFixed(3)}),${sorted[0].v.toFixed(5)},${build(0)})`
}

export interface ReframeOptions {
  sourceWidth: number
  sourceHeight: number
  outWidth: number
  outHeight: number
  /** Where the subject is over time, in normalised source coordinates. */
  track?: { atSec: number; cx: number; cy: number }[]
  zooms?: ZoomKeyframe[]
  /**
   * Source frame rate. zoompan re-times its output to this rate, so a wrong
   * value silently stretches or compresses the clip against its own audio
   * rather than failing.
   */
  sourceFps: number
}

/**
 * Composes the reframe filter chain.
 *
 * crop takes a fixed-size window whose x and y follow the subject (crop only
 * re-evaluates x and y per frame, never w or h), then zoompan applies the
 * punch-ins and scales to the output size. Doing the zoom in crop is not
 * possible for exactly that reason.
 */
export function buildReframeFilter(opts: ReframeOptions): string {
  const { sourceWidth: sw, sourceHeight: sh, outWidth: ow, outHeight: oh } = opts
  const outAspect = ow / oh

  // Largest window of the output aspect that fits inside the source.
  let cropW = Math.min(sw, Math.round(sh * outAspect))
  let cropH = Math.min(sh, Math.round(cropW / outAspect))
  cropW = cropW - (cropW % 2)
  cropH = cropH - (cropH % 2)

  const track = opts.track && opts.track.length > 0 ? opts.track : [{ atSec: 0, cx: 0.5, cy: 0.5 }]

  // Clamp the window to the frame so tracking near an edge cannot slide it out.
  const maxX = Math.max(0, sw - cropW)
  const maxY = Math.max(0, sh - cropH)
  const clamp = (v: number, hi: number): number => Math.max(0, Math.min(hi, v))

  const xExpr = lerpExpr(
    track.map((p) => ({ t: p.atSec, v: clamp(p.cx * sw - cropW / 2, maxX) })),
    't'
  )
  const yExpr = lerpExpr(
    track.map((p) => ({ t: p.atSec, v: clamp(p.cy * sh - cropH / 2, maxY) })),
    't'
  )

  // ffmpeg 6 removed crop's eval option: x and y are evaluated per frame, while
  // w and h are fixed at configuration time. That split is why the zoom has to
  // live in zoompan rather than in crop.
  const chain = [`crop=${cropW}:${cropH}:x='${xExpr}':y='${yExpr}'`]

  if (opts.zooms && opts.zooms.length > 0) {
    // zoompan calls its time variable in_time, and needs d=1 to stay 1:1 with
    // input frames instead of holding each frame for a duration.
    const zExpr = lerpExpr(
      opts.zooms.map((k) => ({ t: k.atSec, v: Math.max(1, k.scale) })),
      'in_time'
    )
    const cxExpr = lerpExpr(
      opts.zooms.map((k) => ({ t: k.atSec, v: k.cx })),
      'in_time'
    )
    const cyExpr = lerpExpr(
      opts.zooms.map((k) => ({ t: k.atSec, v: k.cy })),
      'in_time'
    )
    const fps = opts.sourceFps > 0 ? opts.sourceFps : 30
    chain.push(
      `zoompan=z='${zExpr}':x='iw*(${cxExpr})-(iw/zoom)/2':y='ih*(${cyExpr})-(ih/zoom)/2':d=1:s=${ow}x${oh}:fps=${fps.toFixed(6)}`
    )
  } else {
    chain.push(`scale=${ow}:${oh}`)
  }

  return chain.join(',')
}

/**
 * Places a punch-in over a span: ease in, hold, ease out. Emphasis moments in a
 * clip are short, so the shape matters more than the peak value.
 */
export function punchIn(atSec: number, holdSec: number, scale = 1.25, cx = 0.5, cy = 0.45): ZoomKeyframe[] {
  const ramp = 0.28
  return [
    { atSec: Math.max(0, atSec - ramp), scale: 1, cx, cy },
    { atSec, scale, cx, cy },
    { atSec: atSec + holdSec, scale, cx, cy },
    { atSec: atSec + holdSec + ramp, scale: 1, cx, cy }
  ]
}
