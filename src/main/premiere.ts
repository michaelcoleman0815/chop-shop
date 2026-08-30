import { basename } from 'path'
import { randomUUID } from 'crypto'
import type { Segment } from './tighten'
import type { SuggestedClip } from '../shared/types'

/**
 * Writes an xmeml project for Premiere.
 *
 * The point is to hand over decisions rather than pixels: the file references
 * the original recording by path, so every cut stays editable at full quality
 * instead of arriving as a flattened export.
 *
 * Premiere reads a dialect of its own rather than textbook FCP7 XML, and the
 * differences are not cosmetic. The shapes here were taken from a project
 * Premiere exported itself: paths carry a localhost authority, picture and
 * sound are tied together by explicit link blocks, and a stereo pair is written
 * as two mono tracks rather than one stereo clip.
 */

export interface PremiereSource {
  path: string
  width: number
  height: number
  fps: number
  durationSec: number
}

export interface PremiereClip {
  title: string
  startSec: number
  endSec: number
  /** Kept spans within the clip, relative to startSec. One clipitem each. */
  segments?: Segment[]
}

/** Premiere counts time in ticks as well as frames, at this rate. */
const TICKS_PER_SEC = 254016000000

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Premiere writes file://localhost/..., not the bare file:/// form. */
export function pathUrl(path: string): string {
  const encoded = path
    .split('/')
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
    .join('/')
  return `file://localhost/${encoded}`
}

/**
 * xmeml stores an integer timebase plus an ntsc flag, so 59.94 is written as
 * timebase 60 with ntsc TRUE, while a clean 60 is ntsc FALSE.
 */
export function rateFor(fps: number): { timebase: number; ntsc: boolean } {
  const timebase = Math.round(fps)
  return { timebase, ntsc: Math.abs(fps - timebase) > 0.001 }
}

const frames = (sec: number, fps: number): number => Math.max(0, Math.round(sec * fps))
const ticks = (sec: number): number => Math.round(Math.max(0, sec) * TICKS_PER_SEC)

function rateXml(fps: number, pad: string): string {
  const { timebase, ntsc } = rateFor(fps)
  return [
    `${pad}<rate>`,
    `${pad}\t<timebase>${timebase}</timebase>`,
    `${pad}\t<ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc>`,
    `${pad}</rate>`
  ].join('\n')
}

function timecodeXml(fps: number, pad: string): string {
  return [
    `${pad}<timecode>`,
    rateXml(fps, `${pad}\t`),
    `${pad}\t<string>00:00:00:00</string>`,
    `${pad}\t<frame>0</frame>`,
    `${pad}\t<displayformat>NDF</displayformat>`,
    `${pad}</timecode>`
  ].join('\n')
}

function fileXml(source: PremiereSource, fileId: string, full: boolean, pad: string): string {
  // The body is written once per project; every later reference is the bare id,
  // or Premiere imports the same media as a separate asset each time.
  if (!full) return `${pad}<file id="${fileId}"/>`
  return [
    `${pad}<file id="${fileId}">`,
    `${pad}\t<name>${escapeXml(basename(source.path))}</name>`,
    `${pad}\t<pathurl>${escapeXml(pathUrl(source.path))}</pathurl>`,
    rateXml(source.fps, `${pad}\t`),
    `${pad}\t<duration>${frames(source.durationSec, source.fps)}</duration>`,
    timecodeXml(source.fps, `${pad}\t`),
    `${pad}\t<media>`,
    `${pad}\t\t<video>`,
    `${pad}\t\t\t<samplecharacteristics>`,
    rateXml(source.fps, `${pad}\t\t\t\t`),
    `${pad}\t\t\t\t<width>${source.width}</width>`,
    `${pad}\t\t\t\t<height>${source.height}</height>`,
    `${pad}\t\t\t\t<anamorphic>FALSE</anamorphic>`,
    `${pad}\t\t\t\t<pixelaspectratio>square</pixelaspectratio>`,
    `${pad}\t\t\t\t<fielddominance>none</fielddominance>`,
    `${pad}\t\t\t</samplecharacteristics>`,
    `${pad}\t\t</video>`,
    `${pad}\t\t<audio>`,
    `${pad}\t\t\t<samplecharacteristics>`,
    `${pad}\t\t\t\t<depth>16</depth>`,
    `${pad}\t\t\t\t<samplerate>48000</samplerate>`,
    `${pad}\t\t\t</samplecharacteristics>`,
    `${pad}\t\t\t<channelcount>2</channelcount>`,
    `${pad}\t\t</audio>`,
    `${pad}\t</media>`,
    `${pad}</file>`
  ].join('\n')
}

interface Ids {
  video: string
  audioLeft: string
  audioRight: string
}

/** Picture and both sound channels reference each other, in every clipitem. */
function linkXml(ids: Ids, clipIndex: number, pad: string): string {
  return [
    `${pad}<link>`,
    `${pad}\t<linkclipref>${ids.video}</linkclipref>`,
    `${pad}\t<mediatype>video</mediatype>`,
    `${pad}\t<trackindex>1</trackindex>`,
    `${pad}\t<clipindex>${clipIndex}</clipindex>`,
    `${pad}</link>`,
    `${pad}<link>`,
    `${pad}\t<linkclipref>${ids.audioLeft}</linkclipref>`,
    `${pad}\t<mediatype>audio</mediatype>`,
    `${pad}\t<trackindex>1</trackindex>`,
    `${pad}\t<clipindex>${clipIndex}</clipindex>`,
    `${pad}\t<groupindex>1</groupindex>`,
    `${pad}</link>`,
    `${pad}<link>`,
    `${pad}\t<linkclipref>${ids.audioRight}</linkclipref>`,
    `${pad}\t<mediatype>audio</mediatype>`,
    `${pad}\t<trackindex>2</trackindex>`,
    `${pad}\t<clipindex>${clipIndex}</clipindex>`,
    `${pad}\t<groupindex>1</groupindex>`,
    `${pad}</link>`
  ].join('\n')
}

interface Placed {
  sourceInSec: number
  sourceOutSec: number
  timelineInSec: number
}

/** Lays the kept spans end to end, which is what turns cuts into real edits. */
function placeSegments(clip: PremiereClip): Placed[] {
  const spans =
    clip.segments && clip.segments.length > 0
      ? clip.segments
      : [{ start: 0, end: clip.endSec - clip.startSec }]

  let timeline = 0
  return spans.map((s) => {
    const placed = {
      sourceInSec: clip.startSec + s.start,
      sourceOutSec: clip.startSec + s.end,
      timelineInSec: timeline
    }
    timeline += s.end - s.start
    return placed
  })
}

interface ItemOpts {
  placed: Placed
  source: PremiereSource
  ids: Ids
  clipIndex: number
  masterId: string
  fileId: string
  name: string
  writeFileBody: boolean
  kind: 'video' | 'audioLeft' | 'audioRight'
}

function clipitemXml(o: ItemOpts, pad: string): string {
  const fps = o.source.fps
  const inF = frames(o.placed.sourceInSec, fps)
  const outF = frames(o.placed.sourceOutSec, fps)
  const startF = frames(o.placed.timelineInSec, fps)
  const id = o.kind === 'video' ? o.ids.video : o.kind === 'audioLeft' ? o.ids.audioLeft : o.ids.audioRight
  const audioIndex = o.kind === 'audioRight' ? 2 : 1

  const head = [
    o.kind === 'video'
      ? `${pad}<clipitem id="${id}">`
      : `${pad}<clipitem id="${id}" premiereChannelType="stereo">`,
    `${pad}\t<masterclipid>${o.masterId}</masterclipid>`,
    `${pad}\t<name>${escapeXml(o.name)}</name>`,
    `${pad}\t<enabled>TRUE</enabled>`,
    `${pad}\t<duration>${frames(o.source.durationSec, fps)}</duration>`,
    rateXml(fps, `${pad}\t`),
    `${pad}\t<start>${startF}</start>`,
    `${pad}\t<end>${startF + (outF - inF)}</end>`,
    `${pad}\t<in>${inF}</in>`,
    `${pad}\t<out>${outF}</out>`,
    `${pad}\t<pproTicksIn>${ticks(o.placed.sourceInSec)}</pproTicksIn>`,
    `${pad}\t<pproTicksOut>${ticks(o.placed.sourceOutSec)}</pproTicksOut>`
  ]

  if (o.kind === 'video') {
    head.push(
      `${pad}\t<alphatype>none</alphatype>`,
      `${pad}\t<pixelaspectratio>square</pixelaspectratio>`,
      `${pad}\t<anamorphic>FALSE</anamorphic>`
    )
  }

  head.push(fileXml(o.source, o.fileId, o.writeFileBody, `${pad}\t`))

  if (o.kind !== 'video') {
    head.push(
      `${pad}\t<sourcetrack>`,
      `${pad}\t\t<mediatype>audio</mediatype>`,
      `${pad}\t\t<trackindex>${audioIndex}</trackindex>`,
      `${pad}\t</sourcetrack>`
    )
  }

  head.push(linkXml(o.ids, o.clipIndex, `${pad}\t`), `${pad}</clipitem>`)
  return head.join('\n')
}

const AUDIO_TRACK_ATTRS =
  'premiereTrackType="Stereo" currentExplodedTrackIndex="INDEX" totalExplodedTrackCount="2"'

function sequenceXml(
  name: string,
  placed: Placed[],
  source: PremiereSource,
  seqIndex: number,
  counter: { n: number },
  markers: string[] = []
): string {
  const totalSec = placed.reduce((sum, p) => sum + (p.sourceOutSec - p.sourceInSec), 0)
  const fileId = `file-${seqIndex}`
  const masterId = `masterclip-${seqIndex}`

  const groups = placed.map((p, i) => {
    const ids: Ids = {
      video: `clipitem-${counter.n++}`,
      audioLeft: `clipitem-${counter.n++}`,
      audioRight: `clipitem-${counter.n++}`
    }
    return { placed: p, ids, clipIndex: i + 1, first: i === 0 }
  })

  const item = (g: (typeof groups)[number], kind: ItemOpts['kind'], pad: string): string =>
    clipitemXml(
      {
        placed: g.placed,
        source,
        ids: g.ids,
        clipIndex: g.clipIndex,
        masterId,
        fileId,
        name,
        // Only the very first clipitem in the sequence carries the file body.
        writeFileBody: g.first && kind === 'video',
        kind
      },
      pad
    )

  return [
    `\t<sequence id="sequence-${seqIndex}" explodedTracks="true">`,
    `\t\t<uuid>${randomUUID()}</uuid>`,
    `\t\t<duration>${frames(totalSec, source.fps)}</duration>`,
    rateXml(source.fps, '\t\t'),
    `\t\t<name>${escapeXml(name)}</name>`,
    `\t\t<media>`,
    `\t\t\t<video>`,
    `\t\t\t\t<format>`,
    `\t\t\t\t\t<samplecharacteristics>`,
    rateXml(source.fps, '\t\t\t\t\t\t'),
    `\t\t\t\t\t\t<width>${source.width}</width>`,
    `\t\t\t\t\t\t<height>${source.height}</height>`,
    `\t\t\t\t\t\t<anamorphic>FALSE</anamorphic>`,
    `\t\t\t\t\t\t<pixelaspectratio>square</pixelaspectratio>`,
    `\t\t\t\t\t\t<fielddominance>none</fielddominance>`,
    `\t\t\t\t\t\t<colordepth>24</colordepth>`,
    `\t\t\t\t\t</samplecharacteristics>`,
    `\t\t\t\t</format>`,
    `\t\t\t\t<track>`,
    ...groups.map((g) => item(g, 'video', '\t\t\t\t\t')),
    `\t\t\t\t\t<enabled>TRUE</enabled>`,
    `\t\t\t\t\t<locked>FALSE</locked>`,
    `\t\t\t\t</track>`,
    `\t\t\t</video>`,
    `\t\t\t<audio>`,
    `\t\t\t\t<numOutputChannels>2</numOutputChannels>`,
    `\t\t\t\t<format>`,
    `\t\t\t\t\t<samplecharacteristics>`,
    `\t\t\t\t\t\t<depth>16</depth>`,
    `\t\t\t\t\t\t<samplerate>48000</samplerate>`,
    `\t\t\t\t\t</samplecharacteristics>`,
    `\t\t\t\t</format>`,
    `\t\t\t\t<track ${AUDIO_TRACK_ATTRS.replace('INDEX', '0')}>`,
    ...groups.map((g) => item(g, 'audioLeft', '\t\t\t\t\t')),
    `\t\t\t\t\t<enabled>TRUE</enabled>`,
    `\t\t\t\t\t<locked>FALSE</locked>`,
    `\t\t\t\t\t<outputchannelindex>1</outputchannelindex>`,
    `\t\t\t\t</track>`,
    `\t\t\t\t<track ${AUDIO_TRACK_ATTRS.replace('INDEX', '1')}>`,
    ...groups.map((g) => item(g, 'audioRight', '\t\t\t\t\t')),
    `\t\t\t\t\t<enabled>TRUE</enabled>`,
    `\t\t\t\t\t<locked>FALSE</locked>`,
    `\t\t\t\t\t<outputchannelindex>2</outputchannelindex>`,
    `\t\t\t\t</track>`,
    `\t\t\t</audio>`,
    `\t\t</media>`,
    ...markers,
    timecodeXml(source.fps, '\t\t'),
    `\t</sequence>`
  ].join('\n')
}

export function buildProject(
  clips: PremiereClip[],
  suggestions: SuggestedClip[],
  source: PremiereSource
): string {
  const counter = { n: 1 }

  const markers = suggestions.map((c) =>
    [
      `\t\t<marker>`,
      `\t\t\t<name>${escapeXml(c.title)}</name>`,
      `\t\t\t<comment>${escapeXml(`${c.score} · ${c.reason}`)}</comment>`,
      `\t\t\t<in>${frames(c.startSec, source.fps)}</in>`,
      `\t\t\t<out>${frames(c.endSec, source.fps)}</out>`,
      `\t\t</marker>`
    ].join('\n')
  )

  const master = sequenceXml(
    `${basename(source.path)} · suggestions`,
    [{ sourceInSec: 0, sourceOutSec: source.durationSec, timelineInSec: 0 }],
    source,
    0,
    counter,
    markers
  )

  const sequences = clips.map((c, i) =>
    sequenceXml(c.title, placeSegments(c), source, i + 1, counter)
  )

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="4">',
    master,
    ...sequences,
    '</xmeml>',
    ''
  ].join('\n')
}

/** Captions ride alongside as SRT, which Premiere imports natively. */
export function buildSrt(words: { text: string; startSec: number; endSec: number }[]): string {
  const stamp = (sec: number): string => {
    const ms = Math.max(0, Math.round(sec * 1000))
    const h = Math.floor(ms / 3600000)
    const m = Math.floor((ms % 3600000) / 60000)
    const s = Math.floor((ms % 60000) / 1000)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
  }

  const lines: string[] = []
  let index = 1
  for (let i = 0; i < words.length; i += 5) {
    const group = words.slice(i, i + 5)
    lines.push(
      String(index++),
      `${stamp(group[0].startSec)} --> ${stamp(group[group.length - 1].endSec)}`,
      group.map((w) => w.text).join(' '),
      ''
    )
  }
  return lines.join('\n')
}
