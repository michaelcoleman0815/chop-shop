import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  commit,
  createDoc,
  currentCut,
  resolveCut,
  wordsFromTranscript,
  type EditDoc,
  type Op,
  type Source
} from '../shared/edit'
import { premiereReply } from '../shared/presets'
import { pathFromUrl, parseXmeml, type XmemlSequence, type XmemlTrack } from '../shared/premiere/xmeml'
import { coverWholeTimeline, timelineMoves } from '../shared/premiere/round-trip'
import { pathUrl } from './premiere'
import type { PremiereMedia } from './premiere-cut'
import { proxyPlan, renderProxy, writePremiereReturn } from './premiere-import'
import { audioSeconds, countFrames, findFfmpeg, frameColour, makeClip, toneLevel } from './test-media'

const FIXTURE = join(__dirname, 'premiere-fixtures', 'sequence.xml')
const ORIGINAL = readFileSync(FIXTURE, 'utf8')
const FPS = 30000 / 1001
const FFMPEG = findFfmpeg()

// ---- reading it strictly ----

/** Every tag closes, in order, or this throws: what Premiere's importer asks of a file. */
function assertWellFormed(src: string): void {
  const stack: string[] = []
  const re = /<\?[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g
  let at = 0
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index !== at) throw new Error(`Unreadable XML at ${at}: ${src.slice(at, at + 60)}`)
    at = re.lastIndex
    if (m[5] !== undefined) {
      if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(m[5])) throw new Error(`A bare & in: ${m[5].slice(0, 60)}`)
      continue
    }
    if (!m[2]) continue
    if (m[1]) {
      const open = stack.pop()
      if (open !== m[2]) throw new Error(`</${m[2]}> closes <${open}>`)
    } else if (!m[4]) stack.push(m[2])
  }
  if (at !== src.length || stack.length !== 0) throw new Error(`Unclosed: ${stack.join(' > ')}`)
}

/** A track's clips as Premiere places them, without the file objects' identity. */
const placed = (track: XmemlTrack): unknown[] =>
  track.clips.map((c) => ({
    id: c.id,
    kind: c.kind,
    enabled: c.enabled,
    start: c.start,
    end: c.end,
    in: c.in,
    out: c.out,
    path: c.file?.path ?? null,
    channel: c.channel
  }))

// ---- an edit of the sequence ----

const PROXY = '/Users/you/Library/Cutalong/premiere/proxy.mp4'
const WHOOSH = '/Users/you/Library/Cutalong/sfx/whoosh-v1.wav'
const CITY = '/Users/you/Movies/city.mp4'
const DURATION = 450 / FPS

/** What was said in the sequence, phrase by phrase, with quiet of every length between. */
const PHRASES: [string, number, number][] = [
  ['So here is the plan.', 1.5, 3.0],
  ['We start with the kitchen.', 3.6, 5.2],
  ['Then the chair goes in.', 8.2, 9.8],
  ['And that is the whole thing.', 11.6, 13.4]
]

function spoken(): { text: string; startSec: number; endSec: number }[] {
  return PHRASES.flatMap(([phrase, a, b]) => {
    const words = phrase.split(' ')
    const each = (b - a) / words.length
    return words.map((text, i) => ({ text, startSec: a + i * each, endSec: a + (i + 1) * each - 0.04 }))
  })
}

function importedDoc(dir: string): EditDoc {
  const xmlPath = join(dir, 'sequence.xml')
  copyFileSync(FIXTURE, xmlPath)
  const source: Source = { id: 's1', path: PROXY, durationSec: DURATION, width: 1920, height: 1080, fps: FPS }
  const doc = coverWholeTimeline(
    createDoc({ id: 'p', title: 'Interview cut (Q&A)', source, words: wordsFromTranscript(spoken(), 's1') })
  )
  return {
    ...doc,
    premiere: {
      xmlPath,
      originalPath: '/Users/you/Desktop/Interview cut.xml',
      name: 'Interview cut (Q&A)',
      fps: FPS,
      width: 1920,
      height: 1080,
      durationSec: DURATION,
      clips: 13,
      files: 4
    }
  }
}

/** The beat that starts with a phrase's first word. */
const beatOf = (doc: EditDoc, phrase: number): string => {
  const first = PHRASES[phrase][0].split(' ')[0]
  const word = doc.words.find((w) => w.text === first && Math.abs(w.startSec - PHRASES[phrase][1]) < 0.01)
  const beat = currentCut(doc).beats.find((b) => b.from === word?.id)
  if (!beat) throw new Error(`No beat starts "${PHRASES[phrase][0]}"`)
  return beat.id
}

const edit = (doc: EditDoc, ops: Op[]): EditDoc => {
  const r = commit(doc, ops, 'Edit.')
  if (r.rejected.length) throw new Error(JSON.stringify(r.rejected))
  return r.doc
}

const MEDIA = new Map<string, PremiereMedia>([
  [PROXY, { durationSec: DURATION, video: { width: 1920, height: 1080, fps: FPS, still: false }, channels: 2 }],
  [WHOOSH, { durationSec: 0.8, video: null, channels: 2 }],
  [CITY, { durationSec: 20, video: { width: 1920, height: 1080, fps: 25, still: false }, channels: 2 }]
])
const facts = {
  ffmpeg: 'ffmpeg',
  readMedia: async (path: string): Promise<PremiereMedia> => {
    const m = MEDIA.get(path)
    if (!m) throw new Error(`No facts for ${path}`)
    return m
  },
  makeSound: async (): Promise<string> => WHOOSH
}

// ---- the tests ----

describe('a Premiere sequence, read', () => {
  const seq = parseXmeml(ORIGINAL) as XmemlSequence

  it('reads its name, rate, size, tracks and markers as Premiere wrote them', () => {
    expect(seq.name).toBe('Interview cut (Q&A)')
    expect(seq.uuid).toBe('6a9b3c1e-4f2d-4b8a-9e7c-2d1f0a5b8c3e')
    expect([seq.timebase, seq.ntsc, seq.width, seq.height, seq.durationFrames]).toEqual([30, true, 1920, 1080, 450])
    expect(seq.fps).toBeCloseTo(29.97, 2)
    expect(seq.video.map((t) => t.clips.length)).toEqual([3, 3])
    expect(seq.audio.map((t) => t.clips.length)).toEqual([3, 3, 1, 1])
    expect(seq.markers.map((m) => [m.name, m.in])).toEqual([
      ['Title', 240],
      ['Ending', 420]
    ])
  })

  it('places clips in a cross dissolve by the transition, and cuts them in its middle', () => {
    const [a, b, c] = seq.video[0].clips
    expect([a.start, a.end, a.shownEnd]).toEqual([0, 225, 210])
    expect([b.start, b.end, b.shownStart]).toEqual([195, 330, 210])
    // A file written in full once is named by its id after that.
    expect(c.file?.path).toBe('/Volumes/Shoot/Day 1/A001.mov')
    expect(c.file).toBe(a.file)
    // Its Basic Motion is read; one without any is at 100% in the middle, as Premiere places it.
    expect(c.motion).toEqual({ scale: 120, centerX: 0, centerY: 0 })
    expect(a.motion).toBeNull()
  })

  it('knows a disabled clip, a title and which channel each sound plays', () => {
    const [off, title, broll] = seq.video[1].clips
    expect(off.enabled).toBe(false)
    expect([title.kind, title.file]).toEqual(['generatoritem', null])
    expect(broll.file?.path).toBe('/Volumes/Shoot/Day 1/C001.mov')
    expect(seq.audio.map((t) => t.clips[0].channel)).toEqual([1, 2, 1, 2])
  })

  it('places a picture by its scale and centre, the centre in fractions of the frame’s width', () => {
    // As a real Premiere export wrote it: 113%, moved 9 px left and 47 px up in a 1080 x 1920 frame.
    const real = `<xmeml version="4"><sequence><name>S</name><duration>60</duration><rate><timebase>60</timebase><ntsc>TRUE</ntsc></rate>
      <media><video><format><samplecharacteristics><width>1080</width><height>1920</height></samplecharacteristics></format>
      <track><clipitem id="clipitem-7"><name>MVI.MP4</name><enabled>TRUE</enabled><start>0</start><end>60</end><in>632</in><out>692</out>
      <file id="file-1"><name>MVI.MP4</name><pathurl>file://localhost/Raw/MVI.MP4</pathurl></file>
      <filter><effect><name>Basic Motion</name><effectid>basic</effectid>
        <parameter authoringApp="PremierePro"><parameterid>scale</parameterid><value>113</value></parameter>
        <parameter authoringApp="PremierePro"><parameterid>center</parameterid><value><horiz>-0.00833334</horiz><vert>-0.0435185</vert></value></parameter>
      </effect></filter></clipitem></track></video><audio/></media></sequence></xmeml>`
    const one = parseXmeml(real) as XmemlSequence
    expect(one.video[0].clips[0].motion).toEqual({ scale: 113, centerX: -0.00833334, centerY: -0.0435185 })
    const [p] = proxyPlan(one).picture
    expect(p.scale).toBeCloseTo(1.13, 6)
    // Whole pixels both ways, as Premiere's Position shows them.
    expect(p.offset.x).toBeCloseTo(-9, 3)
    expect(p.offset.y).toBeCloseTo(-47, 3)
  })

  it('reads a file’s address on a Mac, on Windows and on a server', () => {
    expect(pathFromUrl('file://localhost/Volumes/Shoot/Day%201/A001.mov')).toBe('/Volumes/Shoot/Day 1/A001.mov')
    expect(pathFromUrl('file:///Users/me/a.mov')).toBe('/Users/me/a.mov')
    expect(pathFromUrl('file://localhost/C%3a/Clips/A%20B.mov')).toBe('C:\\Clips\\A B.mov')
    // One written by another tool with the backslashes encoded reads the same.
    expect(pathFromUrl('file://localhost/C%3A%5CClips%5CA%20B.mov')).toBe('C:\\Clips\\A B.mov')
    expect(pathFromUrl('file://server/share/a.mov')).toBe('\\\\server\\share\\a.mov')
    // As the Premiere export writes one, and back.
    expect(pathFromUrl(pathUrl('/Users/me/Día 1/take #2.mov'))).toBe('/Users/me/Día 1/take #2.mov')
    expect(pathFromUrl(pathUrl('C:/Clips/A B.mov'))).toBe('C:\\Clips\\A B.mov')
  })

  it('shows the topmost clip at every moment and plays every sound once', () => {
    const plan = proxyPlan(seq)
    expect(plan.frames).toBe(450)
    expect([plan.width, plan.height, plan.rate]).toEqual([1920, 1080, '30000/1001'])
    expect(plan.picture.map((p) => [p.startFrame, p.frames, p.path?.split('/').pop() ?? null])).toEqual([
      [0, 210, 'A001.mov'],
      [210, 120, 'B001.mov'],
      [330, 30, 'A001.mov'],
      [360, 60, 'C001.mov'],
      [420, 30, 'A001.mov']
    ])
    // B comes in at its own frame 85 + 15, where the dissolve's middle is.
    expect(plan.picture[1].inSec * FPS).toBeCloseTo(100, 6)
    expect(plan.picture[3].inSec * FPS).toBeCloseTo(200, 6)
    expect(plan.drawn).toBe(1)
    // The second A clip is at 120%, on both sides of the cutaway over it.
    expect(plan.picture.map((p) => p.scale)).toEqual([1, 1, 1.2, 1, 1.2])
    expect(plan.sound.map((s) => s.path.split('/').pop())).toEqual(['A001.mov', 'Bed.wav', 'B001.mov', 'A001.mov'])
    // A file that is not on this computer is black, and not heard.
    const without = proxyPlan(seq, new Set(['/Volumes/Shoot/Day 1/C001.mov']))
    expect(without.picture.map((p) => [p.startFrame, p.path?.split('/').pop() ?? null])).toContainEqual([360, null])
  })
})

describe('an edit of a Premiere sequence, sent back', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-premiere-return-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('covers every second of the sequence, so a moment here is the same moment in Premiere', () => {
    const doc = importedDoc(dir)
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    expect(resolved.durationSec).toBeCloseTo(DURATION, 6)
    let at = 0
    for (const p of resolved.pieces) {
      expect(p.outStart).toBeCloseTo(at, 6)
      expect(p.srcStart).toBeCloseTo(p.outStart, 6)
      at = p.outEnd
    }
    // Quiet too long for padding has a beat of its own; the words keep theirs.
    expect(cut.beats.filter((b) => b.from === null).length).toBe(3)
    expect(cut.beats.filter((b) => b.from !== null).length).toBe(4)
    expect([cut.captions.on, cut.loudness]).toEqual([false, null])
    expect(timelineMoves(doc)).toBeNull()
  })

  it('adds captions and a whoosh on tracks of their own, and leaves every cut where it was', async () => {
    const start = importedDoc(dir)
    const beat = beatOf(start, 1)
    const doc = edit(start, [
      { op: 'captions', set: { on: true } },
      { op: 'sfx', beats: [beat], add: { kind: 'whoosh' } }
    ])
    const xmlPath = join(dir, 'Interview cut (Q&A) (Cutalong) v2.xml')
    const r = await writePremiereReturn(doc, { ...facts, sfxDir: dir, xmlPath })
    const out = readFileSync(xmlPath, 'utf8')
    assertWellFormed(out)

    const before = parseXmeml(ORIGINAL) as XmemlSequence
    const after = parseXmeml(out) as XmemlSequence
    // Renamed with a new uuid, so it imports beside the one it came from.
    expect(after.name).toBe('Interview cut (Q&A) (Cutalong)')
    expect(after.uuid).not.toBe(before.uuid)
    expect(after.uuid).toMatch(/^[0-9a-f-]{36}$/)
    // Every clip Premiere placed is where it was, on the track it was on.
    expect(after.video.length).toBe(before.video.length)
    before.video.forEach((t, i) => expect(placed(after.video[i])).toEqual(placed(t)))
    before.audio.forEach((t, i) => expect(placed(after.audio[i])).toEqual(placed(t)))
    expect(after.markers.slice(0, 2)).toEqual(before.markers)
    // Every line Premiere wrote is still there, in order, but the name and uuid.
    const lines = out.split('\n')
    let k = 0
    for (const line of ORIGINAL.split('\n')) {
      if (/<name>Interview cut|<uuid>/.test(line)) continue
      while (k < lines.length && lines[k] !== line) k++
      expect(k, `missing: ${line.trim()}`).toBeLessThan(lines.length)
      k++
    }

    // The whoosh on a stereo pair below the sequence's own sound, landing on the beat.
    const added = after.audio.slice(before.audio.length)
    expect(added.length).toBe(2)
    expect(added.map((t) => t.clips.map((c) => [c.file?.path, c.channel]))).toEqual([[[WHOOSH, 1]], [[WHOOSH, 2]]])
    const beatStart = resolveCut(currentCut(doc), doc.words, doc.sources).beats.find((b) => b.id === beat)!.outStart
    const whoosh = added[0].clips[0]
    expect(whoosh.start / FPS).toBeGreaterThan(beatStart - 1)
    expect(whoosh.start / FPS).toBeLessThanOrEqual(beatStart + 0.05)
    expect(whoosh.end).toBeGreaterThan(whoosh.start)
    // Ids of its own, none of them one Premiere used.
    const ids = [...out.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
    const fresh = ids.filter((id) => !ORIGINAL.includes(`id="${id}"`))
    expect(fresh.length).toBeGreaterThan(0)
    expect(fresh.every((id) => id.startsWith('cutalong-'))).toBe(true)
    const clipIds = [...out.matchAll(/<clipitem id="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(clipIds).size).toBe(clipIds.length)

    // The captions beside it, on the sequence's clock.
    expect(r.srtPath).toBe(join(dir, 'Interview cut (Q&A) (Cutalong) v2 captions.srt'))
    const srt = readFileSync(r.srtPath!, 'utf8')
    expect(srt.split('\n')[1]).toMatch(/^00:00:01,5\d\d --> /)
    expect(srt).toContain('kitchen')

    const reply = premiereReply({ ...r, opened: null })
    expect(reply.text).toContain('Interview cut (Q&A) with 1 sound effect on tracks of their own.')
    expect(reply.text).toContain('Your 13 clips are where they were.')
  })

  it('puts a cutaway on a track above the sequence’s own', async () => {
    const start = importedDoc(dir)
    const doc = edit(start, [
      { op: 'treat', beats: [beatOf(start, 2)], set: { frame: 'broll', broll: { path: CITY, inSec: 2, muted: true } } }
    ])
    const xmlPath = join(dir, 'cutaway.xml')
    const r = await writePremiereReturn(doc, { ...facts, sfxDir: dir, xmlPath })
    const after = parseXmeml(readFileSync(xmlPath, 'utf8')) as XmemlSequence
    expect(after.video.length).toBe(3)
    const [clip] = after.video[2].clips
    expect(clip.id).toMatch(/^cutalong-/)
    expect(clip.file?.path).toBe(CITY)
    const beat = resolveCut(currentCut(doc), doc.words, doc.sources).beats.find((b) => b.id === beatOf(start, 2))!
    expect(clip.start).toBe(Math.round(beat.outStart * FPS))
    // No captions were asked for, so none are written.
    expect(r.srtPath).toBeNull()
    expect(r.facts.cutaways).toBe(1)
  })

  it('says so, and writes nothing, when the version would move a cut', async () => {
    const start = importedDoc(dir)
    const word = start.words.find((w) => w.text === 'kitchen.')!
    const doc = edit(start, [{ op: 'strike', from: word.id, to: word.id }])
    expect(timelineMoves(doc)).toBe('1 word is cut')
    const xmlPath = join(dir, 'moved.xml')
    await expect(writePremiereReturn(doc, { ...facts, sfxDir: dir, xmlPath })).rejects.toThrow(
      /Your cuts stay as Premiere has them, and this version moves them: 1 word is cut\./
    )
    expect(() => readFileSync(xmlPath)).toThrow()
  })
})

describe.skipIf(!FFMPEG)('a copy of the sequence to play here', () => {
  let dir: string
  let proxy: string
  beforeAll(async () => {
    const ffmpeg = FFMPEG as string
    dir = mkdtempSync(join(tmpdir(), 'cutalong-premiere-proxy-'))
    // Each recording's frames say which recording and which frame they are; each one's sound is its own tone.
    const coded = (name: string, sec: number, blue: number, hz: number | null): void => {
      makeClip(
        ffmpeg,
        join(dir, name),
        `color=black:s=320x180:r=30:d=${sec},format=rgb24,geq=r='8+16*mod(N,16)':g='8+16*mod(floor(N/16),16)':b=${blue}`,
        hz ? `sine=frequency=${hz}:sample_rate=48000:duration=${sec}` : null
      )
    }
    coded('A001.mov', 18, 40, 600)
    coded('B001.mov', 8, 200, 900)
    coded('C001.mov', 9, 120, null)
    const { execFileSync } = await import('child_process')
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=20', join(dir, 'Bed.wav')])
    // As the Premiere export writes a folder's address, a Windows one too: forward slashes, the drive encoded.
    const url = pathUrl(dir.replace(/\\/g, '/'))
    const text = ORIGINAL.replace(/file:\/\/localhost\/Volumes\/Shoot\/Day%201/g, url).replace(
      /file:\/\/localhost\/Volumes\/Shoot\/Music/g,
      url
    )
    writeFileSync(join(dir, 'sequence.xml'), text)
    const seq = parseXmeml(text) as XmemlSequence
    proxy = join(dir, 'proxy.mp4')
    await renderProxy(ffmpeg, proxyPlan(seq), proxy)
  }, 120_000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  /**
   * Which recording, and which of its frames mod 256, a frame of the copy shows. The
   * recordings are 320 x 180 in a 1920 x 1080 frame, at their own size as Premiere
   * places them, so this reads the middle.
   */
  const middle = { x: 0.47, y: 0.47, w: 0.06, h: 0.06 }
  const shown = (frame: number): { clip: string; n: number } => {
    const [r, g, b] = frameColour(FFMPEG as string, proxy, (frame + 0.5) / FPS, middle)
    const clip = b > 160 ? 'B' : b > 80 ? 'C' : 'A'
    return { clip, n: Math.round((r - 8) / 16) + 16 * Math.round((g - 8) / 16) }
  }
  const near = (n: number, want: number): boolean => Math.min(Math.abs(n - (want % 256)), 256 - Math.abs(n - (want % 256))) <= 2

  it('runs exactly as long as the sequence, frame for frame, with its sound', () => {
    expect(countFrames(FFMPEG as string, proxy)).toBe(450)
    expect(audioSeconds(FFMPEG as string, proxy)).toBeCloseTo(DURATION, 1)
  })

  it('shows the frames Premiere shows, from the clip on top', () => {
    const cases: [number, string, number][] = [
      // A, under a clip that is switched off.
      [90, 'A', 30 + 90],
      [200, 'A', 30 + 200],
      // B from the middle of the dissolve, and under the title Premiere draws.
      [250, 'B', 85 + 55],
      [270, 'B', 85 + 75],
      // The cutaway on V2 over A.
      [380, 'C', 200 + 20],
      [440, 'A', 400 + 110]
    ]
    for (const [frame, clip, n] of cases) {
      const s = shown(frame)
      expect(s.clip, `frame ${frame}`).toBe(clip)
      expect(near(s.n, n), `frame ${frame} shows ${s.n}, not ${n % 256}`).toBe(true)
    }
  })

  it('shows each picture at the size Premiere gives it, on black', () => {
    // Just inside the left edge of a picture at 120%, and outside one at 100%.
    const edge = { x: 0.403, y: 0.48, w: 0.01, h: 0.04 }
    const at = (frame: number): number => frameColour(FFMPEG as string, proxy, (frame + 0.5) / FPS, edge)[2]
    expect(at(340)).toBeGreaterThan(30)
    expect(at(100)).toBeLessThan(15)
    // The corner is black: a picture is never stretched to fill the frame.
    expect(frameColour(FFMPEG as string, proxy, 100.5 / FPS, { x: 0, y: 0, w: 0.1, h: 0.1 })[2]).toBeLessThan(15)
  })

  it('plays each clip’s sound where it is on the timeline, over the music', () => {
    const ffmpeg = FFMPEG as string
    // 0-7 s is A, 7-11 s is B, 11-15 s is A again; the bed runs under all of it.
    expect(toneLevel(ffmpeg, proxy, 2, 2, 600)).toBeGreaterThan(toneLevel(ffmpeg, proxy, 2, 2, 900) + 20)
    expect(toneLevel(ffmpeg, proxy, 8, 2, 900)).toBeGreaterThan(toneLevel(ffmpeg, proxy, 8, 2, 600) + 20)
    expect(toneLevel(ffmpeg, proxy, 12, 2, 600)).toBeGreaterThan(-40)
    expect(toneLevel(ffmpeg, proxy, 8, 2, 220)).toBeGreaterThan(-40)
  })
})
