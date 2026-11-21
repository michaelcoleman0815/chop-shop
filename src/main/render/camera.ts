import type { CameraPlan, Ease, Key } from '../../shared/edit'

/**
 * A camera move as ffmpeg's perspective filter: per frame, the frame's window
 * on the recording is carried to the corners of the picture, sampled between
 * pixels, so a slow push-in glides instead of stepping a pixel at a time the
 * way crop and zoompan do. The numbers are the plan's, the ones the preview
 * draws, so the two move together.
 *
 * Positions are worked out against the picture's real width and height (W
 * and H in the expressions), so a recording whose stored size is off still
 * keeps its shape: the window always has the finished frame's shape.
 */

const n = (v: number): string => (Math.abs(v) < 1e-12 ? '0' : v.toFixed(6))

/** An easing curve over the stored progress, ld(8). */
function easeExpr(e: Ease): string {
  if (e === 'linear') return 'ld(8)'
  if (e === 'out') return '(1-pow(1-ld(8),3))'
  return '(ld(8)*ld(8)*(3-2*ld(8)))'
}

/** Stores a key's view, as zoom, x and y in variables 1 to 3. */
const hold = (k: Key): string => `(st(1,${n(k.zoom)});st(2,${n(k.x)});st(3,${n(k.y)}))`

/** Stores the view between two keys at the time in ld(0): eased, zoom moving evenly in scale. */
function between(a: Key, b: Key): string {
  const la = Math.log(a.zoom)
  const lb = Math.log(b.zoom)
  const len = Math.max(1e-6, b.t - a.t)
  return (
    `(st(8,clip((ld(0)-${n(a.t)})/${n(len)},0,1));st(9,${easeExpr(b.ease)});` +
    `st(1,exp(${n(la)}+${n(lb - la)}*ld(9)));st(2,${n(a.x)}+${n(b.x - a.x)}*ld(9));st(3,${n(a.y)}+${n(b.y - a.y)}*ld(9)))`
  )
}

/** A balanced tree of if()s over the keys, storing the view at ld(0). */
function viewTree(keys: Key[]): string {
  if (keys.length === 1) return hold(keys[0])
  // Segment i runs from keys[i - 1] to keys[i]; before the first and after the last, the ends hold.
  const tree = (lo: number, hi: number): string => {
    if (lo === hi) return between(keys[lo - 1], keys[lo])
    const mid = (lo + hi + 1) >> 1
    return `if(lt(ld(0),${n(keys[mid - 1].t)}),${tree(lo, mid - 1)},${tree(mid, hi)})`
  }
  const last = keys[keys.length - 1]
  return `if(lt(ld(0),${n(keys[0].t)}),${hold(keys[0])},if(gte(ld(0),${n(last.t)}),${hold(last)},${tree(1, keys.length - 1)}))`
}

/** A shake's jolts added to the centre in ld(2) and ld(3), decaying, scaled to the window. */
function shakeParts(plan: CameraPlan): string[] {
  if (!plan.shake) return []
  const { start, sec, amp } = plan.shake
  const jolt = (hz: number, phase: number): string =>
    `if(between(ld(0),${n(start)},${n(start + sec)}),${n(amp)}*pow(1-(ld(0)-${n(start)})/${n(sec)},2)*sin(${n(2 * Math.PI * hz)}*(ld(0)-${n(start)})+${n(phase)}),0)`
  return [`st(2,ld(2)+${jolt(9, 0)}*ld(4)/ld(1))`, `st(3,ld(3)+${jolt(7, 1.3)}*ld(5)/ld(1))`]
}

/**
 * The same move without the perspective filter, for an ffmpeg built without
 * its GPL parts, as a phone's is (perspective is GPL; scale and crop are not).
 *
 * The picture, `picture` in size, is scaled each frame so the window is
 * exactly `out` wide, then cropped to the window. Scale and crop place it to
 * the nearest pixel of the finished frame where perspective samples between
 * pixels, so a slow push-in steps by up to half a pixel. The view is the
 * plan's, worked out by the same expressions, so the move is the same.
 */
export function cropMove(
  plan: CameraPlan,
  offset: number,
  fps: number,
  picture: { width: number; height: number },
  out: { width: number; height: number }
): string {
  const aspect = out.width / out.height
  // The frame's width and height at zoom 1, as fractions of this picture: constants here.
  const fw = Math.min(1, (aspect * picture.height) / picture.width)
  const fh = Math.min(1, picture.width / (aspect * picture.height))
  const prefix = [
    // Scale and crop count frames from 0.
    `st(0,${n(offset)}+n/${fps})`,
    `st(4,${n(fw)})`,
    `st(5,${n(fh)})`,
    viewTree(plan.keys),
    ...shakeParts(plan),
    'st(6,clip(ld(1),1,3))'
  ].join(';')
  // The picture's size once the window is the frame's width, kept even.
  const scaled = (side: number): string => `2*trunc(${n(side / 2)}*ld(6)/${n(fw)}+0.5)`
  const sw = scaled(out.width)
  const sh = scaled((out.width * picture.height) / picture.width)
  const hw = 'ld(4)/(2*ld(6))'
  const hh = 'ld(5)/(2*ld(6))'
  const left = `${prefix};trunc((clip(ld(2),${hw},1-${hw})-${hw})*${sw}+0.5)`
  const top = `${prefix};trunc((clip(ld(3),${hh},1-${hh})-${hh})*${sh}+0.5)`
  const q = (e: string): string => `'${e}'`
  return (
    `scale=w=${q(`${prefix};${sw}`)}:h=${q(`${prefix};${sh}`)}:eval=frame,` +
    `crop=${out.width}:${out.height}:x=${q(left)}:y=${q(top)}:exact=1`
  )
}

/**
 * The perspective filter for a plan, on a picture whose finished shape is
 * `aspect` (width over height). `offset` is how far into the beat's picture
 * this piece starts, in seconds; frames count from it at `fps`.
 */
export function perspectiveFor(plan: CameraPlan, offset: number, fps: number, aspect: number): string {
  const parts = [
    // perspective counts output frames from 1.
    `st(0,${n(offset)}+(on-1)/${fps})`,
    // The frame's width and height at zoom 1, as fractions of this picture.
    `st(4,min(1,${n(aspect)}*H/W))`,
    `st(5,min(1,W/(${n(aspect)}*H)))`,
    viewTree(plan.keys),
    ...shakeParts(plan)
  ]
  parts.push('st(6,clip(ld(1),1,3))')
  const prefix = parts.join(';')
  // Half the window across and down, and its clamped centre.
  const hw = 'ld(4)/(2*ld(6))'
  const hh = 'ld(5)/(2*ld(6))'
  const cx = `clip(ld(2),${hw},1-${hw})`
  const cy = `clip(ld(3),${hh},1-${hh})`
  const left = `${prefix};(${cx}-${hw})*W`
  const right = `${prefix};(${cx}+${hw})*W`
  const top = `${prefix};(${cy}-${hh})*H`
  const bottom = `${prefix};(${cy}+${hh})*H`
  const q = (e: string): string => `'${e}'`
  return (
    `perspective=x0=${q(left)}:y0=${q(top)}:x1=${q(right)}:y1=${q(top)}:x2=${q(left)}:y2=${q(bottom)}` +
    `:x3=${q(right)}:y3=${q(bottom)}:interpolation=linear:sense=source:eval=frame`
  )
}
