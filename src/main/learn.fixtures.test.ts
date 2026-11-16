import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Word } from '../shared/edit/schema'
import { buildPair, fitHabits, type Habits, type LabelledPair } from '../shared/learn'
import type { Transcript } from '../shared/types'
import {
  composeFinished,
  decode,
  encodeAudio,
  encodeVideo,
  findFfmpeg,
  finishedWords,
  FIXTURES,
  hearLoosely,
  musicBed,
  plantEdit,
  readTruth,
  roomTone,
  seeded,
  type EditSpec,
  type PlantedPiece,
  type Truth
} from './learn-fixtures'
import { learnFromFiles } from './learn-pipeline'

/**
 * The whole of learning from an edit, on real audio: speech whose every word
 * is known (checked in, made with espeak-ng), finished videos cut from it here
 * with planted decisions, a music bed, sound effects, a loudness change, a
 * compressor, a moved section and B-roll; then ffmpeg, the features, the
 * snapping, the alignment and the labels, exactly as the app runs them. Only
 * the transcripts are stand-ins: the known words, heard exactly or loosely.
 */

const FFMPEG = findFfmpeg()

type Heard = { text: string; startSec: number; endSec: number }[]

interface Scored {
  labelled: number
  correct: number
  unsure: number
  unused: number
  wrong: string[]
  /** Planted cut edges against recovered ones, in the recording's time. */
  boundaryMs: number[]
  /** The video's own start and end. */
  trimMs: number[]
  /** The two edges of a crossfaded (J or L) seam. */
  fadeMs: number[]
  /** Edges beside a stretch left out because it plays faster. */
  besideMs: number[]
  /** Kept words: where they play against where they were planted. */
  outMs: number[]
}

const pctl = (v: number[], p: number): number => {
  if (v.length === 0) return NaN
  const s = [...v].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]
}
const ms = (v: number): string => (Number.isFinite(v) ? `${Math.round(v)}` : '-')
const report: string[] = []

describe.skipIf(!FFMPEG)('learning from an edit, end to end on speech with known words', () => {
  const ffmpeg = FFMPEG as string
  let work = ''
  let talk: Float32Array
  let other: Float32Array
  let talkTruth: Truth
  let otherTruth: Truth
  const talkPath = join(FIXTURES, 'talk.m4a')

  const at = (line: number, nth = 0): number => talkTruth.words.findIndex((w) => w.line === line) + nth
  const end = (line: number): number => talkTruth.words.map((w) => w.line).lastIndexOf(line)
  const inLine = (line: number): number[] => talkTruth.words.flatMap((w, i) => (w.line === line ? [i] : []))

  // The creator's edit: room either side of each cut, pauses past 0.55 s cut
  // back, the um and uh cut, the second take of line 3 kept, the restart cut
  // back to where it began again, the first take of line 8 kept, the third of
  // line 11, and the white-balance section moved ahead of the shutter one.
  const mainSpec = (): EditSpec => ({
    segments: [
      [at(0), end(0)],
      [at(1, 1), end(2)],
      [at(4), end(4)],
      [at(5), at(5, 3)],
      [at(6), end(6)],
      [at(7), at(7, 2)],
      [at(7, 4), end(7)],
      [at(13), end(14)],
      [at(8), end(8)],
      [at(10), end(10)],
      [at(15), end(15)]
    ],
    before: 0.05,
    after: 0.09,
    jitter: 0.01,
    maxPauseSec: 0.55,
    // Line 6 into line 7 is crossfaded over 0.2 s, the way an audio J or L cut is.
    overlap: { segment: 5, seconds: 0.2, before: 0.25, after: 0.3 }
  })

  const transcriptOf = (words: Heard): Transcript => ({
    words,
    text: words.map((w) => w.text).join(' '),
    language: 'en'
  })

  async function learn(recordings: string[], finished: string, heard: Map<string, Heard>) {
    return learnFromFiles(
      { recordings, finished },
      {
        ffmpeg,
        transcribe: async (path) => transcriptOf(heard.get(path) ?? []),
        id: () => 'fixture',
        now: () => new Date('2026-11-16T00:00:00.000Z')
      }
    )
  }

  function makeFinished(name: string, spec: EditSpec, opts: { loose?: boolean; voiceOver?: boolean } = {}) {
    const { pieces, kept } = plantEdit([talkTruth], spec)
    const vo = otherTruth.words.filter((w) => w.line === 3)
    const voice =
      opts.voiceOver === false
        ? null
        : other.slice(
            Math.round((vo[0].startSec - 0.05) * 22050),
            Math.round((vo[vo.length - 1].endSec + 0.08) * 22050)
          )
    const made = composeFinished([talk], pieces, ffmpeg, work, {
      leadSec: 1.5,
      bedDb: -32,
      gainDb: 3,
      dipDb: -5,
      sfxAt: [3, 7],
      voiceOver: voice,
      seed: 9
    })
    const path = join(work, `${name}.mp4`)
    encodeVideo(ffmpeg, made.samples, path, work, {
      broll: [
        [6, 10],
        [24, 29],
        [41, 44]
      ]
    })
    const shift = made.voiceOver ? made.voiceOver.outStart - (vo[0].startSec - 0.05) : 0
    const words = finishedWords([talkTruth], made.planted, made.voiceOver ? { words: vo, shift } : null)
    return { path, kept, planted: made.planted, words }
  }

  /** The labels recovered, checked word by word against the planted edit. */
  function score(pair: LabelledPair, truths: Truth[], kept: Set<string>, planted: PlantedPiece[]): Scored {
    const s: Scored = {
      labelled: 0,
      correct: 0,
      unsure: 0,
      unused: 0,
      wrong: [],
      boundaryMs: [],
      trimMs: [],
      fadeMs: [],
      besideMs: [],
      outMs: []
    }
    for (const w of pair.words) {
      const rec = Number(w.source.slice(1)) - 1
      const truth = truths[rec].words
      let best = -1
      let most = 0
      truth.forEach((t, i) => {
        const o = Math.min(t.endSec, w.endSec) - Math.max(t.startSec, w.startSec)
        if (o > most) {
          most = o
          best = i
        }
      })
      if (best < 0) continue
      if (w.label === 'unsure') s.unsure++
      if (w.label === 'unused') s.unused++
      const isKept = kept.has(`${rec}:${best}`)
      if (w.label === 'unsure' || (w.label === 'unused' && !isKept)) continue
      s.labelled++
      if ((w.label === 'kept') === isKept) s.correct++
      else s.wrong.push(`${truth[best].text}@${truth[best].startSec.toFixed(2)} ${w.label}`)
      if (w.label === 'kept' && isKept) {
        const p = planted.find(
          (x) => x.rec === rec && truth[best].startSec >= x.rawStart && truth[best].endSec <= x.rawEnd
        )
        if (p && p.speed === 1)
          s.outMs.push(Math.abs(w.outStartSec! - (p.outStart + (truth[best].startSec - p.rawStart))) * 1000)
      }
    }
    // Each planted cut edge against the recovered piece that covers most of
    // it. The first piece's start and the last one's end are trims of the
    // video, not cuts, and are counted apart.
    planted.forEach((p, i) => {
      if (p.speed !== 1) return
      const source = `s${p.rec + 1}`
      const found = pair.pieces
        .filter((q) => q.source === source)
        .map((q) => ({ q, o: Math.min(q.rawEnd, p.rawEnd) - Math.max(q.rawStart, p.rawStart) }))
        .sort((a, b) => b.o - a.o)[0]?.q
      if (!found) return
      const start = Math.abs(found.rawStart - p.rawStart) * 1000
      const end = Math.abs(found.rawEnd - p.rawEnd) * 1000
      // A crossfaded seam has no single cut point: both pieces sound through
      // it. An edge beside a sped-up stretch borders what was left out.
      const intoFade = p.overlapSec > 0
      const outOfFade = (planted[i + 1]?.overlapSec ?? 0) > 0
      const afterFast = (planted[i - 1]?.speed ?? 1) !== 1
      const beforeFast = (planted[i + 1]?.speed ?? 1) !== 1
      ;(i === 0 ? s.trimMs : intoFade ? s.fadeMs : afterFast ? s.besideMs : s.boundaryMs).push(start)
      ;(i === planted.length - 1 ? s.trimMs : outOfFade ? s.fadeMs : beforeFast ? s.besideMs : s.boundaryMs).push(end)
    })
    return s
  }

  /**
   * The habits the planted edit really has: its exact pieces and labels,
   * fitted the same way. Word edges are the ones the app works with (snapped
   * to the sound, as an edit has them), so only the cuts differ.
   */
  function plantedHabits(truths: Truth[], planted: PlantedPiece[], edges: LabelledPair['words']): Habits {
    const recordings = truths.map((t, r) => ({
      id: `s${r + 1}`,
      durationSec: t.durationSec,
      words: t.words.map((w, i): Word => {
        const e = edges.filter((x) => x.source === `s${r + 1}`)[i]
        return {
          id: `t${i}`,
          source: `s${r + 1}`,
          text: w.text,
          startSec: e?.startSec ?? w.startSec,
          endSec: e?.endSec ?? w.endSec
        }
      }),
      features: null
    }))
    const pieces = planted.map((p) => ({
      source: `s${p.rec + 1}`,
      rawStart: p.rawStart,
      rawEnd: p.rawEnd,
      outStart: p.outStart,
      outEnd: p.outEnd,
      match: 1,
      sureStart: true,
      sureEnd: true
    }))
    const pair = buildPair(
      {
        id: 'truth',
        title: 'truth',
        createdAt: '',
        recordings: recordings.map((r) => ({
          id: r.id,
          path: r.id,
          durationSec: r.durationSec,
          bytes: null,
          modifiedAt: null
        })),
        finished: { path: 'finished', durationSec: 0, bytes: null, modifiedAt: null }
      },
      recordings,
      { ok: true, pieces, issues: [], matched: 0, words: 0, unsure: [] },
      Object.fromEntries(truths.map((t, r) => [`s${r + 1}`, t.breaths]))
    )
    return fitHabits([pair])!
  }

  function line(label: string, s: Scored): void {
    report.push(
      `${label.padEnd(34)} ${String(s.labelled).padStart(4)} words  ${((100 * s.correct) / Math.max(1, s.labelled)).toFixed(1).padStart(5)}% right  ` +
        `${String(s.unsure).padStart(2)} unsure  cut edges ${ms(pctl(s.boundaryMs, 0.5))}/${ms(pctl(s.boundaryMs, 0.9))} ms (n ${s.boundaryMs.length})  ` +
        `trims ${s.trimMs.map((v) => ms(v)).join(', ')} ms  ` +
        (s.fadeMs.length ? `J/L seam ${s.fadeMs.map((v) => ms(v)).join(', ')} ms  ` : '') +
        (s.besideMs.length ? `beside the fast stretch ${s.besideMs.map((v) => ms(v)).join(', ')} ms  ` : '') +
        `word times ${ms(pctl(s.outMs, 0.5))}/${ms(pctl(s.outMs, 0.9))} ms (median/p90)`
    )
  }

  function habitLine(label: string, h: Habits | null): void {
    if (!h) return void report.push(`${label}: none`)
    const c = (x: { n: number; of: number } | null): string => (x ? `${x.n}/${x.of}` : '-')
    report.push(
      `${label.padEnd(10)} pauses ${h.pauses?.medianSec.toFixed(3)}/${h.pauses?.p90Sec.toFixed(3)} s (n ${h.pauses?.count})  ` +
        `shortened from ${h.maxPauseSec?.toFixed(2) ?? '-'} s (${c(h.pauseCuts)})  ` +
        `room ${h.pad?.beforeSec.toFixed(3)} before, ${h.pad?.afterSec.toFixed(3)} after${h.pad?.heard ? '' : ' (split not heard)'} (n ${h.pad?.count})  ` +
        `ums cut ${c(h.fillers)}  breaths cut ${c(h.breaths)}  last take ${c(h.lastTake)}`
    )
  }

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'cutalong-learn-'))
    talkTruth = readTruth('talk')
    otherTruth = readTruth('other')
    talk = decode(ffmpeg, talkPath)
    other = decode(ffmpeg, join(FIXTURES, 'other.m4a'))
  })

  afterAll(() => {
    rmSync(work, { recursive: true, force: true })
    if (report.length) console.log(`\nLearning from edits, measured against the planted truth:\n${report.join('\n')}\n`)
  })

  it('recovers every decision of an edit with a music bed, a moved section, retakes and a restart', async () => {
    const fin = makeFinished('main', mainSpec())
    const r = await learn(
      [talkPath],
      fin.path,
      new Map([
        [talkPath, talkTruth.words],
        [fin.path, fin.words]
      ])
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = score(r.pair, [talkTruth], fin.kept, fin.planted)
    line('main, exact transcripts', s)
    expect(s.wrong).toEqual([])
    expect(s.correct / s.labelled).toBeGreaterThanOrEqual(0.98)
    expect(pctl(s.boundaryMs, 0.5)).toBeLessThan(40)
    expect(pctl(s.outMs, 0.9)).toBeLessThan(40)

    const label = (i: number): string => r.pair.words[i].label
    // A line said twice with no cue, only the second take kept.
    expect(
      inLine(3)
        .map(label)
        .every((l) => l === 'cut')
    ).toBe(true)
    expect(
      inLine(4)
        .map(label)
        .every((l) => l === 'kept')
    ).toBe(true)
    // The restart: the opening kept, the abandoned words cut, the take that backs up kept.
    expect(inLine(5).map(label)).toEqual(['kept', 'kept', 'kept', 'kept', 'cut', 'cut', 'cut', 'cut', 'cut'])
    expect(
      inLine(6)
        .map(label)
        .every((l) => l === 'kept')
    ).toBe(true)
    // The moved section plays before the one it followed in the recording.
    const firstOut = (l: number): number => r.pair.words[at(l)].outStartSec!
    expect(firstOut(13)).toBeLessThan(firstOut(8))
    // The voice-over is not in the recording, and is said to be.
    expect(r.pair.issues.some((i) => i.kind === 'unmatched')).toBe(true)

    const planted = plantedHabits([talkTruth], fin.planted, r.pair.words)
    const found = fitHabits([r.pair])!
    habitLine('planted', planted)
    habitLine('recovered', found)
    expect(found.lastTake).toEqual(planted.lastTake)
    expect(found.fillers).toEqual(planted.fillers)
    expect(found.breaths).toEqual(planted.breaths)
    expect(Math.abs(found.pauses!.medianSec - planted.pauses!.medianSec)).toBeLessThan(0.02)
    expect(Math.abs(found.pauses!.p90Sec - planted.pauses!.p90Sec)).toBeLessThan(0.05)
    // The room a cut leaves is exact; how it splits is only claimed when it was heard.
    const room = (h: Habits): number => h.pad!.beforeSec + h.pad!.afterSec
    expect(Math.abs(room(found) - room(planted))).toBeLessThan(0.02)
    if (found.pad!.heard) {
      expect(Math.abs(found.pad!.beforeSec - planted.pad!.beforeSec)).toBeLessThan(0.03)
      expect(Math.abs(found.pad!.afterSec - planted.pad!.afterSec)).toBeLessThan(0.03)
    }
  }, 120_000)

  it('copes with transcripts that hear the words loosely', async () => {
    const fin = makeFinished('loose', mainSpec())
    const r = await learn(
      [talkPath],
      fin.path,
      new Map([
        [talkPath, hearLoosely(talkTruth.words, 3, { dropFillers: false })],
        [fin.path, hearLoosely(fin.words, 4)]
      ])
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = score(r.pair, [talkTruth], fin.kept, fin.planted)
    line('main, loose transcripts', s)
    expect(s.correct / s.labelled).toBeGreaterThanOrEqual(0.95)
    expect(pctl(s.boundaryMs, 0.5)).toBeLessThan(60)
  }, 120_000)

  it('says so when the finished video is cut from a different recording, and labels nothing', async () => {
    const { pieces } = plantEdit([otherTruth], {
      segments: [[0, 30]],
      before: 0.05,
      after: 0.09,
      jitter: 0,
      maxPauseSec: 0.55
    })
    const made = composeFinished([other], pieces, ffmpeg, work, { leadSec: 0.5, bedDb: -32, seed: 3 })
    const path = join(work, 'eggs.mp4')
    encodeVideo(ffmpeg, made.samples, path, work)
    const r = await learn(
      [talkPath],
      path,
      new Map([
        [talkPath, talkTruth.words],
        [path, finishedWords([otherTruth], made.planted)]
      ])
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    report.push(`not from the recording: "${r.message}"`)
    expect(r.message).toMatch(/^I don't think eggs\.mp4 comes from talk\.m4a: only \d+ of its \d+ words match\.$/)
  }, 120_000)

  it('follows a recording split over two files', async () => {
    // Split at the long pause after line 7.
    const cutAt = talkTruth.words[end(7)].endSec + 0.6
    const parts = [talk.slice(0, Math.round(cutAt * 22050)), talk.slice(Math.round(cutAt * 22050))]
    const truths: Truth[] = [
      { ...talkTruth, durationSec: cutAt, words: talkTruth.words.filter((w) => w.endSec < cutAt) },
      {
        ...talkTruth,
        durationSec: talkTruth.durationSec - cutAt,
        words: talkTruth.words
          .filter((w) => w.startSec > cutAt)
          .map((w) => ({ ...w, startSec: w.startSec - cutAt, endSec: w.endSec - cutAt })),
        breaths: talkTruth.breaths
          .filter((b) => b.startSec > cutAt)
          .map((b) => ({ startSec: b.startSec - cutAt, endSec: b.endSec - cutAt }))
      }
    ]
    truths[0].breaths = talkTruth.breaths.filter((b) => b.endSec < cutAt)
    const paths = [join(work, 'take-a.m4a'), join(work, 'take-b.m4a')]
    parts.forEach((x, i) => encodeAudio(ffmpeg, x, paths[i], work))
    const n0 = truths[0].words.length
    const spec = mainSpec()
    const recs = spec.segments.map(([a]) => (a >= n0 ? 1 : 0))
    const { pieces, kept } = plantEdit(truths, {
      ...spec,
      segments: spec.segments.map(([a, b]) => (a >= n0 ? [a - n0, b - n0] : [a, b]) as [number, number]),
      recs
    })
    const made = composeFinished(parts, pieces, ffmpeg, work, { leadSec: 1, bedDb: -32, gainDb: 2, seed: 4 })
    const path = join(work, 'split.mp4')
    encodeVideo(ffmpeg, made.samples, path, work)
    const r = await learn(
      paths,
      path,
      new Map([
        [paths[0], truths[0].words],
        [paths[1], truths[1].words],
        [path, finishedWords(truths, made.planted)]
      ])
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = score(r.pair, truths, kept, made.planted)
    line('recording split over two files', s)
    expect(new Set(r.pair.pieces.map((p) => p.source))).toEqual(new Set(['s1', 's2']))
    expect(s.correct / s.labelled).toBeGreaterThanOrEqual(0.97)
  }, 120_000)

  it('learns from a very short finished video', async () => {
    const { pieces, kept } = plantEdit([talkTruth], {
      segments: [[at(2), end(2)]],
      before: 0.05,
      after: 0.09,
      jitter: 0,
      maxPauseSec: 0.55
    })
    const made = composeFinished([talk], pieces, ffmpeg, work, { leadSec: 0.3, bedDb: -32, seed: 5 })
    const path = join(work, 'short.mp4')
    encodeVideo(ffmpeg, made.samples, path, work)
    const r = await learn(
      [talkPath],
      path,
      new Map([
        [talkPath, talkTruth.words],
        [path, finishedWords([talkTruth], made.planted)]
      ])
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = score(r.pair, [talkTruth], kept, made.planted)
    line(`very short (${(made.samples.length / 22050).toFixed(1)} s)`, s)
    expect(r.pair.words.filter((w) => w.label === 'kept').map((w) => w.text)).toEqual([
      "That's",
      'where',
      'the',
      'good',
      'stuff',
      'is.'
    ])
    // The rest of the recording is far from it, so it counts as material for something else, not as cut.
    expect(r.pair.words.some((w) => w.label === 'unused')).toBe(true)
  }, 120_000)

  it('says when a file has no speech in it', async () => {
    const room = join(work, 'room.m4a')
    encodeAudio(ffmpeg, roomTone(10 * 22050, -58, seeded(2)), room, work)
    const music = join(work, 'music.mp4')
    const bed = musicBed(8, 6).map((v) => v * 10 ** (-24 / 20))
    encodeVideo(ffmpeg, bed, music, work, { compress: false })
    const fin = makeFinished('main-again', mainSpec())

    const silent = await learn(
      [room],
      fin.path,
      new Map([
        [room, []],
        [fin.path, fin.words]
      ])
    )
    expect(silent).toEqual({
      ok: false,
      message: "I couldn't hear any speech in room.m4a, so there is nothing to line up."
    })
    const tune = await learn(
      [talkPath],
      music,
      new Map([
        [talkPath, talkTruth.words],
        [music, []]
      ])
    )
    expect(tune).toEqual({
      ok: false,
      message: "I couldn't hear any speech in music.mp4, so there is nothing to line up."
    })
    report.push(`silence only: "${silent.ok ? '' : silent.message}"`)
    report.push(`music only:   "${tune.ok ? '' : tune.message}"`)
  }, 120_000)

  it('reports a stretch played faster instead of guessing its labels', async () => {
    const fin = makeFinished('faster', { ...mainSpec(), speed: { segment: 6, factor: 1.25 } })
    const r = await learn(
      [talkPath],
      fin.path,
      new Map([
        [talkPath, talkTruth.words],
        [fin.path, fin.words]
      ])
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const speed = r.pair.issues.find((i) => i.kind === 'speed')
    expect(speed).toBeDefined()
    expect(Math.abs(speed!.factor! - 1.25)).toBeLessThan(0.08)
    // The sped-up words are left out, not labelled.
    const faster = inLine(7).slice(4)
    expect(faster.map((i) => r.pair.words[i].label).every((l) => l === 'unsure')).toBe(true)
    const s = score(r.pair, [talkTruth], fin.kept, fin.planted)
    line('one stretch at 1.25 times speed', s)
    report.push(`speed change: "${speed!.text}"`)
    expect(s.correct / s.labelled).toBeGreaterThanOrEqual(0.97)
  }, 120_000)
})
