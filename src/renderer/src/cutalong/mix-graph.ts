import { useCallback, useEffect, useMemo, useRef } from 'react'
import { num } from '../../../shared/anim'
import { activeEffects, heardOf, isNeutral, reverbImpulse, stripsOf, type AudioFx, type MixCut, type Strip } from '../../../shared/mix'

/**
 * The mixer in the preview: a Web Audio graph over the preview's own media
 * (the decks, the music bed, the layer tracks' hidden media). Each strip is
 * a bus: its effects in order, then its fader and its pan, into the
 * speakers. The export is the reference (main/render/mix); this is close to
 * it. The EQ, the filters, the pan and the room are the export's own (the
 * same biquads, the same pan law, the same reflections); the compressor and
 * the limiter are Web Audio's; the gate and the noise reduction are heard in
 * the export only, and the de-esser is a gentle cut of the esses' band.
 *
 * An element is routed once (createMediaElementSource takes it for good),
 * and only once its strip changes anything, so a preview nobody mixed plays
 * exactly as it always has. Media this page cannot read (from another origin
 * without CORS) is never routed: Web Audio would hear it as silence. It
 * keeps playing at its own volume, which its player scales by the strip's
 * fader (`fallback`).
 */

/** Effects the preview cannot play, heard in the export only. */
export const EXPORT_ONLY: ReadonlySet<AudioFx['kind']> = new Set(['gate', 'noise'])

const lin = (db: number): number => Math.pow(10, db / 20)

/** Whether Web Audio may read an element: CORS asked for and given, or from this page's own origin. */
export function readable(el: HTMLMediaElement): boolean {
  const src = el.currentSrc || el.src
  if (!src) return false
  if (el.crossOrigin === 'anonymous' || el.crossOrigin === 'use-credentials') return true
  if (src.startsWith('data:') || src.startsWith('blob:')) return true
  try {
    return new URL(src, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

interface Chain {
  input: AudioNode
  output: AudioNode
  nodes: AudioNode[]
}

/** Chrome's compressor raises its output by its own makeup gain; this takes it back off, as near as can be said. */
const autoMakeupDb = (thresholdDb: number, ratio: number): number => -0.6 * -thresholdDb * (1 - 1 / ratio)

function effectChain(ctx: AudioContext, fx: AudioFx): Chain | null {
  const biquad = (type: BiquadFilterType, freq: number, q: number, gain = 0): BiquadFilterNode => {
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    f.gain.value = gain
    return f
  }
  const line = (nodes: AudioNode[]): Chain => {
    for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i])
    return { input: nodes[0], output: nodes[nodes.length - 1], nodes }
  }
  // Web Audio's high- and low-pass take Q as a resonance in dB: -3.01 dB is the export's Butterworth 0.707.
  const BUTTERWORTH_DB = 20 * Math.log10(Math.SQRT1_2)
  switch (fx.kind) {
    case 'eq':
      return line(
        fx.bands.map((b) =>
          b.type === 'notch'
            ? biquad('notch', b.freq, b.q)
            : b.type === 'peak'
              ? biquad('peaking', b.freq, b.q, b.gainDb)
              : biquad(b.type, b.freq, 0, b.gainDb)
        )
      )
    case 'highpass':
      return line([biquad('highpass', fx.freq, BUTTERWORTH_DB)])
    case 'lowpass':
      return line([biquad('lowpass', fx.freq, BUTTERWORTH_DB)])
    case 'compressor':
    case 'limiter': {
      const c = ctx.createDynamicsCompressor()
      const threshold = fx.kind === 'compressor' ? fx.thresholdDb : fx.ceilingDb
      const ratio = fx.kind === 'compressor' ? fx.ratio : 20
      c.threshold.value = threshold
      c.ratio.value = ratio
      // ffmpeg's knee, 2.83 as a ratio, is 9 dB; a limiter has none.
      c.knee.value = fx.kind === 'compressor' ? 9 : 0
      c.attack.value = fx.kind === 'compressor' ? fx.attackMs / 1000 : 0.005
      c.release.value = fx.releaseMs / 1000
      const makeup = ctx.createGain()
      makeup.gain.value = lin((fx.kind === 'compressor' ? fx.makeupDb : 0) + autoMakeupDb(threshold, ratio))
      return line([c, makeup])
    }
    case 'deesser':
      return line([biquad('peaking', 7000, 1.2, -8 * fx.amount)])
    case 'reverb':
    case 'delay': {
      const input = ctx.createGain()
      const dry = ctx.createGain()
      const wet = ctx.createGain()
      const output = ctx.createGain()
      dry.gain.value = 1 - fx.mix
      wet.gain.value = fx.mix
      input.connect(dry).connect(output)
      const nodes: AudioNode[] = [input, dry, wet, output]
      if (fx.kind === 'reverb') {
        // The export's own reflections, as an impulse at this context's rate.
        const ir = reverbImpulse(fx.room, ctx.sampleRate)
        const buffer = ctx.createBuffer(2, ir.length, ctx.sampleRate)
        buffer.getChannelData(0).set(ir)
        buffer.getChannelData(1).set(ir)
        const conv = ctx.createConvolver()
        conv.normalize = false
        conv.buffer = buffer
        input.connect(conv).connect(wet)
        nodes.push(conv)
      } else {
        const delay = ctx.createDelay(2.5)
        delay.delayTime.value = fx.timeMs / 1000
        const feedback = ctx.createGain()
        feedback.gain.value = fx.feedback
        input.connect(delay)
        delay.connect(feedback).connect(delay)
        delay.connect(wet)
        nodes.push(delay, feedback)
      }
      wet.connect(output)
      return { input, output, nodes }
    }
    default:
      // The gate and the noise reduction: in the export only.
      return null
  }
}

/** One strip in the preview: what comes in, its effects, its fader, its pan. */
class Bus {
  readonly input: GainNode
  readonly fader: GainNode
  readonly panner: StereoPannerNode
  private chain: Chain[] = []
  private said = ''

  constructor(private readonly ctx: AudioContext) {
    this.input = ctx.createGain()
    // Every sound in as two channels, as the export takes it, so a mono file pans as a stereo one does there.
    this.input.channelCount = 2
    this.input.channelCountMode = 'explicit'
    this.input.channelInterpretation = 'speakers'
    this.fader = ctx.createGain()
    this.panner = ctx.createStereoPanner()
    this.fader.connect(this.panner).connect(ctx.destination)
    this.input.connect(this.fader)
  }

  /** The effects, rebuilt only when they change. */
  setEffects(effects: AudioFx[]): void {
    const said = JSON.stringify(effects)
    if (said === this.said) return
    this.said = said
    this.input.disconnect()
    for (const c of this.chain) for (const n of c.nodes) n.disconnect()
    this.chain = effects.map((fx) => effectChain(this.ctx, fx)).filter((c): c is Chain => c !== null)
    let at: AudioNode = this.input
    for (const c of this.chain) {
      at.connect(c.input)
      at = c.output
    }
    at.connect(this.fader)
  }

  set(gain: number, pan: number): void {
    const now = this.ctx.currentTime
    // A short glide, so a fader moved while it plays does not click.
    this.fader.gain.setTargetAtTime(gain, now, 0.01)
    this.panner.pan.setTargetAtTime(Math.min(1, Math.max(-1, pan)), now, 0.01)
  }
}

export interface MixGraph {
  /**
   * Routes an element through a strip ("voice", "music" or a track's id), at
   * its own pan (a clip's, -1 to 1) when it has one; false when it cannot be,
   * and plays as it is.
   */
  route(el: HTMLMediaElement | null | undefined, target: string, pan?: number): boolean
  /** The strip's fader as a volume, for media that could not be routed: 0 when it is not heard. */
  fallback(target: string, time: number): number
}

/**
 * The preview's mixer for a cut, kept on the player's moment. The context
 * and the routing last as long as the editor does; the strips follow the cut.
 */
export function useMixGraph(cut: MixCut, durationSec: number, time: number, playing: boolean): MixGraph {
  const ctx = useRef<AudioContext | null>(null)
  const buses = useRef(new Map<string, Bus>())
  const routed = useRef(new WeakMap<HTMLMediaElement, { node: MediaElementAudioSourceNode; panner: StereoPannerNode; target: string }>())
  const strips = useMemo(() => {
    const heard = heardOf(cut)
    const byTarget = new Map<string, Strip & { heard: boolean }>()
    for (const s of stripsOf(cut)) {
      const track = cut.tracks?.find((t) => t.id === s.target)
      byTarget.set(s.target, { ...s, heard: s.kind === 'voice' ? heard.voice : s.kind === 'music' ? heard.music : !!track && heard.track(track) })
    }
    return byTarget
  }, [cut])
  const live = useRef(strips)
  live.current = strips
  const now = useRef(time)
  now.current = time

  const levelAt = useCallback(
    (s: (Strip & { heard: boolean }) | undefined, t: number): { gain: number; pan: number } => {
      if (!s) return { gain: 1, pan: 0 }
      if (!s.heard) return { gain: 0, pan: 0 }
      return { gain: lin(num(s.mix.gainDb, t, durationSec, 0)), pan: num(s.mix.pan, t, durationSec, 0) }
    },
    [durationSec]
  )
  const levelOf = useRef(levelAt)
  levelOf.current = levelAt

  const busFor = useCallback((target: string): Bus | null => {
    if (!ctx.current) {
      try {
        ctx.current = new AudioContext()
      } catch {
        return null
      }
    }
    let bus = buses.current.get(target)
    if (!bus) {
      bus = new Bus(ctx.current)
      buses.current.set(target, bus)
      // As the strip is now, before anything plays through it.
      const s = live.current.get(target)
      bus.setEffects(s ? activeEffects(s.mix.effects) : [])
      const { gain, pan } = levelOf.current(s, now.current)
      bus.set(gain, pan)
    }
    return bus
  }, [])

  const route = useCallback(
    (el: HTMLMediaElement | null | undefined, target: string, pan = 0): boolean => {
      if (!el) return false
      const was = routed.current.get(el)
      if (was) {
        if (was.target !== target) {
          const bus = busFor(target)
          if (!bus) return false
          was.panner.disconnect()
          was.panner.connect(bus.input)
          was.target = target
        }
        if (Math.abs(was.panner.pan.value - pan) > 1e-4) was.panner.pan.setTargetAtTime(Math.min(1, Math.max(-1, pan)), was.panner.context.currentTime, 0.01)
        return true
      }
      // Nothing to do for a sound nobody mixed: the element plays as it always has.
      const s = live.current.get(target)
      if (!s || (isNeutral(s.mix) && s.heard && Math.abs(pan) < 1e-4)) return false
      if (!readable(el)) return false
      const bus = busFor(target)
      if (!bus || !ctx.current) return false
      try {
        const node = ctx.current.createMediaElementSource(el)
        // Its own place between the speakers, before the strip's: a stereo panner on two channels, as the export pans.
        const panner = ctx.current.createStereoPanner()
        panner.channelCount = 2
        panner.channelCountMode = 'explicit'
        panner.pan.value = Math.min(1, Math.max(-1, pan))
        node.connect(panner).connect(bus.input)
        routed.current.set(el, { node, panner, target })
        return true
      } catch {
        return false
      }
    },
    [busFor]
  )

  // Each strip's effects, as the cut has them.
  useEffect(() => {
    for (const [target, bus] of buses.current) {
      const s = strips.get(target)
      bus.setEffects(s ? activeEffects(s.mix.effects) : [])
    }
  }, [strips])

  // Each strip's fader and pan on the player's moment.
  useEffect(() => {
    for (const [target, bus] of buses.current) {
      const { gain, pan } = levelAt(strips.get(target), time)
      bus.set(gain, pan)
    }
  }, [strips, time, levelAt])

  // Sound only starts once the page has been touched: playing is that touch.
  useEffect(() => {
    if (playing && ctx.current?.state === 'suspended') void ctx.current.resume().catch(() => undefined)
  }, [playing])

  // Closed when the editor goes, and not when React only tries unmounting it (StrictMode mounts it again at once).
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    const c = ctx
    return () => {
      mounted.current = false
      setTimeout(() => {
        if (mounted.current) return
        void c.current?.close().catch(() => undefined)
        c.current = null
      }, 0)
    }
  }, [])

  const fallback = useCallback(
    (target: string, t: number): number => Math.min(1, levelAt(live.current.get(target), t).gain),
    [levelAt]
  )
  return useMemo(() => ({ route, fallback }), [route, fallback])
}
