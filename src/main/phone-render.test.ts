import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyOps,
  cameraClock,
  cameraPlan,
  createDoc,
  currentCut,
  resolveCut,
  viewAt,
  windowAt,
  wordsFromTranscript,
  type Camera,
  type Cut,
  type EditDoc,
  type Resolved
} from '../shared/edit'
import { renderCut, type RenderSource } from './cut-render'
import { platform, setPlatform, type Platform } from './platform'
import { missingOnPhone, filterNames } from './render/lgpl'
import { videoCodec, type Encoder } from './render/encoder'
import { ffmpegRun, findFfmpeg, findFfprobe, frameColour, gradientWindow, makeGradientStill } from './test-media'

const FFMPEG = findFfmpeg()

/** Whether this ffmpeg has a filter. */
function hasFilter(ffmpeg: string, name: string): boolean {
  const out = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? ''
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(out)
}

describe('what a phone ffmpeg has', () => {
  it('reads the filters a graph names, past labels, quotes and escapes', () => {
    expect(
      filterNames("[0:v]scale=w='min(1,2)':h=-2,crop=1:2[a];[a][b]xfade@x=transition=fade:offset=1,format=yuv420p[v]")
    ).toEqual(['scale', 'crop', 'xfade', 'format'])
    expect(filterNames("perspective=x0='st(0,1);ld(0)':y0=0,subtitles='a\\:b.ass'")).toEqual([
      'perspective',
      'subtitles'
    ])
  })

  it('names what a phone lacks: GPL filters, and encoders it has none of', () => {
    expect(missingOnPhone(['-vf', 'eq=contrast=1.2,scale=2:2', '-c:v', 'libx264'])).toEqual(['eq', 'libx264'])
    expect(missingOnPhone(['-filter_complex', 'hue=s=0,lut3d=file=x.cube', '-c:v', 'h264_mediacodec'])).toEqual([])
  })
})

/**
 * A phone's render, run on this machine: the arguments the phone gives its
 * engine, with only the hardware encoder's name changed to x264 so this
 * ffmpeg can run them, as the dev bridge does. Every command must name
 * nothing a phone's ffmpeg lacks, and camera moves land where the plan says.
 */
describe.skipIf(!FFMPEG)('rendering as a phone does', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let still = ''
  let doc: EditDoc
  let sources: RenderSource[]
  const commands: string[][] = []
  let before: Platform

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-phone-render-'))
    still = makeGradientStill(ffmpeg, join(dir, 'gradient.png'))
    const take = join(dir, 'take.mp4')
    ffmpegRun(ffmpeg, [
      ...['-loop', '1', '-framerate', '30', '-t', '8', '-i', still],
      ...['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=8'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', take]
    ])
    const source = { id: 's1', path: take, durationSec: 8, width: 1920, height: 1080, fps: 30 }
    sources = [{ ...source, hasAudio: true }]
    const said = [
      ['One', 0.3, 0.6],
      ['two', 0.7, 1.0],
      ['three', 1.1, 1.4],
      ['four.', 1.5, 1.9],
      ['Five', 2.6, 2.9],
      ['six', 3.0, 3.3],
      ['seven.', 3.4, 3.9],
      ['Eight', 4.6, 4.9],
      ['nine', 5.0, 5.3],
      ['ten.', 5.4, 5.9]
    ].map(([text, startSec, endSec]) => ({
      text: text as string,
      startSec: startSec as number,
      endSec: endSec as number
    }))
    doc = createDoc({ id: 'd', title: 'T', source, words: wordsFromTranscript(said, 's1') })
    before = platform()
    setPlatform({
      ...before,
      run: (bin, args, opts) => {
        if (args.includes('-filter_complex')) commands.push(args)
        const runnable = args.map((a, i) =>
          args[i - 1] === '-c:v' && /_(mediacodec|videotoolbox)$/.test(a) ? 'libx264' : a
        )
        return before.run(bin, runnable, opts)
      }
    })
  })

  afterAll(() => {
    setPlatform(before)
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const withOps = (ops: unknown[]): Cut => {
    const r = applyOps(currentCut(doc), [...ops, { op: 'loudness', lufs: null }], {
      words: doc.words,
      sources: doc.sources
    })
    expect(r.rejected).toEqual([])
    return r.cut
  }
  const render = async (
    cut: Cut,
    name: string,
    encoder: Encoder,
    opts: { perspective?: boolean; quality?: 'preview' | 'final'; maxInputs?: number } = {}
  ): Promise<{ out: string; resolved: Resolved }> => {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const out = await renderCut(cut, resolved, sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: opts.quality ?? 'preview',
      encoder,
      perspective: opts.perspective ?? false,
      maxInputs: opts.maxInputs,
      sfxDir: join(dir, 'sfx')
    })
    return { out, resolved }
  }
  const expected = (resolved: Resolved, beat: string, t: number, move: Camera, frameAspect: number) => {
    const clock = cameraClock(resolved, beat, t, move.word)!
    const plan = cameraPlan(move, clock.length, clock.wordAt, 16 / 9, frameAspect)
    const w = windowAt(viewAt(plan, clock.t), plan.fw, plan.fh)
    return { left: w.x, right: w.x + w.w, top: w.y, bottom: w.y + w.h }
  }
  const expectWindow = (
    got: { left: number; right: number; top: number; bottom: number },
    want: { left: number; right: number; top: number; bottom: number },
    what: string
  ): void => {
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      expect(
        Math.abs(got[side] - want[side]),
        `${what}: ${side} ${got[side].toFixed(3)} for ${want[side].toFixed(3)}`
      ).toBeLessThan(0.03)
    }
  }

  it('pushes in, pans and drifts without the perspective filter, where the plan says', async () => {
    const push: Camera = { kind: 'push-in', zoom: 1.5 }
    const pan: Camera = { kind: 'pan-left' }
    const ken: Camera = { kind: 'ken-burns', zoom: 1.4 }
    const cut = withOps([
      { op: 'camera', beats: ['b1'], move: push },
      { op: 'treat', beats: ['b2'], set: { frame: 'broll', broll: { path: still, inSec: 0, muted: true } } },
      { op: 'camera', beats: ['b2'], move: pan },
      { op: 'camera', beats: ['b3'], move: ken },
      { op: 'aspect', aspect: 'vertical' }
    ])
    commands.length = 0
    const { out, resolved } = await render(cut, 'moves', { kind: 'mediacodec' })
    for (const args of commands) expect(missingOnPhone(args)).toEqual([])
    expect(commands.flat().join(' ')).not.toMatch(/perspective/)
    for (const [beat, move] of [
      ['b1', push],
      ['b2', pan],
      ['b3', ken]
    ] as const) {
      const b = resolved.beats.find((x) => x.id === beat)!
      for (const t of [b.outStart + 0.05, (b.outStart + b.outEnd) / 2, b.outEnd - 0.06]) {
        expectWindow(
          gradientWindow(ffmpeg, out, t),
          expected(resolved, beat, t, move, 9 / 16),
          `${move.kind} at ${t.toFixed(2)} s`
        )
      }
    }
  })

  it.skipIf(!FFMPEG || !hasFilter(FFMPEG, 'perspective'))(
    'draws the same move the perspective filter draws, frame for frame',
    async () => {
      // A busy picture, where a window a pixel off shows.
      const busy = join(dir, 'busy.png')
      ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080', '-frames:v', '1', busy])
      const move: Camera = { kind: 'push-in', zoom: 1.5 }
      const cut = withOps([
        { op: 'treat', beats: ['b1'], set: { frame: 'broll', broll: { path: busy, inSec: 0, muted: true } } },
        { op: 'camera', beats: ['b1'], move },
        { op: 'aspect', aspect: 'wide' }
      ])
      const a = await render(cut, 'with-perspective', { kind: 'x264' }, { perspective: true })
      const b = await render(cut, 'cropped', { kind: 'x264' }, { perspective: false })
      const beat = a.resolved.beats[0]
      const span = ['-ss', beat.outStart.toFixed(3), '-t', (beat.outEnd - beat.outStart).toFixed(3)]
      const psnr = (x: string, y: string): number => {
        const log = spawnSync(
          ffmpeg,
          ['-hide_banner', ...span, '-i', x, ...span, '-i', y, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'],
          { encoding: 'utf8' }
        ).stderr
        return Number(/average:([\d.]+|inf)/.exec(log)?.[1].replace('inf', '99'))
      }
      const same = psnr(a.out, b.out)
      console.log(`[phone-render] perspective and scale-and-crop agree at ${same.toFixed(1)} dB`)
      // One frame early or late would read far lower: the frames are counted alike.
      expect(same).toBeGreaterThan(35)
    }
  )

  it('makes a whole edit with every phone treatment from arguments a phone can run', async () => {
    const tone = join(dir, 'bed.m4a')
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'sine=f=220:d=20', '-c:a', 'aac', tone])
    const cut = withOps([
      { op: 'aspect', aspect: 'vertical' },
      { op: 'captions', set: { on: true } },
      { op: 'treat', beats: ['b1'], set: { zoom: 1.2 } },
      { op: 'camera', beats: ['b2'], move: { kind: 'push-in', zoom: 1.3 } },
      { op: 'look', set: { name: 'warm', temperature: 0.3, contrast: 0.1, vignette: 0.3, grain: 0.2, sharpen: 0.3 } },
      { op: 'transition', beats: ['b3'], kind: 'dissolve', sec: 0.3 },
      { op: 'speed', beats: ['b3'], speed: 1.5 },
      { op: 'voice', polish: 0.7 },
      { op: 'sfx', beats: ['b2'], add: { kind: 'whoosh' } },
      {
        op: 'chapters',
        set: [
          { beat: 'b1', title: 'Start' },
          { beat: 'b3', title: 'The end' }
        ]
      },
      {
        op: 'music',
        set: {
          path: tone,
          levelDb: -14,
          duckDb: 8,
          inSec: 0,
          fadeInSec: 0.5,
          fadeOutSec: 1,
          durationSec: 20,
          lufs: -18
        }
      },
      { op: 'fade', inSec: 0.3, outSec: 0.5 }
    ])
    for (const encoder of [{ kind: 'mediacodec' }, { kind: 'videotoolbox' }] as Encoder[]) {
      commands.length = 0
      const { out, resolved } = await render(cut, `phone-${encoder.kind}`, encoder, { quality: 'final' })
      // The renders, and the sound effects made from nothing on the way.
      const renders = commands.filter((a) => a.includes('-c:v'))
      expect(renders.length).toBeGreaterThan(0)
      for (const args of commands) expect(missingOnPhone(args)).toEqual([])
      for (const args of renders) {
        expect(args[args.indexOf('-c:v') + 1]).toBe(videoCodec(encoder))
        expect(args[args.indexOf('-pix_fmt') + 1]).toBe('nv12')
      }
      const probe = JSON.parse(
        execFileSync(findFfprobe() ?? 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out], {
          encoding: 'utf8'
        }).toString()
      ) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } }
      const video = probe.streams.find((s) => s.codec_type === 'video')
      expect([video?.width, video?.height]).toEqual([1080, 1920])
      expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(true)
      expect(Math.abs(Number(probe.format.duration) - resolved.durationSec)).toBeLessThan(0.15)
    }
    // Two full exports at 1080 x 1920, one for each phone encoder, beside the rest of the suite.
  }, 180_000)

  it('renders a long cut in passes on the phone encoder, chunks and join alike', async () => {
    const cut = withOps([
      { op: 'aspect', aspect: 'square' },
      { op: 'camera', beats: ['b2'], move: { kind: 'push-in', zoom: 1.2 } }
    ])
    commands.length = 0
    const { out, resolved } = await render(cut, 'passes', { kind: 'videotoolbox' }, { maxInputs: 1 })
    expect(commands.length).toBeGreaterThan(2)
    for (const args of commands) expect(missingOnPhone(args)).toEqual([])
    // The chunks are kept near lossless (a high rate and PCM sound) for the join that encodes them again.
    const chunk = commands.find((a) => a[a.length - 1].endsWith('.mkv'))!
    expect(chunk[chunk.indexOf('-c:a') + 1]).toBe('pcm_s16le')
    const joined = frameColour(ffmpeg, out, resolved.durationSec / 2)
    expect(joined.some((c) => c > 20)).toBe(true)
  })
})
