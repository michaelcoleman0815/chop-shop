import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  commit,
  createDoc,
  currentCut,
  resolveCut,
  wordsFromTranscript,
  DEFAULT_CAPTIONS,
  DEFAULT_TREATMENT,
  type EditDoc
} from '../shared/edit'
import {
  buildRenderArgs,
  captionStyleFor,
  chunkSegments,
  frameRate,
  frameSize,
  renderCut,
  type RenderSource,
  type Segment
} from './cut-render'
import { greyShare, probeMedia, sampleColour } from './inspiration/measure'

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

describe('render arguments', () => {
  const seg = (over: Partial<Segment> = {}): Segment => ({
    path: '/a.mov',
    startSec: 1,
    durationSec: 2,
    hasAudio: true,
    treatment: { ...DEFAULT_TREATMENT },
    broll: null,
    ...over
  })
  const opts = {
    width: 540,
    height: 960,
    fps: 30,
    assPath: null,
    fontsDir: null,
    loudness: null,
    quality: 'preview' as const,
    outputPath: '/out.mp4'
  }

  it('seeks each piece as its own input and joins them in order', () => {
    const args = buildRenderArgs([seg(), seg({ startSec: 0.5, durationSec: 1 })], opts)
    expect(args.filter((a) => a === '-i')).toHaveLength(2)
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4)).toEqual(['-ss', '1.000', '-t', '2.000'])
    const graph = args[args.indexOf('-filter_complex') + 1]
    // Picture and sound are joined as two tracks, so either can be cut on its own.
    expect(graph).toContain('[v0][v1]concat=n=2:v=1:a=0,settb=1/30[vcat]')
    expect(graph).toContain('[a0][a1]concat=n=2:v=0:a=1[acat]')
    // Each picture is cut to the frames it covers on the output clock: 2 s and 1 s at 30 fps.
    expect(graph).toContain('trim=end_frame=60,')
    expect(graph).toContain('trim=end_frame=30,')
    expect(graph).not.toContain('loudnorm')
  })

  it('counts frames on the shared clock, so short pieces never add up to drift', () => {
    // Twelve pieces of 0.2345 s: 7.035 frames each. Rounded one by one they
    // would make 84 frames; on the shared clock they make round(84.42) = 84
    // with no piece more than half a frame off where it belongs.
    const pieces = Array.from({ length: 12 }, () => seg({ durationSec: 0.2345 }))
    const graph = buildRenderArgs(pieces, opts)[buildRenderArgs(pieces, opts).indexOf('-filter_complex') + 1]
    const frames = [...graph.matchAll(/trim=end_frame=(\d+),/g)].map((m) => Number(m[1]))
    expect(frames).toHaveLength(12)
    expect(frames.reduce((a, b) => a + b, 0)).toBe(Math.round(12 * 0.2345 * 30))
    let at = 0
    frames.forEach((n, i) => {
      at += n
      expect(Math.abs(at - (i + 1) * 0.2345 * 30)).toBeLessThanOrEqual(0.5)
    })
  })

  it('joins across a transition with xfade and a matching crossfade', () => {
    const args = buildRenderArgs(
      [
        seg({ durationSec: 2, outStart: 0 }),
        seg({ durationSec: 1.5, outStart: 1.6, transition: { kind: 'wipe-left', sec: 0.4 } }),
        seg({ durationSec: 1, outStart: 3.1 })
      ],
      { ...opts, fade: { inSec: 0.5, outSec: 1, color: 'white' } }
    )
    const graph = args[args.indexOf('-filter_complex') + 1]
    // The first run is one piece; the second is the wipe's piece and the hard cut after it.
    expect(graph).toContain('[v1][v2]concat=n=2:v=1:a=0,settb=1/30[vr1]')
    expect(graph).toContain('[vr0][vr1]xfade=transition=wipeleft:duration=0.400000:offset=1.600000[vcat]')
    expect(graph).toContain('[ar0][ar1]acrossfade=d=0.400000:c1=qsin:c2=qsin[acat]')
    expect(graph).toContain('fade=t=in:st=0:d=0.500000:color=white,fade=t=out:st=3.100000:d=1.000000:color=white')
    expect(graph).toContain('afade=t=in:st=0:d=0.500000,afade=t=out:st=3.100000:d=1.000000')
  })

  it('puts motion blur across the middle of a whip pan', () => {
    const args = buildRenderArgs(
      [
        seg({ durationSec: 2, outStart: 0 }),
        seg({ durationSec: 2, outStart: 1.7, transition: { kind: 'whip-left', sec: 0.3 } })
      ],
      opts
    )
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('xfade=transition=slideleft:duration=0.300000:offset=1.700000[vw1]')
    expect(graph).toMatch(/\[vw1\]gblur=sigma=14:sigmaV=0:enable='between\(t,1\.745000,1\.955000\)'\[vcat\]/)
  })

  it('only breaks a long cut into passes at a hard cut', () => {
    const plain = (over: Partial<Segment> = {}): Segment => seg({ durationSec: 1, ...over })
    const t = { kind: 'dissolve' as const, sec: 0.3 }
    const chunks = chunkSegments(
      [plain(), plain({ transition: t }), plain({ transition: t }), plain(), plain({ transition: t }), plain()],
      2
    )
    expect(chunks.map((c) => c.length)).toEqual([3, 2, 1])
    for (const c of chunks) expect(c[0].transition).toBeUndefined()
  })

  it('draws the look of each beat', () => {
    const graph = (s: Segment): string => {
      const args = buildRenderArgs([s], { ...opts, loudness: -14 })
      return args[args.indexOf('-filter_complex') + 1]
    }
    expect(graph(seg({ treatment: { ...DEFAULT_TREATMENT, bw: true } }))).toContain('hue=s=0')
    expect(graph(seg({ treatment: { ...DEFAULT_TREATMENT, zoom: 1.2 } }))).toContain(
      'crop=trunc(iw/1.2000/2)*2:trunc(ih/1.2000/2)*2'
    )
    expect(graph(seg({ hasAudio: false }))).toContain('anullsrc=r=48000:cl=stereo')
    expect(graph(seg())).toContain('loudnorm=I=-14')
    const split = graph(
      seg({ treatment: { ...DEFAULT_TREATMENT, frame: 'split' }, broll: { path: '/b.mov', startSec: 3 } })
    )
    expect(split).toContain('vstack')
    expect(split).toContain('[1:v]')
  })

  it('keeps a logo in its corner and captions in the brand colours', () => {
    const args = buildRenderArgs([seg()], {
      ...opts,
      logo: { path: '/brand/logo.png', corner: 'bottom-right', opacity: 0.8 }
    })
    expect(args.slice(args.indexOf('/brand/logo.png') - 5, args.indexOf('/brand/logo.png') + 1)).toEqual([
      '-loop',
      '1',
      '-t',
      '2.000',
      '-i',
      '/brand/logo.png'
    ])
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('scale=76:-1,format=rgba,colorchannelmixer=aa=0.80[logo]')
    expect(graph).toContain('overlay=x=main_w-overlay_w-24:y=main_h-overlay_h-24:shortest=1[vlogo]')
    expect(args).toContain('[vlogo]')
    const style = captionStyleFor({ ...DEFAULT_CAPTIONS }, 1080, { text: '#FAFAFA', accent: '#FF5A36' })
    expect([style.textColor, style.activeColor]).toEqual(['#FAFAFA', '#FF5A36'])
  })

  it('sizes frames by shape and keeps frame rates standard', () => {
    expect(frameSize('vertical', { width: 1920, height: 1080 })).toEqual({ width: 1080, height: 1920 })
    expect(frameSize('vertical', { width: 1920, height: 1080 }, true)).toEqual({ width: 540, height: 960 })
    expect(frameSize('original', { width: 3840, height: 2160 })).toEqual({ width: 1920, height: 1080 })
    expect(frameRate(29.97)).toBe(30)
    expect(frameRate(59.94)).toBe(60)
    expect(frameRate(23.976)).toBe(24)
  })
})

describe.skipIf(!FFMPEG)('rendering a cut', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let sources: RenderSource[]

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-render-'))
    const path = join(dir, 'source.mp4')
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:sample_rate=48000:duration=6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path
    ])
    const source = { id: 's1', path, durationSec: 6, width: 640, height: 360, fps: 30 }
    sources = [{ ...source, hasAudio: true }]
    // Three one-second shots, played out of order: the last second in black
    // and white, then a punched-in second, then the first second.
    doc = commit(
      createDoc({ id: 'd', title: 'Render', source, words: [] }),
      [
        { op: 'remove', beats: ['b1'] },
        { op: 'insert', to: 0, beat: { source: 's1', inSec: 5, outSec: 6, treatment: { bw: true } } },
        { op: 'insert', to: 1, beat: { source: 's1', inSec: 1, outSec: 2, treatment: { zoom: 1.2 } } },
        { op: 'insert', to: 2, beat: { source: 's1', inSec: 0, outSec: 1 } },
        { op: 'aspect', aspect: 'vertical' }
      ],
      'Out of order.'
    ).doc
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const check = async (out: string): Promise<void> => {
    const info = await probeMedia(ffmpeg, out)
    expect(info.width).toBe(540)
    expect(info.height).toBe(960)
    expect(info.hasAudio).toBe(true)
    expect(Math.abs(info.durationSec - 3)).toBeLessThan(0.15)
    const share = greyShare(await sampleColour(out, { ffmpeg, fps: 6 }))
    expect(share).toBeGreaterThan(0.2)
    expect(share).toBeLessThan(0.45)
  }

  it('renders beats out of order with their looks', async () => {
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    expect(resolved.durationSec).toBeCloseTo(3)
    const fractions: number[] = []
    const out = await renderCut(cut, resolved, sources, {
      ffmpeg,
      outputPath: join(dir, 'one-pass.mp4'),
      workDir: join(dir, 'work-1'),
      quality: 'preview',
      onProgress: (f) => fractions.push(f)
    })
    await check(out)
    expect(fractions[fractions.length - 1]).toBe(1)
  })

  it('renders long cuts in chunks to the same result', async () => {
    const cut = currentCut(doc)
    const out = await renderCut(cut, resolveCut(cut, doc.words, doc.sources), sources, {
      ffmpeg,
      outputPath: join(dir, 'chunked.mp4'),
      workDir: join(dir, 'work-2'),
      quality: 'preview',
      maxInputs: 1
    })
    await check(out)
  })

  it('renders an image as a card and as a full-frame cutaway', async () => {
    const icon = join(dir, 'icon.png')
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=200x200',
      '-frames:v',
      '1',
      icon
    ])
    const broll = { path: icon, inSec: 0, muted: true }
    const withStills = commit(
      doc,
      [
        { op: 'remove', beats: currentCut(doc).beats.map((b) => b.id) },
        { op: 'insert', to: 0, beat: { source: 's1', inSec: 0, outSec: 1, treatment: { frame: 'card', broll } } },
        { op: 'insert', to: 1, beat: { source: 's1', inSec: 1, outSec: 2, treatment: { frame: 'broll', broll } } }
      ],
      'Stills.'
    ).doc
    const cut = currentCut(withStills)
    const out = await renderCut(cut, resolveCut(cut, withStills.words, withStills.sources), sources, {
      ffmpeg,
      outputPath: join(dir, 'stills.mp4'),
      workDir: join(dir, 'work-4'),
      quality: 'preview'
    })
    const info = await probeMedia(ffmpeg, out)
    expect(Math.abs(info.durationSec - 2)).toBeLessThan(0.15)
    const samples = await sampleColour(out, { ffmpeg, fps: 4 })
    // The card is mostly Cutalong's light ground; the cutaway is all red.
    expect(samples[0].luma).toBeGreaterThan(150)
    expect(samples[samples.length - 1].luma).toBeLessThan(110)
    expect(samples[samples.length - 1].sat).toBeGreaterThan(40)
  })

  it('burns in captions from the words', async () => {
    const words = wordsFromTranscript(
      [
        { text: 'Cut', startSec: 0.1, endSec: 0.4 },
        { text: 'along', startSec: 0.45, endSec: 0.8 },
        { text: 'with', startSec: 1.1, endSec: 1.3 },
        { text: 'this.', startSec: 1.35, endSec: 1.8 }
      ],
      's1'
    )
    const spoken = createDoc({ id: 'c', title: 'Captions', source: doc.sources[0], words })
    const cut = currentCut(spoken)
    const out = await renderCut(cut, resolveCut(cut, spoken.words, spoken.sources), sources, {
      ffmpeg,
      outputPath: join(dir, 'captions.mp4'),
      workDir: join(dir, 'work-3'),
      quality: 'preview'
    })
    expect(existsSync(join(dir, 'work-3', 'captions.ass'))).toBe(true)
    expect((await probeMedia(ffmpeg, out)).durationSec).toBeGreaterThan(1.5)
  })
})
