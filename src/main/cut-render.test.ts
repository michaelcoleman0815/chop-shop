import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loudnessEnvelope } from './audio-envelope'
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
import { makeColourClip } from './test-media'

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
    // The first run is one piece (60 frames); the second is the wipe's piece and the hard cut after it (45 + 30).
    // Each is told its frame rate again, which ffmpeg 7's xfade needs, and cut back to its frames, as 6.0 adds one.
    expect(graph).toContain('[v0]settb=1/30,fps=30,trim=end_frame=60[vr0]')
    expect(graph).toContain('[v1][v2]concat=n=2:v=1:a=0,settb=1/30,fps=30,trim=end_frame=75[vr1]')
    // The wipe meets the pictures for its 12 frames from 48, between the old picture before and the new one after.
    expect(graph).toContain('[vc1a0]trim=end_frame=48,setpts=PTS-STARTPTS[vc1before]')
    expect(graph).toContain(
      '[vc1a1]trim=start_frame=48:end_frame=60,setpts=PTS-STARTPTS,settb=1/30,fps=30,trim=end_frame=12[vc1under]'
    )
    expect(graph).toContain('[vc1b0]trim=end_frame=12,setpts=PTS-STARTPTS,settb=1/30,fps=30,trim=end_frame=12[vc1over]')
    expect(graph).toContain('[vc1b1]trim=start_frame=12,setpts=PTS-STARTPTS[vc1after]')
    expect(graph).toContain('[vc1under][vc1over]xfade=transition=wipeleft:duration=0.400000:offset=0,format=yuv420p[vc1meet]')
    // Stamped again by frame count, which the join reads exactly on every version.
    expect(graph).toContain('[vc1meet]setpts=N/(30*TB)[vc1meets]')
    expect(graph).toContain(
      '[vc1before][vc1meets][vc1after]concat=n=3:v=1:a=0,settb=1/30,fps=30,trim=end_frame=123[vcat]'
    )
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
    // The blur's times are the transition's own: it is made from pictures exactly its length.
    expect(graph).toContain(
      "[vc1under][vc1over]xfade=transition=slideleft:duration=0.300000:offset=0,gblur=sigma=14:sigmaV=0:enable='between(t,0.045000,0.255000)',format=yuv420p[vc1meet]"
    )
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
    // Read a second past the end, so the picture ends first.
    expect(args.slice(args.indexOf('/brand/logo.png') - 5, args.indexOf('/brand/logo.png') + 1)).toEqual([
      '-loop',
      '1',
      '-t',
      '3.000',
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

  it('puts each pass on the frames the cut’s clock gives it, one that starts a hair from half a frame too', async () => {
    // Six colours, a beat of each, every cut within a thousandth of a frame of
    // half a frame, where a pass's millisecond timestamps could round either
    // way. In passes of one, every frame shows the beat the clock puts there.
    const hues: [string, number[]][] = [
      ['red', [255, 0, 0]],
      ['blue', [0, 0, 255]],
      ['lime', [0, 255, 0]],
      ['yellow', [255, 255, 0]],
      ['magenta', [255, 0, 255]],
      ['cyan', [0, 255, 255]]
    ]
    const path = makeColourClip(
      ffmpeg,
      join(dir, 'hues.mp4'),
      hues.map(([color], k) => ({ color, hz: 300 + 150 * k, sec: 1.5 }))
    )
    const source = { id: 's1', path, durationSec: 9, width: 320, height: 180, fps: 30 }
    const lengths = [1.01665, 1.03336, 0.93332, 1.03335, 1.00002, 1.1833]
    const hued = commit(
      createDoc({ id: 'h', title: 'Hues', source, words: [] }),
      [
        { op: 'remove', beats: ['b1'] },
        ...lengths.map((l, k) => ({
          op: 'insert' as const,
          to: k,
          beat: { source: 's1', inSec: 1.5 * k + 0.2, outSec: 1.5 * k + 0.2 + l }
        })),
        { op: 'aspect', aspect: 'original' },
        { op: 'loudness', lufs: null }
      ],
      'Hues.'
    ).doc
    const cut = currentCut(hued)
    const resolved = resolveCut(cut, hued.words, hued.sources)
    const halves = resolved.pieces.slice(1).map((p) => Math.abs(((p.outStart * 30) % 1) - 0.5))
    expect(Math.max(...halves)).toBeLessThan(0.002)
    const out = await renderCut(cut, resolved, [{ ...source, hasAudio: true }], {
      ffmpeg,
      outputPath: join(dir, 'hues-passes.mp4'),
      workDir: join(dir, 'work-hues'),
      quality: 'preview',
      maxInputs: 1
    })
    // Every frame as one pixel, in the order it plays.
    const frames = ['-vf', 'scale=1:1:flags=area,format=rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']
    const px = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', out, ...frames], {
      maxBuffer: 1 << 20
    })
    const nearest = (i: number): number => {
      const d = hues.map(([, c]) => Math.abs(c[0] - px[i]) + Math.abs(c[1] - px[i + 1]) + Math.abs(c[2] - px[i + 2]))
      return d.indexOf(Math.min(...d))
    }
    const shown = Array.from({ length: px.length / 3 }, (_, i) => nearest(i * 3))
    const meant = Array.from({ length: Math.round(resolved.durationSec * 30) }, (_, i) =>
      resolved.pieces.findIndex((p) => i >= Math.round(p.outStart * 30) && i < Math.round(p.outEnd * 30))
    )
    expect(shown).toEqual(meant)
  })

  it('renders shots of many different files, as a vlog has, in passes of a few', async () => {
    // Nine clips of a day, a second of each.
    const clips = Array.from({ length: 9 }, (_, k) => {
      const path = join(dir, `clip-${k}.mp4`)
      execFileSync(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        sources[0].path,
        '-t',
        '1.2',
        '-vf',
        `hue=h=${k * 40}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        path
      ])
      return { id: `s${k + 1}`, path, durationSec: 1.2, width: 640, height: 360, fps: 30 }
    })
    const day = commit(
      createDoc({ id: 'v', title: 'Day', sources: clips, words: [] }),
      [
        {
          op: 'remove',
          beats: currentCut(createDoc({ id: 'v', title: 'Day', sources: clips, words: [] })).beats.map((b) => b.id)
        },
        ...clips.map((c, k) => ({ op: 'insert' as const, to: k, beat: { source: c.id, inSec: 0, outSec: 1 } }))
      ],
      'The day.'
    ).doc
    const cut = currentCut(day)
    const workDir = join(dir, 'work-day')
    const out = await renderCut(
      cut,
      resolveCut(cut, day.words, day.sources),
      clips.map((c) => ({ ...c, hasAudio: true })),
      {
        ffmpeg,
        outputPath: join(dir, 'day.mp4'),
        workDir,
        quality: 'preview'
      }
    )
    const info = await probeMedia(ffmpeg, out)
    expect(Math.abs(info.durationSec - 9)).toBeLessThan(0.15)
    // Two clips a pass, and the last pass reads the five back as one.
    expect(readdirSync(workDir).filter((f) => f.startsWith('chunk-'))).toHaveLength(5)
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

  it('punches in by amounts that do not divide the frame evenly, as /shorts does', async () => {
    // 1.12 crops a 540x960 frame to 482x856, which is not quite 9:16; scaled back
    // up, its pixels are a hair off square, and the join refused the mix.
    const punched = commit(
      createDoc({ id: 'p', title: 'Punch', source: doc.sources[0], words: [] }),
      [
        { op: 'remove', beats: ['b1'] },
        { op: 'insert', to: 0, beat: { source: 's1', inSec: 0, outSec: 1 } },
        { op: 'insert', to: 1, beat: { source: 's1', inSec: 1, outSec: 2, treatment: { zoom: 1.12 } } },
        { op: 'insert', to: 2, beat: { source: 's1', inSec: 2, outSec: 3, treatment: { zoom: 1.08 } } },
        { op: 'aspect', aspect: 'vertical' }
      ],
      'Punched.'
    ).doc
    const cut = currentCut(punched)
    for (const quality of ['preview', 'final'] as const) {
      const out = await renderCut(cut, resolveCut(cut, punched.words, punched.sources), sources, {
        ffmpeg,
        outputPath: join(dir, `punch-${quality}.mp4`),
        workDir: join(dir, `work-punch-${quality}`),
        quality
      })
      expect(Math.abs((await probeMedia(ffmpeg, out)).durationSec - 3)).toBeLessThan(0.15)
    }
  })

  it('exports a recording with no sound at the usual loudness target, in one pass or in chunks', async () => {
    const mute = [{ ...sources[0], hasAudio: false }]
    const cut = currentCut(doc)
    expect(cut.loudness).not.toBeNull()
    for (const maxInputs of [Infinity, 1]) {
      const name = maxInputs === 1 ? 'chunked' : 'whole'
      const out = await renderCut(cut, resolveCut(cut, doc.words, doc.sources), mute, {
        ffmpeg,
        outputPath: join(dir, `mute-${name}.mp4`),
        workDir: join(dir, `work-mute-${name}`),
        quality: 'final',
        maxInputs
      })
      const info = await probeMedia(ffmpeg, out)
      expect(Math.abs(info.durationSec - 3)).toBeLessThan(0.15)
      expect(info.hasAudio).toBe(true)
    }
  })

  it('plays the better sound from another recording, lined up under the picture', async () => {
    // Two seconds of silence, then a tone. The picture starts one second into
    // it, so the first second of the export is quiet and the second is not,
    // where the camera's own sound is a tone all the way through.
    const voice = join(dir, 'voice.wav')
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=mono:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000:duration=4',
      '-filter_complex',
      '[0:a][1:a]concat=n=2:v=0:a=1[a]',
      '-map',
      '[a]',
      voice
    ])
    const lined = { ...doc.sources[0], audio: { path: voice, offsetSec: 1 } }
    const two = commit(
      createDoc({ id: 'x', title: 'Lined', source: lined, words: [] }),
      [
        { op: 'remove', beats: ['b1'] },
        { op: 'insert', to: 0, beat: { source: 's1', inSec: 0, outSec: 2 } }
      ],
      'Two seconds.'
    ).doc
    const cut = currentCut(two)
    const out = await renderCut(cut, resolveCut(cut, two.words, two.sources), [{ ...lined, hasAudio: true }], {
      ffmpeg,
      outputPath: join(dir, 'lined.mp4'),
      workDir: join(dir, 'work-lined'),
      quality: 'preview'
    })
    const env = await loudnessEnvelope(ffmpeg, out)
    const mean = (from: number, to: number): number => {
      const part = Array.from(env.db).slice(Math.round(from / env.hopSec), Math.round(to / env.hopSec))
      return part.reduce((n, v) => n + v, 0) / part.length
    }
    expect(mean(0.1, 0.85)).toBeLessThan(-60)
    expect(mean(1.15, 1.9)).toBeGreaterThan(-30)
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
