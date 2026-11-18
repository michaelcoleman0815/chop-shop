import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false }, safeStorage: {} }))
vi.mock('./apikey', () => ({ readApiKey: () => null }))
vi.mock('./ffmpeg', async () => {
  const { findFfmpeg } = await import('./test-media')
  const installer = (await import('@ffprobe-installer/ffprobe')) as unknown as { default?: { path: string }; path?: string }
  const installed = installer.default?.path ?? installer.path ?? 'ffprobe'
  const { spawnSync } = await import('child_process')
  const ffprobe =
    [process.env.FFPROBE_PATH, installed, 'ffprobe'].find((bin) => bin && spawnSync(bin, ['-version']).status === 0) ??
    'ffprobe'
  return { FFMPEG_PATH: findFfmpeg() ?? 'ffmpeg', FFPROBE_PATH: ffprobe }
})

import {
  commit,
  createDoc,
  currentCut,
  gridAspect,
  gridLayout,
  gridPictures,
  panelInStep,
  pieceTime,
  resolveCut,
  viewThroughAngles,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Resolved
} from '../shared/edit'
import { joinViews, MIN_SHOT_SEC, planPovs } from '../shared/pov'
import { frameSize, renderCut } from './cut-render'
import { factsFor, guessRoles } from './session'
import { findSession, hearViews } from './session-povs'
import { AS_PLAYED, AS_SHOT, ffmpegRun, findFfmpeg } from './test-media'

/**
 * One gaming session recorded by four players, made up from nothing: each
 * recording its player's own picture (every frame says whose it is and which
 * frame), the shared voice chat (each player's own lines loud, the others'
 * through the chat), and game sound of its own; started and stopped at its
 * own time. Planted in it: one player laughing alone, a bang in another's
 * game, a third shouting, and everyone laughing at once. Cutalong lines the
 * four up by ear, finds whose is whose, hears each on the first player's
 * clock, cuts to whoever reacts and to everyone at once, and the export
 * shows each moment through the view the editor does, frame for frame.
 */

const FFMPEG = findFfmpeg()
const FONTS = fileURLToPath(new URL('../../resources/fonts/', import.meta.url))
const RATE = 24000
const FPS = 30
const FRAME = 1 / FPS
const W = 640
const H = 360

interface Player {
  n: number
  /** Home's t is this recording's t + offsetSec: the second started 3.37 s after the first. */
  offsetSec: number
  sec: number
  f0: number
  /** Its pictures' blue, which says whose they are. */
  blue: number
}

const PLAYERS: Player[] = [
  { n: 1, offsetSec: 0, sec: 42, f0: 130, blue: 30 },
  { n: 2, offsetSec: -3.37, sec: 40.6, f0: 175, blue: 100 },
  { n: 3, offsetSec: 2.81, sec: 41.3, f0: 215, blue: 170 },
  { n: 4, offsetSec: -1.13, sec: 41.4, f0: 155, blue: 240 }
]

/** What was planted, on the first player's clock. */
const LAUGH = { by: 2, startSec: 12, endSec: 13.2 }
const BANG = { by: 3, startSec: 19, endSec: 19.5 }
const SHOUT = { by: 4, startSec: 25, endSec: 25.45 }
const EVERYONE = { startSec: 32, endSec: 33.5 }
/** Where the lines go: around what was planted. */
const FREE: [number, number][] = [
  [0.6, 11.2],
  [14.1, 18.2],
  [20.6, 24.3],
  [26.3, 31.2],
  [34.4, 41.2]
]

/** A repeatable pseudo-random stream. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

interface Said {
  text: string
  startSec: number
  endSec: number
  by: number
  loud: number
}

/** The voice chat: lines in turn from each player, each word a syllable of their voice. */
function lines(): Said[] {
  const r = rng(5)
  const out: Said[] = []
  let who = 0
  for (const [from, to] of FREE) {
    let t = from
    for (;;) {
      const count = 3 + Math.floor(r() * 4)
      const words: Said[] = []
      let u = t
      for (let k = 0; k < count; k++) {
        const len = 0.2 + r() * 0.2
        words.push({ text: `word${out.length + words.length + 1}`, startSec: u, endSec: u + len, by: (who % 4) + 1, loud: 1 })
        u += len + 0.06 + r() * 0.08
      }
      if (words[words.length - 1].endSec > to) break
      words[words.length - 1].text += '.'
      out.push(...words)
      who++
      t = words[words.length - 1].endSec + 0.5 + r() * 0.7
    }
  }
  out.push({ text: 'No!', startSec: SHOUT.startSec, endSec: SHOUT.endSec, by: SHOUT.by, loud: 3.6 })
  return out.sort((a, b) => a.startSec - b.startSec).map((w, i) => ({ ...w, text: w.text.replace(/^word\d+/, `word${i + 1}`) }))
}

const SAID = lines()

/** A voice: a few harmonics, normalised so the loudest it gets is 1. */
const voice = (f0: number, u: number): number => {
  let v = 0
  for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * h * f0 * u) / h
  return v / 2.45
}

/** One player's recording's sound: their game, the voice chat as they heard it, and their own voice. */
function soundOf(p: Player): Float32Array {
  const n = Math.round(p.sec * RATE)
  const out = new Float32Array(n)
  const r = rng(100 + p.n)
  // The game: a low rumble, and small sounds of its own every few seconds.
  let low = 0
  let nextSound = 1 + r() * 2
  for (let i = 0; i < n; i++) {
    low = 0.97 * low + 0.03 * (r() * 2 - 1)
    out[i] += 0.12 * low
    const t = i / RATE
    if (t >= nextSound) {
      for (let k = i; k < Math.min(n, i + Math.round(0.1 * RATE)); k++) out[k] += 0.03 * (r() * 2 - 1)
      nextSound = t + 2 + r() * 3
    }
  }
  // Something on home's clock, laid into this recording where it heard it.
  const lay = (startSec: number, endSec: number, fill: (u: number, d: number) => number): void => {
    const a = Math.max(0, Math.round((startSec + p.offsetSec) * RATE))
    const b = Math.min(n, Math.round((endSec + p.offsetSec) * RATE))
    for (let i = a; i < b; i++) out[i] += fill(i / RATE - (startSec + p.offsetSec), endSec - startSec)
  }
  // Each player's own voice is loud in their own recording; the others come in through the chat, 8 dB down.
  const heard = (by: number): number => (by === p.n ? 1 : 0.4)
  const f0Of = (by: number): number => PLAYERS[by - 1].f0
  for (const w of SAID)
    lay(w.startSec, w.endSec, (u, d) => 0.22 * w.loud * heard(w.by) * Math.pow(Math.sin((Math.PI * u) / d), 0.6) * voice(f0Of(w.by), u))
  // Laughter: a high voice pulsing five times a second.
  const laugh = (by: number) => (u: number) =>
    0.3 * heard(by) * voice(290 + 20 * by, u) * Math.pow(Math.max(0, Math.sin(2 * Math.PI * 5 * u)), 2)
  lay(LAUGH.startSec, LAUGH.endSec, laugh(LAUGH.by))
  for (const q of PLAYERS) lay(EVERYONE.startSec, EVERYONE.endSec, laugh(q.n))
  // The bang is in one player's game only: game sound never goes through the chat.
  if (p.n === BANG.by) lay(BANG.startSec, BANG.endSec, (u, d) => 0.7 * Math.sqrt(1 - u / d) * (r() * 2 - 1))
  return out
}

function writeWav(path: string, samples: Float32Array): void {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++)
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(RATE, 24)
  head.writeUInt32LE(RATE * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([head, data]))
}

/** What view a stretch of home's clock shows in a cut: home, another player's, or everyone. */
function viewAt(cut: Cut, resolved: Resolved, homeSec: number): string | null {
  const piece = resolved.pieces.find((p) => p.source === 's1' && p.srcStart <= homeSec && homeSec < p.srcEnd)
  const beat = piece && cut.beats.find((b) => b.id === piece.beat)
  if (!beat) return null
  if (beat.treatment.grid) return 'grid'
  return beat.treatment.angle?.layout === 'full' ? beat.treatment.angle.source : 's1'
}

const circular = (a: number, b: number): number => {
  const d = (((a - b) % 256) + 256) % 256
  return Math.min(d, 256 - d)
}

describe.skipIf(!FFMPEG)('a gaming session from four players’ recordings', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  const paths: string[] = []

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-pov-'))
    for (const p of PLAYERS) {
      const wav = join(dir, `${p.n}.wav`)
      writeWav(wav, soundOf(p))
      const path = join(dir, `Lantern run pov-${p.n}.mp4`)
      ffmpegRun(ffmpeg, [
        '-f', 'lavfi', '-i',
        `color=black:s=${W}x${H}:r=${FPS}:d=${p.sec},format=rgb24,geq=r='8+16*mod(N,16)':g='8+16*mod(floor(N/16),16)':b=${p.blue}`,
        '-i', wav,
        '-vf', AS_SHOT, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-shortest', path
      ])
      paths.push(path)
    }
  }, 120_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** Whose picture a stretch of an exported frame is, and which of its frames (counted in 256s). */
  const shown = (path: string, frame: number, crop: string | null): { who: number; frame: number } => {
    const raw = execFileSync(
      ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-i', path,
        '-vf', `select=eq(n\\,${frame}),${crop ? `${crop},` : ''}${AS_PLAYED},scale=1:1:flags=area,format=rgb24`,
        '-frames:v', '1', '-f', 'rawvideo', '-'
      ],
      { maxBuffer: 1024 }
    )
    const who = PLAYERS.reduce((best, p) => (Math.abs(raw[2] - p.blue) < Math.abs(raw[2] - best.blue) ? p : best)).n
    return { who, frame: Math.round((raw[0] - 8) / 16) + 16 * Math.round((raw[1] - 8) / 16) }
  }

  it('lines the four up by the voice chat, cuts to whoever reacts and to everyone at once, and exports what the editor shows', async () => {
    const request = 'Our four POVs from last night, mine is pov-1. Make it fun.'
    const facts = await Promise.all(paths.map((p) => factsFor(p)))
    const found = await findSession(guessRoles(facts, request), facts, request)

    // Lined up by ear within a frame of where each really started.
    expect(found.talking).toEqual([paths[0]])
    expect(found.povs?.map((p) => p.path)).toEqual(paths.slice(1))
    for (const [i, p] of (found.povs ?? []).entries()) expect(Math.abs(p.offsetSec - PLAYERS[i + 1].offsetSec), p.path).toBeLessThan(FRAME)
    expect(found.reply).toBe(
      'This is one session from 4 players’ views: I lined Lantern run pov-2.mp4, Lantern run pov-3.mp4 and Lantern run pov-4.mp4 up with yours, Lantern run pov-1.mp4, by the voice chat. Lantern run pov-1.mp4 is yours, as you said.'
    )

    // The edit: the first player's recording and its words, the others as its views, each heard on its clock.
    const home = { id: 's1', path: paths[0], durationSec: PLAYERS[0].sec, width: W, height: H, fps: FPS }
    const start = createDoc({ id: 'pov', title: 'Lantern run', source: home, words: wordsFromTranscript(SAID, 's1') })
    const joined = joinViews(
      start,
      (found.povs ?? []).map((p, i) => ({
        path: p.path,
        offsetSec: p.offsetSec,
        camera: { path: p.path, durationSec: PLAYERS[i + 1].sec, width: W, height: H, fps: FPS }
      }))
    )
    const lined = commit(joined.doc, joined.ops, 'Lined up.')
    expect(lined.rejected).toEqual([])
    const stages: string[] = []
    const maps = await hearViews(lined.doc, (stage) => stages.push(stage), ffmpeg)
    expect(Object.keys(maps).sort()).toEqual(['s1', 's1@s2', 's1@s3', 's1@s4'])
    // Each view as it is heard, and all of them for the credits once done.
    expect(stages).toEqual([
      'Listening to Lantern run pov-2.mp4 (1 of 3)',
      'Listening to Lantern run pov-3.mp4 (2 of 3)',
      'Listening to Lantern run pov-4.mp4 (3 of 3)',
      'Listening to the other players’ views'
    ])
    const heard: EditDoc = { ...lined.doc, audio: { ...(lined.doc.audio ?? {}), ...maps } }

    // As it comes in: on yours, the others for their reactions, everyone at once where you all react.
    const plan = planPovs(heard, { mode: 'reactions', everyone: true, fill: true })
    if (!('ops' in plan)) throw new Error(plan.say)
    const made = commit(heard, [...plan.ops, { op: 'captions', set: { on: false } }, { op: 'loudness', lufs: null }], plan.summary)
    expect(made.rejected).toEqual([])
    const doc = made.doc
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    expect(plan.summary).toBe(
      'It stays on yours and cuts to the others for 3 reactions, back to yours each time. Everyone shows at once where you all react together. The play between your lines is in.'
    )
    // Each planted moment through the view of whoever made it; everyone at once where all four laugh.
    expect(viewAt(cut, resolved, 12.6)).toBe('s2')
    expect(viewAt(cut, resolved, 19.25)).toBe('s3')
    expect(viewAt(cut, resolved, 25.2)).toBe('s4')
    expect(viewAt(cut, resolved, 32.75)).toBe('grid')
    for (const t of [6, 16.5, 22.8, 30.6, 37]) expect(viewAt(cut, resolved, t), `${t} s`).toBe('s1')
    const grid = cut.beats.find((b) => b.treatment.grid)?.treatment.grid
    expect(grid?.panels.map((p) => [p.show, p.label])).toEqual([
      ['', 'pov-1'],
      ['s2', 'pov-2'],
      ['s3', 'pov-3'],
      ['s4', 'pov-4']
    ])
    // The whole of the first recording plays, in order, with no shot under the shortest.
    const shots: { view: string | null; sec: number }[] = []
    for (const p of resolved.pieces) {
      const v = viewAt(cut, resolved, (p.srcStart + p.srcEnd) / 2)
      const last = shots[shots.length - 1]
      if (last && last.view === v) last.sec += p.outEnd - p.outStart
      else shots.push({ view: v, sec: p.outEnd - p.outStart })
    }
    for (const s of shots) expect(s.sec, `${s.view}`).toBeGreaterThanOrEqual(MIN_SHOT_SEC - 1e-6)
    expect(resolved.durationSec).toBeGreaterThan(38)

    // The export.
    const out = await renderCut(
      cut,
      resolved,
      doc.sources.map((s) => ({ ...s, hasAudio: true })),
      { ffmpeg, outputPath: join(dir, 'session.mp4'), workDir: join(dir, 'work'), quality: 'preview', fontsDir: FONTS, assets: [] }
    )
    if (process.env.POV_KEEP) copyFileSync(out, process.env.POV_KEEP)

    // What the editor shows at a moment: the piece playing there, through its view, at the time it reads.
    const seen = viewThroughAngles(cut, resolved, doc.sources)
    const playing = (outSec: number) => {
      const piece = seen.resolved.pieces.find((p) => p.outStart <= outSec && outSec < p.outEnd)
      if (!piece) throw new Error(`Nothing plays at ${outSec}`)
      return piece
    }
    const ownerOf = (sourceId: string): number => {
      const s = doc.sources.find((x) => x.id === sourceId)
      return paths.indexOf(s?.path ?? '') + 1
    }
    const output = { width: W / 2, height: H / 2 }
    const design = frameSize(cut.aspect, home)
    const scale = output.width / design.width
    // At the middle of every shot, and a frame in from each end: whose picture, and which frame of it.
    const problems: string[] = []
    let at = 0
    for (const s of shots) {
      const first = Math.ceil(at * FPS + 0.01)
      const last = Math.floor((at + s.sec) * FPS - 0.01)
      for (const f of [first + 1, Math.round((first + last) / 2), last - 1]) {
        const t = f / FPS
        const piece = playing(t)
        const beat = cut.beats.find((b) => b.id === piece.beat)
        const g = beat?.treatment.grid
        if (!g) {
          const want = { who: ownerOf(piece.source.split('@').pop() as string), frame: Math.floor(pieceTime(piece, t) * FPS + 1e-6) }
          const got = shown(out, f, 'crop=iw*0.4:ih*0.4:iw*0.3:ih*0.3')
          // And the moment it is: where that player really was then, whatever the line-up found.
          const homeSec = resolved.pieces.find((p) => p.beat === piece.beat && p.outStart <= t && t < p.outEnd)
          const truth = Math.floor(((homeSec ? pieceTime(homeSec, t) : 0) + PLAYERS[want.who - 1].offsetSec) * FPS + 1e-6)
          if (got.who !== want.who) problems.push(`frame ${f}: player ${got.who}'s picture for ${want.who}'s`)
          else if (circular(got.frame, want.frame) > 1) problems.push(`frame ${f}: their frame ${got.frame} for ${want.frame}`)
          else if (circular(got.frame, truth) > 2) problems.push(`frame ${f}: their frame ${got.frame}, really ${truth % 256}`)
          continue
        }
        // A grid: each panel's picture at the time the editor gives it.
        const pictures = gridPictures(g, { id: 's1' }, { sources: doc.sources, assets: [] })
        const layout = gridLayout(design, g.panels.length, gridAspect(pictures))
        g.panels.forEach((panel, i) => {
          const r = layout.panels[i]
          const crop = `crop=${Math.round(r.w * scale * 0.3)}:${Math.round(r.h * scale * 0.3)}:${Math.round((r.x + r.w * 0.35) * scale)}:${Math.round((r.y + r.h * 0.4) * scale)}`
          const inStep = panelInStep(cut.angles, 's1', panel) ?? 0
          const want = { who: panel.show ? ownerOf(panel.show) : 1, frame: Math.floor((pieceTime(piece, t) + inStep) * FPS + 1e-6) }
          const got = shown(out, f, crop)
          if (got.who !== want.who) problems.push(`frame ${f}, panel ${i}: player ${got.who}'s picture for ${want.who}'s`)
          else if (circular(got.frame, want.frame) > 1) problems.push(`frame ${f}, panel ${i}: their frame ${got.frame} for ${want.frame}`)
        })
      }
      at += s.sec
    }
    expect(problems).toEqual([])
  }, 300_000)
})
