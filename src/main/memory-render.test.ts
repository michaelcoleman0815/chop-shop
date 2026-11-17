import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { cpus, tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { renderCut, type RenderSource } from './cut-render'
import { countFrames, findFfmpeg, frameColour, makeColourClip, toneLevel, type Rgb } from './test-media'
import { HAND_OVER, standIn } from './test-bin'

const FFMPEG = findFfmpeg()

/**
 * ffmpeg, its resident size polled while it renders: VmRSS, or ps where there
 * is no /proc, or on Windows the working set tasklist reports. The peak of
 * each render goes in a file; a render that passes the cap is stopped, so
 * one that balloons fails the test instead of taking the machine's memory.
 * Anything else ffmpeg is asked runs as it is.
 */
const WATCHING = String.raw`${HAND_OVER}
const { execFileSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const env = process.env
const real = env.CUTALONG_MEMORY_FFMPEG
const args = process.argv.slice(2)
const last = args[args.length - 1] || ''
if (!args.includes('-progress')) handOver(real, args)
const child = spawn(real, args, { stdio: 'inherit' })
/** The child's resident size in KB, or 0 when it cannot be read. */
function rss() {
  try {
    if (process.platform === 'linux') {
      const m = /^VmRSS:\s*(\d+)/m.exec(fs.readFileSync('/proc/' + child.pid + '/status', 'utf8'))
      return m ? Number(m[1]) : 0
    }
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'PID eq ' + child.pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
      const m = /"([^"]*) K"\s*$/m.exec(out)
      return m ? Number(m[1].replace(/\D/g, '')) : 0
    }
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()) || 0
  } catch {
    return 0
  }
}
let peak = 0
let running = true
const poll = () => {
  if (!running) return
  peak = Math.max(peak, rss())
  if (peak > Number(env.CUTALONG_MEMORY_CAP_KB)) child.kill('SIGKILL')
  else setTimeout(poll, process.platform === 'win32' ? 200 : 50)
}
poll()
child.on('exit', (code, signal) => {
  running = false
  fs.appendFileSync(env.CUTALONG_MEMORY_PEAKS, peak + ' ' + path.basename(last) + '\n')
  if (signal && process.platform !== 'win32') process.kill(process.pid, signal)
  process.exit(code === null ? 1 : code)
})
`

/**
 * What any pass may hold, in MB. Most of it is the encoder's: x264 at
 * 1080 x 1920 held about 550 MB on four cores, and ffmpeg gives it more
 * threads on more cores, about 40 MB a core. Every pass of this export held
 * 650 to 710 MB on four cores with ffmpeg 6.0, 6.1 and 7.0; in one pass the
 * same nine pieces passed 1.5 GB within seconds, and the app's export of a
 * clip like this held more than 7 GB before the system stopped it.
 */
const BOUND_MB = 1000 + 40 * Math.max(0, cpus().length - 4)
/** Where the stand-in stops a render, so a cut that balloons cannot hurt a shared machine. */
const CAP_MB = BOUND_MB + 500

/**
 * An export of a cut made of many pieces of one long recording, as every
 * /clipping clip is: nine pieces of a wide recording, each its own colour and
 * tone, exported vertical with captions and loudness, through a stand-in that
 * watches ffmpeg's memory.
 */
describe.skipIf(!FFMPEG)('the memory an export of many pieces holds', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let sources: RenderSource[]
  const colours: Rgb[] = [
    [255, 0, 0],
    [0, 0, 255],
    [0, 255, 0],
    [255, 255, 0],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
    [0, 0, 0],
    [128, 128, 128]
  ]
  // Half an octave apart, so each stands well clear of the next.
  const hz = (k: number): number => Math.round(220 * 2 ** (k / 2))
  // A second or so of each colour, each a little longer than the last, so the cuts fall between frames.
  const pieces = colours.map((_, k) => ({ inSec: 1.6 * k + 0.2, outSec: 1.6 * k + 1.2 + 0.037 * k }))

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-memory-'))
    const hex = (c: Rgb): string => `0x${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
    const path = makeColourClip(
      ffmpeg,
      join(dir, 'service.mp4'),
      colours.map((c, k) => ({ color: hex(c), hz: hz(k), sec: 1.6 })),
      '1280x720'
    )
    const source = { id: 's1', path, durationSec: 1.6 * colours.length, width: 1280, height: 720, fps: 30 }
    sources = [{ ...source, hasAudio: true }]
    // A word every 0.4 s, for the captions a clip has.
    const said = Array.from({ length: 36 }, (_, i) => ({ text: `word${i}`, startSec: 0.4 * i, endSec: 0.4 * i + 0.3 }))
    doc = createDoc({ id: 'd', title: 'Service', source, words: wordsFromTranscript(said, 's1') })
    standIn(join(dir, 'watching-ffmpeg'), WATCHING)
    Object.assign(process.env, {
      CUTALONG_MEMORY_FFMPEG: ffmpeg,
      CUTALONG_MEMORY_CAP_KB: String(CAP_MB * 1024),
      CUTALONG_MEMORY_PEAKS: join(dir, 'peaks')
    })
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const nearest = (c: Rgb): number => {
    const d = colours.map((r) => Math.abs(r[0] - c[0]) + Math.abs(r[1] - c[1]) + Math.abs(r[2] - c[2]))
    return d.indexOf(Math.min(...d))
  }

  it('holds a bounded amount however many pieces the cut has, and plays each where it belongs', async () => {
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'remove', beats: currentCut(doc).beats.map((b) => b.id) },
        ...pieces.map((p, k) => ({ op: 'insert', to: k, beat: { source: 's1', ...p } })),
        { op: 'aspect', aspect: 'vertical' }
      ],
      { words: doc.words, sources: doc.sources }
    )
    expect(r.rejected).toEqual([])
    const cut = r.cut
    expect(cut.captions.on).toBe(true)
    expect(cut.loudness).not.toBeNull()
    const resolved = resolveCut(cut, doc.words, doc.sources)
    expect(resolved.pieces).toHaveLength(9)

    const out = join(dir, 'nine.mp4')
    let stopped: string | null = null
    await renderCut(cut, resolved, sources, {
      ffmpeg: join(dir, 'watching-ffmpeg'),
      outputPath: out,
      workDir: join(dir, 'work'),
      quality: 'final'
    }).catch((err: Error) => (stopped = err.message))
    const peaks = readFileSync(process.env.CUTALONG_MEMORY_PEAKS as string, 'utf8')
      .trim()
      .split('\n')
      .map((line) => ({ mb: Math.round(Number(line.split(' ')[0]) / 1024), file: line.split(' ')[1] }))
    const said = peaks.map((p) => `${p.file} ${p.mb} MB`).join(', ')
    expect(stopped, `stopped: ${said}`).toBeNull()
    // In passes of a few pieces, then one that reads them back.
    expect(peaks.length).toBeGreaterThan(2)
    for (const p of peaks) expect(p.mb, `${said}; bound ${BOUND_MB} MB`).toBeLessThan(BOUND_MB)

    // Every frame, each piece's picture and sound where it plays.
    expect(countFrames(ffmpeg, out)).toBe(Math.round(resolved.durationSec * 30))
    resolved.pieces.forEach((p, k) => {
      const mid = (p.outStart + p.outEnd) / 2
      // Above the captions, which sit at chest height.
      expect(nearest(frameColour(ffmpeg, out, mid, { x: 0.2, y: 0.1, w: 0.6, h: 0.3 })), `piece ${k}`).toBe(k)
      const own = toneLevel(ffmpeg, out, mid - 0.2, 0.4, hz(k))
      const next = toneLevel(ffmpeg, out, mid - 0.2, 0.4, hz((k + 1) % colours.length))
      expect(own, `piece ${k}'s tone`).toBeGreaterThan(next + 20)
    })
  }, 300_000)
})
