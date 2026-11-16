import type { Envelope } from '../audio/snap'
import type { CropPlan, FaceBox, FaceSample } from './faces'

/**
 * Synthetic footage with a known truth, for tests and the evaluation script:
 * a face-like shape whose mouth opens and closes on a schedule, a voice that
 * starts a set delay after each opening, and the distractors that fool a
 * naive detector (a swaying head, nods, blinks, a hand over the mouth, a
 * turn to the side, dim light, a voice from off camera).
 *
 * Nothing here is used by the app. It is pure so the same scenes can be
 * measured without ffmpeg (tiles cut in JS) and through it (frames piped in).
 */

/** A seeded random source, so every run draws the same noise. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Pose {
  /** Centre of the face box, as shares of the frame. */
  cx: number
  cy: number
  /** Face box width as a share of the frame width. */
  size: number
  /** -1 to 1: chin down to chin up. */
  nod: number
  /** -1 to 1: turned to one side to the other; 1 is a profile. */
  turn: number
}

export interface SceneFace {
  pose: (t: number) => Pose
  /** 0 closed to 1 wide open. */
  mouth: (t: number) => number
  /** 0 open to 1 shut. */
  blink?: (t: number) => number
  visible?: (t: number) => boolean
  /** A hand over the mouth. */
  covered?: (t: number) => boolean
}

export interface Scene {
  width: number
  height: number
  fps: number
  durationSec: number
  faces: SceneFace[]
  /** Overall light, 1 as normal. */
  light?: (t: number) => number
  /** Sensor noise, in grey levels. */
  noise?: number
  seed?: number
  /**
   * Stamp each frame's number in its top-left corner as 12 black and white
   * squares, so an export can be read back frame by frame (see readStamp).
   */
  stamp?: boolean
}

const STAMP_BITS = 12
const STAMP_CELL = 6

/** The frame number stamped into a frame by a scene with `stamp`, or -1 when there is none. */
export function readStamp(frame: Uint8Array, width: number): number {
  let n = 0
  for (let b = 0; b < STAMP_BITS; b++) {
    let s = 0
    for (let y = 1; y < STAMP_CELL - 1; y++)
      for (let x = 1; x < STAMP_CELL - 1; x++) s += frame[(2 + y) * width + 2 + b * STAMP_CELL + x]
    const v = s / ((STAMP_CELL - 2) * (STAMP_CELL - 2))
    if (v > 170) n |= 1 << b
    else if (v > 85) return -1
  }
  return n
}

/** A face box is taller than wide in pixels, about as Vision draws one. */
const BOX_ASPECT = 1.15

export function faceBox(scene: Scene, pose: Pose): FaceBox {
  const w = pose.size
  const h = (pose.size * scene.width * BOX_ASPECT) / scene.height
  return { x: pose.cx - w / 2, y: pose.cy - h / 2, w, h }
}

/** The boxes a face detector would report, a few times a second, with a little jitter. */
export function detections(scene: Scene, perSec = 4, jitter = 0.004, seed = 7): FaceSample[] {
  const r = rng(seed)
  const out: FaceSample[] = []
  for (let t = 0; t < scene.durationSec; t += 1 / perSec) {
    const faces: FaceBox[] = []
    for (const f of scene.faces) {
      if (f.visible && !f.visible(t)) continue
      const p = f.pose(t)
      if (Math.abs(p.turn) > 0.95) continue
      const b = faceBox(scene, p)
      const j = (): number => (r() * 2 - 1) * jitter
      faces.push({ x: b.x + j(), y: b.y + j(), w: b.w * (1 + j()), h: b.h * (1 + j()) })
    }
    out.push({ t: Math.round(t * 1000) / 1000, faces })
  }
  return out
}

function background(w: number, h: number, seed: number): Uint8Array {
  const r = rng(seed)
  const bg = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = 62 + (40 * x) / w + 14 * Math.sin(x / 11) * Math.sin(y / 15) + (r() - 0.5) * 18
      bg[y * w + x] = Math.max(0, Math.min(255, v))
    }
  }
  return bg
}

/** Skin texture fixed to the face, so a moving head moves its texture with it. */
function texture(seed: number): Float32Array {
  const r = rng(seed)
  const n = 64
  const t = new Float32Array(n * n)
  for (let i = 0; i < t.length; i++) t[i] = (r() - 0.5) * 16
  return t
}

const inEllipse = (u: number, v: number, cu: number, cv: number, ru: number, rv: number): number =>
  ((u - cu) / ru) ** 2 + ((v - cv) / rv) ** 2

/**
 * Draws one frame in grey, 8 bits a pixel. The face is drawn only inside its
 * own box, over a fixed background, so a few hundred frames take well under
 * a second.
 */
export function makeRenderer(scene: Scene): (t: number, out?: Uint8Array) => Uint8Array {
  const { width: W, height: H } = scene
  const seed = scene.seed ?? 1
  const bg = background(W, H, seed)
  const tex = texture(seed + 1)
  const noise = rng(seed + 2)
  const gauss = (): number => {
    // Irwin-Hall: close enough to normal for sensor noise.
    let s = 0
    for (let i = 0; i < 4; i++) s += noise()
    return (s - 2) * 1.73
  }
  return (t: number, out = new Uint8Array(W * H)) => {
    const light = scene.light ? scene.light(t) : 1
    const frame = new Float32Array(W * H)
    for (let i = 0; i < frame.length; i++) frame[i] = bg[i]
    for (const face of scene.faces) {
      if (face.visible && !face.visible(t)) continue
      const p = face.pose(t)
      const box = faceBox(scene, p)
      const open = Math.max(0, Math.min(1, face.mouth(t)))
      const blink = face.blink ? face.blink(t) : 0
      const covered = face.covered ? face.covered(t) : false
      // The jaw drops as the mouth opens, so the face grows downward.
      const jaw = 1 + 0.08 * open
      const x0 = Math.floor(box.x * W) - 2
      const x1 = Math.ceil((box.x + box.w) * W) + 2
      const y0 = Math.floor(box.y * H) - 2
      const y1 = Math.ceil((box.y + box.h * (0.5 + 0.5 * jaw)) * H) + 3
      const cxp = (box.x + box.w / 2) * W
      const cyp = (box.y + box.h / 2) * H
      const hu = (box.w * W) / 2
      const hv = (box.h * H) / 2
      const squash = 1 - 0.07 * Math.abs(p.nod)
      const lift = -0.1 * p.nod
      const sideways = 0.42 * p.turn
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const u = (x - cxp) / hu
          let v = (y - cyp) / hv
          if (v > 0) v /= jaw
          if (u * u + v * v > 1) continue
          // Features slide with the nod and the turn; the outline does not.
          const fu = u - sideways * (1 - v * v)
          const fv = (v - lift) / squash
          let g = 168 - 28 * (u * u + v * v) - 18 * p.turn * u
          g += tex[(Math.floor((u + 1) * 31.5) & 63) * 64 + (Math.floor((v + 1) * 31.5) & 63)]
          // Brows and eyes; the eye on the far side of a turn disappears.
          for (const side of [-1, 1]) {
            const fade = Math.max(0, 1 - Math.max(0, side * -p.turn) * 1.6)
            if (Math.abs(fv + 0.44) < 0.035 && Math.abs(fu - side * 0.36) < 0.16) g -= 85 * fade
            const ev = 0.07 * (1 - blink) + 0.005
            if (inEllipse(fu, fv, side * 0.36, -0.24, 0.15, ev) <= 1) g = g * (1 - fade) + 45 * fade
          }
          // Nose: a soft shadow and two nostrils.
          if (Math.abs(fu) < 0.06 && fv > -0.16 && fv < 0.24) g -= 14
          if (inEllipse(fu, fv, -0.07, 0.27, 0.04, 0.025) <= 1 || inEllipse(fu, fv, 0.07, 0.27, 0.04, 0.025) <= 1)
            g -= 50
          // Lips, the dark of the open mouth, and teeth along its top.
          const mv = 0.5 + 0.04 * open
          if (inEllipse(fu, fv, 0, mv, 0.34, 0.07 + 0.11 * open) <= 1) g = 112
          if (open > 0.02 && inEllipse(fu, fv, 0, mv, 0.26, 0.13 * open) <= 1) {
            g = fv < mv - 0.07 * open && open > 0.25 ? 205 : 32
          }
          if (covered && Math.abs(u) < 0.62 && v > 0.22 && v < 1) g = 186 + tex[(x & 63) * 64 + (y & 63)] * 0.6
          frame[y * W + x] = g
        }
      }
    }
    const sigma = scene.noise ?? 2.5
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i] * light + sigma * gauss()
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v
    }
    if (scene.stamp) {
      const n = Math.round(t * scene.fps)
      for (let b = 0; b < STAMP_BITS; b++) {
        const v = (n >> b) & 1 ? 255 : 0
        for (let y = 0; y < STAMP_CELL; y++)
          for (let x = 0; x < STAMP_CELL; x++) out[(2 + y) * W + 2 + b * STAMP_CELL + x] = v
      }
    }
    return out
  }
}

/** One word as spoken to camera. */
export interface SpokenWord {
  text: string
  /** The mouth starts to move. */
  openSec: number
  /** The sound starts (on the picture's clock). */
  onsetSec: number
  /** The sound stops. */
  endSec: number
  /** The mouth is still again. */
  settleSec: number
  /** Openings within the word. */
  syllables: number
  peak: number
}

const smooth = (x: number): number => {
  const k = Math.max(0, Math.min(1, x))
  return k * k * (3 - 2 * k)
}

/** How open the mouth is over time, for a list of words. */
export function mouthOf(words: SpokenWord[]): (t: number) => number {
  const sorted = [...words].sort((a, b) => a.openSec - b.openSec)
  return (t: number) => {
    for (const w of sorted) {
      if (t < w.openSec || t > w.settleSec) continue
      const hold = 0.7 * w.peak
      if (t < w.onsetSec) return hold * smooth((t - w.openSec) / Math.max(1e-6, w.onsetSec - w.openSec))
      if (t <= w.endSec) {
        const k = (t - w.onsetSec) / Math.max(1e-6, w.endSec - w.onsetSec)
        return hold + 0.3 * w.peak * Math.sin(2 * Math.PI * w.syllables * k)
      }
      return hold * (1 - smooth((t - w.endSec) / Math.max(1e-6, w.settleSec - w.endSec)))
    }
    return 0
  }
}

/** A stretch of voice: on screen (it follows the mouth) or off camera (it does not). */
export interface VoiceLine {
  startSec: number
  endSec: number
  /** Loudness follows this, 0 to 1. */
  amplitude: (t: number) => number
  pitchHz: number
}

/** The voice for words spoken on screen: loud while the mouth is open between onset and end. */
export function voiceOf(words: SpokenWord[]): VoiceLine[] {
  const mouth = mouthOf(words)
  return words.map((w) => ({
    startSec: w.onsetSec,
    endSec: w.endSec,
    amplitude: (t: number) => Math.min(1, mouth(t) / Math.max(0.05, w.peak)),
    pitchHz: 128
  }))
}

/**
 * Mono samples for a set of voice lines, with the whole track delayed by
 * `offsetSec` (positive: the sound runs behind the picture, as through a
 * wireless microphone), over a quiet room.
 */
export function voiceSamples(lines: VoiceLine[], rate: number, durationSec: number, offsetSec = 0): Float32Array {
  const n = Math.round(durationSec * rate)
  const out = new Float32Array(n)
  const room = rng(99)
  for (let i = 0; i < n; i++) out[i] = (room() - 0.5) * 0.002
  for (const line of lines) {
    const a = Math.max(0, Math.floor((line.startSec + offsetSec) * rate))
    const b = Math.min(n, Math.ceil((line.endSec + offsetSec) * rate))
    let phase = 0
    for (let i = a; i < b; i++) {
      const t = i / rate - offsetSec
      // 8 ms ramps at each end so the edges do not click.
      const edge = Math.min(1, (t - line.startSec) / 0.008, (line.endSec - t) / 0.008)
      const f = line.pitchHz * (1 + 0.03 * Math.sin(2 * Math.PI * 5 * t))
      phase += (2 * Math.PI * f) / rate
      let s = 0
      for (let h = 1; h <= 8; h++) s += Math.sin(h * phase) / h
      out[i] += 0.16 * s * line.amplitude(t) * Math.max(0, edge)
    }
  }
  return out
}

/** A 16-bit mono WAV file. */
export function wav(samples: Float32Array, rate: number): Uint8Array {
  const data = samples.length * 2
  const buf = new ArrayBuffer(44 + data)
  const v = new DataView(buf)
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  v.setUint32(4, 36 + data, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  text(36, 'data')
  v.setUint32(40, data, true)
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true)
  }
  return new Uint8Array(buf)
}

/**
 * A schedule of words for a take: `count` words in phrases, each preceded by
 * a mouth that moves `leadSec` before the sound and settles `settleSec`
 * after it, with leads and lengths varied so nothing lines up by accident.
 */
export function schedule(opts: {
  startSec: number
  count: number
  seed?: number
  leadSec?: [number, number]
  settleSec?: [number, number]
  gapSec?: [number, number]
}): SpokenWord[] {
  const r = rng(opts.seed ?? 3)
  const pick = ([a, b]: [number, number]): number => a + (b - a) * r()
  const words: SpokenWord[] = []
  let t = opts.startSec
  for (let i = 0; i < opts.count; i++) {
    const lead = pick(opts.leadSec ?? [0.06, 0.16])
    const len = 0.22 + 0.4 * r()
    const settle = pick(opts.settleSec ?? [0.07, 0.15])
    const openSec = t
    const onsetSec = openSec + lead
    const endSec = onsetSec + len
    words.push({
      text: `w${i + 1}`,
      openSec,
      onsetSec,
      endSec,
      settleSec: endSec + settle,
      syllables: 1 + Math.floor(r() * 3),
      peak: 0.75 + 0.25 * r()
    })
    t = endSec + settle + pick(opts.gapSec ?? [0.35, 0.9])
  }
  return words
}

/**
 * What the crop pass (main/mouth.ts) makes of one frame, done in JS: each
 * slot's window shrunk to its tile by area averaging, then the whole
 * picture, side by side. Lets the whole path run in a test without ffmpeg.
 */
export function tilesFor(
  frame: Uint8Array,
  size: { width: number; height: number },
  plan: CropPlan,
  t: number,
  out?: Uint8Array
): Uint8Array {
  const { tileW: TW, tileH: TH } = plan
  const rowW = TW * (plan.slots.length + 1)
  const row = out ?? new Uint8Array(rowW * TH)
  const shrink = (k: number, x0: number, y0: number, w: number, h: number): void => {
    for (let ty = 0; ty < TH; ty++) {
      for (let tx = 0; tx < TW; tx++) {
        const a = x0 + (tx * w) / TW
        const b = x0 + ((tx + 1) * w) / TW
        const c = y0 + (ty * h) / TH
        const d = y0 + ((ty + 1) * h) / TH
        let s = 0
        let n = 0
        for (let y = Math.floor(c); y < Math.ceil(d); y++) {
          for (let x = Math.floor(a); x < Math.ceil(b); x++) {
            const cover = (Math.min(x + 1, b) - Math.max(x, a)) * (Math.min(y + 1, d) - Math.max(y, c))
            s += frame[Math.min(size.height - 1, y) * size.width + Math.min(size.width - 1, x)] * cover
            n += cover
          }
        }
        row[ty * rowW + k * TW + tx] = Math.round(s / n)
      }
    }
  }
  plan.slots.forEach((slot, k) => {
    const win = [...slot.windows].reverse().find((w) => w.fromSec <= t) ?? slot.windows[0]
    shrink(k, win?.x ?? 0, win?.y ?? 0, slot.w, slot.h)
  })
  shrink(plan.slots.length, 0, 0, size.width, size.height)
  return row
}

/** Loudness in dBFS every `hopSec`, the way main/audio-envelope measures it. */
export function envelopeOf(samples: Float32Array, rate: number, hopSec = 0.01): Envelope {
  const per = Math.max(1, Math.round(rate * hopSec))
  const db: number[] = []
  for (let i = 0; i < samples.length; i += per) {
    let s = 0
    const end = Math.min(samples.length, i + per)
    for (let j = i; j < end; j++) s += samples[j] * samples[j]
    db.push(10 * Math.log10(s / (end - i) + 1e-12))
  }
  return { hopSec, db: Float32Array.from(db) }
}

export interface TakeOptions {
  width?: number
  height?: number
  fps?: number
  /** Words said on camera. */
  words?: number
  seed?: number
  /** Face width as a share of the frame's width, and where it sits. */
  size?: number
  cx?: number
  cy?: number
  /** Nods in the pauses, where the mouth is still. */
  nods?: boolean
  blinks?: boolean
  /** Stretches (on the picture's clock) where someone off camera talks and the mouth stays still. */
  offCamera?: [number, number][]
  /** A hand over the mouth for this stretch. */
  covered?: [number, number] | null
  /** Overall light, 1 as normal. */
  light?: number
  /** The face only comes into frame at this time. */
  enterSec?: number
  /** A second face beside the first that never talks. */
  listener?: boolean
  /** A stretch where the head turns to a profile and back, over a third of a second each way. */
  turned?: [number, number] | null
  /** Stamp each frame's number into it (see Scene.stamp). */
  stamp?: boolean
}

/** A synthetic take with its truth: the scene, the words as spoken, the voices, and where the distractors are. */
export interface Take {
  scene: Scene
  words: SpokenWord[]
  lines: VoiceLine[]
  nods: [number, number][]
  offCamera: [number, number][]
  durationSec: number
}

export function take(opts: TakeOptions = {}): Take {
  const width = opts.width ?? 320
  const height = opts.height ?? 180
  const fps = opts.fps ?? 30
  const offCamera = opts.offCamera ?? []
  // Words start once the face is in view, and leave the off-camera stretches free.
  let words = schedule({ startSec: Math.max(0, opts.enterSec ?? 0) + 1, count: opts.words ?? 16, seed: opts.seed ?? 3 })
  for (const [a, b] of offCamera) {
    const shift = b + 0.6 - a
    words = words.map((w) =>
      w.openSec >= a - 0.4
        ? {
            ...w,
            openSec: w.openSec + shift,
            onsetSec: w.onsetSec + shift,
            endSec: w.endSec + shift,
            settleSec: w.settleSec + shift
          }
        : w
    )
  }
  const last = words[words.length - 1]
  const durationSec = Math.max(last.settleSec, ...offCamera.map(([, b]) => b)) + 1.5
  // Nods in the pauses between words, clear of any word's movement.
  const nods: [number, number][] = []
  if (opts.nods ?? true) {
    for (let i = 2; i + 1 < words.length; i += 4) {
      const a = words[i].settleSec + 0.08
      const b = words[i + 1].openSec - 0.08
      if (b - a > 0.3) nods.push([a, b])
    }
  }
  const nodAt = (t: number): number => {
    for (const [a, b] of nods) if (t >= a && t <= b) return Math.sin(Math.PI * ((t - a) / (b - a)) * 2) * 0.9
    return 0
  }
  const size = opts.size ?? 0.24
  const cx = opts.cx ?? (opts.listener ? 0.32 : 0.5)
  const cy = opts.cy ?? 0.46
  const enter = opts.enterSec ?? -1
  const covered = opts.covered ?? null
  const turned = opts.turned ?? null
  const turnAt = (t: number): number => {
    if (!turned) return 0
    const [a, b] = turned
    return Math.max(0, Math.min(1, (t - a) / 0.33, (b - t) / 0.33))
  }
  const faces: SceneFace[] = [
    {
      pose: (t) => ({
        cx: cx + 0.012 * Math.sin(2 * Math.PI * 0.21 * t),
        cy: cy + 0.03 * nodAt(t),
        size,
        nod: nodAt(t),
        turn: turnAt(t)
      }),
      mouth: mouthOf(words),
      blink: opts.blinks === false ? undefined : (t) => (t % 2.9 < 0.1 ? 1 : 0),
      visible: (t) => t >= enter,
      covered: covered ? (t) => t >= covered[0] && t <= covered[1] : undefined
    }
  ]
  if (opts.listener) {
    faces.push({
      pose: (t) => ({ cx: 0.72, cy: cy + 0.01 * Math.sin(2 * Math.PI * 0.17 * t), size: size * 0.9, nod: 0, turn: 0 }),
      mouth: () => 0,
      blink: (t) => ((t + 1.3) % 3.3 < 0.1 ? 1 : 0)
    })
  }
  const lines = voiceOf(words)
  for (const [a, b] of offCamera) {
    lines.push({
      startSec: a,
      endSec: b,
      amplitude: (t) => 0.55 + 0.35 * Math.abs(Math.sin(2 * Math.PI * 2.3 * (t - a))),
      pitchHz: 205
    })
  }
  const light = opts.light ?? 1
  return {
    scene: { width, height, fps, durationSec, faces, light: () => light, seed: opts.seed ?? 3, stamp: opts.stamp },
    words,
    lines,
    nods,
    offCamera,
    durationSec
  }
}
