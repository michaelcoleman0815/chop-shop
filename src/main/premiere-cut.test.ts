import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addSources,
  captionPages,
  commit,
  createDoc,
  currentCut,
  resolveCut,
  wordsFromTranscript,
  type EditDoc,
  type Op,
  type Source
} from '../shared/edit'
import { renderCut, segmentsFor } from './cut-render'
import { PLANNER_SYSTEM } from './planner-prompt'
import { buildPremiereXml, captionsSrt, planPremiere, writePremiere, type PremiereMedia } from './premiere-cut'
import { ffmpegRun, findFfmpeg, gradientWindow, makeClip, makeGradientStill, onsets } from './test-media'

const FFMPEG = findFfmpeg()

// ---- reading xmeml back ----

interface El {
  name: string
  attrs: Record<string, string>
  children: El[]
  text: string
}

/** A strict little XML reader: every tag must close, in order, or it throws. */
function parseXml(src: string): El {
  const root: El = { name: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const re = /<\?[^>]*\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g
  let at = 0
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index !== at) throw new Error(`Unreadable XML at ${at}: ${src.slice(at, at + 40)}`)
    at = re.lastIndex
    if (m[5] !== undefined) {
      stack[stack.length - 1].text += m[5]
      continue
    }
    if (!m[2]) continue
    if (m[1]) {
      const top = stack.pop()
      if (!top || top.name !== m[2]) throw new Error(`</${m[2]}> closes <${top?.name}>`)
      continue
    }
    const attrs = Object.fromEntries([...m[3].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]))
    const el: El = { name: m[2], attrs, children: [], text: '' }
    stack[stack.length - 1].children.push(el)
    if (!m[4]) stack.push(el)
  }
  if (at !== src.length || stack.length !== 1) throw new Error('The XML does not close every tag.')
  return root
}

const kids = (el: El, name: string): El[] => el.children.filter((c) => c.name === name)
const kid = (el: El, name: string): El => {
  const found = kids(el, name)[0]
  if (!found) throw new Error(`<${el.name}> has no <${name}>`)
  return found
}
const num = (el: El, name: string): number => Number(kid(el, name).text.trim())
const every = (el: El, name: string): El[] => [
  ...(el.name === name ? [el] : []),
  ...el.children.flatMap((c) => every(c, name))
]

interface Clip {
  id: string
  path: string
  start: number
  end: number
  inSec: number
  outSec: number
  scale: number
  gain: number
  channel: number
  links: string[]
}

/** The sequence as Premiere would read it: its tracks of clips, its markers, and its files. */
function readSequence(xml: string): {
  fps: number
  width: number
  height: number
  duration: number
  video: Clip[][]
  audio: Clip[][]
  markers: { name: string; at: number }[]
  fileBodies: Map<string, number>
} {
  const doc = parseXml(xml)
  const seq = every(doc, 'sequence')[0]
  const rate = kid(seq, 'rate')
  const fps = num(rate, 'timebase') * (kid(rate, 'ntsc').text === 'TRUE' ? 1000 / 1001 : 1)
  const paths = new Map<string, string>()
  const fileBodies = new Map<string, number>()
  for (const f of every(doc, 'file')) {
    if (f.children.length === 0) continue
    fileBodies.set(f.attrs.id, (fileBodies.get(f.attrs.id) ?? 0) + 1)
    const url = kid(f, 'pathurl').text.trim().replace('file://localhost', '')
    paths.set(f.attrs.id, url.split('/').map(decodeURIComponent).join('/'))
  }
  const clipsOf = (track: El): Clip[] =>
    kids(track, 'clipitem').map((c) => {
      const ticksIn = num(c, 'pproTicksIn')
      const ticksOut = num(c, 'pproTicksOut')
      const params = every(c, 'parameter')
      const value = (id: string): number | null => {
        const p = params.find((x) => kid(x, 'parameterid').text.trim() === id)
        return p ? Number(kid(p, 'value').text.trim()) : null
      }
      const source = kids(c, 'sourcetrack')[0]
      return {
        id: c.attrs.id,
        path: paths.get(kid(c, 'file').attrs.id) ?? '?',
        start: num(c, 'start') / fps,
        end: num(c, 'end') / fps,
        inSec: ticksIn / 254016000000,
        outSec: ticksOut / 254016000000,
        scale: value('scale') ?? 100,
        gain: value('level') ?? 1,
        channel: source ? num(source, 'trackindex') : 0,
        links: kids(c, 'link').map((l) => kid(l, 'linkclipref').text.trim())
      }
    })
  const media = kid(seq, 'media')
  const format = every(kid(kid(media, 'video'), 'format'), 'samplecharacteristics')[0]
  return {
    fps,
    width: num(format, 'width'),
    height: num(format, 'height'),
    duration: num(seq, 'duration') / fps,
    video: kids(kid(media, 'video'), 'track').map(clipsOf),
    audio: kids(kid(media, 'audio'), 'track').map(clipsOf),
    markers: kids(seq, 'marker').map((m) => ({ name: kid(m, 'name').text, at: num(m, 'in') / fps })),
    fileBodies
  }
}

// ---- an edit to open ----

/** Two recordings: each frame's colour says which recording and which frame it is; each word is a tone. */
const SAID_A = [
  ['Here', 0.4, 0.6],
  ['is', 0.7, 0.85],
  ['the', 0.95, 1.05],
  ['plan.', 1.15, 1.6],
  ['Step', 2.2, 2.45],
  ['one', 2.55, 2.75],
  ['matters.', 2.85, 3.3],
  ['Then', 4.0, 4.25],
  ['step', 4.35, 4.6],
  ['two.', 4.7, 5.0],
  ['That', 5.8, 6.05],
  ['is', 6.15, 6.3],
  ['all.', 6.4, 6.8]
] as const
const SAID_B = [
  ['Another', 0.5, 0.85],
  ['angle', 0.95, 1.3],
  ['here.', 1.4, 1.7],
  ['Back', 2.6, 2.85],
  ['to', 2.95, 3.1],
  ['you.', 3.2, 3.6]
] as const
const words = (
  said: readonly (readonly [string, number, number])[]
): { text: string; startSec: number; endSec: number }[] =>
  said.map(([text, startSec, endSec]) => ({ text, startSec, endSec }))

/** A recording whose every frame is a solid colour: red and green count the frame, blue names the recording. */
function codedClip(
  ffmpeg: string,
  path: string,
  sec: number,
  blue: number,
  hz: number,
  said: readonly (readonly [string, number, number])[]
): string {
  const gates = said.map(([, a, b]) => `between(t,${a},${b})`).join('+')
  return makeClip(
    ffmpeg,
    path,
    `color=black:s=640x360:r=30:d=${sec},format=rgb24,geq=r='8+16*mod(N,16)':g='8+16*mod(floor(N/16),16)':b=${blue}`,
    `aevalsrc=exprs='0.4*sin(2*PI*${hz}*t)*(${gates})|0.4*sin(2*PI*${hz}*t)*(${gates})':s=48000:d=${sec}`
  )
}

/** Each frame's mean colour, in one pass. */
function frameColours(ffmpeg: string, path: string): [number, number, number][] {
  const raw = execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-vf',
      'scale=1:1:flags=area,format=rgb24',
      '-f',
      'rawvideo',
      '-'
    ],
    { maxBuffer: 1 << 24 }
  )
  const out: [number, number, number][] = []
  for (let i = 0; i + 2 < raw.length; i += 3) out.push([raw[i], raw[i + 1], raw[i + 2]])
  return out
}

/** Which recording and which of its frames a coded colour shows. */
const decode = ([r, g, b]: [number, number, number]): string =>
  `${b > 120 ? 'B' : 'A'}${Math.round((r - 8) / 16) + 16 * Math.round((g - 8) / 16)}`

function editWith(dir: string, ffmpeg: string | null, ops: Op[]): { doc: EditDoc; still: string } {
  const a: Source = { id: 's1', path: join(dir, 'a.mp4'), durationSec: 8, width: 640, height: 360, fps: 30 }
  const b: Source = { id: 's2', path: join(dir, 'b.mp4'), durationSec: 6, width: 640, height: 360, fps: 30 }
  const still = join(dir, 'gradient.png')
  if (ffmpeg) {
    codedClip(ffmpeg, a.path, 8, 40, 600, SAID_A)
    codedClip(ffmpeg, b.path, 6, 200, 900, SAID_B)
    makeGradientStill(ffmpeg, still)
  }
  let doc = createDoc({ id: 'p', title: 'Plan', source: a, words: wordsFromTranscript(words(SAID_A), 's1') })
  doc = addSources(doc, [b], wordsFromTranscript(words(SAID_B), 's2', 's2w'), 'B.')
  const r = commit(
    doc,
    ops.map((op) =>
      op.op === 'treat' && op.set.broll ? { ...op, set: { ...op.set, broll: { ...op.set.broll, path: still } } } : op
    ),
    'Edit.'
  )
  if (r.rejected.length) throw new Error(JSON.stringify(r.rejected))
  return { doc: r.doc, still }
}

const EDIT: Op[] = [
  { op: 'aspect', aspect: 'vertical' },
  { op: 'captions', set: { on: false } },
  { op: 'loudness', lufs: null },
  // "is" struck, so the first beat plays as two pieces.
  { op: 'strike', from: 'w2', to: 'w2' },
  { op: 'transition', beats: ['b2'], kind: 'dissolve', sec: 0.4 },
  { op: 'treat', beats: ['b3'], set: { frame: 'broll', broll: { path: 'still', inSec: 0, muted: true } } },
  { op: 'jcut', beats: ['b4'], sec: 0.3 },
  { op: 'speed', beats: ['b5'], speed: 2 },
  { op: 'treat', beats: ['b6'], set: { zoom: 1.2 } }
]

describe('a Premiere project from an edit, read back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutalong-premiere-plan-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const { doc, still } = editWith(dir, null, EDIT)
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const sources = doc.sources.map((s) => ({ ...s, hasAudio: true }))
  const media = new Map<string, PremiereMedia>([
    [doc.sources[0].path, { durationSec: 8, video: { width: 640, height: 360, fps: 30, still: false }, channels: 2 }],
    [doc.sources[1].path, { durationSec: 6, video: { width: 640, height: 360, fps: 30, still: false }, channels: 2 }],
    [still, { durationSec: 0.04, video: { width: 1920, height: 1080, fps: 25, still: true }, channels: 0 }]
  ])
  const plan = planPremiere({
    name: 'Plan v2',
    cut,
    resolved,
    segments: segmentsFor(cut, resolved, sources),
    shapes: new Map(doc.sources.map((s) => [s.path, s])),
    width: 1080,
    height: 1920,
    fps: 30,
    media,
    sfxFiles: new Map(),
    graphics: []
  })
  const seq = readSequence(buildPremiereXml(plan, media))

  it('is well-formed xmeml with each file written once and every link pointing at a clip', () => {
    expect(seq.width).toBe(1080)
    expect(seq.height).toBe(1920)
    expect(Math.abs(seq.duration - resolved.durationSec)).toBeLessThan(1 / 30)
    expect([...seq.fileBodies.values()].every((n) => n === 1)).toBe(true)
    expect(seq.fileBodies.size).toBe(3)
    const ids = new Set([...seq.video, ...seq.audio].flat().map((c) => c.id))
    expect(ids.size).toBe([...seq.video, ...seq.audio].flat().length)
    for (const c of [...seq.video, ...seq.audio].flat()) for (const l of c.links) expect(ids.has(l), l).toBe(true)
  })

  it('cuts the recordings end to end, from where each piece starts, and links each picture to its sound', () => {
    const v1 = seq.video[0]
    // Seven pieces: the first beat in two around the struck word, then one for each beat, the last two from b.mp4.
    expect(v1.map((c) => (c.path.endsWith('b.mp4') ? 'B' : 'A')).join('')).toBe('AAAAABB')
    for (let i = 1; i < v1.length; i++) expect(Math.abs(v1[i].start - v1[i - 1].end)).toBeLessThan(1e-6)
    expect(v1[0].start).toBe(0)
    expect(Math.abs(v1[v1.length - 1].end - resolved.durationSec)).toBeLessThan(1 / 30)
    // Each clip plays its length of source from its in point.
    for (const c of v1) expect(Math.abs(c.outSec - c.inSec - (c.end - c.start))).toBeLessThan(1e-6)
    // The first piece starts where its beat's first word does, less the beat's pad.
    expect(Math.abs(v1[0].inSec - resolved.pieces[0].srcStart)).toBeLessThan(1 / 30)
    // The voice is the stereo pair, and every piece of picture is linked to both its sides.
    const [left, right] = seq.audio
    expect(left.map((c) => c.channel)).toEqual(left.map(() => 1))
    expect(right.map((c) => c.channel)).toEqual(right.map(() => 2))
    for (const [i, c] of v1.entries()) expect(c.links).toEqual([c.id, left[i].id, right[i].id])
  })

  it('cuts a transition in its middle, and keeps a J cut’s picture and sound apart', () => {
    const tr = resolved.transitions![0]
    const middle = (tr.outStart + tr.outEnd) / 2
    const v1 = seq.video[0]
    expect(v1.some((c) => Math.abs(c.end - Math.round(middle * 30) / 30) < 1e-6)).toBe(true)
    // The J cut: the beat's sound comes in before its picture does.
    const j = resolved.splitEdits![0]
    const pictureIn = v1.find((c) => Math.abs(c.start - Math.round((j.at + j.sec) * 30) / 30) < 1e-6)
    const soundIn = seq.audio[0].find((c) => Math.abs(c.start - Math.round(j.at * 30) / 30) < 1e-6)
    expect(pictureIn && soundIn).toBeTruthy()
  })

  it('scales each picture to fill the frame as the export does, a punch-in further, and a cutaway on the track above', () => {
    const v1 = seq.video[0]
    const cover = (1920 / 360) * 100
    for (const c of v1.slice(0, -1)) expect(Math.abs(c.scale - cover)).toBeLessThan(0.01)
    expect(Math.abs(v1[v1.length - 1].scale - cover * 1.2)).toBeLessThan(0.01)
    const v2 = seq.video[1]
    expect(v2).toHaveLength(1)
    expect(v2[0].path).toBe(still)
    expect(Math.abs(v2[0].scale - (1920 / 1080) * 100)).toBeLessThan(0.01)
    const b3 = resolved.beats.find((b) => b.id === 'b3')!
    expect(Math.abs(v2[0].start - b3.outStart)).toBeLessThan(1 / 30)
  })

  it('marks what stays in Cutalong where it happens, and says so', () => {
    const names = seq.markers.map((m) => m.name)
    expect(names).toContain('Dissolve, 0.4 s')
    expect(names).toContain('Speed 2x')
    expect(plan.leftOut).toEqual(['1 transition', '1 speed change'])
    // Every chapter set is a marker where its beat starts, though too close together for YouTube to show.
    const titled = commit(
      doc,
      [
        {
          op: 'chapters',
          set: [
            { beat: 'b4', title: 'The end' },
            { beat: 'b1', title: 'Opening' }
          ]
        }
      ],
      'Chapters.'
    ).doc
    const c2 = currentCut(titled)
    const r2 = resolveCut(c2, titled.words, titled.sources)
    const p2 = planPremiere({
      ...{ name: 'Plan v3', width: 1080, height: 1920, fps: 30, graphics: [], sfxFiles: new Map() },
      cut: c2,
      resolved: r2,
      segments: segmentsFor(c2, r2, sources),
      shapes: new Map(doc.sources.map((s) => [s.path, s])),
      media
    })
    const chapters = p2.markers.filter((m) => m.comment === 'A chapter.')
    expect(chapters.map((m) => [m.name, m.atSec])).toEqual([
      ['Opening', 0],
      ['The end', r2.beats.find((b) => b.id === 'b4')!.outStart]
    ])
  })

  it('loops the music under the whole video at the level it sits under speech, and places the sounds', () => {
    const withMusic = commit(
      doc,
      [
        { op: 'music', set: { path: '/music/bed.m4a', levelDb: -12, duckDb: 12, lufs: -14 } },
        { op: 'sfx', beats: ['b6'], add: { kind: 'pop' } },
        // A whoosh peaks on b6's cut, so it is still playing when the pop starts there.
        { op: 'sfx', beats: ['b6'], add: { kind: 'whoosh' } }
      ],
      'Music.'
    ).doc
    const c2 = currentCut(withMusic)
    const r2 = resolveCut(c2, withMusic.words, withMusic.sources)
    const m2 = new Map(media)
    m2.set('/music/bed.m4a', { durationSec: 5, video: null, channels: 2 })
    m2.set('/sfx/pop-v1.wav', { durationSec: 0.12, video: null, channels: 2 })
    m2.set('/sfx/whoosh-v1.wav', { durationSec: 0.7, video: null, channels: 2 })
    const p2 = planPremiere({
      ...{ name: 'Plan v3', width: 1080, height: 1920, fps: 30, graphics: [] },
      cut: c2,
      resolved: r2,
      segments: segmentsFor(c2, r2, sources),
      shapes: new Map(doc.sources.map((s) => [s.path, s])),
      media: m2,
      sfxFiles: new Map([
        ['pop', '/sfx/pop-v1.wav'],
        ['whoosh', '/sfx/whoosh-v1.wav']
      ])
    })
    // Five seconds of track for a longer video: looped, end to end, to the last frame.
    expect(p2.music.length).toBe(Math.ceil(r2.durationSec / 5))
    expect(p2.music[p2.music.length - 1].end).toBeCloseTo(r2.durationSec, 6)
    // Against a voice recorded at -20 LUFS: -20 - 12 - 12 + 14 = -30 dB.
    expect(p2.music[0].gainDb).toBeCloseTo(-30, 6)
    // Each keeps all of itself: the pop goes a pair of tracks down, under the whoosh it starts inside.
    const b6 = r2.beats[5].outStart
    expect(p2.sounds.map((lane) => lane.map((c) => c.path.split('/').pop()))).toEqual([
      ['whoosh-v1.wav'],
      ['pop-v1.wav']
    ])
    expect(p2.sounds[0][0].start).toBeCloseTo(b6 - 0.35, 6)
    expect(p2.sounds[0][0].end).toBeCloseTo(b6 + 0.35, 6)
    expect(p2.sounds[1][0].start).toBeCloseTo(b6, 6)
    expect(p2.leftOut).toContain('the music’s fades and its rise between lines')
    const s2 = readSequence(buildPremiereXml(p2, m2))
    expect(s2.audio).toHaveLength(8)
    expect(s2.audio[2][0].gain).toBeCloseTo(Math.pow(10, -30 / 20), 5)
  })

  it('points at a Windows file the way Premiere writes it there, and the planner knows the command', () => {
    const path = 'C:\\Users\\you\\My Talk & Co.mp4'
    const clip = { path, start: 0, end: 1, inSec: 0, origin: { outStart: 0, srcStart: 0 } }
    const xml = buildPremiereXml(
      { ...plan, picture: [clip], cutaways: [], voice: [], music: [], sounds: [], markers: [] },
      new Map([[path, { durationSec: 5, video: { width: 1920, height: 1080, fps: 30, still: false }, channels: 2 }]])
    )
    expect(xml).toContain('<pathurl>file://localhost/C%3A/Users/you/My%20Talk%20%26%20Co.mp4</pathurl>')
    expect(xml).toContain('<name>My Talk &amp; Co.mp4</name>')
    expect(PLANNER_SYSTEM).toContain('/premiere')
  })

  it('writes the captions as SRT, a page at a time, as the export shows them', () => {
    const srt = captionsSrt(resolved, { ...cut.captions, on: true, uppercase: true })!
    const pages = captionPages(resolved, cut.captions.wordsPerScreen)
    const blocks = srt.trim().split('\n\n')
    expect(blocks).toHaveLength(pages.length)
    expect(blocks[0].split('\n')[2]).toBe(pages[0].map((w) => w.text.toUpperCase()).join(' '))
    expect(blocks[0].split('\n')[1]).toMatch(/^00:00:00,\d{3} --> 00:00:0\d,\d{3}$/)
  })
})

describe.skipIf(!FFMPEG)('a Premiere project plays as the export does', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let xmlPath = ''
  let exportPath = ''

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-premiere-'))
    doc = editWith(dir, ffmpeg, EDIT).doc
    xmlPath = join(dir, 'Plan v2.xml')
    await writePremiere(doc, { ffmpeg, xmlPath, sfxDir: join(dir, 'sfx') })
    const cut = currentCut(doc)
    exportPath = await renderCut(
      cut,
      resolveCut(cut, doc.words, doc.sources),
      doc.sources.map((s) => ({ ...s, hasAudio: true })),
      { ffmpeg, outputPath: join(dir, 'export.mp4'), workDir: join(dir, 'work'), quality: 'preview' }
    )
  }, 120000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /**
   * The sequence played the way Premiere reads it, at the export's size: each
   * clip from its in point for its length, scaled about its centre by its
   * Scale and cropped to the frame, cutaways laid over, and the voice's left
   * side cut together with silence where it has none.
   */
  function conform(seq: ReturnType<typeof readSequence>, width: number, height: number): string {
    const k = width / seq.width
    const inputs: string[] = []
    const chains: string[] = []
    const picture = (c: Clip, label: string): void => {
      const len = (c.end - c.start).toFixed(6)
      if (/\.png$/.test(c.path)) inputs.push('-loop', '1', '-t', len, '-i', c.path)
      else inputs.push('-ss', c.inSec.toFixed(6), '-t', len, '-i', c.path)
      const n = inputs.filter((x) => x === '-i').length - 1
      const s = ((c.scale / 100) * k).toFixed(6)
      chains.push(
        `[${n}:v]fps=30,scale=trunc(iw*${s}/2)*2:trunc(ih*${s}/2)*2,pad=max(iw\\,${width}):max(ih\\,${height}):(ow-iw)/2:(oh-ih)/2,crop=${width}:${height},setsar=1,trim=duration=${len},setpts=PTS-STARTPTS[${label}]`
      )
    }
    seq.video[0].forEach((c, i) => picture(c, `p${i}`))
    chains.push(`${seq.video[0].map((_, i) => `[p${i}]`).join('')}concat=n=${seq.video[0].length}:v=1:a=0[base]`)
    let over = 'base'
    ;(seq.video[1] ?? []).forEach((c, i) => {
      picture(c, `c${i}`)
      chains.push(`[c${i}]setpts=PTS+${c.start.toFixed(6)}/TB[cs${i}]`)
      chains.push(`[${over}][cs${i}]overlay=eof_action=pass[o${i}]`)
      over = `o${i}`
    })
    let at = 0
    const sound: string[] = []
    seq.audio[0].forEach((c, i) => {
      if (c.start > at + 0.001) {
        chains.push(`anullsrc=r=48000:cl=mono,atrim=duration=${(c.start - at).toFixed(6)}[g${i}]`)
        sound.push(`[g${i}]`)
      }
      inputs.push('-ss', c.inSec.toFixed(6), '-t', (c.end - c.start).toFixed(6), '-i', c.path)
      const n = inputs.filter((x) => x === '-i').length - 1
      chains.push(
        `[${n}:a]pan=mono|c0=c0,aresample=48000,apad,atrim=duration=${(c.end - c.start).toFixed(6)},asetpts=PTS-STARTPTS[s${i}]`
      )
      sound.push(`[s${i}]`)
      at = c.end
    })
    chains.push(`${sound.join('')}concat=n=${sound.length}:v=0:a=1[voice]`)
    const out = join(dir, 'conform.mp4')
    ffmpegRun(ffmpeg, [
      ...inputs,
      '-filter_complex',
      chains.join(';'),
      '-map',
      `[${over}]`,
      '-map',
      '[voice]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '12',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      out
    ])
    return out
  }

  it('shows the same frame of the same recording as the export, frame by frame, wherever both cut', () => {
    const seq = readSequence(readFileSync(xmlPath, 'utf8'))
    const played = conform(seq, 540, 960)
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    // Left out of the comparison: the dissolve (blended in the export, cut in its
    // middle here), the beat at 2x (Premiere gets it at its own speed), and the cutaway.
    const tr = resolved.transitions![0]
    const fast = resolved.beats.find((b) => b.id === 'b5')!
    const away = resolved.beats.find((b) => b.id === 'b3')!
    const skip = (t: number): boolean =>
      (t > tr.outStart - 0.07 && t < tr.outEnd + 0.07) ||
      t > fast.outStart - 0.04 ||
      (t > away.outStart - 0.04 && t < away.outEnd + 0.04)
    const ours = frameColours(ffmpeg, exportPath)
    const theirs = frameColours(ffmpeg, played)
    let compared = 0
    const wrong: string[] = []
    for (let f = 0; f < Math.min(ours.length, theirs.length); f++) {
      const t = (f + 0.5) / 30
      if (skip(t)) continue
      compared++
      if (decode(ours[f]) !== decode(theirs[f]))
        wrong.push(`${t.toFixed(3)} s: ${decode(ours[f])} vs ${decode(theirs[f])}`)
    }
    expect(compared).toBeGreaterThan(80)
    expect(wrong, wrong.slice(0, 5).join('; ')).toEqual([])
    // The cutaway is framed the same: the same window of the gradient.
    const mid = (away.outStart + away.outEnd) / 2
    const a = gradientWindow(ffmpeg, exportPath, mid)
    const b = gradientWindow(ffmpeg, played, mid)
    for (const side of ['left', 'right', 'top', 'bottom'] as const)
      expect(Math.abs(a[side] - b[side]), side).toBeLessThan(0.03)
  })

  it('starts every word on the same moment as the export does', () => {
    const seq = readSequence(readFileSync(xmlPath, 'utf8'))
    const played = join(dir, 'conform.mp4')
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const tr = resolved.transitions![0]
    const fast = resolved.beats.find((b) => b.id === 'b5')!
    expect(seq.audio[0].length).toBeGreaterThan(5)
    for (const hz of [600, 900]) {
      const band = `bandpass=f=${hz}:width_type=q:w=8,bandpass=f=${hz}:width_type=q:w=8`
      // Not the dissolve's crossfade, nor the beat at 2x, nor the end of the file, where silencedetect reports one.
      const ours = onsets(ffmpeg, exportPath, -35, 0.05, band).filter(
        (t) =>
          !(t > tr.outStart - 0.1 && t < tr.outEnd + 0.1) &&
          !(t > fast.outStart - 0.1 && t < fast.outEnd + 0.1) &&
          t < resolved.durationSec - 0.05
      )
      const theirs = onsets(ffmpeg, played, -35, 0.05, band)
      expect(ours.length, `${hz} Hz`).toBeGreaterThan(1)
      for (const t of ours) {
        const near = Math.min(...theirs.map((x) => Math.abs(x - t)))
        expect(near, `${hz} Hz word at ${t.toFixed(3)} s`).toBeLessThan(0.012)
      }
    }
  })

  it('writes the captions beside it, and names a missing file in a sentence', async () => {
    const withCaptions = commit(doc, [{ op: 'captions', set: { on: true } }], 'Captions.').doc
    const out = await writePremiere(withCaptions, {
      ffmpeg,
      xmlPath: join(dir, 'Plan v3.xml'),
      sfxDir: join(dir, 'sfx')
    })
    expect(out.srtPath).toBe(join(dir, 'Plan v3 captions.srt'))
    expect(readFileSync(out.srtPath!, 'utf8')).toContain('-->')
    expect(out.facts).toMatchObject({ cuts: 7, recordings: 2, cutaways: 1, music: false, sounds: 0 })
    const gone = {
      ...withCaptions,
      sources: withCaptions.sources.map((s, i) => (i === 1 ? { ...s, path: join(dir, 'gone.mp4') } : s))
    }
    await expect(
      writePremiere(gone, { ffmpeg, xmlPath: join(dir, 'Plan v4.xml'), sfxDir: join(dir, 'sfx') })
    ).rejects.toThrow(`I can't find gone.mp4. It was at ${join(dir, 'gone.mp4')}.`)
  })
})
