import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut, type EditDoc, type Op } from '../shared/edit'
import { AudioFxSchema, defaultFx, FX_KINDS, type AudioFx } from '../shared/mix'
import { DEFAULT_TREATMENT } from '../shared/edit'
import { buildRenderArgs, renderCut, type Segment } from './cut-render'
import { clipSounds } from './layer-sounds'
import { missingOnPhone } from './render/lgpl'
import { busChains, effectChains, fxChains, levelFilters, mixPlan, movingPan, panFilter } from './render/mix'
import { ffmpegRun, findFfmpeg, makeColourClip, meanLevel, toneLevel } from './test-media'

/**
 * The mixer in the export: the filters each effect becomes, then whole
 * renders read back from the file. A track's fader is heard as its tone's
 * level, pan as one side against the other, an EQ as one tone taken down
 * beside another left alone, a reverb as a tail after its sound stops, an
 * echo as repeats where they fall, mute and solo as what is left.
 */

const fx = (raw: unknown): AudioFx => AudioFxSchema.parse(raw)

describe('the filters each effect becomes', () => {
  it('writes every effect, fader and pan as filters the phone has too', () => {
    const chains = FX_KINDS.flatMap((kind) => fxChains(defaultFx(kind), 'in', 'out'))
    const moving = { gainDb: 0, gainKeys: [{ t: 0, v: 0 }, { t: 1, v: -6 }], pan: 0, panKeys: [{ t: 0, v: -1 }, { t: 1, v: 1 }], effects: [], silent: false }
    chains.push(`[a]${levelFilters(moving).join(',')}[b]`, `[c]${panFilter(0.4)}[d]`)
    expect(missingOnPhone(['-filter_complex', chains.join(';')])).toEqual([])
  })

  it('writes the EQ band by band, with shelves at a slope of one and a notch as a band rejected', () => {
    const eq = fx({
      kind: 'eq',
      bands: [
        { type: 'peak', freq: 3000, gainDb: -6, q: 2 },
        { type: 'lowshelf', freq: 120, gainDb: 3 },
        { type: 'highshelf', freq: 8000, gainDb: -2 },
        { type: 'notch', freq: 60, q: 10 }
      ]
    })
    expect(fxChains(eq, 'a', 'b')).toEqual([
      '[a]equalizer=f=3000.0:t=q:w=2.000:g=-6.00,lowshelf=f=120.0:t=s:w=1:g=3.00,highshelf=f=8000.0:t=s:w=1:g=-2.00,bandreject=f=60.0:t=q:w=10.000[b]'
    ])
  })

  it('gives ffmpeg its levels as it wants them: the compressor and gate in linear terms', () => {
    expect(fxChains(fx({ kind: 'compressor', thresholdDb: -20, ratio: 4, makeupDb: 6 }), 'a', 'b')[0]).toBe(
      '[a]acompressor=threshold=0.100000:ratio=4.00:attack=10.00:release=150.0:makeup=1.995262[b]'
    )
    expect(fxChains(fx({ kind: 'gate', thresholdDb: -40, rangeDb: -20 }), 'a', 'b')[0]).toBe(
      '[a]agate=threshold=0.010000:ratio=10:range=0.100000:attack=5.00:release=200.0[b]'
    )
    expect(fxChains(fx({ kind: 'highpass', freq: 100 }), 'a', 'b')[0]).toBe('[a]highpass=f=100.0:poles=2:t=q:w=0.707[b]')
    expect(fxChains(fx({ kind: 'lowpass', freq: 6000 }), 'a', 'b')[0]).toBe('[a]lowpass=f=6000.0:poles=2:t=q:w=0.707[b]')
    expect(fxChains(fx({ kind: 'deesser', amount: 0.6 }), 'a', 'b')[0]).toBe('[a]deesser=i=0.600:m=0.600:f=0.5:s=o[b]')
  })

  it('takes back off the front what afftdn and alimiter hand back late', () => {
    expect(fxChains(fx({ kind: 'noise', reduceDb: 18 }), 'a', 'b')[0]).toBe(
      '[a]afftdn=nr=18.0:nf=-50.0:tn=1,atrim=start=0.025,asetpts=PTS-STARTPTS[b]'
    )
    expect(fxChains(fx({ kind: 'limiter', ceilingDb: -3 }), 'a', 'b')[0]).toBe(
      '[a]alimiter=limit=0.707946:level=false:attack=5:release=50.0,atrim=start_sample=240,asetpts=PTS-STARTPTS[b]'
    )
  })

  it('writes an echo as its repeats, and a reverb as four stages of reflections mixed under the sound', () => {
    expect(fxChains(fx({ kind: 'delay', timeMs: 300, feedback: 0.5, mix: 0.4 }), 'a', 'b')[0]).toMatch(
      /^\[a\]aecho=in_gain=0\.600000:out_gain=1:delays=300\.0\|600\.0\|900\.0.*:decays=0\.400000\|0\.200000\|0\.100000/
    )
    const reverb = fxChains(fx({ kind: 'reverb', room: 0.5, mix: 0.3 }), 'a', 'b')
    expect(reverb[0]).toBe('[a]asplit=2[bd][bw]')
    expect(reverb[1].match(/aecho=/g)).toHaveLength(4)
    expect(reverb[1]).toMatch(/^\[bw\]aecho=in_gain=0:out_gain=1:/)
    expect(reverb[2]).toBe('[bd]volume=0.700000[bs]')
    expect(reverb[3]).toBe('[bs][br]amix=inputs=2:duration=first:normalize=0[b]')
  })

  it('pans as Web Audio does, and moves the pan along its keys', () => {
    expect(panFilter(-1)).toBe('pan=stereo|c0=1.000000*c0+1.000000*c1|c1=0*c0+0*c1')
    expect(panFilter(0.5)).toBe('pan=stereo|c0=0.707107*c0+0*c1|c1=0.707107*c0+1.000000*c1')
    const moving = movingPan([{ t: 1, v: -1 }, { t: 3, v: 1 }])
    expect(moving).toMatch(/^aeval=exprs='st\(0,if\(lt\(t,1\.000000\)/)
    // Each channel's expression works the pan out for itself.
    expect(moving.split('|').filter((e) => e.includes('st(0,'))).toHaveLength(2)
  })

  it('leaves out what changes nothing, mutes with a zero level, and chains a strip in order', () => {
    expect(levelFilters({ gainDb: 0, gainKeys: [], pan: 0, panKeys: [], effects: [], silent: false })).toEqual([])
    expect(levelFilters({ gainDb: -6, gainKeys: [], pan: 0, panKeys: [], effects: [], silent: true })).toEqual(['volume=0'])
    expect(levelFilters({ gainDb: 0, gainKeys: [{ t: 0, v: 0 }, { t: 2, v: -12 }], pan: 0, panKeys: [], effects: [], silent: false })[0]).toBe(
      'asetnsamples=n=480'
    )
    expect(effectChains([], 'a', 'b', 4)).toEqual([])
    const plan = { gainDb: -3, gainKeys: [], pan: 0, panKeys: [], effects: [defaultFx('highpass')], silent: false }
    expect(busChains(plan, 'in', 'out', 4)).toEqual([
      '[in]highpass=f=80.0:poles=2:t=q:w=0.707[outfxe0]',
      '[outfxe0]apad,atrim=duration=4.000000[outfx]',
      '[outfx]volume=-3.00dB[out]'
    ])
  })
})

describe('the mixer in the export’s sound chain', () => {
  const seg: Segment = { path: '/a.mov', startSec: 1, durationSec: 2, hasAudio: true, treatment: { ...DEFAULT_TREATMENT }, broll: null }
  const opts = { width: 540, height: 960, fps: 30, assPath: null, fontsDir: null, quality: 'preview' as const, outputPath: '/out.mp4' }
  const graph = (args: string[]): string => args[args.indexOf('-filter_complex') + 1]
  const plan = (over: Record<string, unknown>) => ({ gainDb: 0, gainKeys: [], pan: 0, panKeys: [], effects: [], silent: false, ...over })

  it('runs the voice’s effects after its polish and before its loudness, and its fader after, then a limiter last', () => {
    const fx = graph(
      buildRenderArgs([seg], {
        ...opts,
        loudness: -14,
        voice: 0.5,
        mix: { voice: plan({ gainDb: 4, pan: 0.3, effects: [defaultFx('highpass')] }), music: null, tracks: {} }
      })
    )
    const at = (part: string): number => fx.indexOf(part)
    expect(at('[avoice]')).toBeGreaterThan(0)
    expect(at('[avoice]highpass')).toBeGreaterThan(at('[avoice]'))
    expect(at('loudnorm')).toBeGreaterThan(at('[avoice]highpass'))
    expect(at('volume=4.00dB,pan=stereo')).toBeGreaterThan(at('loudnorm'))
    // Nothing after the fader catches its peaks but the limiter it gets.
    expect(fx).toMatch(/\[avlevel\]alimiter=limit=0\.84.*\[amaster\];\[amaster\]aformat/)
  })

  it('leaves a cut nobody mixed exactly as it was, and puts the music’s strip after its own level and fades', () => {
    const music = { path: '/bed.mp3', inSec: 0, gainDb: -20, keys: [], fadeInSec: 1, fadeOutSec: 1 }
    const plain = graph(buildRenderArgs([seg], { ...opts, loudness: -14, music }))
    expect(plain).not.toMatch(/avfx|avlevel|amaster|abedmix/)
    const mixed = graph(buildRenderArgs([seg], { ...opts, loudness: -14, music, mix: { voice: null, music: plan({ silent: false, gainDb: -3, effects: [defaultFx('lowpass')] }), tracks: {} } }))
    expect(mixed).toMatch(/afade=t=out[^;]*\[abed\];\[abed\]lowpass=.*\[abedmixfx\];\[abedmixfx\]volume=-3\.00dB\[abedmix\];\[aloud\]\[abedmix\]amix/)
    // A muted bed is not read at all.
    const muted = buildRenderArgs([seg], { ...opts, loudness: -14, music, mix: { voice: null, music: plan({ silent: true }), tracks: {} } })
    expect(muted).not.toContain('/bed.mp3')
  })
})

const FFMPEG = findFfmpeg()

/** The level of one tone on one side, in dB. */
const sideLevel = (ffmpeg: string, path: string, start: number, dur: number, hz: number, ch: 0 | 1): number =>
  meanLevel(ffmpeg, path, start, dur, `pan=mono|c0=c${ch},bandpass=f=${hz}:width_type=q:w=12,bandpass=f=${hz}:width_type=q:w=12`)

describe.skipIf(!FFMPEG)('the mixer in a whole export', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  const tone = (name: string, spec: string, sec = 4): string => {
    const path = join(dir, `${name}.wav`)
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', `${spec}:sample_rate=48000:duration=${sec}`, path])
    return path
  }

  /** The edit with these ops, exported; the file's path. */
  const render = async (name: string, ops: Op[]): Promise<{ out: string; cut: Cut }> => {
    const r = applyOps(currentCut(doc), [{ op: 'aspect', aspect: 'original' }, { op: 'captions', set: { on: false } }, { op: 'loudness', lufs: null }, ...ops], doc)
    expect(r.rejected).toEqual([])
    const cut = r.cut
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const sources = doc.sources.map((s) => ({ ...s, hasAudio: true }))
    const sounds = await clipSounds({ cut, resolved, words: doc.words, sources }, async () => true)
    const out = await renderCut(cut, resolved, sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'preview',
      layers: { overlays: [], sounds }
    })
    return { out, cut }
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-mix-'))
    // The edit's own sound: four seconds of a 440 Hz tone, the voice.
    const base = { id: 's1', path: join(dir, 'base.mp4'), durationSec: 4, width: 320, height: 180, fps: 30 }
    makeColourClip(ffmpeg, base.path, [{ color: '0x808080', hz: 440, sec: 4 }])
    const words = wordsFromTranscript(
      ['one', 'two', 'three', 'four', 'five', 'six'].map((text, i) => ({ text, startSec: 0.2 + i * 0.6, endSec: 0.6 + i * 0.6 })),
      's1'
    )
    doc = createDoc({ id: 'd', title: 'Mix', source: base, words })
  }, 60_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('sets each track at its fader, pans it, and takes one tone down with an EQ beside one left alone', async () => {
    const a = tone('a', 'sine=frequency=1000')
    const b = tone('b', 'sine=frequency=2500')
    const c = tone('c', 'sine=frequency=1500')
    // 700 Hz and 3000 Hz together, so the EQ's work is one against the other.
    const pair = join(dir, 'pair.wav')
    ffmpegRun(ffmpeg, [
      '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=3000:sample_rate=48000:duration=4',
      '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0', pair
    ])
    const { out, cut } = await render('levels', [
      { op: 'clip-add', kind: 'sound', src: a, from: 'start', to: '4s' },
      { op: 'clip-add', kind: 'sound', src: b, from: 'start', to: '4s', track: 't1' },
      { op: 'track-add', kind: 'sound' },
      { op: 'clip-add', kind: 'sound', src: b, from: 'start', to: '4s', track: 't2' },
      { op: 'track-update', track: 't1', name: 'One' },
      { op: 'track-add', kind: 'sound' },
      { op: 'clip-add', kind: 'sound', src: c, from: 'start', to: '4s', track: 't3' },
      { op: 'track-add', kind: 'sound' },
      { op: 'clip-add', kind: 'sound', src: pair, from: 'start', to: '4s', track: 't4' },
      // t1 holds 1000 Hz and 2500 Hz as they are; t2 2500 Hz 12 dB down: so 2500 Hz is t1's and t2's together.
      { op: 'mix', target: 't2', gainDb: -12 },
      // t3, 1500 Hz, hard left for its first two seconds, then swung right.
      { op: 'mix', target: 't3', pan: { keys: [{ t: 0, v: -1 }, { t: 2, v: -1, ease: 'hold' }, { t: 2.01, v: 1 }] } },
      // t4: 3000 Hz cut 18 dB by a narrow band; 700 Hz left as it is.
      { op: 'mix', target: 't4', effects: [{ kind: 'eq', bypass: false, bands: [{ type: 'peak', freq: 3000, gainDb: -18, q: 4 }] }] },
      // The voice 10 dB down.
      { op: 'mix', target: 'voice', gainDb: -10 }
    ] as Op[])
    expect(Object.keys(mixPlan(cut, 4)?.tracks ?? {})).toEqual(['t2', 't3', 't4'])

    // 1000 Hz plays as recorded on t1 alongside the 2500 Hz there (0 dB) and on t2 (-12 dB): 20·log10(1 + 0.251) = +1.95 dB.
    const one = toneLevel(ffmpeg, out, 0.5, 1, 1000)
    const both = toneLevel(ffmpeg, out, 0.5, 1, 2500)
    expect(both - one).toBeGreaterThan(1.2)
    expect(both - one).toBeLessThan(2.7)

    // Hard left: the left side has it, the right does not. Swung right: the other way.
    expect(sideLevel(ffmpeg, out, 0.5, 1, 1500, 0) - sideLevel(ffmpeg, out, 0.5, 1, 1500, 1)).toBeGreaterThan(30)
    expect(sideLevel(ffmpeg, out, 2.5, 1, 1500, 1) - sideLevel(ffmpeg, out, 2.5, 1, 1500, 0)).toBeGreaterThan(30)

    // The band takes 3000 Hz down about 18 dB against 700 Hz, which were the same level.
    const kept = toneLevel(ffmpeg, out, 0.5, 2, 700)
    const cutDown = toneLevel(ffmpeg, out, 0.5, 2, 3000)
    expect(kept - cutDown).toBeGreaterThan(14)
    expect(kept - cutDown).toBeLessThan(22)

    // The voice, 10 dB under the 1000 Hz tone it was level with (a sine at the same strength, in both).
    const voice = toneLevel(ffmpeg, out, 0.5, 1, 440)
    expect(one - voice).toBeGreaterThan(7)
    expect(one - voice).toBeLessThan(13)
  }, 120_000)

  it('moves a fader along its keys, and silences what is muted or not soloed', async () => {
    const a = tone('fade', 'sine=frequency=1000')
    const b = tone('solo', 'sine=frequency=2500')
    const { out } = await render('keys', [
      { op: 'clip-add', kind: 'sound', src: a, from: 'start', to: '4s' },
      { op: 'track-add', kind: 'sound' },
      { op: 'clip-add', kind: 'sound', src: b, from: 'start', to: '4s', track: 't2' },
      // t1 down 24 dB from 2 s on, over a fifth of a second.
      { op: 'mix', target: 't1', gainDb: { keys: [{ t: 1.9, v: 0 }, { t: 2.1, v: -24 }] } },
      { op: 'mix', target: 'voice', mute: true }
    ] as Op[])
    const early = toneLevel(ffmpeg, out, 0.5, 1, 1000)
    const late = toneLevel(ffmpeg, out, 2.5, 1, 1000)
    expect(early - late).toBeGreaterThan(20)
    expect(early - late).toBeLessThan(28)
    expect(toneLevel(ffmpeg, out, 0.5, 1, 440)).toBeLessThan(-70)
    expect(toneLevel(ffmpeg, out, 0.5, 1, 2500)).toBeGreaterThan(-40)

    const soloed = await render('solo', [
      { op: 'clip-add', kind: 'sound', src: a, from: 'start', to: '4s' },
      { op: 'track-add', kind: 'sound' },
      { op: 'clip-add', kind: 'sound', src: b, from: 'start', to: '4s', track: 't2' },
      { op: 'mix', target: 't2', solo: true }
    ] as Op[])
    expect(toneLevel(ffmpeg, soloed.out, 0.5, 1, 2500)).toBeGreaterThan(-40)
    expect(toneLevel(ffmpeg, soloed.out, 0.5, 1, 1000)).toBeLessThan(-70)
    expect(toneLevel(ffmpeg, soloed.out, 0.5, 1, 440)).toBeLessThan(-70)
  }, 120_000)

  it('leaves a room ringing after its sound stops, and repeats an echo where it falls', async () => {
    const blip = tone('blip', 'sine=frequency=1000', 0.3)
    const ping = tone('ping', 'sine=frequency=2500', 0.1)
    const { out } = await render('room', [
      { op: 'mix', target: 'voice', mute: true },
      { op: 'clip-add', kind: 'sound', src: blip, from: 'start+0.5', to: '0.3s' },
      { op: 'mix', target: 't1', effects: [{ kind: 'reverb', bypass: false, room: 0.8, mix: 0.5 }] },
      { op: 'track-add', kind: 'sound' },
      { op: 'clip-add', kind: 'sound', src: ping, from: 'start+2', to: '0.1s', track: 't2' },
      { op: 'mix', target: 't2', effects: [{ kind: 'delay', bypass: false, timeMs: 400, feedback: 0.5, mix: 0.5 }] }
    ] as Op[])
    // The room, still heard half a second after the blip stopped, and dying away.
    const tail = toneLevel(ffmpeg, out, 1.0, 0.3, 1000)
    const later = toneLevel(ffmpeg, out, 1.6, 0.3, 1000)
    expect(tail).toBeGreaterThan(-60)
    expect(tail).toBeGreaterThan(later)
    // The ping at 2 s, the first repeat 0.4 s on, and nothing between.
    expect(toneLevel(ffmpeg, out, 2.4, 0.1, 2500)).toBeGreaterThan(-50)
    expect(toneLevel(ffmpeg, out, 2.4, 0.1, 2500) - toneLevel(ffmpeg, out, 2.22, 0.12, 2500)).toBeGreaterThan(15)
  }, 120_000)
})
