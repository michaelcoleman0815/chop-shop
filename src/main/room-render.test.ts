import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc, type Resolved } from '../shared/edit'
import { renderCut, type RenderSource } from './cut-render'
import { MOST_BOOST_DB } from './render/levels'
import { ffmpegRun, findFfmpeg, loudnessOf, meanLevel, onsets, toneLevel } from './test-media'

const FFMPEG = findFfmpeg()

/**
 * A quiet voice across a room, rendered for real: a 220 Hz buzz with its
 * harmonics, spoken in words 0.6 s apart, the last sentence 10 dB softer, over
 * pink noise as air handling makes it. Turned up to -14 LUFS, the room comes
 * up with it; a voice in a room (Voice.room) has the room taken down and the
 * pauses dipped, and a voice too quiet to reach the target is turned up only
 * so far.
 */
describe.skipIf(!FFMPEG)('a quiet voice in a room', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  const said: { text: string; startSec: number; endSec: number }[] = []
  let duration = 0

  /** A take of the voice `voiceDb` under the usual, over a room `roomAmp` loud, with an amen in one pause. */
  const take = (name: string, voiceDb: number, roomAmp: number): { doc: EditDoc; sources: RenderSource[] } => {
    const gate = (soft: boolean): string =>
      said
        .filter((w) => w.text.startsWith('soft') === soft)
        .map((w) => `between(t,${w.startSec},${w.endSec})`)
        .join('+')
    const g = Math.pow(10, voiceDb / 20)
    const buzz = '(0.25*sin(2*PI*220*t)+0.12*sin(2*PI*440*t)+0.06*sin(2*PI*660*t))'
    // The amen: 1 kHz in the middle of the pause after the second word, as loud as the voice, and not a word.
    const amen = `0.15*sin(2*PI*1000*t)*between(t,${AMEN[0]},${AMEN[1]})`
    const graph =
      `aevalsrc=exprs='${g}*(${buzz}*((${gate(false)})+0.316*(${gate(true)}))+${amen})':s=48000:d=${duration}[v];` +
      `anoisesrc=a=${roomAmp}:c=pink:r=48000:d=${duration}:seed=3[n];[v][n]amix=inputs=2:normalize=0[a]`
    const path = join(dir, `${name}.mov`)
    ffmpegRun(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      `color=gray:s=320x180:r=30:d=${duration}`,
      '-filter_complex',
      graph,
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
    return {
      doc: createDoc({ id: name, title: 'T', source, words: wordsFromTranscript(said, 's1') }),
      sources: [{ ...source, hasAudio: true }]
    }
  }
  const AMEN: [number, number] = [2.12, 2.32]

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-room-'))
    // Three sentences of four words, 0.5 s each and 0.6 s apart, the last one soft.
    let t = 0.3
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 4; i++) {
        said.push({ text: `${s === 2 ? 'soft' : 'word'}${s}${i}${i === 3 ? '.' : ''}`, startSec: t, endSec: t + 0.5 })
        t += 1.1
      }
    }
    duration = Math.ceil(t)
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const render = async (
    t: { doc: EditDoc; sources: RenderSource[] },
    ops: unknown[],
    name: string
  ): Promise<{ out: string; resolved: Resolved }> => {
    const r = applyOps(currentCut(t.doc), [{ op: 'aspect', aspect: 'original' }, { op: 'loudness', lufs: -14 }, ...ops], {
      words: t.doc.words,
      sources: t.doc.sources
    })
    expect(r.rejected).toEqual([])
    const resolved = resolveCut(r.cut, t.doc.words, t.doc.sources)
    const out = await renderCut(r.cut, resolved, t.sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'final'
    })
    return { out, resolved }
  }

  // On the video's clock: a word's buzz, and the room in the middle of the pause after a word, against the buzz.
  type Made = { out: string; resolved: Resolved }
  const buzzOf = (m: Made, k: number): number => toneLevel(ffmpeg, m.out, m.resolved.words[k].outStart + 0.1, 0.3, 220)
  const voice = (m: Made): number => buzzOf(m, 4)
  const room = (m: Made, k: number): number => meanLevel(ffmpeg, m.out, m.resolved.words[k].outEnd + 0.2, 0.2) - voice(m)

  it('takes the room down and dips its pauses, and keeps every word where it was', async () => {
    // A voice about 18 dB under the target, over a room 30 dB under the voice.
    const t = take('noisy', -18, 0.004)
    const plain = await render(t, [], 'noisy-plain')
    const cleaned = await render(t, [{ op: 'voice', polish: 0, room: true }], 'noisy-room')
    // Pauses the cut keeps whole: those inside a beat (between beats it keeps 0.2 s).
    for (const k of [5, 6, 9]) expect(room(cleaned, k), `the pause after word ${k}`).toBeLessThan(room(plain, k) - 10)
    // The voice is as loud against the target as it was, and the soft sentence is not taken for the room.
    expect(Math.abs(voice(cleaned) - voice(plain))).toBeLessThan(1.5)
    expect(Math.abs(buzzOf(cleaned, 9) - buzzOf(plain, 9))).toBeLessThan(2)
    // The amen in a pause is not dipped.
    const amen = (m: Made): number => {
      const at = m.resolved.words[1].outEnd + (AMEN[0] - said[1].endSec) + 0.05
      return toneLevel(ffmpeg, m.out, at, 0.1, 1000) - voice(m)
    }
    expect(Math.abs(amen(cleaned) - amen(plain))).toBeLessThan(1.5)
    // Every word lands where it did: the print and afftdn's delay come off exactly.
    const band = 'bandpass=f=220:width_type=q:w=4,bandpass=f=220:width_type=q:w=4'
    const was = onsets(ffmpeg, plain.out, -40, 0.1, band)
    const now = onsets(ffmpeg, cleaned.out, -40, 0.1, band)
    expect(now.length).toBe(said.length)
    expect(now.length).toBe(was.length)
    now.forEach((at, i) => expect(Math.abs(at - was[i]) * 1000, `word onset ${i}`).toBeLessThan(3))
    // Both near the target (loudnorm in one pass lands within a dB and a half of it on 11 s), peaks under it.
    for (const m of [plain, cleaned]) {
      const l = loudnessOf(ffmpeg, m.out)
      expect(Math.abs(l.lufs + 14), `${l.lufs} LUFS`).toBeLessThan(1.5)
      expect(l.truePeak).toBeLessThan(-0.5)
    }
  })

  it(`turns a voice too quiet to reach the target up ${MOST_BOOST_DB} dB and no further`, async () => {
    const t = take('whisper', -36, 0.0005)
    const heard = loudnessOf(ffmpeg, t.sources[0].path).lufs
    expect(heard).toBeLessThan(-14 - MOST_BOOST_DB - 2)
    const { out } = await render(t, [], 'whisper')
    expect(Math.abs(loudnessOf(ffmpeg, out).lufs - (heard + MOST_BOOST_DB))).toBeLessThan(1.5)
  })
})
