// Real argument lists from the desktop renderer (src/main/cut-render.ts), for
// the phone engine's self-test: it writes ../src/desktop-renders.json, which
// the phone runs with libx264 swapped for its hardware encoder (selftest.ts,
// useHardwareEncoder) and the runner runs as is (make_media.py). Paths are
// placeholders the self-test fills in: {media}, {fonts}, {work}, {out}.
// From the repository's root, after its npm install:
//   npx vitest run --config mobile/engine/example/tools/vitest.config.mts
import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { buildRenderArgs, captionStyleFor, type Segment } from '../../../../src/main/cut-render'
import { buildAss } from '../../../../src/main/captions'
import { colorConversion } from '../../../../src/main/intake'
import { DEFAULT_CAPTIONS, DEFAULT_TREATMENT } from '../../../../src/shared/edit'

const OUT = process.env.DESKTOP_ARGS_OUT ?? join(__dirname, '../src/desktop-renders.json')

const seg = (over: Partial<Segment>): Segment => ({
  path: '{media}/h264_1080p.mp4',
  startSec: 0,
  durationSec: 1,
  hasAudio: true,
  treatment: { ...DEFAULT_TREATMENT },
  broll: null,
  ...over
})

describe('desktop render arguments for the phone self-test', () => {
  it('writes them', () => {
    const renders: unknown[] = []

    // 1. A vertical cut of three pieces from two recordings: trims and seeks
    // per input, scale and crop to 1080x1920, a dissolve (xfade and
    // acrossfade), a punch-in, word captions in the bundled Archivo Black, a
    // logo in a corner, a music bed under it all, a sound effect, loudness
    // set to -14 LUFS and a fade at each end.
    {
      const W = 1080
      const H = 1920
      const words = [
        { text: 'One', startSec: 0.2, endSec: 0.6 },
        { text: 'phone', startSec: 0.6, endSec: 1.0 },
        { text: 'export', startSec: 1.0, endSec: 1.5 },
        { text: 'with', startSec: 2.0, endSec: 2.3 },
        { text: 'captions', startSec: 2.3, endSec: 3.0 },
        { text: 'burned', startSec: 3.3, endSec: 3.8 },
        { text: 'in.', startSec: 3.8, endSec: 4.4 }
      ]
      const style = captionStyleFor({ ...DEFAULT_CAPTIONS }, W, null)
      const ass = buildAss(words, W, H, style)
      const segments: Segment[] = [
        seg({ path: '{media}/h264_1080p.mp4', startSec: 1.0, durationSec: 2.0, outStart: 0 }),
        seg({
          path: '{media}/hevc_portrait.mov',
          startSec: 0.5,
          durationSec: 1.6,
          outStart: 1.6,
          transition: { kind: 'dissolve', sec: 0.4 }
        }),
        seg({
          path: '{media}/h264_1080p.mp4',
          startSec: 5.0,
          durationSec: 1.5,
          outStart: 3.2,
          treatment: { ...DEFAULT_TREATMENT, zoom: 1.2 }
        })
      ]
      const args = buildRenderArgs(segments, {
        width: W,
        height: H,
        fps: 30,
        assPath: '{work}/captions.ass',
        fontsDir: '{fonts}',
        loudness: -14,
        logo: { path: '{media}/logo.png', corner: 'top-right', opacity: 1 },
        fade: { inSec: 0.3, outSec: 0.3, color: 'black' },
        music: {
          path: '{media}/music.m4a',
          inSec: 0,
          gainDb: -12,
          keys: [
            { t: 0, db: 0 },
            { t: 0.2, db: -8 },
            { t: 4.4, db: -8 },
            { t: 4.7, db: 0 }
          ],
          fadeInSec: 0.5,
          fadeOutSec: 1
        },
        sfx: [{ path: '{media}/whoosh.wav', startSec: 1.5, trimSec: 0, gainDb: -6 }],
        quality: 'final',
        outputPath: '{out}/desktop-cut.mp4'
      })
      expect(args).toContain('libx264')
      renders.push({
        name: 'desktop-cut',
        about:
          'buildRenderArgs: three pieces from two recordings, a dissolve, a punch-in, captions in Archivo Black, a logo, a music bed, a sound effect, -14 LUFS, fades',
        args,
        files: { 'captions.ass': ass },
        output: 'desktop-cut.mp4',
        width: W,
        height: H,
        durationSec: 4.7,
        audio: true
      })
    }

    // 2. A wide cut: an HLG recording converted to ordinary video with
    // zscale (the conversion intake picks for HDR), then a piece played at
    // 1.5x (setpts and atempo), the whole graded with a 3D LUT.
    {
      const W = 1280
      const H = 720
      const segments: Segment[] = [
        seg({
          path: '{media}/hlg_10bit.mov',
          startSec: 0.2,
          durationSec: 2.0,
          outStart: 0,
          convert: colorConversion('hlg', true)
        }),
        seg({
          path: '{media}/h264_1080p.mp4',
          startSec: 6.0,
          durationSec: 1.2 / 1.5,
          srcSec: 1.2,
          steps: [{ srcSec: 1.2, speed: 1.5 }],
          outStart: 2.0
        })
      ]
      const args = buildRenderArgs(segments, {
        width: W,
        height: H,
        fps: 30,
        assPath: null,
        fontsDir: null,
        loudness: -16,
        look: { lut: { path: '{media}/grade.cube', strength: 1 } },
        lutKind: '3d',
        quality: 'preview',
        outputPath: '{out}/desktop-hdr-look.mp4'
      })
      const graph = args[args.indexOf('-filter_complex') + 1]
      expect(graph).toContain('zscale=')
      expect(graph).toContain('lut3d=')
      expect(graph).toContain('atempo')
      renders.push({
        name: 'desktop-hdr-look',
        about: 'buildRenderArgs: HLG through zscale to ordinary video, a piece at 1.5x (atempo), a 3D LUT over the whole, -16 LUFS',
        args,
        files: {},
        output: 'desktop-hdr-look.mp4',
        width: W,
        height: H,
        durationSec: 2.8,
        audio: true
      })
    }

    writeFileSync(OUT, JSON.stringify({ from: 'src/main/cut-render.ts buildRenderArgs, written by tools/desktop-args.test.ts', renders }, null, 2) + '\n')
  })
})
