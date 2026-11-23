import { num } from '../anim'
import { rand, turbulence, wiggle } from '../fx/noise'
import { letterSegments, pointAlong } from './letters'
import type { ParticleSettings } from './presets'

/**
 * The particles, stepped from the clip's start (less its pre-run) at a fixed
 * step, so the particles at any moment are one sequence of steps away from
 * the beginning whatever order the moments are asked for in: playing, seeking
 * back, the export's frames one after another. Every random number is a hash
 * of the seed and the particle's own number (shared/fx/noise), never
 * Math.random, so the editor's preview and the export see the same
 * particles.
 *
 * The state is copied aside every second of simulated time, so a seek starts
 * from the copy just before it and steps at most a second; playing on steps
 * one frame's worth. No more particles than the settings' cap ever live.
 */

/** Steps a second: the simulation's own clock, whatever the frame rate. */
export const STEPS_PER_SEC = 60
const DT = 1 / STEPS_PER_SEC

/** What each particle holds, packed: x, y, its velocity, its age, its number, its life, and the push of the air on it. */
export const STRIDE = 9
const X = 0
const Y = 1
const VX = 2
const VY = 3
export const AGE = 4
export const ID = 5
export const LIFE = 6
const TX = 7
const TY = 8
/** The air's push on a particle is worked out again every this many steps, each particle on its own beat: a tenth of a second. */
const AIR_EVERY = 6

/** The randoms each particle draws, by slot. */
export const R = {
  where: 0,
  where2: 1,
  side: 2,
  angle: 3,
  speed: 4,
  life: 5,
  size: 6,
  colour: 7,
  spin: 8,
  phase: 9,
  flicker: 10,
  spinWay: 11
} as const

/** The particles alive at a moment, and how far past their last step the moment is. */
export interface ParticleFrame {
  /** Packed STRIDE numbers a particle. */
  data: Float64Array
  count: number
  /** Seconds past the last step: drawn moved on by their velocity this much. */
  ahead: number
  /** Seconds since the simulation began (the clip's start less its pre-run), at the last step. */
  time: number
}

interface Snapshot {
  step: number
  born: number
  carry: number
  count: number
  data: Float64Array
}

const varied = (base: number, variance: number, r: number, reach: number): number => base * (1 + variance * (r * 2 - 1) * reach)

export class ParticleSim {
  private readonly s: ParticleSettings
  private readonly w: number
  private readonly h: number
  private readonly length: number
  private readonly bounds: [number, number, number, number]
  private readonly damp: number
  private readonly every: number
  private readonly burstStep: number
  private readonly letters: ReturnType<typeof letterSegments> | null
  private readonly saved = new Map<number, Snapshot>()
  /** Steps taken since it was made, for seeing what a seek cost. */
  stepsTaken = 0
  /** Steps of simulated time between the copies kept. */
  get copyEvery(): number {
    return this.every
  }
  private highest = 0
  // The live state.
  private step = 0
  private born = 0
  private carry = 0
  private count = 0
  private data: Float64Array

  constructor(settings: ParticleSettings, frame: { width: number; height: number }, length: number) {
    this.s = settings
    this.w = frame.width
    this.h = frame.height
    this.length = length
    const reach = Math.max(settings.size, settings.sizeEnd) * 1.5 + settings.speed * settings.stretch + 0.2 * Math.max(frame.width, frame.height)
    this.bounds = [-reach, -reach, frame.width + reach, frame.height + reach]
    this.damp = Math.exp(-settings.drag * DT)
    // A copy a second, or fewer for a long clip, at most about 120 of them: a seek then steps a few seconds at most.
    const steps = Math.ceil((length + settings.prerun) * STEPS_PER_SEC)
    this.every = Math.max(STEPS_PER_SEC, Math.ceil(steps / 120))
    this.burstStep = Math.round(settings.prerun * STEPS_PER_SEC)
    const [x0, y0, x1, y1] = settings.area
    this.letters =
      settings.emitter === 'text' && settings.text
        ? letterSegments(settings.text, { x: x0 * frame.width, y: y0 * frame.height, w: (x1 - x0) * frame.width, h: (y1 - y0) * frame.height })
        : null
    this.data = new Float64Array(settings.max * STRIDE)
    this.saved.set(0, this.snapshot())
  }

  /** The particles `local` seconds into the clip. */
  at(local: number): ParticleFrame {
    const tau = Math.max(0, local) + this.s.prerun
    const target = Math.floor(tau * STEPS_PER_SEC + 1e-7)
    // From the live state when it is behind and no copy is nearer; else from the copy before the target.
    const copy = Math.min(Math.floor(target / this.every) * this.every, this.highest)
    if (this.step > target || this.step < copy) this.restore(this.saved.get(copy) as Snapshot)
    while (this.step < target) this.advance()
    return { data: this.data, count: this.count, ahead: tau - this.step * DT, time: this.step * DT }
  }

  private snapshot(): Snapshot {
    return { step: this.step, born: this.born, carry: this.carry, count: this.count, data: this.data.slice(0, this.count * STRIDE) }
  }

  private restore(s: Snapshot): void {
    this.step = s.step
    this.born = s.born
    this.carry = s.carry
    this.count = s.count
    this.data.set(s.data)
  }

  /** One step: forces, moves, the old and the strayed taken out, the new born. */
  private advance(): void {
    const s = this.s
    const d = this.data
    const time = this.step * DT
    const [bx0, by0, bx1, by1] = this.bounds
    const swirl = Math.max(1, s.swirl)
    let w = 0
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE
      const id = d[o + ID]
      const age = d[o + AGE] + DT
      const life = d[o + LIFE]
      if (age >= life) continue
      let vx = d[o + VX]
      let vy = d[o + VY]
      let x = d[o + X]
      let y = d[o + Y]
      let tx = d[o + TX]
      let ty = d[o + TY]
      if ((s.turbulence > 0 || s.sway > 0) && (this.step + id) % AIR_EVERY === 0) {
        tx = this.airX(id, x, y, time)
        ty = this.airY(x, y, time)
      }
      const ax = s.wind + tx
      const ay = s.gravity + ty
      vx = (vx + ax * DT) * this.damp
      vy = (vy + ay * DT) * this.damp
      x += vx * DT
      y += vy * DT
      if (x < bx0 || x > bx1 || y < by0 || y > by1) continue
      const t = w * STRIDE
      d[t + X] = x
      d[t + Y] = y
      d[t + VX] = vx
      d[t + VY] = vy
      d[t + AGE] = age
      d[t + ID] = id
      d[t + LIFE] = life
      d[t + TX] = tx
      d[t + TY] = ty
      w++
    }
    this.count = w
    this.step++
    this.stepsTaken++
    // Born over this step: the clip's rate at its own clock, and the burst when the clip starts.
    const local = this.step * DT - s.prerun
    const rate = Math.max(0, num(s.rate, Math.max(0, local), this.length, 0))
    // Thinned to what the cap holds over a life, so a rate past it stays even rather than leaving a gap at the emitter.
    const held = Math.min(1, s.max / Math.max(1, rate * s.life))
    this.carry += rate * held * DT
    let n = Math.floor(this.carry)
    this.carry -= n
    if (this.step === Math.max(1, this.burstStep)) n += s.burst
    for (let k = 0; k < n; k++) {
      const id = this.born++
      if (this.count >= s.max) continue
      // Born at an even spread across the step, so a point's particles leave in a stream rather than in clumps.
      this.spawn(id, ((k + 0.5) / Math.max(1, n)) * DT)
    }
    if (this.step % this.every === 0 && !this.saved.has(this.step)) {
      this.saved.set(this.step, this.snapshot())
      this.highest = Math.max(this.highest, this.step)
    }
  }

  /** How long a particle lives, from its number. */
  lifeOf(id: number): number {
    return Math.max(DT, varied(this.s.life, this.s.variance, rand(this.s.seed, id, R.life), 0.5))
  }

  private spawn(id: number, age: number): void {
    const s = this.s
    const r = (slot: number): number => rand(s.seed, id, slot)
    const [x0, y0, x1, y1] = s.area
    let x = 0
    let y = 0
    let dir = s.direction
    switch (s.emitter) {
      case 'point':
        x = ((x0 + x1) / 2) * this.w
        y = ((y0 + y1) / 2) * this.h
        break
      case 'line': {
        const f = r(R.where)
        x = (x0 + (x1 - x0) * f) * this.w
        y = (y0 + (y1 - y0) * f) * this.h
        break
      }
      case 'box':
        x = (x0 + (x1 - x0) * r(R.where)) * this.w
        y = (y0 + (y1 - y0) * r(R.where2)) * this.h
        break
      case 'text': {
        const p = this.letters ? pointAlong(this.letters, r(R.where)) : null
        x = p ? p[0] : ((x0 + x1) / 2) * this.w
        y = p ? p[1] : ((y0 + y1) / 2) * this.h
        break
      }
      case 'edge': {
        // Just outside the frame, along a little more than the edge, so wind and a slant still fill the corners.
        const out = s.size * 0.6 + s.speed * s.stretch
        const along = -0.15 + 1.3 * r(R.where)
        let side = s.edge
        if (side === 'around') {
          const per = 2 * (this.w + this.h)
          const at = r(R.side) * per
          side = at < this.w ? 'top' : at < 2 * this.w ? 'bottom' : at < 2 * this.w + this.h ? 'left' : 'right'
          // Around the frame, each comes inward.
          dir = side === 'top' ? 90 : side === 'bottom' ? -90 : side === 'left' ? 0 : 180
        }
        if (side === 'top' || side === 'bottom') {
          x = along * this.w
          y = side === 'top' ? -out : this.h + out
        } else {
          y = along * this.h
          x = side === 'left' ? -out : this.w + out
        }
        break
      }
    }
    const angle = ((dir + (r(R.angle) - 0.5) * s.spread) * Math.PI) / 180
    const speed = Math.max(0, varied(s.speed, s.variance, r(R.speed), 0.6))
    const vx = Math.cos(angle) * speed
    const vy = Math.sin(angle) * speed
    const o = this.count * STRIDE
    const d = this.data
    d[o + X] = x + vx * age
    d[o + Y] = y + vy * age
    d[o + VX] = vx
    d[o + VY] = vy
    d[o + AGE] = age
    d[o + ID] = id
    d[o + LIFE] = this.lifeOf(id)
    // The air's push from where it is born, until its first turn comes.
    d[o + TX] = this.airX(id, x, y, this.step * DT)
    d[o + TY] = this.airY(x, y, this.step * DT)
    this.count++
  }

  /**
   * The air across: the turbulence where it is, which every particle there
   * shares, and its own sway, which it does not, so a fall of snow drifts
   * about without gathering into streams.
   */
  private airX(id: number, x: number, y: number, time: number): number {
    const s = this.s
    const swirl = Math.max(1, s.swirl)
    let a = s.turbulence > 0 ? turbulence(x / swirl, y / swirl, s.seed * 7 + 1, 2, time * 0.3) * s.turbulence : 0
    if (s.sway > 0) a += wiggle(time, 0.35 + 0.4 * rand(s.seed, id, R.spin), Math.floor(rand(s.seed, id, R.phase) * 1e9)) * s.sway
    return a
  }

  private airY(x: number, y: number, time: number): number {
    const s = this.s
    const swirl = Math.max(1, s.swirl)
    return s.turbulence > 0 ? turbulence(x / swirl + 31.7, y / swirl - 12.3, s.seed * 7 + 2, 2, time * 0.3) * s.turbulence : 0
  }
}

/** Particle systems kept between frames, by what they are: a few, the most recently drawn. */
const kept = new Map<string, ParticleSim>()
const KEEP = 8

/** The system for these settings, kept from the last frame that drew it, or a new one. */
export function simFor(key: string, settings: ParticleSettings, frame: { width: number; height: number }, length: number): ParticleSim {
  let sim = kept.get(key)
  if (sim) {
    kept.delete(key)
    kept.set(key, sim)
    return sim
  }
  sim = new ParticleSim(settings, frame, length)
  kept.set(key, sim)
  while (kept.size > KEEP) kept.delete(kept.keys().next().value as string)
  return sim
}

/** Every kept system dropped, for tests that start afresh. */
export function forgetParticles(): void {
  kept.clear()
}
