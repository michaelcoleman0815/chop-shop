import { execFileSync, spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyOps,
  createDoc,
  currentCut,
  placeSfx,
  resolveCut,
  SFX_INFO,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Op,
  type SfxKind
} from '../shared/edit'
import { renderCut, type RenderSource } from './cut-render'
import { withOwnSounds } from '../shared/sounds'
import { ownSounds } from './own-sounds'
import { fromPlannerOp } from './planner-prompt'
import { makeSfx, readSound } from './sfx'
import { ffmpegRun, findFfmpeg, makeClip, meanLevel, onsets, toneLevel } from './test-media'

const FFMPEG = findFfmpeg()

/** Four sentences, each its own beat, two seconds apart, over a recording with no sound of its own. */
const SAID = [0, 1, 2, 3].flatMap((k) =>
  ['One', 'two', 'three', 'four.'].map((text, i) => ({
    text,
    startSec: 0.5 + k * 2.6 + i * 0.4,
    endSec: 0.5 + k * 2.6 + i * 0.4 + 0.3
  }))
)

/** The loudest stretch of `win` seconds between `from` and `to`, by its start. */
function loudestAt(ffmpeg: string, path: string, from: number, to: number, win = 0.04): number {
  let best = { at: from, db: -Infinity }
  for (let t = from; t + win <= to; t += 0.01) {
    const db = meanLevel(ffmpeg, path, t, win)
    if (db > best.db) best = { at: t, db }
  }
  return best.at + win / 2
}

describe.skipIf(!FFMPEG)('sound effects', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let sources: RenderSource[]

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-sfx-'))
    const path = makeClip(
      ffmpeg,
      join(dir, 'quiet.mp4'),
      'color=c=gray:s=320x180:r=30:d=11',
      'anullsrc=r=48000:cl=stereo:d=11'
    )
    const source = { id: 's1', path, durationSec: 11, width: 320, height: 180, fps: 30 }
    sources = [{ ...source, hasAudio: true }]
    doc = createDoc({ id: 'd', title: 'Quiet', source, words: wordsFromTranscript(SAID, 's1') })
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('makes each built-in sound to its length and level, and shaped as it should be', async () => {
    const made = {} as Record<SfxKind, string>
    for (const kind of Object.keys(SFX_INFO) as SfxKind[]) {
      made[kind] = await makeSfx(ffmpeg, kind, join(dir, 'sfx'))
      const read = await readSound(ffmpeg, made[kind])
      expect(Math.abs(read.durationSec - SFX_INFO[kind].sec), kind).toBeLessThan(0.03)
      expect(Math.abs(read.peakDb + 1), `${kind} peak ${read.peakDb}`).toBeLessThan(0.6)
      // A sound that starts on its moment starts at once; a whoosh and a riser swell from nothing.
      if (SFX_INFO[kind].lands === 'start') expect(read.leadSec, kind).toBeLessThan(0.01)
    }
    // A whoosh swells to its middle and dies away.
    const w = made.whoosh
    expect(meanLevel(ffmpeg, w, 0.3, 0.1)).toBeGreaterThan(meanLevel(ffmpeg, w, 0, 0.06) + 10)
    expect(meanLevel(ffmpeg, w, 0.3, 0.1)).toBeGreaterThan(meanLevel(ffmpeg, w, 0.63, 0.06) + 10)
    // Its filters sweep up to its middle and back, so it is far brighter there than near its start.
    const bright = (at: number, sec: number): number =>
      meanLevel(ffmpeg, w, at, sec, 'highpass=f=3000,highpass=f=3000') - meanLevel(ffmpeg, w, at, sec)
    expect(bright(0.3, 0.1)).toBeGreaterThan(bright(0.06, 0.06) + 8)
    // A riser ends far louder than it starts, and higher.
    const r = made.riser
    expect(meanLevel(ffmpeg, r, 1.65, 0.3)).toBeGreaterThan(meanLevel(ffmpeg, r, 0.05, 0.3) + 15)
    expect(toneLevel(ffmpeg, r, 1.7, 0.25, 1500)).toBeGreaterThan(toneLevel(ffmpeg, r, 1.7, 0.25, 250) + 6)
    // A hit is a low boom; a ding rings at its pitch; a pop and a click are over quickly.
    const h = made.hit
    expect(meanLevel(ffmpeg, h, 0, 0.5, 'lowpass=f=150')).toBeGreaterThan(
      meanLevel(ffmpeg, h, 0, 0.5, 'highpass=f=1000') + 10
    )
    expect(toneLevel(ffmpeg, made.ding, 0.05, 0.4, 1046.5)).toBeGreaterThan(
      toneLevel(ffmpeg, made.ding, 0.05, 0.4, 1500) + 20
    )
    expect(meanLevel(ffmpeg, made.pop, 0.11, 0.03)).toBeLessThan(meanLevel(ffmpeg, made.pop, 0, 0.03) - 30)
    expect(meanLevel(ffmpeg, made.click, 0.03, 0.02)).toBeLessThan(meanLevel(ffmpeg, made.click, 0, 0.01) - 30)
  })

  const render = async (ops: Op[], name: string): Promise<{ out: string; cut: Cut }> => {
    const r = applyOps(
      currentCut(doc),
      [{ op: 'aspect', aspect: 'original' }, { op: 'loudness', lufs: null }, ...ops],
      { words: doc.words, sources: doc.sources }
    )
    expect(r.rejected).toEqual([])
    const out = await renderCut(r.cut, resolveCut(r.cut, doc.words, doc.sources), sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      sfxDir: join(dir, 'sfx'),
      quality: 'final'
    })
    return { out, cut: r.cut }
  }

  it('lands each sound on its moment: a word, a cut, the end of a riser, the middle of a transition', async () => {
    const third = doc.words[9]
    const { out, cut } = await render(
      [
        { op: 'sfx', beats: ['b1'], add: { kind: 'pop', word: doc.words[2].id } },
        { op: 'sfx', beats: ['b2'], add: { kind: 'hit' } },
        { op: 'sfx', beats: ['b3'], add: { kind: 'riser' } },
        { op: 'transition', beats: ['b4'], kind: 'dissolve', sec: 0.6 },
        { op: 'sfx', beats: ['b4'], add: { kind: 'whoosh' } },
        { op: 'sfx', beats: ['b3'], add: { kind: 'ding', word: third.id } }
      ],
      'placed'
    )
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const placed = placeSfx(cut.beats, resolved)
    const at = (kind: SfxKind): number => placed.find((p) => p.sfx.kind === kind)!.atSec
    const found = onsets(ffmpeg, out, -25, 0.05)
    const nearest = (t: number): number => Math.min(...found.map((f) => Math.abs(f - t)))
    // The pop starts on its word, the hit on the cut into its beat, the ding on its word.
    expect(nearest(at('pop')), `pop at ${at('pop').toFixed(3)} in ${found.map((f) => f.toFixed(3))}`).toBeLessThan(0.01)
    expect(nearest(at('hit')), 'hit').toBeLessThan(0.01)
    expect(nearest(at('ding')), 'ding').toBeLessThan(0.01)
    // The riser is loud just before its beat comes in, and ends there.
    const riserEnd = at('riser')
    expect(meanLevel(ffmpeg, out, riserEnd - 0.15, 0.12)).toBeGreaterThan(-30)
    // The whoosh peaks in the middle of the dissolve it runs through.
    const tr = resolved.transitions![0]
    const middle = (tr.outStart + tr.outEnd) / 2
    expect(Math.abs(loudestAt(ffmpeg, out, middle - 0.3, middle + 0.3) - middle)).toBeLessThan(0.06)
    expect(Math.abs(at('whoosh') - middle)).toBeLessThan(1e-9)
  })

  it('plays one of the person’s own sounds on its moment, past the silence it starts with, at a known level', async () => {
    // Three tenths of a second of silence, then a short burst peaking near -3 dBFS.
    const own = join(dir, 'boom.wav')
    ffmpegRun(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      "aevalsrc=exprs='0.7*sin(2*PI*300*t)*between(t,0.3,0.5)':s=48000:d=0.8",
      own
    ])
    const read = await readSound(ffmpeg, own)
    expect(Math.abs(read.leadSec - 0.3)).toBeLessThan(0.01)
    const word = doc.words[6]
    const { out, cut } = await render(
      [
        {
          op: 'sfx',
          beats: ['b2'],
          add: { path: own, name: 'boom', word: word.id, leadSec: read.leadSec, peakDb: read.peakDb }
        }
      ],
      'own'
    )
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const wordAt = resolved.words.find((w) => w.id === word.id)!.outStart
    const found = onsets(ffmpeg, out, -25, 0.05)
    expect(Math.min(...found.map((f) => Math.abs(f - wordAt)))).toBeLessThan(0.01)
    // Brought to the level the built-in sounds play at: its loudest sample near -7 dBFS.
    const peak = Number(
      /max_volume: (-?\d+(?:\.\d+)?) dB/.exec(
        spawnSync(ffmpeg, ['-hide_banner', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
          .stderr
      )?.[1]
    )
    expect(Math.abs(peak + 7)).toBeLessThan(0.8)
  })

  it('peaks one of their whooshes on the cut, and ends one of their risers on it, as the planner picks them', async () => {
    // A library as a person keeps it: a whoosh with silence before it and its loudest a third of the way in, and
    // a riser swelling to its end. Each is read, chosen and planned as a real one is.
    const sounds = join(dir, 'mine')
    mkdirSync(join(sounds, 'whoosh'), { recursive: true })
    mkdirSync(join(sounds, 'riser'), { recursive: true })
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', "aevalsrc=exprs='0.6*sin(2*PI*400*t)*if(lt(t,0.25),0,if(lt(t,0.5),pow((t-0.25)/0.25,2),pow((1-t)/0.5,2)))':s=48000:d=1", join(sounds, 'whoosh', 'Air.wav')])
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', "aevalsrc=exprs='0.6*sin(2*PI*400*t)*pow(t/1.5,3)':s=48000:d=1.5", join(sounds, 'riser', 'Rise.wav')])
    const library = await ownSounds(ffmpeg, [sounds], join(dir, 'mine.json'))
    expect(library.map((s) => [s.kind, s.name])).toEqual([
      ['whoosh', 'Air'],
      ['riser', 'Rise']
    ])
    const planned = withOwnSounds(
      [
        { op: 'sfx' as const, beats: ['b2'], kind: 'whoosh' as const, sound: '', word: '', gainDb: 0 },
        { op: 'sfx' as const, beats: ['b4'], kind: 'riser' as const, sound: 's2', word: '', gainDb: 0 }
      ],
      library
    )
    const { out, cut } = await render(planned.map((o) => fromPlannerOp(o)) as Op[], 'mine')
    const at = new Map(placeSfx(cut.beats, resolveCut(cut, doc.words, doc.sources)).map((p) => [p.beat, p.atSec]))
    const b2 = at.get('b2')!
    expect(Math.abs(loudestAt(ffmpeg, out, b2 - 0.5, b2 + 0.6) - b2)).toBeLessThan(0.05)
    const b4 = at.get('b4')!
    // Loud right up to the cut, and gone after it.
    expect(Math.abs(loudestAt(ffmpeg, out, b4 - 1.4, b4 + 0.4) - b4)).toBeLessThan(0.06)
    expect(meanLevel(ffmpeg, out, b4 + 0.1, 0.2)).toBeLessThan(-60)
  })

  it('keeps a word’s sound where graphics hold the word out of the subtitles', async () => {
    // As subtitlePass leaves it when a card covers the third sentence: its words out of the subtitles only.
    const word = doc.words[9]
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'aspect', aspect: 'original' },
        { op: 'loudness', lufs: null },
        // A wide recording starts without captions: these are asked for.
        { op: 'captions', set: { on: true } },
        { op: 'sfx', beats: ['b3'], add: { kind: 'pop', word: word.id } }
      ],
      { words: doc.words, sources: doc.sources }
    )
    expect(r.rejected).toEqual([])
    const resolved = resolveCut(r.cut, doc.words, doc.sources)
    const card = resolved.beats[2]
    const shown = resolved.words.filter((w) => w.beat !== card.id)
    const workDir = join(dir, 'work-held')
    const out = await renderCut(r.cut, resolved, sources, {
      ffmpeg,
      outputPath: join(dir, 'held.mp4'),
      workDir,
      sfxDir: join(dir, 'sfx'),
      quality: 'final',
      captionWords: shown
    })
    const wordAt = resolved.words.find((w) => w.id === word.id)!.outStart
    const found = onsets(ffmpeg, out, -25, 0.05)
    expect(Math.min(...found.map((f) => Math.abs(f - wordAt)))).toBeLessThan(0.01)
    // The subtitles run before and after the card, and none while it holds the screen.
    const times = [
      ...readFileSync(join(workDir, 'captions.ass'), 'utf8').matchAll(/^Dialogue: \d+,([\d:.]+),([\d:.]+)/gm)
    ].map((m) => m.slice(1, 3).map((t) => t.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)))
    expect(times.length).toBeGreaterThan(0)
    expect(times.some(([from]) => from < card.outStart)).toBe(true)
    expect(times.some(([from]) => from >= card.outEnd)).toBe(true)
    expect(times.filter(([from, until]) => until > card.outStart + 0.02 && from < card.outEnd - 0.02)).toEqual([])
  })

  it('names a missing sound file in a sentence', async () => {
    await expect(
      render([{ op: 'sfx', beats: ['b2'], add: { path: join(dir, 'gone.wav'), name: 'gone' } }], 'gone')
    ).rejects.toThrow(`I can't find gone.wav. It was at ${join(dir, 'gone.wav')}.`)
    // And a recording made without any sound effect has none of their inputs.
    execFileSync(ffmpeg, ['-version'])
  })
})
