import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, savedOps, wordsFromTranscript, type Cut, type Op } from '../edit'
import { describePlan } from '../presets/plan'
import {
  defaultFx,
  delayTaps,
  FX_KINDS,
  fromMixPlannerOp,
  hasMix,
  heardOf,
  isNeutral,
  MIX_PLANNER_OPS,
  mixLines,
  mixPhrases,
  rampKeys,
  readFxSpec,
  reverbImpulse,
  roomSec,
  stripsOf,
  wantsMix
} from '.'

/**
 * The mixer's model: what the mix op does to a cut and what it refuses, which
 * strips are heard under mute and solo, the shared numbers the export and the
 * preview both play (ramps, the room, the repeats), and the planner's forms
 * through to the edit.
 */

const words = wordsFromTranscript(
  ['So', 'this', 'is', 'the', 'new', 'mic', 'and', 'it', 'sounds', 'warm'].map((text, i) => ({
    text,
    startSec: 0.2 + i * 0.4,
    endSec: 0.5 + i * 0.4
  })),
  's1'
)
const source = { id: 's1', path: '/take.mp4', durationSec: 5, width: 1080, height: 1920, fps: 30 }
const doc = createDoc({ id: 'd', title: 't', source, words })
const ctx = { words: doc.words, sources: doc.sources, assets: [{ id: 'a1', kind: 'audio', path: '/ding.wav' }] }

function run(ops: Op[], cut: Cut = currentCut(doc)) {
  const r = applyOps(cut, ops, ctx)
  return { cut: r.cut, rejected: r.rejected.map((x) => x.reason) }
}

const withSounds = (): Cut =>
  run([
    { op: 'clip-add', kind: 'sound', src: '/ding.wav', from: 'start', to: '2s' },
    { op: 'track-add', kind: 'sound' },
    { op: 'clip-add', kind: 'sound', src: '/ding.wav', from: 'w3', to: '1s', track: 't2' },
    { op: 'music', set: { path: '/bed.mp3' } }
  ] as Op[]).cut

describe('the mix op', () => {
  it('sets the voice’s level, pan and effects, and takes the strip out again once it changes nothing', () => {
    const { cut, rejected } = run([
      { op: 'mix', target: 'voice', gainDb: -3, pan: 0.2, add: [defaultFx('compressor')] }
    ] as Op[])
    expect(rejected).toEqual([])
    expect(cut.voiceMix).toMatchObject({ gainDb: -3, pan: 0.2, effects: [{ kind: 'compressor', ratio: 3 }] })
    const back = run([{ op: 'mix', target: 'voice', gainDb: 0, pan: 0, effects: [] }] as Op[], cut)
    expect(back.cut.voiceMix).toBeUndefined()
  })

  it('mixes a track by its id, the music only once there is a bed, and keeps the track’s mute and solo on the track', () => {
    const cut = withSounds()
    const r = run(
      [
        { op: 'mix', target: 't2', gainDb: { keys: [{ t: 1, v: 0 }, { t: 2, v: -12 }] }, solo: true },
        { op: 'mix', target: 'music', add: [defaultFx('lowpass')], mute: true }
      ] as Op[],
      cut
    )
    expect(r.rejected).toEqual([])
    const t2 = r.cut.tracks?.find((t) => t.id === 't2')
    expect(t2?.solo).toBe(true)
    expect(t2?.mix?.gainDb).toEqual({ keys: [{ t: 1, v: 0 }, { t: 2, v: -12 }] })
    expect(r.cut.musicMix).toMatchObject({ mute: true, effects: [{ kind: 'lowpass', freq: 12000 }] })
    expect(run([{ op: 'mix', target: 'music', gainDb: -3 }] as Op[]).rejected).toEqual([
      'There is no music to mix. Choose a track for the bed first.'
    ])
  })

  it('refuses a strip that is not there, a level past the fader, a pan past a speaker, and an effect that is not on', () => {
    const cut = withSounds()
    const refused = (op: Record<string, unknown>): string[] => run([op as Op], cut).rejected
    expect(refused({ op: 'mix', target: 't9', gainDb: -3 })).toEqual(['There is no track t9. Mix the voice, the music, or a track by its id.'])
    expect(refused({ op: 'mix', target: 'voice', gainDb: -80 })).toEqual(['A level goes from -60 dB to +12 dB. To silence a sound, mute it.'])
    expect(refused({ op: 'mix', target: 'voice', pan: { keys: [{ t: 0, v: 0 }, { t: 1, v: 1.5 }] } })).toEqual([
      'Pan goes from -1, all the way left, to 1, all the way right.'
    ])
    expect(refused({ op: 'mix', target: 't1', remove: ['reverb'] })).toEqual(['There is no reverb on it to take off.'])
    expect(refused({ op: 'mix', target: 't1', remove: [2] })).toEqual(['There is no effect 2 on it: it has none.'])
    // The cut is as it was.
    expect(run([{ op: 'mix', target: 't9', gainDb: -3 } as Op], cut).cut).toEqual(cut)
  })

  it('takes effects off by place and by kind, and puts new ones at the end', () => {
    const cut = withSounds()
    const chain = [defaultFx('highpass'), defaultFx('reverb'), defaultFx('compressor'), defaultFx('reverb')]
    const set = run([{ op: 'mix', target: 't1', effects: chain }] as Op[], cut).cut
    const r = run([{ op: 'mix', target: 't1', remove: [1, 'reverb'], add: [defaultFx('limiter')] }] as Op[], set)
    expect(r.rejected).toEqual([])
    expect(r.cut.tracks?.[0].mix?.effects.map((f) => f.kind)).toEqual(['compressor', 'limiter'])
  })

  it('pans a clip along its keys, and only a clip that sounds', () => {
    const cut = withSounds()
    const r = run(
      [
        { op: 'key-set', clip: 'c1', prop: 'pan', t: 0, v: -1 },
        { op: 'key-set', clip: 'c1', prop: 'pan', t: 1, v: 1 }
      ] as Op[],
      cut
    )
    expect(r.rejected).toEqual([])
    expect(r.cut.tracks?.[0].clips[0].pan).toEqual({ keys: [{ t: 0, v: -1 }, { t: 1, v: 1 }] })
    const titled = run([{ op: 'clip-add', kind: 'text', text: { value: 'HI' }, from: 'start', to: '1s' }] as Op[], cut).cut
    const clip = titled.tracks?.find((t) => t.kind === 'picture')?.clips[0].id as string
    expect(run([{ op: 'key-set', clip, prop: 'pan', t: 0, v: 0.5 } as Op], titled).rejected).toEqual(['A text clip has no sound to set.'])
  })

  it('is never kept in a version’s ops, so 0.2.13 still opens the edit', () => {
    expect(savedOps([{ op: 'mix', target: 'voice', gainDb: -3 } as Op, { op: 'loudness', lufs: -14 }])).toEqual([{ op: 'loudness', lufs: -14 }])
  })
})

describe('the strips and what is heard', () => {
  it('has a strip for the voice, each track that sounds and the music, and none for a track of pictures only', () => {
    const cut = run([{ op: 'clip-add', kind: 'text', text: { value: 'HI' }, from: 'start', to: '1s' } as Op], withSounds()).cut
    expect(stripsOf(cut).map((s) => `${s.kind}:${s.target}`)).toEqual(['voice:voice', 'track:t1', 'track:t2', 'music:music'])
    const video = run([{ op: 'clip-add', kind: 'video', src: '/broll.mp4', from: 'start', to: '1s', track: 't3' } as Op], cut).cut
    expect(stripsOf(video).map((s) => s.target)).toContain('t3')
  })

  it('hears only the soloed strips while any is, and none that is muted', () => {
    const cut = withSounds()
    expect(heardOf(cut)).toMatchObject({ voice: true, music: true })
    const solo = run([{ op: 'mix', target: 't2', solo: true } as Op], cut).cut
    const heard = heardOf(solo)
    expect([heard.voice, heard.music, heard.track(solo.tracks![0]), heard.track(solo.tracks![1])]).toEqual([false, false, false, true])
    const voice = run([{ op: 'mix', target: 'voice', solo: true, mute: true } as Op], cut).cut
    expect(heardOf(voice).voice).toBe(false)
    expect(heardOf(voice).music).toBe(false)
  })

  it('counts a strip with only bypassed effects as changing nothing', () => {
    expect(isNeutral({ effects: [{ ...defaultFx('reverb'), bypass: true }] })).toBe(true)
    expect(isNeutral({ effects: [defaultFx('reverb')] })).toBe(false)
    expect(isNeutral({ gainDb: { keys: [{ t: 0, v: 0 }] }, effects: [] })).toBe(false)
  })
})

describe('the numbers the export and the preview share', () => {
  it('lays keys out as straight ramps: eased stretches in pieces, a held one as a step', () => {
    expect(rampKeys(-6, 10)).toEqual([])
    expect(rampKeys({ keys: [{ t: 1, v: 0 }, { t: 2, v: -12 }] }, 10)).toEqual([
      { t: 1, v: 0 },
      { t: 2, v: -12 }
    ])
    const held = rampKeys({ keys: [{ t: 1, v: 0, ease: 'hold' }, { t: 2, v: -12 }] }, 10)
    expect(held).toEqual([
      { t: 1, v: 0 },
      { t: 1.999, v: 0 },
      { t: 2, v: -12 }
    ])
    const eased = rampKeys({ keys: [{ t: 0, v: 0, ease: 'ease-in' }, { t: 1, v: 1 }] }, 10)
    expect(eased).toHaveLength(13)
    // Easing in, it is still low halfway.
    expect(eased[6].v).toBeLessThan(0.5)
  })

  it('reads a fader or pan with an expression at twenty moments a second', () => {
    const swing = rampKeys({ keys: [], expr: 'sin(time * PI) * 6' }, 2)
    expect(swing).toHaveLength(41)
    expect(swing[0]).toEqual({ t: 0, v: 0 })
    // Half a second in, the sine is at its top.
    expect(swing[10].t).toBeCloseTo(0.5)
    expect(swing[10].v).toBeCloseTo(6)
  })

  it('rings the room for its length and brings its reflections to the level of the sound', () => {
    const rate = 48000
    for (const room of [0, 0.5, 1]) {
      const ir = reverbImpulse(room, rate)
      expect(ir.length / rate).toBeGreaterThan(roomSec(room) * 0.95)
      expect(ir.length / rate).toBeLessThan(roomSec(room) * 1.05)
      const energy = ir.reduce((s, v) => s + v * v, 0)
      expect(energy).toBeGreaterThan(0.98)
      expect(energy).toBeLessThan(1.02)
    }
  })

  it('repeats an echo until it is no longer heard', () => {
    const taps = delayTaps({ kind: 'delay', bypass: false, timeMs: 200, feedback: 0.5, mix: 0.5 })
    expect(taps[0]).toEqual({ ms: 200, g: 0.5 })
    expect(taps[1]).toEqual({ ms: 400, g: 0.25 })
    expect(taps[taps.length - 1].g).toBeGreaterThanOrEqual(0.001)
    expect(delayTaps({ kind: 'delay', bypass: false, timeMs: 200, feedback: 0, mix: 0.5 })).toHaveLength(1)
  })

  it('gives every effect usual settings that pass its own schema', () => {
    for (const kind of FX_KINDS) expect(defaultFx(kind).kind).toBe(kind)
  })
})

/** A planner form, parsed as the plan's schema parses it, as the edit takes it. */
const form = (f: Record<string, unknown>): unknown => fromMixPlannerOp(MIX_PLANNER_OPS[0].parse(f))
const blank = { set: [], keys: [], mute: '', solo: '', effects: '', spec: '' }

describe('the planner’s mix forms', () => {
  it('turns each form into the op the edit takes, and applies it', () => {
    const cut = withSounds()
    const ops = [
      form({ ...blank, op: 'mix', target: 't2', set: [{ key: 'gainDb', value: -6 }, { key: 'pan', value: -0.5 }] }),
      form({ ...blank, op: 'mix', target: 'music', keys: [{ key: 'gainDb', t: 3, v: -18 }, { key: 'gainDb', t: 1, v: 0 }] }),
      form({ ...blank, op: 'mix', target: 'voice', effects: 'add', spec: '[{"kind":"highpass","freq":90},{"kind":"deesser"}]' }),
      form({ ...blank, op: 'mix', target: 't1', effects: 'replace', spec: '{"kind":"reverb","room":0.7}' }),
      form({ ...blank, op: 'mix', target: 't1', mute: 'on' })
    ]
    expect(ops[1]).toEqual({ op: 'mix', target: 'music', gainDb: { keys: [{ t: 1, v: 0 }, { t: 3, v: -18 }] } })
    const r = run(ops as Op[], cut)
    expect(r.rejected).toEqual([])
    expect(r.cut.tracks?.[1].mix).toEqual({ gainDb: -6, pan: -0.5, effects: [] })
    expect(r.cut.voiceMix?.effects.map((f) => f.kind)).toEqual(['highpass', 'deesser'])
    expect(r.cut.tracks?.[0]).toMatchObject({ mute: true, mix: { effects: [{ kind: 'reverb', room: 0.7, mix: 0.2 }] } })
    const removed = run([form({ ...blank, op: 'mix', target: 'voice', effects: 'remove', spec: '["deesser"]' }) as Op], r.cut)
    expect(removed.cut.voiceMix?.effects.map((f) => f.kind)).toEqual(['highpass'])
  })

  it('refuses a spec it cannot read, with the reason', () => {
    expect(form({ ...blank, op: 'mix', target: 'voice', effects: 'add', spec: '{"kind":"chorus"}' })).toMatchObject({
      refused: expect.stringMatching(/^Its effects do not fit/)
    })
    expect(form({ ...blank, op: 'mix', target: 'voice', effects: 'add', spec: 'reverb please' })).toEqual({ refused: 'Its spec is not JSON.' })
    expect(form({ ...blank, op: 'mix', target: 'voice', effects: 'remove', spec: '' })).toEqual({
      refused: 'Say which effects to take off: their kinds, or their places counting from 1.'
    })
    expect(readFxSpec('').ok).toBe(true)
  })

  it('shows the strips back to the planner as lines: those mixed, or every one when the ask is about mixing', () => {
    const cut = run(
      [{ op: 'mix', target: 't2', gainDb: -6, add: [defaultFx('compressor'), { ...defaultFx('reverb'), bypass: true }] }] as Op[],
      withSounds()
    ).cut
    expect(mixLines(cut, false)).toEqual([
      't2 "Sound 2" level -6 pan 0 | effects 1 compressor -18 dB 3:1, 2 reverb room 0.5 mix 0.2 (bypassed)'
    ])
    expect(mixLines(cut, true).map((l) => l.split(' ')[0])).toEqual(['voice', 't1', 't2', 'music'])
    expect(mixLines(currentCut(doc), false)).toEqual([])
  })

  it('wants its guide for mixing words, a sound turned up or down, or a cut already mixed, and never for the plain word music', () => {
    const plain = currentCut(doc)
    const asks = (ask: string): boolean => wantsMix(ask, plain)
    expect(asks('make this an 8 minute review, start with the strongest line, cut the rambling, captions, upbeat music, chapters, and B-roll of the phone when I mention it')).toBe(false)
    expect(asks('add some music')).toBe(false)
    expect(asks('pan left across the photo')).toBe(false)
    expect(asks('make it 30 seconds')).toBe(false)
    for (const ask of [
      'put some reverb on the voice',
      'add an echo',
      'compress my voice',
      'there is a hum, take it out',
      'EQ the music so it sits under me',
      'de-ess it',
      'pan the ding to the left ear',
      'make the music quieter',
      'turn the second sound track down a bit',
      'pull the fader down',
      'mix this properly'
    ])
      expect(asks(ask), ask).toBe(true)
    const mixed = run([{ op: 'mix', target: 'voice', mute: true } as Op]).cut
    expect(hasMix(mixed)).toBe(true)
    expect(wantsMix('make it shorter', mixed)).toBe(true)
  })

  it('says what a plan did in the mixer, in the app’s voice', () => {
    expect(mixPhrases([{ op: 'mix', target: 'voice', add: [{ kind: 'compressor' }, { kind: 'eq' }] }])).toEqual(['the voice gets a compressor and an EQ'])
    expect(mixPhrases([{ op: 'mix', target: 'music', mute: true }])).toEqual(['the music is muted'])
    expect(mixPhrases([{ op: 'mix', target: 't1', gainDb: -3 }, { op: 'mix', target: 't2', pan: 0.5 }])).toEqual([
      'a track’s level changes',
      'a track moves between the speakers'
    ])
    // The Mix tab sends the whole chain for one setting: that is a change, not new effects.
    expect(mixPhrases([{ op: 'mix', target: 'voice', effects: [{ kind: 'eq' }, { kind: 'reverb' }] }])).toEqual(['the voice’s effects change'])
    expect(mixPhrases([{ op: 'mix', target: 't1', gainDb: -3, pan: 0.2 }, { op: 'mix', target: 't2', gainDb: -3, pan: 0.2 }])).toEqual([
      'two tracks are mixed'
    ])
    expect(mixPhrases([{ op: 'mix', target: 'voice', gainDb: -3, pan: 0.1 }])).toEqual(['the voice is mixed'])
    const cut = withSounds()
    const after = run([{ op: 'mix', target: 'voice', add: [defaultFx('reverb')] } as Op], cut).cut
    const said = describePlan(
      [{ op: 'mix', target: 'voice', add: [defaultFx('reverb')] } as Op],
      resolveCut(cut, doc.words, doc.sources),
      resolveCut(after, doc.words, doc.sources),
      after
    )
    expect(said).toContain('The voice gets a reverb')
  })
})
