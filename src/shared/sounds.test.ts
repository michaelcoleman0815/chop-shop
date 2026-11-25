import { describe, expect, it } from 'vitest'
import { placeSfx, sfxGainDb, SfxSchema } from './edit/sfx'
import { landOf, ownFor, placedSound, soundById, soundKindOf, soundsLines, withOwnSounds, type OwnSound } from './sounds'

const own = (kind: OwnSound['kind'], name: string, over: Partial<OwnSound> = {}): OwnSound => ({
  path: `/sounds/${kind}/${name}.wav`,
  name,
  kind,
  sec: 0.6,
  leadSec: 0.04,
  landSec: kind === 'whoosh' ? 0.3 : kind === 'riser' ? 0.6 : 0,
  peakDb: -3,
  ...over
})
const LIBRARY = [own('whoosh', 'Air 1'), own('whoosh', 'Air 2'), own('pop', 'Hollow Pop', { sec: 0.1 }), own('paper', 'Page turn')]
const timing = { beats: [{ id: 'b1', outStart: 2 }], words: [{ id: 'w1', outStart: 5 }] }

describe('own sounds', () => {
  it('says what a file is from its folder when that names a kind, else its name, else its folder', () => {
    expect(soundKindOf('Air 1', 'whoosh')).toBe('whoosh')
    expect(soundKindOf('Mechanical Keyboard Click 15')).toBe('type')
    expect(soundKindOf('Camera Shutter Click 01')).toBe('shutter')
    expect(soundKindOf('Swooshy Approach 05')).toBe('riser')
    expect(soundKindOf('turn_fast_paper_01')).toBe('paper')
    expect(soundKindOf('10', 'Whooshes')).toBe('whoosh')
    expect(soundKindOf('Always Sunny Theme')).toBe('other')
  })

  it('lands a whoosh at its loudest, a riser where it ends, and anything else as it starts', () => {
    expect(landOf('whoosh', 0.9, 0.4)).toBe(0.4)
    expect(landOf('riser', 2.2, 2.1)).toBe(2.2)
    expect(landOf('pop', 0.1, 0.02)).toBe(0)
    // On a beat at 2 s: the whoosh starts 0.3 s before it, with the file's silence skipped.
    const sfx = SfxSchema.parse(placedSound(LIBRARY[0]))
    const [p] = placeSfx([{ id: 'b1', sfx: [sfx] }], timing)
    expect(p.startSec).toBeCloseTo(1.7, 9)
    expect(p.trimSec).toBeCloseTo(0.04, 9)
    // On the first moment of the video, the part that would come before it is trimmed, so it still lands in time.
    const [first] = placeSfx([{ id: 'b1', sfx: [sfx] }], { ...timing, beats: [{ id: 'b1', outStart: 0.1 }] })
    expect(first.startSec).toBe(0)
    expect(first.trimSec).toBeCloseTo(0.24, 9)
  })

  it('plays as loud as the made sound it stands in for', () => {
    const made = { whoosh: -7, pop: -7, riser: -9 } as const
    for (const kind of ['whoosh', 'pop', 'riser'] as const) {
      const s = placedSound(own(kind, 'x', { peakDb: -12 }))
      // A file peaking at -12 dBFS, played at this gain, peaks where a made one does.
      expect(-12 + sfxGainDb(s)).toBeCloseTo(made[kind], 9)
    }
  })

  it('makes a planned sound one of theirs, the next one each time, and keeps what it names', () => {
    const planned = [
      { op: 'sfx', beats: ['b1'], kind: 'whoosh', sound: '', word: '', gainDb: 0 },
      { op: 'sfx', beats: ['b2'], kind: 'whoosh', sound: '', word: '', gainDb: -3 },
      { op: 'sfx', beats: ['b3'], kind: 'whoosh', sound: '', word: '', gainDb: 0 },
      { op: 'sfx', beats: ['b4'], kind: 'click', sound: 's4', word: 'w9', gainDb: 0 },
      { op: 'sfx', beats: ['b5'], kind: 'ding', sound: '', word: '', gainDb: 0 },
      { op: 'sfx', beats: ['b6'], kind: 'none', sound: '', word: '', gainDb: 0 },
      { op: 'music', path: '' }
    ]
    const out = withOwnSounds(planned, LIBRARY) as { own?: { name?: string; word?: string; as?: string; gainDb?: number } }[]
    expect(out.map((o) => o.own?.name ?? null)).toEqual(['Air 1', 'Air 2', 'Air 1', 'Page turn', null, null, null])
    expect(out[3].own).toMatchObject({ word: 'w9', as: 'whoosh' })
    // Quieter than usual by what was asked.
    expect((out[0].own?.gainDb ?? 0) - (out[1].own?.gainDb ?? 0)).toBeCloseTo(3, 9)
    // Nothing of theirs, nothing changed.
    expect(withOwnSounds(planned, [])).toBe(planned)
  })

  it('leaves a kind made when theirs run too long to stand in for it', () => {
    expect(ownFor([own('pop', 'Long pop', { sec: 2 })], 'pop', 0)).toBeNull()
    expect(soundById(LIBRARY, 's9')).toBeNull()
    expect(soundById(LIBRARY, 'whoosh')).toBeNull()
  })

  it('reads to the planner as a line a kind, names and lengths only', () => {
    expect(soundsLines(LIBRARY)).toEqual([
      'whoosh: s1 "Air 1" 0.6 s; s2 "Air 2" 0.6 s',
      'pop: s3 "Hollow Pop" 0.1 s',
      'paper: s4 "Page turn" 0.6 s'
    ])
    expect(soundsLines(LIBRARY).join()).not.toContain('/sounds/')
  })
})
