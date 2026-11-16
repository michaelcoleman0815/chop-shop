import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { basename, dirname, join } from 'path'
import {
  CAMERA_INFO,
  captionPages,
  currentCut,
  describeLook,
  placeSfx,
  RECORDED_VOICE_LUFS,
  resolveCut,
  sfxGainDb,
  TRANSITION_INFO,
  type Cut,
  type EditDoc,
  type Resolved
} from '../shared/edit'
import { describeSpeed, seconds, type PremiereFacts } from '../shared/presets'
import { isImagePath } from '../shared/assets'
import { buildScene, DEFAULT_THEME, designSize, graphicTitle } from '../shared/motion'
import { pathUrl } from './premiere'
import { frameSize, segmentsFor, type Segment } from './cut-render'
import { makeSfx } from './sfx'

/**
 * A Cutalong edit as a Premiere project: an xmeml sequence that plays the
 * person's own files, cut where the edit cuts them, so it can be finished
 * there at full quality.
 *
 * Premiere gets what xmeml can say exactly: every cut from every recording,
 * J and L cuts as picture and sound cut apart, cutaways on the track above,
 * the punch-in zooms, the music and the sound effects at their levels, the
 * chapters as markers, and the captions as an SRT beside it. What it cannot
 * say (the look, camera moves, speed, transitions, graphics) stays in
 * Cutalong, and a marker sits where each one was, so nothing is lost
 * silently. The dialect follows src/main/premiere.ts, which was taken from a
 * project Premiere wrote itself.
 */

/** A file's facts, as Premiere wants them in the project. */
export interface PremiereMedia {
  durationSec: number
  /** Its picture, when it has one. */
  video: { width: number; height: number; fps: number; still: boolean } | null
  /** Sound channels; 0 for none. */
  channels: number
}

/** A stretch of a file on the sequence. Times are seconds. */
export interface PremiereClip {
  path: string
  start: number
  end: number
  /** Where it starts in the file. */
  inSec: number
  /** Percent, when it is not 100. */
  scale?: number
  /** dB, when it is not 0. */
  gainDb?: number
  /** A picture and its own sound share a group, and are linked in Premiere. */
  group?: number
  /**
   * Where its piece started on the output and in the file before any cut was
   * moved, so the project can find the very frame the export shows there.
   */
  origin: { outStart: number; srcStart: number }
}

export interface PremiereMarker {
  atSec: number
  name: string
  comment: string
}

export interface PremierePlan {
  name: string
  width: number
  height: number
  fps: number
  durationSec: number
  /** V1: the recordings. */
  picture: PremiereClip[]
  /** V2: cutaways over them. */
  cutaways: PremiereClip[]
  /** A1 and A2: the voice. */
  voice: PremiereClip[]
  /** A3 and A4. */
  music: PremiereClip[]
  /** A5 and A6, and a pair more for each sound that plays over another. */
  sounds: PremiereClip[][]
  markers: PremiereMarker[]
  /** What stays in Cutalong, as phrases for a sentence: "the look", "2 camera moves". */
  leftOut: string[]
}

export interface PremiereInput {
  name: string
  cut: Cut
  resolved: Resolved
  /** From segmentsFor: what the export plays, piece by piece. */
  segments: Segment[]
  /** The recordings' shapes, by path, for how far each is scaled to fill the frame. */
  shapes: Map<string, { width: number; height: number }>
  width: number
  height: number
  fps: number
  /** Every file the plan reads, by path: lengths for the music's loops and the sounds. */
  media: Map<string, PremiereMedia>
  /** Built-in sound effects as files, by kind. */
  sfxFiles: Map<string, string>
  /** Graphics on the output clock, for a marker on each. */
  graphics: { start: number; title: string }[]
}

/** The loudness a typical track is mastered to, when a bed's own is not known (as cut-render assumes). */
const TYPICAL_TRACK_LUFS = -14

/** A cutaway on a card fills at most this much of the frame's short side (as cut-render draws it). */
const CARD_SHARE = 0.6

const EPS = 1e-6

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** A label as a marker's name: "a push-in" is "Push-in". */
const named = (label: string): string => {
  const bare = label.replace(/^an? /, '')
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

/**
 * Lays stretches end to end the way Premiere wants them: where two overlap,
 * as a transition makes them, the cut goes in the middle of the overlap, so
 * everything else keeps its time.
 */
function butt(clips: PremiereClip[]): PremiereClip[] {
  const out: PremiereClip[] = []
  for (const c of clips) {
    const prev = out[out.length - 1]
    const next = { ...c }
    if (prev && next.start < prev.end - EPS) {
      const mid = (next.start + prev.end) / 2
      prev.end = mid
      next.inSec += mid - next.start
      next.start = mid
    }
    if (next.end - next.start > EPS) out.push(next)
  }
  return out.filter((c) => c.end - c.start > EPS)
}

/** Percent that covers a w x h frame with a picture of this shape, centred, as the export crops it. */
function coverScale(frame: { width: number; height: number }, shape: { width: number; height: number }): number {
  if (shape.width <= 0 || shape.height <= 0) return 100
  return Math.max(frame.width / shape.width, frame.height / shape.height) * 100
}

/** What the music does in Cutalong that a level in Premiere does not: its rise between lines and its fades. */
function musicLeftOut(bed: NonNullable<Cut['music']>): string | null {
  const fades = bed.fadeInSec > 0 || bed.fadeOutSec > 0
  if (bed.duckDb > 0) return fades ? 'the music’s fades and its rise between lines' : 'the music rising between lines'
  return fades ? 'the music’s fades' : null
}

/** Turns the edit into tracks and markers. Pure, so it can be checked without Premiere or ffmpeg. */
export function planPremiere(input: PremiereInput): PremierePlan {
  const { cut, resolved, segments } = input
  const frame = { width: input.width, height: input.height }
  const beats = new Map(cut.beats.map((b) => [b.id, b]))
  const picture: PremiereClip[] = []
  const cutaways: PremiereClip[] = []
  const voice: PremiereClip[] = []
  const markers: PremiereMarker[] = []
  const counts = { speed: 0, reverse: 0, freeze: 0, split: 0, card: 0, bw: 0, camera: 0 }
  const marked = new Set<string>()
  /** One marker per beat and kind of thing, where its picture starts, counted for the reply. */
  const mark = (beat: string, kind: keyof typeof counts, atSec: number, name: string, comment: string): void => {
    const key = `${beat} ${kind} ${name}`
    if (marked.has(key)) return
    marked.add(key)
    counts[kind]++
    markers.push({ atSec, name, comment })
  }

  segments.forEach((s, i) => {
    const piece = resolved.pieces[i]
    const beat = piece ? beats.get(piece.beat) : undefined
    const t = s.treatment
    const outStart = s.outStart ?? piece?.outStart ?? 0
    const pic = s.picture ?? { startSec: s.startSec, durationSec: s.durationSec, outStart }
    // A freeze holds the frame at the piece's start; the export seeks a frame early to find it.
    const from = s.hold && piece ? piece.srcStart : pic.startSec
    const shape = input.shapes.get(s.path) ?? frame
    const zoom = t && t.zoom > 1.001 ? t.zoom : 1
    picture.push({
      path: s.path,
      start: pic.outStart,
      end: pic.outStart + pic.durationSec,
      inSec: from,
      scale: coverScale(frame, shape) * zoom,
      group: i,
      origin: { outStart: pic.outStart, srcStart: from }
    })
    if (!s.hold && (s.audio || s.hasAudio)) {
      // The better recording, or this one's own sound lined up with the mouth, is not linked:
      // Premiere would call it out of sync, when it is the one that is in sync.
      const inSec = s.startSec + (s.audio?.offsetSec ?? 0)
      voice.push({
        path: s.audio?.path ?? s.path,
        start: outStart,
        end: outStart + s.durationSec,
        inSec,
        ...(s.audio ? {} : { group: i }),
        origin: { outStart, srcStart: inSec }
      })
    }
    if (s.broll) {
      const b = s.broll
      const facts = input.media.get(b.path)
      const size = facts?.video ?? { width: frame.width, height: frame.height }
      const box = Math.min(frame.width, frame.height) * CARD_SHARE
      const scale = t?.frame === 'card' ? Math.min(box / size.width, box / size.height) * 100 : coverScale(frame, size)
      const inSec = facts?.video?.still ? 0 : b.startSec
      cutaways.push({
        path: b.path,
        start: pic.outStart,
        end: pic.outStart + pic.durationSec,
        inSec,
        scale,
        origin: { outStart: pic.outStart, srcStart: inSec }
      })
    }
    if (!piece || !beat) return
    const at = pic.outStart
    const id = beat.id
    if (s.hold) mark(id, 'freeze', at, `Freeze frame, ${seconds(pic.durationSec)}`, 'Cutalong holds the frame here.')
    const treatment = beat.treatment
    const broll = treatment.broll
    if (Math.abs((treatment.speed ?? 1) - 1) > 1e-6 || treatment.ramp) {
      const speed = describeSpeed(treatment.speed ?? 1, treatment.ramp)
      mark(id, 'speed', at, `Speed ${speed}`, 'Cutalong plays this beat at this speed.')
    }
    if (broll && (Math.abs((broll.speed ?? 1) - 1) > 1e-6 || broll.ramp)) {
      const speed = describeSpeed(broll.speed ?? 1, broll.ramp)
      mark(id, 'speed', at, `Cutaway speed ${speed}`, 'Cutalong plays this cutaway at this speed.')
    }
    if (treatment.reverse || broll?.reverse) mark(id, 'reverse', at, 'Backwards', 'Cutalong plays this backwards.')
    const camera = t?.camera ?? (s.broll && broll?.camera ? broll.camera : undefined)
    if (camera) mark(id, 'camera', at, named(CAMERA_INFO[camera.kind].label), 'A camera move in Cutalong.')
    if (s.broll && t?.frame === 'split') {
      mark(id, 'split', at, 'Split screen', 'Cutalong shows the cutaway on top and the speaker below.')
    }
    if (s.broll && t?.frame === 'card') mark(id, 'card', at, 'Card', 'Cutalong shows the picture on a plain ground.')
    if (t?.bw) mark(id, 'bw', at, 'Black and white', 'Cutalong shows this beat in black and white.')
  })

  // The music, from where the bed starts, looped as the export loops it, at
  // the level it sits under speech: Premiere has the recording's own
  // loudness, as the preview assumes, not the export's.
  const music: PremiereClip[] = []
  const bed = cut.music
  const bedLength = bed ? (input.media.get(bed.path)?.durationSec ?? 0) : 0
  if (bed && bedLength > bed.inSec + 0.05) {
    const gainDb = RECORDED_VOICE_LUFS + bed.levelDb - bed.duckDb - (bed.lufs ?? TYPICAL_TRACK_LUFS)
    let at = 0
    let inSec = bed.inSec
    while (at < resolved.durationSec - EPS) {
      const end = Math.min(resolved.durationSec, at + bedLength - inSec)
      music.push({ path: bed.path, start: at, end, inSec, gainDb, origin: { outStart: at, srcStart: inSec } })
      at = end
      inSec = 0
    }
  }

  // The sound effects, where the export mixes them, at the level the preview plays them.
  const offsetDb = cut.loudness === null ? 0 : RECORDED_VOICE_LUFS - cut.loudness
  const sounds: PremiereClip[] = []
  for (const p of placeSfx(cut.beats, resolved)) {
    const path = p.sfx.kind ? input.sfxFiles.get(p.sfx.kind) : p.sfx.path
    const length = path ? input.media.get(path)?.durationSec : undefined
    if (!path || !length || length - p.trimSec < 0.02) continue
    const end = Math.min(resolved.durationSec, p.startSec + length - p.trimSec)
    sounds.push({
      path,
      start: p.startSec,
      end,
      inSec: p.trimSec,
      gainDb: sfxGainDb(p.sfx) + offsetDb,
      origin: { outStart: p.startSec, srcStart: p.trimSec }
    })
  }
  // A track holds one clip at a time: a sound that starts while another plays goes on the next pair down.
  const lanes: PremiereClip[][] = []
  for (const s of sounds.filter((x) => x.end - x.start > 0.02).sort((a, b) => a.start - b.start)) {
    const lane = lanes.find((l) => l[l.length - 1].end <= s.start + EPS)
    if (lane) lane.push(s)
    else lanes.push([s])
  }

  // Every chapter the person set, where its beat starts, the first at 0:00, whether or not YouTube would show it.
  const starts = new Map(resolved.beats.map((b) => [b.id, b.outStart]))
  const chapters = (cut.chapters ?? [])
    .filter((c) => starts.has(c.beat))
    .map((c) => ({ title: c.title, atSec: starts.get(c.beat) as number }))
    .sort((a, b) => a.atSec - b.atSec)
  chapters.forEach((c, i) => markers.push({ atSec: i === 0 ? 0 : c.atSec, name: c.title, comment: 'A chapter.' }))
  const transitions = resolved.transitions ?? []
  for (const tr of transitions) {
    markers.push({
      atSec: tr.outStart,
      name: `${named(TRANSITION_INFO[tr.kind].label)}, ${seconds(tr.sec)}`,
      comment: 'A transition in Cutalong; a cut in the middle of it here.'
    })
  }
  for (const g of input.graphics) markers.push({ atSec: g.start, name: g.title, comment: 'A graphic in Cutalong.' })
  if (cut.look) markers.push({ atSec: 0, name: `Look: ${describeLook(cut.look)}`, comment: 'The look in Cutalong.' })

  const leftOut = [
    cut.look ? 'the look' : null,
    transitions.length ? plural(transitions.length, 'transition') : null,
    counts.camera ? plural(counts.camera, 'camera move') : null,
    counts.speed ? plural(counts.speed, 'speed change') : null,
    counts.reverse ? `${plural(counts.reverse, 'beat')} played backwards` : null,
    counts.freeze ? plural(counts.freeze, 'freeze frame') : null,
    counts.split ? plural(counts.split, 'split screen') : null,
    counts.card ? plural(counts.card, 'card') : null,
    counts.bw ? `black and white on ${plural(counts.bw, 'beat')}` : null,
    input.graphics.length ? plural(input.graphics.length, 'graphic') : null,
    cut.fade && (cut.fade.inSec > 0 || cut.fade.outSec > 0) ? 'the fades' : null,
    music.length && bed ? musicLeftOut(bed) : null,
    cut.voice && cut.voice.polish > 0 ? 'the voice polish' : null,
    cut.loudness !== null ? 'the loudness' : null
  ].filter((x): x is string => x !== null)

  return {
    name: input.name,
    width: input.width,
    height: input.height,
    fps: input.fps,
    durationSec: resolved.durationSec,
    picture: butt(picture),
    cutaways: butt(cutaways),
    voice: butt(voice),
    music,
    sounds: lanes,
    markers: markers.sort((a, b) => a.atSec - b.atSec),
    leftOut
  }
}

// ---- xmeml ----

/** Premiere counts time in ticks as well as frames, at this rate. */
const TICKS_PER_SEC = 254016000000

/** A file's name from its path, whichever way its slashes lean. */
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

const xml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A rate as xmeml writes it: 29.97 is timebase 30 with ntsc TRUE. */
export function sequenceRate(fps: number): { timebase: number; ntsc: boolean; fps: number } {
  const timebase = Math.max(1, Math.round(fps))
  const ntsc = Math.abs(fps - timebase) > 0.001 && Math.abs(fps - (timebase * 1000) / 1001) < 0.01
  return { timebase, ntsc, fps: ntsc ? (timebase * 1000) / 1001 : timebase }
}

const rateXml = (r: { timebase: number; ntsc: boolean }, pad: string): string =>
  `${pad}<rate>\n${pad}\t<timebase>${r.timebase}</timebase>\n${pad}\t<ntsc>${r.ntsc ? 'TRUE' : 'FALSE'}</ntsc>\n${pad}</rate>`

interface Placed extends PremiereClip {
  id: string
  /** Track index among tracks of its kind, from 1, and its place on that track, from 1. */
  track: number
  index: number
  kind: 'video' | 'audio'
  /** For sound: which of the file's channels this side plays. */
  channel?: number
}

/** The project as xmeml, for Premiere's File > Import. */
export function buildPremiereXml(plan: PremierePlan, media: Map<string, PremiereMedia>): string {
  const rate = sequenceRate(plan.fps)
  const frame = (sec: number): number => Math.max(0, Math.round(sec * rate.fps + 1e-6))
  const tick = Math.round(TICKS_PER_SEC / rate.fps)
  let next = 1
  const fileIds = new Map<string, string>()
  const written = new Set<string>()
  const fileId = (path: string): string => {
    if (!fileIds.has(path)) fileIds.set(path, `file-${fileIds.size + 1}`)
    return fileIds.get(path) as string
  }

  const place = (clips: PremiereClip[], kind: 'video' | 'audio', track: number, channel?: number): Placed[] =>
    clips.map((c, i) => ({ ...c, id: `clipitem-${next++}`, kind, track, index: i + 1, channel }))

  const v1 = place(plan.picture, 'video', 1)
  const v2 = place(plan.cutaways, 'video', 2)
  const audio: Placed[][] = []
  // The voice always has its pair; the music and each lane of sounds when there is any.
  for (const clips of [plan.voice, plan.music, ...plan.sounds].filter((c, i) => i === 0 || c.length > 0)) {
    const left = audio.length + 1
    audio.push(place(clips, 'audio', left, 1), place(clips, 'audio', left + 1, 2))
  }

  // A picture and its own sound are linked: Premiere moves them together.
  const groups = new Map<number, Placed[]>()
  for (const p of [...v1, ...audio.flat()]) {
    if (p.group === undefined) continue
    groups.set(p.group, [...(groups.get(p.group) ?? []), p])
  }

  const fileXml = (path: string, pad: string): string => {
    const id = fileId(path)
    if (written.has(id)) return `${pad}<file id="${id}"/>`
    written.add(id)
    const m = media.get(path)
    const lines = [
      `${pad}<file id="${id}">`,
      `${pad}\t<name>${xml(fileName(path))}</name>`,
      // A Windows path's drive and backslashes read as Premiere writes them there: file://localhost/C%3A/...
      `${pad}\t<pathurl>${xml(pathUrl(path.replace(/\\/g, '/')))}</pathurl>`,
      rateXml(rate, `${pad}\t`),
      // A still lasts as long as it is asked to.
      `${pad}\t<duration>${frame(m?.video?.still ? Math.max(m.durationSec, plan.durationSec) : (m?.durationSec ?? 0))}</duration>`,
      `${pad}\t<media>`
    ]
    if (m?.video) {
      const own = sequenceRate(m.video.fps || plan.fps)
      lines.push(
        `${pad}\t\t<video>`,
        `${pad}\t\t\t<samplecharacteristics>`,
        rateXml(own, `${pad}\t\t\t\t`),
        `${pad}\t\t\t\t<width>${m.video.width}</width>`,
        `${pad}\t\t\t\t<height>${m.video.height}</height>`,
        `${pad}\t\t\t\t<anamorphic>FALSE</anamorphic>`,
        `${pad}\t\t\t\t<pixelaspectratio>square</pixelaspectratio>`,
        `${pad}\t\t\t\t<fielddominance>none</fielddominance>`,
        `${pad}\t\t\t</samplecharacteristics>`,
        `${pad}\t\t</video>`
      )
    }
    if (m && m.channels > 0) {
      lines.push(
        `${pad}\t\t<audio>`,
        `${pad}\t\t\t<samplecharacteristics>`,
        `${pad}\t\t\t\t<depth>16</depth>`,
        `${pad}\t\t\t\t<samplerate>48000</samplerate>`,
        `${pad}\t\t\t</samplecharacteristics>`,
        `${pad}\t\t\t<channelcount>${Math.min(2, m.channels)}</channelcount>`,
        `${pad}\t\t</audio>`
      )
    }
    lines.push(`${pad}\t</media>`, `${pad}</file>`)
    return lines.join('\n')
  }

  const scaleXml = (scale: number, pad: string): string =>
    [
      `${pad}<filter>`,
      `${pad}\t<effect>`,
      `${pad}\t\t<name>Basic Motion</name>`,
      `${pad}\t\t<effectid>basic</effectid>`,
      `${pad}\t\t<effectcategory>motion</effectcategory>`,
      `${pad}\t\t<effecttype>motion</effecttype>`,
      `${pad}\t\t<mediatype>video</mediatype>`,
      `${pad}\t\t<parameter authoringApp="PremierePro">`,
      `${pad}\t\t\t<parameterid>scale</parameterid>`,
      `${pad}\t\t\t<name>Scale</name>`,
      `${pad}\t\t\t<valuemin>0</valuemin>`,
      `${pad}\t\t\t<valuemax>1000</valuemax>`,
      `${pad}\t\t\t<value>${scale.toFixed(4)}</value>`,
      `${pad}\t\t</parameter>`,
      `${pad}\t</effect>`,
      `${pad}</filter>`
    ].join('\n')

  const levelXml = (gainDb: number, pad: string): string =>
    [
      `${pad}<filter>`,
      `${pad}\t<effect>`,
      `${pad}\t\t<name>Audio Levels</name>`,
      `${pad}\t\t<effectid>audiolevels</effectid>`,
      `${pad}\t\t<effectcategory>audiolevels</effectcategory>`,
      `${pad}\t\t<effecttype>audiolevels</effecttype>`,
      `${pad}\t\t<mediatype>audio</mediatype>`,
      `${pad}\t\t<parameter authoringApp="PremierePro">`,
      `${pad}\t\t\t<parameterid>level</parameterid>`,
      `${pad}\t\t\t<name>Level</name>`,
      `${pad}\t\t\t<valuemin>0</valuemin>`,
      `${pad}\t\t\t<valuemax>3.98109</valuemax>`,
      `${pad}\t\t\t<value>${Math.min(3.98109, Math.pow(10, gainDb / 20)).toFixed(6)}</value>`,
      `${pad}\t\t</parameter>`,
      `${pad}\t</effect>`,
      `${pad}</filter>`
    ].join('\n')

  const linkXml = (p: Placed, pad: string): string[] => {
    const group = p.group === undefined ? undefined : groups.get(p.group)
    if (!group || group.length < 2) return []
    return group.flatMap((g) => [
      `${pad}<link>`,
      `${pad}\t<linkclipref>${g.id}</linkclipref>`,
      `${pad}\t<mediatype>${g.kind}</mediatype>`,
      `${pad}\t<trackindex>${g.track}</trackindex>`,
      `${pad}\t<clipindex>${g.index}</clipindex>`,
      ...(g.kind === 'audio' ? [`${pad}\t<groupindex>1</groupindex>`] : []),
      `${pad}</link>`
    ])
  }

  /**
   * Where a clip starting on frame `start` reads its file from. A picture shows
   * what the export shows there: the first of the file's own frames at or
   * after where its piece started, and one frame on for every frame since. A
   * sound starts on a frame too, so it reads from the moment that frame is
   * on the piece's clock, which keeps every word where the export has it.
   */
  const inPoint = (p: Placed, start: number, still: boolean): number => {
    if (still) return 0
    const o = p.origin
    if (p.kind === 'audio') return Math.max(0, o.srcStart + (start / rate.fps - o.outStart))
    const own = sequenceRate(media.get(p.path)?.video?.fps || plan.fps).fps
    return Math.max(0, Math.ceil(o.srcStart * own - 1e-6) / own + (start - frame(o.outStart)) / rate.fps)
  }

  const itemXml = (p: Placed, pad: string): string => {
    const m = media.get(p.path)
    const start = frame(p.start)
    const end = Math.max(start + 1, frame(p.end))
    const still = !!m?.video?.still
    const inSec = inPoint(p, start, still)
    const inF = frame(inSec)
    const ticksIn = Math.round(inSec * TICKS_PER_SEC)
    const mono = (m?.channels ?? 2) < 2
    const lines = [
      p.kind === 'video'
        ? `${pad}<clipitem id="${p.id}">`
        : `${pad}<clipitem id="${p.id}" premiereChannelType="${mono ? 'mono' : 'stereo'}">`,
      `${pad}\t<masterclipid>master-${fileId(p.path)}</masterclipid>`,
      `${pad}\t<name>${xml(fileName(p.path))}</name>`,
      `${pad}\t<enabled>TRUE</enabled>`,
      `${pad}\t<duration>${still ? inF + (end - start) : frame(m?.durationSec ?? p.end - p.start)}</duration>`,
      rateXml(rate, `${pad}\t`),
      `${pad}\t<start>${start}</start>`,
      `${pad}\t<end>${end}</end>`,
      `${pad}\t<in>${inF}</in>`,
      `${pad}\t<out>${inF + (end - start)}</out>`,
      `${pad}\t<pproTicksIn>${ticksIn}</pproTicksIn>`,
      `${pad}\t<pproTicksOut>${ticksIn + (end - start) * tick}</pproTicksOut>`
    ]
    if (p.kind === 'video') {
      lines.push(
        `${pad}\t<alphatype>none</alphatype>`,
        `${pad}\t<pixelaspectratio>square</pixelaspectratio>`,
        `${pad}\t<anamorphic>FALSE</anamorphic>`
      )
      if (still) lines.push(`${pad}\t<stillframe>TRUE</stillframe>`)
    }
    lines.push(fileXml(p.path, `${pad}\t`))
    if (p.kind === 'audio') {
      lines.push(
        `${pad}\t<sourcetrack>`,
        `${pad}\t\t<mediatype>audio</mediatype>`,
        `${pad}\t\t<trackindex>${mono ? 1 : (p.channel ?? 1)}</trackindex>`,
        `${pad}\t</sourcetrack>`
      )
      if (p.gainDb !== undefined && Math.abs(p.gainDb) > 0.01) lines.push(levelXml(p.gainDb, `${pad}\t`))
    } else if (p.scale !== undefined && Math.abs(p.scale - 100) > 0.01) {
      lines.push(scaleXml(p.scale, `${pad}\t`))
    }
    lines.push(...linkXml(p, `${pad}\t`), `${pad}</clipitem>`)
    return lines.join('\n')
  }

  const trackXml = (items: Placed[], pad: string, extra: string[] = [], attrs = ''): string =>
    [
      `${pad}<track${attrs}>`,
      ...items.map((p) => itemXml(p, `${pad}\t`)),
      `${pad}\t<enabled>TRUE</enabled>`,
      `${pad}\t<locked>FALSE</locked>`,
      ...extra.map((e) => `${pad}\t${e}`),
      `${pad}</track>`
    ].join('\n')

  const markerXml = (m: PremiereMarker): string =>
    [
      `\t\t<marker>`,
      `\t\t\t<name>${xml(m.name)}</name>`,
      `\t\t\t<comment>${xml(m.comment)}</comment>`,
      `\t\t\t<in>${frame(m.atSec)}</in>`,
      `\t\t\t<out>-1</out>`,
      `\t\t</marker>`
    ].join('\n')

  const sequence = [
    `\t<sequence id="sequence-1" explodedTracks="true">`,
    `\t\t<uuid>${randomUUID()}</uuid>`,
    `\t\t<duration>${frame(plan.durationSec)}</duration>`,
    rateXml(rate, '\t\t'),
    `\t\t<name>${xml(plan.name)}</name>`,
    `\t\t<media>`,
    `\t\t\t<video>`,
    `\t\t\t\t<format>`,
    `\t\t\t\t\t<samplecharacteristics>`,
    rateXml(rate, '\t\t\t\t\t\t'),
    `\t\t\t\t\t\t<width>${plan.width}</width>`,
    `\t\t\t\t\t\t<height>${plan.height}</height>`,
    `\t\t\t\t\t\t<anamorphic>FALSE</anamorphic>`,
    `\t\t\t\t\t\t<pixelaspectratio>square</pixelaspectratio>`,
    `\t\t\t\t\t\t<fielddominance>none</fielddominance>`,
    `\t\t\t\t\t\t<colordepth>24</colordepth>`,
    `\t\t\t\t\t</samplecharacteristics>`,
    `\t\t\t\t</format>`,
    trackXml(v1, '\t\t\t\t'),
    ...(v2.length ? [trackXml(v2, '\t\t\t\t')] : []),
    `\t\t\t</video>`,
    `\t\t\t<audio>`,
    `\t\t\t\t<numOutputChannels>2</numOutputChannels>`,
    `\t\t\t\t<format>`,
    `\t\t\t\t\t<samplecharacteristics>`,
    `\t\t\t\t\t\t<depth>16</depth>`,
    `\t\t\t\t\t\t<samplerate>48000</samplerate>`,
    `\t\t\t\t\t</samplecharacteristics>`,
    `\t\t\t\t</format>`,
    // A stereo pair is two tracks, left and right, as Premiere writes them.
    ...audio.map((items, i) =>
      trackXml(
        items,
        '\t\t\t\t',
        [`<outputchannelindex>${(i % 2) + 1}</outputchannelindex>`],
        ` premiereTrackType="Stereo" currentExplodedTrackIndex="${i % 2}" totalExplodedTrackCount="2"`
      )
    ),
    `\t\t\t</audio>`,
    `\t\t</media>`,
    ...plan.markers.map(markerXml),
    `\t\t<timecode>`,
    rateXml(rate, '\t\t\t'),
    `\t\t\t<string>00:00:00:00</string>`,
    `\t\t\t<frame>0</frame>`,
    `\t\t\t<displayformat>NDF</displayformat>`,
    `\t\t</timecode>`,
    `\t</sequence>`
  ].join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="4">',
    sequence,
    '</xmeml>',
    ''
  ].join('\n')
}

/** The captions as SRT, page by page as the export shows them, for Premiere's captions track. */
export function captionsSrt(resolved: Resolved, captions: Cut['captions']): string | null {
  const pages = captionPages(resolved, captions.wordsPerScreen)
  if (pages.length === 0) return null
  const stamp = (sec: number): string => {
    const ms = Math.max(0, Math.round(sec * 1000))
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
  }
  return pages
    .map((page, i) => {
      const text = page.map((w) => w.text).join(' ')
      return [
        String(i + 1),
        `${stamp(page[0].outStart)} --> ${stamp(page[page.length - 1].outEnd)}`,
        captions.uppercase ? text.toUpperCase() : text,
        ''
      ].join('\n')
    })
    .join('\n')
}

/** A file's length, picture and sound, read from what ffmpeg says about it. */
export async function premiereMedia(ffmpeg: string, path: string): Promise<PremiereMedia> {
  await fs.access(path).catch(() => {
    throw new Error(`I can't find ${basename(path)}. It was at ${path}.`)
  })
  const stderr = await new Promise<string>((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-i', path])
    let err = ''
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('close', () => resolve(err))
    p.on('error', () => resolve(err))
  })
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const video = /Stream #\d+:\d+[^\n]*?: Video:([^\n]*)/.exec(stderr)
  const size = video ? /\b(\d{2,5})x(\d{2,5})\b/.exec(video[1]) : null
  const fps = video ? /([\d.]+) fps/.exec(video[1]) : null
  const audio = /Stream #\d+:\d+[^\n]*?: Audio:([^\n]*)/.exec(stderr)
  let width = size ? Number(size[1]) : 0
  let height = size ? Number(size[2]) : 0
  const rotation = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(stderr)
  if (rotation && Math.abs(Math.round(Number(rotation[1]) / 90)) % 2 === 1) [width, height] = [height, width]
  const channels = !audio ? 0 : /\bmono\b/.test(audio[1]) ? 1 : Number(/(\d+) channels/.exec(audio[1])?.[1]) || 2
  return {
    durationSec: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    video: size ? { width, height, fps: fps ? Number(fps[1]) : 30, still: isImagePath(path) } : null,
    channels
  }
}

/**
 * Writes the edit's current version for Premiere: the project at xmlPath and,
 * when anything is said, the captions beside it as "<name> captions.srt".
 * Built-in sound effects are made into sfxDir first, as the export makes them.
 */
export async function writePremiere(
  doc: EditDoc,
  opts: { ffmpeg: string; xmlPath: string; sfxDir: string }
): Promise<{ xmlPath: string; srtPath: string | null; facts: PremiereFacts }> {
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const first = doc.sources.find((s) => s.id === resolved.pieces[0]?.source) ?? doc.sources[0]
  if (!first || resolved.pieces.length === 0) throw new Error('The edit has nothing in it to open yet.')
  const media = new Map<string, PremiereMedia>()
  const read = async (path: string): Promise<PremiereMedia> => {
    if (!media.has(path)) media.set(path, await premiereMedia(opts.ffmpeg, path))
    return media.get(path) as PremiereMedia
  }
  const sources = []
  for (const s of doc.sources) {
    const used = resolved.pieces.some((p) => p.source === s.id)
    sources.push({ ...s, hasAudio: used ? (await read(s.path)).channels > 0 : false })
  }
  const segments = segmentsFor(cut, resolved, sources)
  for (const s of segments) {
    if (s.audio) await read(s.audio.path)
    if (s.broll) await read(s.broll.path)
  }
  if (cut.music) await read(cut.music.path)
  const sfxFiles = new Map<string, string>()
  for (const p of placeSfx(cut.beats, resolved)) {
    const kind = p.sfx.kind
    if (kind && !sfxFiles.has(kind)) sfxFiles.set(kind, await makeSfx(opts.ffmpeg, kind, opts.sfxDir))
    const path = kind ? sfxFiles.get(kind) : p.sfx.path
    if (path) await read(path)
  }
  // Graphics are drawn in Cutalong; each gets a marker where it comes in.
  const byId = new Map((cut.motion ?? []).map((m) => [m.id, m]))
  const scene = buildScene({
    cut,
    resolved,
    words: doc.words,
    size: designSize(cut.aspect, first),
    theme: DEFAULT_THEME,
    assets: doc.assets
  })
  const graphics = scene.items.flatMap((i) => {
    const item = byId.get(i.id)
    return item ? [{ start: i.start, title: graphicTitle(item) }] : []
  })
  const size = frameSize(cut.aspect, first)
  const name = basename(opts.xmlPath).replace(/\.xml$/i, '')
  const plan = planPremiere({
    name,
    cut,
    resolved,
    segments,
    shapes: new Map(doc.sources.map((s) => [s.path, { width: s.width, height: s.height }])),
    width: size.width,
    height: size.height,
    fps: first.fps,
    media,
    sfxFiles,
    graphics
  })
  await fs.mkdir(dirname(opts.xmlPath), { recursive: true })
  await fs.writeFile(opts.xmlPath, buildPremiereXml(plan, media))
  const srt = captionsSrt(resolved, cut.captions)
  const srtPath = srt ? join(dirname(opts.xmlPath), `${name} captions.srt`) : null
  if (srt && srtPath) await fs.writeFile(srtPath, srt)
  const showsCutaway = new Set(resolved.pieces.filter((_, i) => segments[i].broll).map((p) => p.beat))
  return {
    xmlPath: opts.xmlPath,
    srtPath,
    facts: {
      cuts: plan.picture.length,
      recordings: new Set(plan.picture.map((c) => c.path)).size,
      cutaways: showsCutaway.size,
      music: plan.music.length > 0,
      sounds: plan.sounds.flat().length,
      markers: plan.markers.length,
      leftOut: plan.leftOut
    }
  }
}

/** Where Premiere Pro is installed, the newest first; null when it is not. */
export async function findPremiere(): Promise<string | null> {
  const mac = process.platform === 'darwin'
  if (!mac && process.platform !== 'win32') return null
  const root = mac ? '/Applications' : join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Adobe')
  const folders = (await fs.readdir(root).catch(() => [] as string[])).filter((n) => /^Adobe Premiere Pro/.test(n))
  for (const folder of folders.sort().reverse()) {
    const inside = await fs.readdir(join(root, folder)).catch(() => [] as string[])
    const app = inside.find((n) => (mac ? /^Adobe Premiere Pro.*\.app$/ : /^Adobe Premiere Pro\.exe$/).test(n))
    if (app) return join(root, folder, app)
  }
  return null
}

/** Opens a project in Premiere, which reads an xmeml file as a project to bring in. */
export function openInPremiere(app: string, path: string): void {
  const child =
    process.platform === 'darwin'
      ? spawn('open', ['-a', app, path], { detached: true, stdio: 'ignore' })
      : spawn(app, [path], { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}
