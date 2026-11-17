import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addCamera,
  applyOps,
  createDoc,
  currentCut,
  pipBox,
  resolveCut,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Op
} from '../shared/edit'
import { renderCut } from './cut-render'
import { writePremiere } from './premiere-cut'
import { AS_PLAYED, findFfmpeg, makeClip, onsets, toneLevel } from './test-media'

const FFMPEG = findFfmpeg()

/** Three sentences, a tone for each word. */
const SAID = [0, 1, 2].flatMap((k) =>
  ['One', 'two', 'three.'].map((text, i) => ({
    text,
    startSec: 0.5 + k * 2 + i * 0.4,
    endSec: 0.8 + k * 2 + i * 0.4
  }))
)

/** Camera 2 started this much earlier: what camera 1 shows at t, camera 2 shows at t + LEAD. */
const LEAD = 1

/** A camera whose every frame says which camera and which frame it is; its words a tone of its own. */
function camera(ffmpeg: string, path: string, sec: number, blue: number, hz: number, shift: number): string {
  const gates = SAID.map((w) => `between(t,${w.startSec + shift},${w.endSec + shift})`).join('+')
  return makeClip(
    ffmpeg,
    path,
    `color=black:s=640x360:r=30:d=${sec},format=rgb24,geq=r='8+16*mod(N,16)':g='8+16*mod(floor(N/16),16)':b=${blue}`,
    `aevalsrc=exprs='0.4*sin(2*PI*${hz}*t)*(${gates})|0.4*sin(2*PI*${hz}*t)*(${gates})':s=48000:d=${sec}`
  )
}

/** The camera and frame a coded picture shows, from the mean colour of a stretch of a frame. */
function seen(ffmpeg: string, path: string, frame: number, crop = ''): string {
  const raw = execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-vf',
      `select=eq(n\\,${frame}),${crop ? `${crop},` : ''}${AS_PLAYED},scale=1:1:flags=area,format=rgb24`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-'
    ],
    { maxBuffer: 1024 }
  )
  return `${raw[2] > 120 ? 2 : 1}:${Math.round((raw[0] - 8) / 16) + 16 * Math.round((raw[1] - 8) / 16)}`
}

describe.skipIf(!FFMPEG)('another camera of the same take', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-angles-'))
    const one = { id: 's1', path: join(dir, 'one.mp4'), durationSec: 7, width: 640, height: 360, fps: 30 }
    const two = { id: 's2', path: join(dir, 'two.mp4'), durationSec: 8, width: 640, height: 360, fps: 30 }
    camera(ffmpeg, one.path, 7, 40, 600, 0)
    camera(ffmpeg, two.path, 8, 200, 900, LEAD)
    doc = createDoc({ id: 'd', title: 'Two cameras', source: one, words: wordsFromTranscript(SAID, 's1') })
    doc = addCamera(doc, two, 's1', LEAD, 'Camera 2 is lined up.').doc
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const render = async (ops: Op[], name: string): Promise<{ out: string; cut: Cut }> => {
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'aspect', aspect: 'original' },
        { op: 'captions', set: { on: false } },
        { op: 'loudness', lufs: null },
        ...ops
      ],
      doc
    )
    expect(r.rejected).toEqual([])
    const out = await renderCut(
      r.cut,
      resolveCut(r.cut, doc.words, doc.sources),
      doc.sources.map((s) => ({ ...s, hasAudio: true })),
      {
        ffmpeg,
        outputPath: join(dir, `${name}.mp4`),
        workDir: join(dir, `work-${name}`),
        quality: 'final'
      }
    )
    return { out, cut: r.cut }
  }

  it('shows the other camera at the lined-up moment, beside, over or instead of the first, and keeps the first one’s sound', async () => {
    const plain = await render([], 'plain')
    const { out, cut } = await render(
      [
        { op: 'angle', beats: ['b1'], source: 's2' },
        { op: 'angle', beats: ['b2'], source: 's2', layout: 'pip' },
        { op: 'angle', beats: ['b3'], source: 's2', layout: 'side' }
      ],
      'cameras'
    )
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const middle = (id: string): number => {
      const b = resolved.beats.find((x) => x.id === id)!
      return Math.round(((b.outStart + b.outEnd) / 2) * 30)
    }
    const plus = (code: string): string => `2:${Number(code.split(':')[1]) + LEAD * 30}`
    // Instead: the frame camera 1 showed there, from camera 2, a second further into its file.
    const f1 = middle('b1')
    expect(seen(ffmpeg, out, f1)).toBe(plus(seen(ffmpeg, plain.out, f1)))
    // In a box, top right: camera 2 in the box, camera 1 around it.
    const f2 = middle('b2')
    const box = pipBox({ width: 640, height: 360 }, { width: 640, height: 360 })
    const inBox = `crop=${box.width - 8}:${box.height - 8}:${box.x + 4}:${box.y + 4}`
    expect(seen(ffmpeg, out, f2, inBox)).toBe(plus(seen(ffmpeg, plain.out, f2)))
    expect(seen(ffmpeg, out, f2, 'crop=200:150:20:190')).toBe(seen(ffmpeg, plain.out, f2))
    // Side by side across the wide frame: camera 1 on the left, camera 2 on the right.
    const f3 = middle('b3')
    expect(seen(ffmpeg, out, f3, 'crop=300:340:10:10')).toBe(seen(ffmpeg, plain.out, f3))
    expect(seen(ffmpeg, out, f3, 'crop=300:340:330:10')).toBe(plus(seen(ffmpeg, plain.out, f3)))
    // The sound is camera 1's all the way through, every word where it was; camera 2's never plays.
    const band = (hz: number): string => `bandpass=f=${hz}:width_type=q:w=8,bandpass=f=${hz}:width_type=q:w=8`
    const ours = onsets(ffmpeg, out, -35, 0.05, band(600)).filter((t) => t < resolved.durationSec - 0.05)
    const before = onsets(ffmpeg, plain.out, -35, 0.05, band(600)).filter((t) => t < resolved.durationSec - 0.05)
    expect(ours.length).toBe(before.length)
    ours.forEach((t, i) => expect(Math.abs(t - before[i])).toBeLessThan(0.005))
    // Camera 2's own 900 Hz words: as quiet through every beat it shows as where it never shows.
    for (const id of ['b1', 'b2', 'b3']) {
      const b = resolved.beats.find((x) => x.id === id)!
      const word = resolved.words.find((w) => w.beat === id)!
      const at = word.outStart + 0.05
      expect(toneLevel(ffmpeg, out, at, 0.2, 900), id).toBeLessThan(toneLevel(ffmpeg, out, at, 0.2, 600) - 25)
      expect(
        Math.abs(toneLevel(ffmpeg, out, at, 0.2, 900) - toneLevel(ffmpeg, plain.out, at, 0.2, 900)),
        id
      ).toBeLessThan(2)
      expect(b.outEnd).toBeGreaterThan(at)
    }
  })

  it('opens in Premiere cut on the other camera’s file where a beat shows it, the sound still the first one’s', async () => {
    const cut = applyOps(
      currentCut(doc),
      [
        { op: 'angle', beats: ['b1'], source: 's2' },
        { op: 'angle', beats: ['b2'], source: 's2', layout: 'pip' },
        { op: 'angle', beats: ['b3'], source: 's2', layout: 'side' }
      ],
      doc
    ).cut
    const shown = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 9, cut }] }
    const written = await writePremiere(shown, {
      ffmpeg,
      xmlPath: join(dir, 'Cameras v9.xml'),
      sfxDir: join(dir, 'sfx')
    })
    const xml = readFileSync(written.xmlPath, 'utf8')
    const video = xml.slice(xml.indexOf('<video>'), xml.indexOf('</video>\n\t\t\t<audio>'))
    const audio = xml.slice(xml.indexOf('</video>\n\t\t\t<audio>'))
    const resolved = resolveCut(cut, doc.words, doc.sources)
    // The first picture clip is camera 2's file, a second further in; the voice is camera 1's.
    const first = /<clipitem id="[^"]+">[\s\S]*?<\/clipitem>/.exec(video)![0]
    expect(first).toContain('two.mp4')
    const inSec = Number(/<pproTicksIn>(\d+)<\/pproTicksIn>/.exec(first)![1]) / 254016000000
    expect(Math.abs(inSec - (resolved.pieces[0].srcStart + LEAD))).toBeLessThan(1 / 30 + 1e-6)
    expect(audio).toContain('one.mp4')
    expect(audio).not.toContain('two.mp4')
    expect(xml).toContain('<name>Camera in a box</name>')
    expect(xml).toContain('<name>Cameras side by side</name>')
    expect(written.facts.leftOut).toEqual([
      'another camera in a box on 1 beat',
      'cameras side by side on 1 beat',
      'the loudness'
    ])
  })
})
