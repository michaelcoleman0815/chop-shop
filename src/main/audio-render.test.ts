import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyOps,
  createDoc,
  currentCut,
  resolveCut,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Resolved
} from '../shared/edit'
import { renderCut, type RenderSource } from './cut-render'
import { ffmpegRun, findFfmpeg, loudnessOf, meanLevel, onsets, toneLevel } from './test-media'

const FFMPEG = findFfmpeg()

/**
 * The sound of a finished video measured for real: a voice cleaned up, and a
 * music bed that dips under speech. The "voice" is a 220 Hz buzz with its
 * harmonics, spoken in words, over a hiss floor, a 40 Hz rumble and sharp
 * 7 kHz esses; the "music" is a steady 1 kHz tone, so its level can be read
 * apart from the voice at any moment. A two-second shot with no one speaking
 * sits between the first two sentences, for the bed to come up in.
 */
describe.skipIf(!FFMPEG)('rendering voice polish and a music bed', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let sources: RenderSource[]
  let music = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-audio-'))
    // Sentences of four words, 0.4 s each and 0.2 s apart, 2.5 s between sentences.
    const said: { text: string; startSec: number; endSec: number }[] = []
    let t = 0.5
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 4; i++) {
        said.push({ text: i === 3 ? `end${s}.` : `word${s}${i}`, startSec: t, endSec: t + 0.4 })
        t += i === 3 ? 2.9 : 0.6
      }
    }
    const duration = Math.ceil(t)
    const gate = said.map((w) => `between(t,${w.startSec},${w.endSec})`).join('+')
    // Esses: 80 ms of 7 kHz at the start of every other word.
    const esses = said
      .filter((_, i) => i % 2 === 0)
      .map((w) => `between(t,${w.startSec},${w.startSec + 0.08})`)
      .join('+')
    const voice =
      `aevalsrc=exprs='(0.25*sin(2*PI*220*t)+0.12*sin(2*PI*440*t)+0.06*sin(2*PI*660*t))*(${gate})` +
      `+0.12*sin(2*PI*7000*t)*(${esses})+0.05*sin(2*PI*40*t)':s=48000:d=${duration}[v];` +
      `anoisesrc=a=0.006:c=white:r=48000:d=${duration}[n];[v][n]amix=inputs=2:normalize=0[a]`
    const path = join(dir, 'take.mov')
    ffmpegRun(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      `color=gray:s=320x180:r=30:d=${duration}`,
      '-filter_complex',
      voice,
      '-map',
      '0:v',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'pcm_s16le',
      path
    ])
    const source = { id: 's1', path, durationSec: duration, width: 320, height: 180, fps: 30 }
    sources = [{ ...source, hasAudio: true }]
    doc = createDoc({ id: 'd', title: 'T', source, words: wordsFromTranscript(said, 's1') })
    music = join(dir, 'bed.wav')
    ffmpegRun(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=48000:duration=3',
      '-af',
      'volume=0.5',
      music
    ])
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** The cut: the three sentences, a quiet held shot after the first, any extra ops. */
  const withOps = (ops: unknown[]): Cut => {
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'aspect', aspect: 'original' },
        { op: 'insert', to: 1, beat: { source: 's1', inSec: 2.9, outSec: 4.9 } },
        ...ops
      ],
      { words: doc.words, sources: doc.sources }
    )
    expect(r.rejected).toEqual([])
    return r.cut
  }
  const render = async (cut: Cut, name: string): Promise<{ out: string; resolved: Resolved }> => {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const out = await renderCut(cut, resolved, sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'final'
    })
    return { out, resolved }
  }
  /** The middle second of the quiet shot. */
  const quiet = (resolved: Resolved): { from: number; len: number } => {
    const b = resolved.beats[1]
    return { from: (b.outStart + b.outEnd) / 2 - 0.5, len: 1 }
  }

  it('cleans up the voice and still lands on the loudness target', async () => {
    const plain = await render(withOps([]), 'plain')
    const polished = await render(withOps([{ op: 'voice', polish: 1 }]), 'polished')
    const word = plain.resolved.words[1]
    const gap = quiet(plain.resolved)
    const voice = (out: string): number => toneLevel(ffmpeg, out, word.outStart + 0.05, 0.3, 220)
    // Rumble at 40 Hz, against the voice.
    const rumble = (out: string): number => toneLevel(ffmpeg, out, gap.from, gap.len, 40) - voice(out)
    expect(rumble(polished.out)).toBeLessThan(rumble(plain.out) - 15)
    // Hiss in the quiet shot, against the voice.
    const hiss = (out: string): number => meanLevel(ffmpeg, out, gap.from, gap.len, 'highpass=f=1500') - voice(out)
    expect(hiss(polished.out)).toBeLessThan(hiss(plain.out) - 6)
    // Esses, against the voice.
    const ess = (out: string): number => toneLevel(ffmpeg, out, word.outStart - 0.6, 0.08, 7000) - voice(out)
    expect(ess(polished.out)).toBeLessThan(ess(plain.out) - 2)
    // The words land where they did: the denoiser's and limiter's delays are taken back.
    const voiceBand = 'bandpass=f=220:width_type=q:w=4,bandpass=f=220:width_type=q:w=4'
    const was = onsets(ffmpeg, plain.out, -35, 0.1, voiceBand)
    const now = onsets(ffmpeg, polished.out, -35, 0.1, voiceBand)
    expect(now.length).toBe(was.length)
    now.forEach((t, i) => expect(Math.abs(t - was[i]) * 1000, `word onset ${i}`).toBeLessThan(3))
    // Both at the target, peaks under it.
    for (const out of [plain.out, polished.out]) {
      const l = loudnessOf(ffmpeg, out)
      expect(Math.abs(l.lufs + 14)).toBeLessThan(1)
      expect(l.truePeak).toBeLessThan(-0.5)
    }
  })

  it('lays a bed under the voice that dips while anyone speaks', async () => {
    const { out, resolved } = await render(
      withOps([{ op: 'music', set: { path: music, lufs: loudnessOf(ffmpeg, music).lufs, fadeInSec: 0.5 } }]),
      'bed'
    )
    const gap = quiet(resolved)
    const w = resolved.words[5]
    const under = toneLevel(ffmpeg, out, w.outStart + 0.05, 0.3, 1000)
    const alone = toneLevel(ffmpeg, out, gap.from, gap.len, 1000)
    // 12 dB down under the words, give or take.
    expect(alone - under).toBeGreaterThan(10)
    expect(alone - under).toBeLessThan(14)
    // Alone, about 12 dB under the voice.
    const voice = toneLevel(ffmpeg, out, w.outStart + 0.05, 0.3, 220)
    expect(Math.abs(voice - alone - 12)).toBeLessThan(4)
    // Faded in at the start; still playing, dipped, past the 3 s the track lasts.
    expect(toneLevel(ffmpeg, out, 0, 0.08, 1000)).toBeLessThan(alone - 6)
    expect(w.outStart).toBeGreaterThan(3)
    expect(Math.abs(loudnessOf(ffmpeg, out).lufs + 14)).toBeLessThan(1)
  })
})
