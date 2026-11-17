import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, type Cut, type EditDoc } from '../shared/edit'
import { renderCut, type RenderSource } from './cut-render'
import { hasEncoder } from './providers/testing'
import { AS_PLAYED, audioSeconds, countFrames, ffmpegRun, findFfmpeg, frameColour, makeColourClip, toneLevel } from './test-media'

const FFMPEG = findFfmpeg()

/** The mean colour of output frame number `n`, picked by count rather than by seeking. */
function frameN(ffmpeg: string, path: string, n: number): [number, number, number] {
  const out = execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-vf',
      `select=eq(n\\,${n}),${AS_PLAYED},scale=1:1:flags=area,format=rgb24`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-'
    ],
    { maxBuffer: 1024 }
  )
  return [out[0], out[1], out[2]]
}

describe.skipIf(!FFMPEG)('exports of awkward material', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let sources: RenderSource[]

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-zz-'))
    // Red with a 440 Hz tone for 3 s, then blue with 880 Hz for 3 s.
    const path = makeColourClip(ffmpeg, join(dir, 'source.mp4'), [
      { color: 'red', hz: 440, sec: 3 },
      { color: 'blue', hz: 880, sec: 3 }
    ])
    const source = { id: 's1', path, durationSec: 6, width: 320, height: 180, fps: 30 }
    sources = [{ ...source, hasAudio: true }]
    doc = createDoc({ id: 'd', title: 'T', source, words: [] })
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const cutWith = (ops: unknown[]): Cut => {
    const r = applyOps(
      currentCut(doc),
      [{ op: 'remove', beats: ['b1'] }, ...ops, { op: 'aspect', aspect: 'original' }, { op: 'loudness', lufs: null }],
      { words: doc.words, sources: doc.sources }
    )
    expect(r.rejected).toEqual([])
    return r.cut
  }

  const render = async (cut: Cut, name: string, extra: Record<string, unknown> = {}) => {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const out = await renderCut(cut, resolved, sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'final',
      ...extra
    })
    return { out, total: resolved.durationSec }
  }

  it('B-roll shorter than its beat: the picture keeps its length and stays with the sound', async () => {
    // A 1 s green cutaway over a 4 s beat, then a 1 s beat of the red speaker.
    const green = join(dir, 'green-1s.mp4')
    ffmpegRun(ffmpeg, [
      '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30:d=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', green
    ])
    const broll = { path: green, inSec: 0, muted: true }
    const cut = cutWith([
      // The blue speaker's voice (880 Hz) for 4 s under the cutaway, then 1 s of the red speaker (440 Hz).
      { op: 'insert', to: 0, beat: { source: 's1', inSec: 1.9, outSec: 5.9, treatment: { frame: 'broll', broll } } },
      { op: 'insert', to: 1, beat: { source: 's1', inSec: 0.5, outSec: 1.5 } }
    ])
    const { out, total } = await render(cut, 'short-broll')
    const frames = countFrames(ffmpeg, out)
    console.log('short-broll: resolver', total, 's; frames', frames, '(want', Math.round(total * 30), ') audio', audioSeconds(ffmpeg, out))
    for (const t of [1.5, 2.5, 3.5, 4.5])
      console.log(`  t=${t}: colour`, frameColour(ffmpeg, out, t), '440 Hz', toneLevel(ffmpeg, out, t - 0.2, 0.4, 440), '880 Hz', toneLevel(ffmpeg, out, t - 0.2, 0.4, 880))
    expect(total).toBeCloseTo(5, 6)
    expect(frames).toBe(150)
    // At 2.5 s the voice is still the cutaway beat's (880 Hz), so the red speaker must not be on screen yet.
    const [r25] = frameColour(ffmpeg, out, 2.5)
    expect(r25).toBeLessThan(100)
    // The last beat is the red speaker, picture and sound together.
    const [r, , b] = frameColour(ffmpeg, out, 4.5)
    expect(r).toBeGreaterThan(150)
    expect(b).toBeLessThan(80)
  })

  it('a recorder file with artwork, sorted as talking, exports its full length on a plain frame', async () => {
    const art = join(dir, 'art.jpg')
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'color=c=purple:s=600x600', '-frames:v', '1', art])
    const m4a = join(dir, 'voice.m4a')
    ffmpegRun(ffmpeg, [
      '-f', 'lavfi', '-i', 'sine=f=300:d=6', '-i', art, '-map', '0:a', '-map', '1:v',
      '-c:a', 'aac', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic', m4a
    ])
    // As a project saved before cover art was told apart has it: 600 x 600,
    // the artwork's size. The export probes it again and finds no picture.
    const src = { id: 's1', path: m4a, durationSec: 6, width: 600, height: 600, fps: 30, audio: null }
    const vdoc = createDoc({ id: 'v', title: 'Voice', source: src, words: [] })
    const r = applyOps(
      currentCut(vdoc),
      [
        { op: 'remove', beats: ['b1'] },
        { op: 'insert', to: 0, beat: { source: 's1', inSec: 1, outSec: 4 } },
        { op: 'insert', to: 1, beat: { source: 's1', inSec: 4.5, outSec: 5.5 } },
        { op: 'loudness', lufs: null }
      ],
      { words: vdoc.words, sources: vdoc.sources }
    )
    const resolved = resolveCut(r.cut, vdoc.words, vdoc.sources)
    const out = await renderCut(r.cut, resolved, [{ ...src, hasAudio: true, hasVideo: false }], {
      ffmpeg,
      outputPath: join(dir, 'voice-out.mp4'),
      workDir: join(dir, 'work-voice'),
      quality: 'final'
    })
    const frames = countFrames(ffmpeg, out)
    expect(frames).toBe(Math.round(resolved.durationSec * 30))
    expect(audioSeconds(ffmpeg, out)).toBeCloseTo(resolved.durationSec, 1)
    // Black, not purple: the artwork is not the speaker.
    expect(Math.max(...frameColour(ffmpeg, out, 2))).toBeLessThan(20)
  })

  it('a recording whose picture stops 3 s before its sound keeps every later beat in sync', async () => {
    // 3 s of picture (red), 6 s of sound (440 Hz then 880 Hz), as a recorder that dropped its video can leave.
    const lopsided = join(dir, 'lopsided.mp4')
    ffmpegRun(ffmpeg, [
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=3',
      '-f', 'lavfi', '-i', 'sine=f=440:d=3,apad=pad_dur=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', lopsided
    ])
    const src = { id: 's2', path: lopsided, durationSec: 6, width: 320, height: 180, fps: 30, audio: null }
    const two = { ...doc, sources: [...doc.sources, src] }
    const r = applyOps(
      currentCut(two),
      [
        { op: 'remove', beats: ['b1'] },
        // 1 s of the lopsided recording's picture, then 2.5 s past where its picture stops.
        { op: 'insert', to: 0, beat: { source: 's2', inSec: 2.0, outSec: 5.5 } },
        { op: 'insert', to: 1, beat: { source: 's1', inSec: 3.5, outSec: 4.5 } },
        { op: 'aspect', aspect: 'original' },
        { op: 'loudness', lufs: null }
      ],
      { words: two.words, sources: two.sources }
    )
    expect(r.rejected).toEqual([])
    const resolved = resolveCut(r.cut, two.words, two.sources)
    const out = await renderCut(r.cut, resolved, [...sources, { ...src, hasAudio: true }], {
      ffmpeg,
      outputPath: join(dir, 'lopsided-out.mp4'),
      workDir: join(dir, 'work-lopsided'),
      quality: 'final'
    })
    const frames = countFrames(ffmpeg, out)
    console.log('lopsided: resolver', resolved.durationSec, 'frames', frames, 'want', Math.round(resolved.durationSec * 30), 'colour at 3.0 s', frameColour(ffmpeg, out, 3.0), 'blue (s1) should start at 3.5 s')
    expect(frames).toBe(Math.round(resolved.durationSec * 30))
  })

  it('a recording whose sound track is digital silence (a screen recording, no mic) exports at the loudness target', async () => {
    const silent = join(dir, 'screen-silent.mp4')
    ffmpegRun(ffmpeg, [
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', silent
    ])
    const src = { id: 's1', path: silent, durationSec: 4, width: 320, height: 180, fps: 30, audio: null }
    const sdoc = createDoc({ id: 'scr', title: 'Screen', source: src, words: [] })
    const cut = currentCut(sdoc)
    console.log('loudness target', cut.loudness)
    for (const extra of [{ maxInputs: Infinity }, { maxInputs: 1 }]) {
      const r = applyOps(
        cut,
        [
          { op: 'remove', beats: ['b1'] },
          { op: 'insert', to: 0, beat: { source: 's1', inSec: 0, outSec: 2 } },
          { op: 'insert', to: 1, beat: { source: 's1', inSec: 2, outSec: 4 } }
        ],
        { words: sdoc.words, sources: sdoc.sources }
      )
      const resolved = resolveCut(r.cut, sdoc.words, sdoc.sources)
      const name = `silent-${extra.maxInputs === 1 ? 'passes' : 'one'}`
      try {
        const out = await renderCut(r.cut, resolved, [{ ...src, hasAudio: true }], {
          ffmpeg,
          outputPath: join(dir, `${name}.mp4`),
          workDir: join(dir, `work-${name}`),
          quality: 'final',
          ...extra
        })
        console.log(name, 'frames', countFrames(ffmpeg, out), 'audio', audioSeconds(ffmpeg, out))
      } catch (err) {
        console.log(name, 'FAILED:', String(err).split('\n').slice(-3).join(' | '))
        throw err
      }
    }
  })

  it('a lav on one input (voice on the left channel only) is heard in both ears', async () => {
    const lav = join(dir, 'lav-left.mp4')
    ffmpegRun(ffmpeg, [
      '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=4',
      '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*300*t)|0':s=48000:d=4",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', lav
    ])
    const src = { id: 's1', path: lav, durationSec: 4, width: 320, height: 180, fps: 30, audio: null }
    const ldoc = createDoc({ id: 'lav', title: 'Lav', source: src, words: [] })
    const resolved = resolveCut(currentCut(ldoc), ldoc.words, ldoc.sources)
    const out = await renderCut(currentCut(ldoc), resolved, [{ ...src, hasAudio: true }], {
      ffmpeg,
      outputPath: join(dir, 'lav-out.mp4'),
      workDir: join(dir, 'work-lav'),
      quality: 'final'
    })
    const level = (ch: string): number => {
      const r = require('child_process').spawnSync(
        ffmpeg,
        ['-hide_banner', '-i', out, '-af', `pan=mono|c0=${ch},volumedetect`, '-f', 'null', '-'],
        { encoding: 'utf8' }
      )
      return Number(/mean_volume:\s*(-?[\d.]+)/.exec(r.stderr)?.[1] ?? -91)
    }
    console.log('lav export: left', level('c0'), 'dB, right', level('c1'), 'dB')
    expect(level('c1')).toBeGreaterThan(level('c0') - 6)
  })

  it('iPhone HDR (HLG) B-roll is converted for export the way the speaker is', async () => {
    // One HLG clip, as an iPhone records by default: shown once as the speaker, once as B-roll.
    const hlg = join(dir, 'iphone-hlg.mov')
    ffmpegRun(ffmpeg, [
      '-f', 'lavfi', '-i', 'color=c=0x5080B0:s=320x180:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=300:d=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-c:a', 'aac', hlg
    ])
    const src = { id: 's2', path: hlg, durationSec: 3, width: 320, height: 180, fps: 30, audio: null, color: 'hlg' as const }
    const two = { ...doc, sources: [...doc.sources, src] }
    const broll = { path: hlg, inSec: 0.5, muted: true }
    const r = applyOps(
      currentCut(two),
      [
        { op: 'remove', beats: ['b1'] },
        { op: 'insert', to: 0, beat: { source: 's2', inSec: 0.5, outSec: 1.5 } },
        { op: 'insert', to: 1, beat: { source: 's1', inSec: 0.5, outSec: 1.5, treatment: { frame: 'broll', broll } } },
        { op: 'aspect', aspect: 'original' },
        { op: 'loudness', lufs: null }
      ],
      { words: two.words, sources: two.sources }
    )
    expect(r.rejected).toEqual([])
    const resolved = resolveCut(r.cut, two.words, two.sources)
    const out = await renderCut(r.cut, resolved, [...sources, { ...src, hasAudio: true }], {
      ffmpeg,
      outputPath: join(dir, 'hlg-out.mp4'),
      workDir: join(dir, 'work-hlg'),
      quality: 'final'
    })
    const asSpeaker = frameColour(ffmpeg, out, 0.5)
    const asBroll = frameColour(ffmpeg, out, 1.5)
    console.log('HLG clip as the speaker', asSpeaker, 'the same clip as B-roll', asBroll)
    for (let i = 0; i < 3; i++) expect(Math.abs(asSpeaker[i] - asBroll[i])).toBeLessThan(12)
  })

  // Making the AVIF needs an AV1 encoder, which not every ffmpeg has.
  it.skipIf(!hasEncoder(FFMPEG, 'libaom-av1'))('an AVIF still (assets take .avif as an image) shows for its whole beat', async () => {
    const avif = join(dir, 'photo.avif')
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'color=c=green:s=320x180', '-frames:v', '1', '-c:v', 'libaom-av1', '-still-picture', '1', avif])
    const broll = { path: avif, inSec: 0, muted: true }
    const cut = cutWith([
      { op: 'insert', to: 0, beat: { source: 's1', inSec: 2.0, outSec: 5.0, treatment: { frame: 'broll', broll } } },
      { op: 'insert', to: 1, beat: { source: 's1', inSec: 0.5, outSec: 1.5 } }
    ])
    const { out, total } = await render(cut, 'avif-broll')
    const frames = countFrames(ffmpeg, out)
    console.log('avif: resolver', total, 'frames', frames, 'want', Math.round(total * 30), 'colour at 2.5 s', frameColour(ffmpeg, out, 2.5), 'at 3.5 s', frameColour(ffmpeg, out, 3.5))
    expect(frames).toBe(Math.round(total * 30))
    // The speaker (red) comes back at 3 s, with the 440 Hz voice.
    expect(frameColour(ffmpeg, out, 2.5)[1]).toBeGreaterThan(100)
  })

  it('a brand logo that is a GIF (the logo chooser offers it) exports', async () => {
    const logo = join(dir, 'logo.gif')
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'color=c=white:s=64x64', '-frames:v', '1', logo])
    const cut = cutWith([{ op: 'insert', to: 0, beat: { source: 's1', inSec: 0.5, outSec: 1.5 } }])
    const { out } = await render(cut, 'gif-logo', {
      brand: { colors: { text: '#FFFFFF', accent: '#FFCC00' }, logo: { path: logo, corner: 'top-right', opacity: 0.9 } }
    })
    expect(countFrames(ffmpeg, out)).toBe(30)
  })

  it('a GIF as B-roll, which the B-roll chooser offers, exports', async () => {
    const gif = join(dir, 'spin.gif')
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc=s=160x120:r=10:d=1', gif])
    const broll = { path: gif, inSec: 0, muted: true }
    const cut = cutWith([
      { op: 'insert', to: 0, beat: { source: 's1', inSec: 0.5, outSec: 1.5 } },
      { op: 'insert', to: 1, beat: { source: 's1', inSec: 1.5, outSec: 2.5, treatment: { frame: 'broll', broll } } }
    ])
    const { out } = await render(cut, 'gif-broll')
    expect(countFrames(ffmpeg, out)).toBe(60)
  })

  it("a LUT in a folder with an apostrophe (Mike's LUTs) exports", async () => {
    const folder = join(dir, "Mike's LUTs")
    mkdirSync(folder, { recursive: true })
    const lut = join(folder, 'identity.cube')
    writeFileSync(
      lut,
      ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1', ''].join('\n')
    )
    const cut = cutWith([
      { op: 'insert', to: 0, beat: { source: 's1', inSec: 0.5, outSec: 1.5 } },
      { op: 'look', set: { lut: { path: lut, strength: 1 } }, replace: true }
    ])
    const { out } = await render(cut, 'lut-apostrophe')
    expect(countFrames(ffmpeg, out)).toBe(30)
  })

  it('a motion graphic starting on frame 2 shows from frame 2, not frame 3', async () => {
    // A white card with alpha, 15 frames long, as motion-render writes them (qtrle, argb).
    const card = join(dir, 'card.mov')
    ffmpegRun(ffmpeg, [
      '-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=30:d=0.5,format=argb',
      '-c:v', 'qtrle', '-pix_fmt', 'argb', card
    ])
    const cut = cutWith([{ op: 'insert', to: 0, beat: { source: 's1', inSec: 0.5, outSec: 1.5 } }])
    // motion-render places a span starting on frame `first` at first / fps.
    const results: Record<number, number> = {}
    for (const first of [1, 2, 4, 5]) {
      const { out } = await render(cut, `overlay-${first}`, {
        overlays: [{ path: card, startSec: first / 30, durationSec: 15 / 30 }]
      })
      let shown = -1
      for (let n = 0; n < 10; n++) {
        if (frameN(ffmpeg, out, n)[2] > 200) {
          shown = n
          break
        }
      }
      results[first] = shown
    }
    console.log('overlay first frame shown, by intended first frame:', results)
    expect(results).toEqual({ 1: 1, 2: 2, 4: 4, 5: 5 })
  })
})
