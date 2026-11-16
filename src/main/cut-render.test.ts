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
    expect(graph).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][acat]')
    expect(graph).not.toContain('loudnorm')
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
