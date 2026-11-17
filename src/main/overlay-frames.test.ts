import { createCanvas } from '@napi-rs/canvas'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript } from '../shared/edit'
import { renderFrame, type Layer } from '../shared/motion'
import { buildRenderArgs, renderCut, TO_YUVA, type OverlaySpan } from './cut-render'
import { renderMotion } from './motion-render'
import { ffmpegRun, findFfmpeg } from './test-media'

/**
 * Graphics on the frame the preview draws them on. The preview draws a
 * graphic at each frame's own time; the export draws the same frames into
 * overlay files and lays them over the picture. Eight red squares come and go
 * in turn, each sliding four pixels a frame, starting on frames whose times
 * round every way to the millisecond; every frame of the export must show
 * each square where the preview's drawing has it, or neither must show it.
 * A frame early or late moves a square by four pixels, or shows it alone.
 */

const FFMPEG = findFfmpeg()
const W = 320
const H = 180
const SEC = 8
/** The rows the squares slide along. */
const BAND = { y: 78, h: 24 }

/** The left edge of the red square in a band of rows, or null when there is none. */
function leftEdge(rgb: Uint8Array, stride: number): number | null {
  for (let x = 0; x < W; x++)
    for (let y = 0; y < BAND.h; y++) {
      const i = (y * W + x) * stride
      if (rgb[i] > 180 && rgb[i + 1] < 90 && rgb[i + 2] < 90) return x
    }
  return null
}

describe('graphics land on the frame the preview draws them on', () => {
  it('lays each overlay on the output frames by count, from its first frame', () => {
    const args = buildRenderArgs(
      [{ path: '/a.mov', startSec: 0, durationSec: 4, hasAudio: true, treatment: null, broll: null }],
      {
        width: 540,
        height: 960,
        fps: 24,
        assPath: null,
        fontsDir: null,
        loudness: null,
        quality: 'preview',
        outputPath: '/out.mp4',
        // 68/24 s is 2.8333…, which rounds down to the millisecond.
        overlays: [{ path: '/m0.mov', startSec: 68 / 24, durationSec: 0.25 }]
      }
    )
    expect(args[args.indexOf('-filter_complex') + 1]).toContain(`[1:v]${TO_YUVA},settb=1/24,setpts=N+68[mo0]`)
  })
})

describe.skipIf(!FFMPEG)('graphics in an export, frame by frame', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-overlay-frames-'))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  for (const fps of [24, 30, 60]) {
    it(`shows every frame of a graphic on its own frame at ${fps} fps`, async () => {
      const work = join(dir, String(fps))
      const clip = join(dir, `grey-${fps}.mp4`)
      ffmpegRun(ffmpeg, [
        '-f',
        'lavfi',
        '-i',
        `color=c=0x606060:s=${W}x${H}:r=${fps}:d=${SEC}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=48000:duration=${SEC}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        clip
      ])
      const source = { id: 's1', path: clip, durationSec: SEC, width: W, height: H, fps }
      // Sentences with pauses between, so the cut is in several pieces: exported in passes, as such a cut is,
      // and in one pass when told to.
      const said = Array.from({ length: 7 }, (_, i) => ({
        text: `w${i}.`,
        startSec: 0.1 + i * 1.1,
        endSec: 0.9 + i * 1.1
      }))
      const doc = createDoc({ id: 'd', title: 'Frames', sources: [source], words: wordsFromTranscript(said, 's1') })
      const cut = applyOps(
        currentCut(doc),
        [
          { op: 'loudness', lufs: null },
          { op: 'captions', set: { on: false } }
        ],
        { words: doc.words, sources: doc.sources }
      ).cut
      const resolved = resolveCut(cut, doc.words, doc.sources)
      const firsts = Array.from({ length: 8 }, (_, i) => Math.round((0.3 + i * 0.8) * fps) + i).filter(
        (f) => (f + 8) / fps < resolved.durationSec
      )
      const layers = firsts.map(
        (first): Layer =>
          ({
            kind: 'shape',
            start: first / fps,
            end: (first + 6) / fps,
            shape: { type: 'rect', w: 16, h: 16 },
            fill: '#ff0000',
            transform: {
              x: {
                keys: [
                  { t: 0, v: 40, ease: 'linear' },
                  { t: 6 / fps, v: 64 }
                ]
              },
              y: 90
            }
          }) as Layer
      )
      const made = await renderMotion(layers, {
        ffmpeg,
        workDir: join(work, 'motion'),
        width: W,
        height: H,
        fps,
        design: { width: W, height: H },
        duration: resolved.durationSec,
        fontsDir: null
      })
      // The same frames in files that count time in frames, as other makers of overlays write them.
      const counted: OverlaySpan[] = made.map((o, i) => {
        const path = join(work, `counted-${i}.mov`)
        ffmpegRun(ffmpeg, ['-i', o.path, '-c', 'copy', '-video_track_timescale', String(fps), path])
        return { ...o, path }
      })
      const canvas = createCanvas(W, H)
      const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
      for (const [name, overlays, maxInputs] of [
        ['in one pass', made, Infinity],
        ['in passes', made, undefined],
        ['from files that count in frames', counted, Infinity]
      ] as const) {
        const out = await renderCut(cut, resolved, [{ ...source, hasAudio: true }], {
          ffmpeg,
          outputPath: join(work, `out-${name.replace(/ /g, '-')}.mp4`),
          workDir: join(work, name.replace(/ /g, '-')),
          quality: 'final',
          overlays,
          ...(maxInputs === undefined ? {} : { maxInputs })
        })
        // Every frame of the export, decoded in order, in the squares' band.
        const raw = execFileSync(
          ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            out,
            '-vf',
            `crop=${W}:${BAND.h}:0:${BAND.y},scale=in_color_matrix=bt709:in_range=tv,format=gbrp,format=rgb24`,
            '-fps_mode',
            'passthrough',
            '-f',
            'rawvideo',
            '-'
          ],
          { maxBuffer: 1 << 27 }
        )
        const size = W * BAND.h * 3
        const frames = Math.floor(raw.length / size)
        expect(frames, name).toBe(Math.round(resolved.durationSec * fps))
        const wrong: string[] = []
        let shown = 0
        for (let n = 0; n < frames; n++) {
          const exported = leftEdge(raw.subarray(n * size, (n + 1) * size), 3)
          // The preview's drawing of the same frame: the shared code at the frame's own time.
          renderFrame(ctx, n / fps, layers, { width: W, height: H }, { width: W, height: H })
          const drawn = leftEdge(new Uint8Array(ctx.getImageData(0, BAND.y, W, BAND.h).data.buffer), 4)
          if (drawn !== null) shown++
          if (exported === drawn || (exported !== null && drawn !== null && Math.abs(exported - drawn) <= 1)) continue
          wrong.push(`frame ${n}: export ${exported ?? 'none'}, preview ${drawn ?? 'none'}`)
        }
        expect(shown, name).toBe(firsts.length * 6)
        expect(wrong, name).toEqual([])
      }
    }, 240_000)
  }
})
