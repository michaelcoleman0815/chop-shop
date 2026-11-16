import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AudioMap } from '../shared/audio/map'
import { estimateOffset as lineUpByEar, shiftEnvelope as onClipClock } from '../shared/audio/offset'
import { snapWords, type Envelope } from '../shared/audio/snap'
import {
  applyOps,
  createDoc,
  currentCut,
  resolveCut,
  wordsFromTranscript,
  type Source,
  type Word
} from '../shared/edit'
import { BUILT_IN_PRESETS, planStyle } from '../shared/presets'
import type { MouthResult } from '../shared/vision/analyse'
import type { FaceSample } from '../shared/vision/faces'
import { heardFrom } from '../shared/vision/offset'
import {
  detections,
  makeRenderer,
  readStamp,
  take,
  voiceSamples,
  wav,
  type Take,
  type TakeOptions,
  type VoiceLine
} from '../shared/vision/synthetic'
import { loudnessEnvelope } from './audio-envelope'
import { renderCut } from './cut-render'
import { displaySize, measureMouth, watchClip, watchMouth, type FaceDetector } from './mouth'

function findFfmpeg(): string | null {
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg']
  try {
    candidates.splice(1, 0, require('ffmpeg-static') as string)
  } catch {
    // Not installed in this checkout; the system one will do.
  }
  for (const bin of candidates) {
    if (!bin) continue
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}

const FFMPEG = findFfmpeg()
const ESPEAK = spawnSync('espeak-ng', ['--version']).status === 0 ? 'espeak-ng' : null
const FPS = 30

/** Renders a take's frames in JS and pipes them to ffmpeg with its voice, as an H.264 and AAC file. */
async function encode(
  ffmpeg: string,
  t: Take,
  lines: VoiceLine[],
  offsetSec: number,
  path: string,
  extra?: string[]
): Promise<void> {
  const rate = 48000
  const wavPath = path.replace(/\.mp4$/, '.wav')
  writeFileSync(wavPath, wav(voiceSamples(lines, rate, t.durationSec, offsetSec), rate))
  const { scene } = t
  const render = makeRenderer(scene)
  const n = Math.round(t.durationSec * scene.fps)
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-s',
      `${scene.width}x${scene.height}`,
      '-r',
      String(scene.fps),
      '-i',
      '-',
      '-i',
      wavPath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-g',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
      ...(extra ?? []),
      path
    ])
    let err = ''
    ff.stderr.on('data', (d) => (err += d))
    ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err))))
    const frame = new Uint8Array(scene.width * scene.height)
    let i = 0
    const pump = (): void => {
      while (i < n) {
        render(i / scene.fps, frame)
        i++
        if (!ff.stdin.write(Buffer.from(frame))) {
          ff.stdin.once('drain', pump)
          return
        }
      }
      ff.stdin.end()
    }
    pump()
  })
}

/** Boxes as the Mac's Vision helper reports them: a few a second, times relative to where it started. */
const detectorFor =
  (t: Take, perSec = 4): FaceDetector =>
  async (_path, startSec, durationSec) =>
    detections(t.scene, perSec)
      .filter((s) => s.t >= startSec && s.t <= startSec + durationSec)
      .map((s): FaceSample => ({ t: s.t - startSec, faces: s.faces }))

/** What transcription hands over: loose word times on the sound's clock, then snapped to the sound. */
function transcribed(t: Take, env: Envelope, offsetSec: number): Word[] {
  const loose = t.words.map((w) => ({
    text: w.text,
    startSec: Math.max(0, w.onsetSec + offsetSec - 0.09),
    endSec: w.endSec + offsetSec + 0.11
  }))
  const asked = t.offCamera.map(([a, b], k) => ({ text: `q${k + 1}`, startSec: a + offsetSec, endSec: b + offsetSec }))
  return snapWords(wordsFromTranscript([...loose, ...asked], 's1'), env)
}

const sourceFor = (t: Take, path: string): Source => ({
  id: 's1',
  path,
  durationSec: t.durationSec,
  width: t.scene.width,
  height: t.scene.height,
  fps: t.scene.fps
})

describe.skipIf(!FFMPEG)('watching the mouth in real footage', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  interface Watched {
    take: Take
    path: string
    words: Word[]
    env: Envelope
    result: MouthResult | null
  }
  const watched = new Map<string, Watched>()

  async function watch(name: string, opts: TakeOptions, offsetSec: number, detect?: FaceDetector): Promise<Watched> {
    const hit = watched.get(name)
    if (hit) return hit
    const t = take(opts)
    const path = join(dir, `${name}.mp4`)
    await encode(ffmpeg, t, t.lines, offsetSec, path)
    const env = await loudnessEnvelope(ffmpeg, path)
    const words = transcribed(t, env, offsetSec)
    const result = await watchMouth({
      ffmpeg,
      source: sourceFor(t, path),
      words,
      envelope: env,
      detect: detect ?? detectorFor(t)
    })
    const w = { take: t, path, words, env, result }
    watched.set(name, w)
    return w
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-mouth-'))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  for (const planted of [0, 0.04, 0.12, 0.2]) {
    it(`measures a sound ${Math.round(planted * 1000)} ms behind the mouth to within 15 ms`, async () => {
      const { result } = await watch(`offset-${planted}`, { seed: 3, words: 14 }, planted)
      expect(result?.estimate).toBeTruthy()
      expect(Math.abs((result?.estimate?.offsetSec ?? 9) - planted)).toBeLessThan(0.015)
      expect(result?.estimate?.confidence).toBeGreaterThanOrEqual(0.6)
      if (planted > 1 / FPS) {
        expect(result?.source.audioOffsetSec).toBeCloseTo(planted, 1)
        expect(result?.notice).toMatch(/^Your audio was 0\.\d+ s behind your mouth\. I lined it up\.$/)
      } else expect(result?.source.audioOffsetSec).toBeUndefined()
    })
  }

  it('times cuts to the mouth to within a frame, through H.264', async () => {
    const { take: t, result } = await watch('offset-0.12', { seed: 3, words: 14 }, 0.12)
    const words = (result?.words ?? []).filter((w) => /^w\d+$/.test(w.text))
    expect(words).toHaveLength(t.words.length)
    words.forEach((w, i) => {
      const rest = Math.floor(t.words[i].openSec * FPS + 1e-9)
      const settle = Math.ceil(t.words[i].settleSec * FPS - 1e-9)
      expect(w.stillBefore && w.stillAfter).toBeTruthy()
      expect(Math.abs(Math.round(((w.stillBefore as [number, number])[1] + 0.0005) * FPS) - rest)).toBeLessThanOrEqual(
        1
      )
      expect(Math.abs(Math.round((w.stillAfter as [number, number])[0] * FPS - 0.5) - settle)).toBeLessThanOrEqual(1)
    })
  })

  it('does not read nods as talking', async () => {
    const { take: t, result } = await watch('offset-0.12', { seed: 3, words: 14 }, 0.12)
    const series = result?.series
    expect(series).toBeTruthy()
    let frames = 0
    let talking = 0
    series?.times.forEach((time, i) => {
      if (!t.nods.some(([a, b]) => time >= a && time <= b) || !Number.isFinite(series.talk[i])) return
      frames++
      if (series.talk[i] > 0.3) talking++
    })
    expect(frames).toBeGreaterThan(20)
    expect(talking / frames).toBeLessThan(0.05)
  })

  it('marks a question from off camera', async () => {
    const base = take({ seed: 6, words: 12 })
    const ask: [number, number] = [base.words[6].settleSec + 0.3, base.words[6].settleSec + 2.1]
    const { result } = await watch('off-camera', { seed: 6, words: 12, offCamera: [ask] }, 0.08)
    expect(result?.words.filter((w) => w.offCamera).map((w) => w.text)).toEqual(['q1'])
    expect(result?.notice).toContain('Someone off camera speaks at')
  })

  it('works on vertical footage', async () => {
    const { result } = await watch(
      'vertical',
      { seed: 9, words: 12, width: 180, height: 320, size: 0.42, cy: 0.38 },
      0.12
    )
    expect(Math.abs((result?.estimate?.offsetSec ?? 9) - 0.12)).toBeLessThan(0.015)
    expect(result?.words.filter((w) => w.stillBefore).length).toBeGreaterThan(8)
  })

  it('keeps sound-only timing when there is no face, or no face detector on this computer', async () => {
    const { words, result } = await watch('no-face', { seed: 4, words: 8 }, 0.12, async () => [])
    expect(result?.words).toEqual(words)
    expect(result?.source.audioOffsetSec).toBeUndefined()
    expect(result?.notice).toBeNull()
    const t = take({ seed: 4, words: 8 })
    const none = await watchMouth({
      ffmpeg,
      source: sourceFor(t, join(dir, 'no-face.mp4')),
      words,
      envelope: null,
      detect: async () => {
        throw new Error('chopshop-vision is missing. Run scripts/build-native.sh.')
      }
    })
    expect(none).toBeNull()
  })

  it('renders the sound lined up with the mouth', async () => {
    const { take: t, path, result } = await watch('offset-0.12', { seed: 3, words: 14 }, 0.12)
    const r = result as MouthResult
    const doc = createDoc({ id: 'd', title: 'take', source: r.source, words: r.words, at: '2026-11-16T00:00:00.000Z' })
    const base = currentCut(doc)
    // One beat, captions off: just the picture and the sound of a few words.
    const cut = { ...base, beats: [base.beats[1]], captions: { ...base.captions, on: false }, loudness: null }
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const piece = resolved.pieces[0]
    const firstWord = r.words.find((w) => w.id === cut.beats[0].from) as Word
    const truth = t.words[Number(firstWord.text.slice(1)) - 1]
    const onsetIn = async (file: string): Promise<number> => {
      const env = await loudnessEnvelope(ffmpeg, file)
      const peak = Math.max(...Array.from(env.db))
      const i = Array.from(env.db).findIndex((v) => v > peak - 20)
      return i * env.hopSec
    }
    for (const [name, source] of [
      ['lined-up', doc.sources[0]],
      ['as-recorded', { ...doc.sources[0], audioOffsetSec: undefined }]
    ] as const) {
      const out = join(dir, `${name}.mp4`)
      await renderCut(cut, resolved, [{ ...source, hasAudio: true }], {
        ffmpeg,
        outputPath: out,
        workDir: join(dir, `work-${name}`),
        quality: 'preview'
      })
      const expected = truth.onsetSec - piece.srcStart + (name === 'lined-up' ? 0 : 0.12)
      expect(Math.abs((await onsetIn(out)) - expected)).toBeLessThan(0.02)
    }
    expect(existsSync(path)).toBe(true)
  })

  it('lines up the better sound from another recording with the mouth, on top of lining it up by ear', async () => {
    // The camera hears the voice 0.12 s late, through a wireless microphone;
    // a recorder on the speaker hears it in time, and started 1.5 s earlier.
    const t = take({ seed: 6, words: 14 })
    const camera = join(dir, 'two-recorders.mp4')
    await encode(ffmpeg, t, t.lines, 0.12, camera)
    const recorder = join(dir, 'two-recorders-recorder.wav')
    writeFileSync(recorder, wav(voiceSamples(t.lines, 48000, t.durationSec + 1.5, 1.5), 48000))
    // As intake does it: by ear first, then the recorder's words and loudness on the clip's clock.
    const byEar = lineUpByEar(await loudnessEnvelope(ffmpeg, camera), await loudnessEnvelope(ffmpeg, recorder))
    expect(byEar && Math.abs(byEar.offsetSec - 1.38)).toBeLessThan(0.015)
    const at = (byEar as { offsetSec: number }).offsetSec
    const heard = onClipClock(await loudnessEnvelope(ffmpeg, recorder), at, t.durationSec)
    const words = transcribed(t, heard, 0.12)
    const map: AudioMap = {
      v: 1,
      words: {},
      segments: [{ kind: 'laughter', startSec: 4, endSec: 4.5 }],
      emphasis: [],
      level: { floor: -60, speech: -20 }
    }
    const w = await watchClip(
      { source: { ...sourceFor(t, camera), audio: { path: recorder, offsetSec: at } }, words, envelope: heard, map },
      detectorFor(t),
      ffmpeg
    )
    const d = w.source.audioOffsetSec ?? 0
    expect(Math.abs(d - 0.12)).toBeLessThan(0.015)
    // Picture t plays the recorder at t + 1.5: the two offsets add up.
    expect(Math.abs((heardFrom(w.source)?.offsetSec ?? 0) - 1.5)).toBeLessThan(0.02)
    expect(heardFrom(w.source)?.path).toBe(recorder)
    // The sound's stretches moved with the words.
    expect(w.map?.segments[0].startSec).toBeCloseTo(4 - d, 6)

    // And the export plays the recorder's voice on the mouth.
    const doc = createDoc({ id: 'd', title: 'take', source: w.source, words: w.words, at: '2026-11-16T00:00:00.000Z' })
    const base = currentCut(doc)
    const cut = { ...base, beats: [base.beats[1]], captions: { ...base.captions, on: false }, loudness: null }
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const piece = resolved.pieces[0]
    const first = w.words.find((x) => x.id === cut.beats[0].from) as Word
    const truth = t.words[Number(first.text.slice(1)) - 1]
    const out = join(dir, 'two-recorders-out.mp4')
    await renderCut(cut, resolved, [{ ...w.source, hasAudio: true }], {
      ffmpeg,
      outputPath: out,
      workDir: join(dir, 'work-two-recorders'),
      quality: 'preview'
    })
    const env = await loudnessEnvelope(ffmpeg, out)
    const peak = Math.max(...Array.from(env.db))
    const onset = Array.from(env.db).findIndex((v) => v > peak - 20) * env.hopSec
    expect(Math.abs(onset - (truth.onsetSec - piece.srcStart))).toBeLessThan(0.025)
  })

  it('opens every /snappy cut of the export on a still mouth, frame for frame', async () => {
    // Each source frame carries its number, so the export can be read back.
    const { take: t, path, result } = await watch('stamped', { seed: 3, words: 10, stamp: true }, 0.12)
    const r = result as MouthResult
    const doc = createDoc({ id: 'd', title: 'take', source: r.source, words: r.words, at: '2026-11-16T00:00:00.000Z' })
    const snappy = BUILT_IN_PRESETS.find((p) => p.command === 'snappy')
    const plan = planStyle(doc, snappy?.style ?? {})
    const snapped = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources }).cut
    const cut = { ...snapped, captions: { ...snapped.captions, on: false }, loudness: null }
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const out = join(dir, 'snappy.mp4')
    await renderCut(cut, resolved, [{ ...doc.sources[0], hasAudio: true }], {
      ffmpeg,
      outputPath: out,
      workDir: join(dir, 'work-snappy'),
      quality: 'final'
    })
    const { width: W, height: H } = t.scene
    const raw = spawnSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
      {
        maxBuffer: 1 << 28
      }
    ).stdout
    const stamps: number[] = []
    for (let i = 0; i + W * H <= raw.length; i += W * H) stamps.push(readStamp(raw.subarray(i, i + W * H), W))
    expect(stamps.every((s) => s >= 0)).toBe(true)
    // Where the source frame number jumps is a cut; each must open where it was planned, on a still mouth.
    const opening = [stamps[0], ...stamps.filter((s, i) => i > 0 && s !== stamps[i - 1] + 1)]
    expect(opening).toEqual(resolved.pieces.map((p) => Math.ceil(p.srcStart * FPS - 1e-6)))
    // At rest or just starting: under 15% of how wide that word opens.
    for (const f of opening) {
      const word = t.words.find((w) => f / FPS <= w.settleSec) ?? t.words[0]
      expect(t.scene.faces[0].mouth(f / FPS) / word.peak).toBeLessThan(0.15)
    }
    expect(existsSync(path)).toBe(true)
  })

  it('reads the size of footage stored on its side', async () => {
    const src = join(dir, 'offset-0.mp4')
    await watch('offset-0', { seed: 3, words: 14 }, 0)
    const rotated = join(dir, 'rotated.mp4')
    const made = spawnSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-display_rotation',
      '90',
      '-i',
      src,
      '-c',
      'copy',
      rotated
    ])
    if (made.status !== 0) return
    expect(await displaySize(ffmpeg, rotated, { width: 320, height: 180 })).toEqual({ width: 180, height: 320 })
    expect(await displaySize(ffmpeg, src, { width: 320, height: 180 })).toEqual({ width: 320, height: 180 })
  })

  const plan = {
    width: 320,
    height: 180,
    tileW: 64,
    tileH: 72,
    slots: [{ w: 100, h: 112, windows: [{ fromSec: 0, x: 0, y: 0, track: 0 }] }],
    tracks: [
      {
        id: 0,
        points: [
          { t: 0, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.5 } },
          { t: 1, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.5 } }
        ]
      }
    ]
  }

  it('fails cleanly on a file it cannot read', async () => {
    await expect(measureMouth(ffmpeg, join(dir, 'missing.mp4'), plan, { fps: 30, durationSec: 2 })).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('gives up when the picture stops coming', async () => {
    // A stand-in for an ffmpeg that hangs: it never sends a frame.
    const stuck = join(dir, 'stuck.sh')
    writeFileSync(stuck, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
    await expect(
      measureMouth(stuck, join(dir, 'offset-0.12.mp4'), plan, { fps: 30, durationSec: 2, stallSec: 0.3 })
    ).rejects.toThrow('The picture stopped coming after 0 frames.')
  })

  describe.skipIf(!ESPEAK)('with espeak-ng speech', () => {
    it('lines up espeak-ng speech whose mouth follows the voice', async () => {
      // Each word spoken by espeak-ng, trimmed to its sound, starts where the
      // take's sound would, and the mouth follows its loudness syllable by
      // syllable, opening before it as the take's mouths do.
      const base = take({ seed: 11, words: 10 })
      const rate = 48000
      const planted = 0.12
      const said = [
        'camera',
        'settings',
        'exposure',
        'focus',
        'lenses',
        'lighting',
        'framing',
        'colour',
        'audio',
        'shutter'
      ]
      const clips: { at: number; samples: Float32Array }[] = []
      const words = base.words.map((w, k) => {
        const file = join(dir, `say-${k}.wav`)
        spawnSync(ESPEAK as string, ['-w', file, '-s', '165', said[k]])
        const bytes = readFileSync(file)
        const sr = bytes.readUInt32LE(24)
        const all = Float32Array.from(
          { length: (bytes.length - 44) / 2 },
          (_, i) => bytes.readInt16LE(44 + i * 2) / 32768
        )
        const loud = (i: number): boolean => Math.abs(all[i]) > 0.02
        let a = 0
        while (a < all.length && !loud(a)) a++
        let b = all.length - 1
        while (b > a && !loud(b)) b--
        const next = base.words[k + 1]
        const room = (next ? next.openSec - 0.15 : base.durationSec - 0.5) - w.onsetSec
        const len = Math.min((b - a) / sr, room)
        const samples = Float32Array.from(
          { length: Math.round(len * rate) },
          (_, i) => all[a + Math.floor((i * sr) / rate)] ?? 0
        )
        clips.push({ at: w.onsetSec, samples })
        return { ...w, endSec: w.onsetSec + len, settleSec: w.onsetSec + len + (w.settleSec - w.endSec) }
      })
      // How open the mouth is while each clip plays: its loudness over 40 ms, scaled to the word.
      const level = clips.map(({ samples }) => {
        const hop = Math.round(rate * 0.01)
        const env = Float32Array.from({ length: Math.ceil(samples.length / hop) }, (_, j) => {
          let s = 0
          for (let i = j * hop; i < Math.min(samples.length, (j + 1) * hop); i++) s += samples[i] * samples[i]
          return Math.sqrt(s / hop)
        })
        const top = Math.max(...env) || 1
        return (sec: number): number => {
          const j = Math.max(0, Math.min(env.length - 1, Math.floor(sec / 0.01)))
          let s = 0
          let c = 0
          for (let q = j - 2; q <= j + 2; q++) if (q >= 0 && q < env.length) ((s += env[q] / top), c++)
          return s / c
        }
      })
      const mouth = (sec: number): number => {
        for (const [k, w] of words.entries()) {
          if (sec < w.openSec || sec > w.settleSec) continue
          const ease = (x: number): number => Math.max(0, Math.min(1, x)) ** 2 * (3 - 2 * Math.max(0, Math.min(1, x)))
          const during = (s: number): number => w.peak * (0.25 + 0.75 * level[k](s - w.onsetSec))
          if (sec < w.onsetSec) return during(0) * ease((sec - w.openSec) / (w.onsetSec - w.openSec))
          if (sec <= w.endSec) return during(sec)
          return during(w.endSec) * (1 - ease((sec - w.endSec) / (w.settleSec - w.endSec)))
        }
        return 0
      }
      const t: Take = { ...base, words, scene: { ...base.scene, faces: [{ ...base.scene.faces[0], mouth }] } }
      const voice = new Float32Array(Math.round(t.durationSec * rate))
      for (const { at, samples } of clips) {
        const from = Math.round((at + planted) * rate)
        for (let i = 0; i < samples.length && from + i < voice.length; i++) voice[from + i] += samples[i]
      }
      const path = join(dir, 'espeak.mp4')
      writeFileSync(path.replace(/\.mp4$/, '.voice.wav'), wav(voice, rate))
      const silent: VoiceLine[] = [{ startSec: 0, endSec: 0, amplitude: () => 0, pitchHz: 100 }]
      await encode(ffmpeg, t, silent, 0, path)
      // Swap the silent track for the spoken one.
      const spoken = join(dir, 'espeak-spoken.mp4')
      spawnSync(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        path,
        '-i',
        path.replace(/\.mp4$/, '.voice.wav'),
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-shortest',
        spoken
      ])
      const env = await loudnessEnvelope(ffmpeg, spoken)
      const heard = snapWords(
        wordsFromTranscript(
          t.words.map((w) => ({
            text: w.text,
            startSec: w.onsetSec + planted - 0.08,
            endSec: w.endSec + planted + 0.1
          })),
          's1'
        ),
        env
      )
      const result = await watchMouth({
        ffmpeg,
        source: sourceFor(t, spoken),
        words: heard,
        envelope: env,
        detect: detectorFor(t)
      })
      expect(Math.abs((result?.estimate?.offsetSec ?? 9) - planted)).toBeLessThan(0.025)
    })
  })
})
