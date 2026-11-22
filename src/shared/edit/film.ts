/**
 * Old film over the picture: the frame weaving in the gate, dust and hairs on
 * the print, scratches running down it, light leaking in at the edges and the
 * exposure flickering. Part of a look (edit/look.ts), so any edit can have it
 * ("/look dust 0.3") and an archival documentary wears it by default.
 *
 * Everything here is a pure function of the frame number, so the preview and
 * the export draw exactly the same specks at exactly the same moments: the
 * export renders one loop of it to a file with alpha (main/render/film.ts)
 * and lays it over the graded picture, the editor draws the same frames on a
 * canvas over the player. The weave is the one part that moves the picture
 * itself: the export crops along it with ffmpeg's crop filter, the preview
 * moves the player by the same amount with a transform.
 *
 * Drawing uses only the part of the 2D canvas API that Skia (in the export)
 * and the browser (in the editor) share.
 */

/** The film repeats after this many seconds: long enough that a speck pattern never reads as a loop. */
export const FILM_LOOP_SEC = 8

/** The soft layer (leaks and flicker) is drawn this many times smaller than the frame and scaled up. */
export const FILM_SOFT_SCALE = 5

export interface FilmLook {
  weave?: number
  dust?: number
  leak?: number
  flicker?: number
}

/** The 2D canvas calls the film draws with, shared by Skia's and the browser's canvases. */
export interface FilmCanvas {
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  globalAlpha: number
  lineCap: CanvasLineCap
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  arc(x: number, y: number, r: number, a0: number, a1: number): void
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, a0: number, a1: number): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
  fill(): void
  stroke(): void
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient
}

const clamp01 = (v: number | undefined): number => Math.min(1, Math.max(0, v ?? 0))

/** A repeatable random number from 0 to 1 for a seed: the same seed, the same number, everywhere. */
export function hash01(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** A stream of repeatable random numbers for one frame of one layer. */
function stream(frame: number, layer: number): () => number {
  let i = 0
  return () => hash01(frame * 7919 + layer * 104729 + i++ * 31)
}

/** Frames in one loop of the film at a frame rate. */
export function loopFrames(fps: number): number {
  return Math.max(1, Math.round(FILM_LOOP_SEC * fps))
}

/** The film's own frame at a moment: the loop's frame showing at time t. */
export function filmFrame(t: number, fps: number): number {
  const n = Math.floor(Math.max(0, t) * fps + 1e-6)
  return n % loopFrames(fps)
}

// ---------- Gate weave ----------

/** How far the frame weaves at most, as a share of its width, at full weave. */
const WEAVE_MAX = 0.0028

/** A number from -1 to 1 that changes every frame, written the way ffmpeg's expressions can say it too. */
function jitter(frame: number, k: number): number {
  const x = Math.sin(frame * 12.9898 + k) * 43758.5453
  return 2 * (x - Math.floor(x)) - 1
}

/** How much bigger the picture is drawn so the weave never shows an edge. */
export function weaveScale(amount: number): number {
  return 1 + 2.4 * WEAVE_MAX * clamp01(amount)
}

/**
 * Where the weave has the picture at time t, as shares of the frame's width
 * and height: a slow drift with a jolt of its own every frame, as a print
 * shifts in a projector's gate.
 */
export function weaveAt(amount: number, t: number, fps: number): { dx: number; dy: number } {
  const a = WEAVE_MAX * clamp01(amount)
  if (a <= 0) return { dx: 0, dy: 0 }
  const n = Math.floor(t * fps + 1e-6)
  const tau = 2 * Math.PI
  return {
    dx: a * (0.55 * Math.sin(tau * 0.83 * t) + 0.3 * Math.sin(tau * 2.31 * t + 1.7) + 0.15 * jitter(n, 1.3)),
    dy: a * 0.8 * (0.5 * Math.sin(tau * 0.61 * t + 0.4) + 0.3 * Math.sin(tau * 1.73 * t + 2.2) + 0.2 * jitter(n, 4.1))
  }
}

/**
 * The weave as ffmpeg's crop filter moves it, then scaled back to the frame:
 * the same sums as weaveAt, on the filter's own clock. Works on 6.0, 6.1 and 7.0.
 */
export function weaveFilter(amount: number, width: number, height: number, fps: number): string | null {
  const a = WEAVE_MAX * clamp01(amount)
  if (a <= 0) return null
  const s = weaveScale(amount)
  const f = (v: number): string => v.toFixed(6)
  const tau = 2 * Math.PI
  const n = `floor(t*${fps}+0.000001)`
  // jitter(n, k) = 2*frac(sin(n*12.9898+k)*43758.5453)-1, with frac(x) = x-floor(x).
  const jit = (k: number): string =>
    `(2*((sin(${n}*12.9898+${k})*43758.5453)-floor(sin(${n}*12.9898+${k})*43758.5453))-1)`
  const dx = `${f(a)}*(0.55*sin(${f(tau * 0.83)}*t)+0.3*sin(${f(tau * 2.31)}*t+1.7)+0.15*${jit(1.3)})`
  const dy = `${f(a * 0.8)}*(0.5*sin(${f(tau * 0.61)}*t+0.4)+0.3*sin(${f(tau * 1.73)}*t+2.2)+0.2*${jit(4.1)})`
  const w = `iw/${f(s)}`
  const h = `ih/${f(s)}`
  // The window moves with the weave; the picture in it moves the other way, as on a screen.
  return `crop=w='${w}':h='${h}':x='(iw-ow)/2+(${dx})*iw':y='(ih-oh)/2+(${dy})*ih':exact=1,scale=${width}:${height},setsar=1`
}

/** The weave as the preview moves the player: the same offset, the same scale. */
export function weaveTransform(amount: number, t: number, fps: number): string | undefined {
  if (clamp01(amount) <= 0) return undefined
  const s = weaveScale(amount)
  const { dx, dy } = weaveAt(amount, t, fps)
  return `translate(${(-dx * s * 100).toFixed(4)}%, ${(-dy * s * 100).toFixed(4)}%) scale(${s.toFixed(5)})`
}

// ---------- Dust, hairs and scratches: the fine layer, at the frame's own size ----------

/** A scratch runs down the print for a while: where it starts in the loop, how long, where across. */
interface Scratch {
  start: number
  frames: number
  x: number
  drift: number
  alpha: number
  width: number
}

/** The scratches of one loop, the same for every frame that asks. */
function scratches(amount: number, frames: number): Scratch[] {
  const count = Math.round(clamp01(amount) * 5)
  const out: Scratch[] = []
  for (let i = 0; i < count; i++) {
    const r = (k: number): number => hash01(9001 + i * 17 + k)
    out.push({
      start: Math.floor(r(0) * frames),
      frames: Math.round(frames * (0.06 + r(1) * 0.14)),
      x: 0.08 + r(2) * 0.84,
      drift: (r(3) - 0.5) * 0.02,
      alpha: 0.1 + r(4) * 0.18,
      width: 0.6 + r(5) * 1.2
    })
  }
  return out
}

/**
 * One frame of dust, hairs and scratches over a frame `width` by `height`:
 * dark and light specks that change every frame, now and then a hair, and
 * scratches that stay put for a second or so. Sizes follow the frame's
 * height, so the preview and the export draw them alike at any size.
 */
export function drawFilmFine(ctx: FilmCanvas, width: number, height: number, look: FilmLook, frame: number, fps: number): void {
  ctx.clearRect(0, 0, width, height)
  const dust = clamp01(look.dust)
  if (dust <= 0) return
  const u = height / 1080
  const next = stream(frame, 1)
  ctx.globalAlpha = 1
  // Specks: a few a frame, more as dust goes up; most dark (dirt on the print), some light (on the negative).
  const specks = Math.floor(dust * 7 + next() * dust * 6)
  for (let i = 0; i < specks; i++) {
    const x = next() * width
    const y = next() * height
    const r = (0.6 + next() ** 2 * 3.4) * u
    const light = next() < 0.3
    ctx.fillStyle = light ? 'rgba(250, 244, 228, 0.55)' : 'rgba(24, 18, 12, 0.6)'
    ctx.beginPath()
    if (next() < 0.5) ctx.arc(x, y, r, 0, Math.PI * 2)
    else ctx.ellipse(x, y, r * (1.2 + next()), r * (0.5 + next() * 0.5), next() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  // A hair now and then: a thin dark curl for a single frame.
  if (next() < 0.06 * dust * 2) {
    const x = next() * width
    const y = next() * height
    const len = (30 + next() * 70) * u
    const a = next() * Math.PI * 2
    ctx.strokeStyle = 'rgba(20, 14, 10, 0.55)'
    ctx.lineWidth = Math.max(0.8, 1.1 * u)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.quadraticCurveTo(
      x + Math.cos(a + 1.2) * len * 0.7,
      y + Math.sin(a + 1.2) * len * 0.7,
      x + Math.cos(a) * len,
      y + Math.sin(a) * len
    )
    ctx.stroke()
  }
  // Scratches: light lines down the whole frame, wavering a little frame to frame.
  const frames = loopFrames(fps)
  for (const s of scratches(dust, frames)) {
    const into = (frame - s.start + frames) % frames
    if (into >= s.frames) continue
    const x = (s.x + s.drift * (into / Math.max(1, s.frames)) + (hash01(frame * 3 + s.start) - 0.5) * 0.0015) * width
    ctx.strokeStyle = `rgba(240, 232, 214, ${(s.alpha * (0.7 + 0.3 * hash01(frame + s.start))).toFixed(3)})`
    ctx.lineWidth = Math.max(0.7, s.width * u)
    ctx.lineCap = 'butt'
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x + (hash01(s.start + 5) - 0.5) * 4 * u, height)
    ctx.stroke()
  }
}

// ---------- Light leaks and flicker: the soft layer, drawn small and scaled up ----------

/** How dark the flicker makes a frame, 0 to about 0.12: the veil laid over it. */
export function flickerAt(amount: number, frame: number, fps: number): number {
  const a = clamp01(amount)
  if (a <= 0) return 0
  const t = frame / fps
  const v = 0.035 + 0.03 * jitter(frame, 7.7) + 0.02 * Math.sin(2 * Math.PI * 1.1 * t)
  return Math.min(0.12, Math.max(0, v * a * 1.4))
}

/** A leak: a soft warm glow at an edge, swelling and fading over a second or two. */
interface Leak {
  start: number
  frames: number
  x: number
  y: number
  r: number
  hue: string
  strength: number
}

function leaks(amount: number, frames: number): Leak[] {
  const count = Math.max(1, Math.round(clamp01(amount) * 3))
  const out: Leak[] = []
  for (let i = 0; i < count; i++) {
    const r = (k: number): number => hash01(4242 + i * 23 + k)
    const edge = Math.floor(r(0) * 4)
    const along = 0.15 + r(1) * 0.7
    const [x, y] = edge === 0 ? [along, -0.05] : edge === 1 ? [1.05, along] : edge === 2 ? [along, 1.05] : [-0.05, along]
    out.push({
      start: Math.floor((i / count) * frames + r(2) * (frames / count) * 0.5),
      frames: Math.round(frames * (0.16 + r(3) * 0.14)),
      x,
      y,
      r: 0.45 + r(4) * 0.35,
      hue: r(5) < 0.6 ? '255, 150, 70' : '255, 205, 120',
      strength: 0.18 + r(6) * 0.17
    })
  }
  return out
}

/** One frame of leaks and flicker over a small frame, to be scaled up smoothly to the picture's size. */
export function drawFilmSoft(ctx: FilmCanvas, width: number, height: number, look: FilmLook, frame: number, fps: number): void {
  ctx.clearRect(0, 0, width, height)
  ctx.globalAlpha = 1
  const veil = flickerAt(look.flicker ?? 0, frame, fps)
  if (veil > 0) {
    ctx.fillStyle = `rgba(0, 0, 0, ${veil.toFixed(4)})`
    ctx.fillRect(0, 0, width, height)
  }
  const leak = clamp01(look.leak)
  if (leak <= 0) return
  const frames = loopFrames(fps)
  for (const l of leaks(leak, frames)) {
    const into = (frame - l.start + frames) % frames
    if (into >= l.frames) continue
    // Swells in and fades away, never popping on or off.
    const u = into / Math.max(1, l.frames)
    const swell = Math.sin(Math.PI * u) ** 2
    const alpha = l.strength * leak * swell
    if (alpha <= 0.002) continue
    const cx = l.x * width
    const cy = l.y * height
    const radius = l.r * Math.max(width, height)
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
    g.addColorStop(0, `rgba(${l.hue}, ${alpha.toFixed(4)})`)
    g.addColorStop(0.45, `rgba(${l.hue}, ${(alpha * 0.45).toFixed(4)})`)
    g.addColorStop(1, `rgba(${l.hue}, 0)`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, width, height)
  }
}

/** The size the soft layer is drawn at for a frame. */
export function softSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(2, Math.round(width / FILM_SOFT_SCALE / 2) * 2),
    height: Math.max(2, Math.round(height / FILM_SOFT_SCALE / 2) * 2)
  }
}

/** Which of the film's two layers a look draws. */
export function filmLayers(look: FilmLook | null | undefined): { fine: boolean; soft: boolean } {
  return { fine: clamp01(look?.dust) > 0, soft: clamp01(look?.leak) > 0 || clamp01(look?.flicker) > 0 }
}
