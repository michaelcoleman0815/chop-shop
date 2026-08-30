import { basename } from 'path'
import type { Segment } from './tighten'
import type { SuggestedClip } from '../shared/types'

/**
 * Writes an xmeml (Final Cut Pro 7 XML) project for Premiere.
 *
 * The point is to hand over decisions rather than pixels: the file references
 * the original recording by path, so every cut stays editable at full quality
 * instead of arriving as a flattened export. xmeml counts in frames, not
 * seconds, and Premiere reads a slightly extended dialect of it.
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

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** file:// URL with each path segment encoded, as Premiere expects. */
export function pathUrl(path: string): string {
  return 'file://' + path.split('/').map(encodeURIComponent).join('/').replace(/^%2F/, '/')
}

/**
 * xmeml stores an integer timebase plus an ntsc flag, so 59.94 is written as
 * timebase 60 with ntsc TRUE rather than as a fraction.
 */
export function rateFor(fps: number): { timebase: number; ntsc: boolean } {
  const rounded = Math.round(fps)
  const ntsc = Math.abs(fps - rounded) > 0.001 || [24, 30, 60].includes(rounded)
  return { timebase: rounded, ntsc: ntsc && Math.abs(fps - rounded) > 0.001 }
}

const frames = (sec: number, fps: number): number => Math.max(0, Math.round(sec * fps))

function rateXml(fps: number, indent: string): string {
  const { timebase, ntsc } = rateFor(fps)
  return [
    `${indent}<rate>`,
    `${indent}  <timebase>${timebase}</timebase>`,
    `${indent}  <ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc>`,
    `${indent}</rate>`
  ].join('\n')
}

function fileXml(source: PremiereSource, fileId: string, includeBody: boolean, indent: string): string {
  if (!includeBody) return `${indent}<file id="${fileId}"/>`
  return [
    `${indent}<file id="${fileId}">`,
    `${indent}  <name>${escapeXml(basename(source.path))}</name>`,
    `${indent}  <pathurl>${escapeXml(pathUrl(source.path))}</pathurl>`,
    rateXml(source.fps, `${indent}  `),
    `${indent}  <duration>${frames(source.durationSec, source.fps)}</duration>`,
    `${indent}  <media>`,
    `${indent}    <video>`,
    `${indent}      <samplecharacteristics>`,
    `${indent}        <width>${source.width}</width>`,
    `${indent}        <height>${source.height}</height>`,
    `${indent}      </samplecharacteristics>`,
    `${indent}    </video>`,
    `${indent}    <audio>`,
    `${indent}      <channelcount>2</channelcount>`,
    `${indent}    </audio>`,
    `${indent}  </media>`,
    `${indent}</file>`
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

function clipitemXml(
  placed: Placed,
  source: PremiereSource,
  id: string,
  fileId: string,
  name: string,
  first: boolean,
  audio: boolean,
  indent: string
): string {
  const fps = source.fps
  const inF = frames(placed.sourceInSec, fps)
  const outF = frames(placed.sourceOutSec, fps)
  const startF = frames(placed.timelineInSec, fps)
  const endF = startF + (outF - inF)

  return [
    `${indent}<clipitem id="${id}">`,
    `${indent}  <name>${escapeXml(name)}</name>`,
    `${indent}  <enabled>TRUE</enabled>`,
    `${indent}  <duration>${frames(source.durationSec, fps)}</duration>`,
    rateXml(fps, `${indent}  `),
    `${indent}  <start>${startF}</start>`,
    `${indent}  <end>${endF}</end>`,
    `${indent}  <in>${inF}</in>`,
    `${indent}  <out>${outF}</out>`,
    // The file body is written once; later references point at the same id.
    fileXml(source, fileId, first, `${indent}  `),
    audio
      ? [
          `${indent}  <sourcetrack>`,
          `${indent}    <mediatype>audio</mediatype>`,
          `${indent}    <trackindex>1</trackindex>`,
          `${indent}  </sourcetrack>`
        ].join('\n')
      : `${indent}  <sourcetrack><mediatype>video</mediatype></sourcetrack>`,
    `${indent}</clipitem>`
  ].join('\n')
}

export function buildSequence(
  clip: PremiereClip,
  source: PremiereSource,
  index: number
): string {
  const placed = placeSegments(clip)
  const total = placed.reduce((sum, p) => sum + (p.sourceOutSec - p.sourceInSec), 0)
  const fileId = `file-${index}`

  const video = placed.map((p, i) =>
    clipitemXml(p, source, `cv-${index}-${i}`, fileId, clip.title, i === 0, false, '            ')
  )
  const audio = placed.map((p, i) =>
    clipitemXml(p, source, `ca-${index}-${i}`, fileId, clip.title, false, true, '            ')
  )

  return [
    `    <sequence id="seq-${index}">`,
    `      <name>${escapeXml(clip.title)}</name>`,
    `      <duration>${frames(total, source.fps)}</duration>`,
    rateXml(source.fps, '      '),
    `      <media>`,
    `        <video>`,
    `          <format>`,
    `            <samplecharacteristics>`,
    rateXml(source.fps, '              '),
    `              <width>${source.width}</width>`,
    `              <height>${source.height}</height>`,
    `            </samplecharacteristics>`,
    `          </format>`,
    `          <track>`,
    ...video,
    `          </track>`,
    `        </video>`,
    `        <audio>`,
    `          <track>`,
    ...audio,
    `          </track>`,
    `        </audio>`,
    `      </media>`,
    `    </sequence>`
  ].join('\n')
}

/** Markers on a master sequence, one per suggestion, for working in place. */
export function buildMasterSequence(
  clips: SuggestedClip[],
  source: PremiereSource
): string {
  const markers = clips.map((c) =>
    [
      `      <marker>`,
      `        <name>${escapeXml(c.title)}</name>`,
      `        <comment>${escapeXml(`${c.score} · ${c.reason}`)}</comment>`,
      `        <in>${frames(c.startSec, source.fps)}</in>`,
      `        <out>${frames(c.endSec, source.fps)}</out>`,
      `      </marker>`
    ].join('\n')
  )

  const whole: Placed = {
    sourceInSec: 0,
    sourceOutSec: source.durationSec,
    timelineInSec: 0
  }

  return [
    `    <sequence id="seq-master">`,
    `      <name>${escapeXml(basename(source.path))} · suggestions</name>`,
    `      <duration>${frames(source.durationSec, source.fps)}</duration>`,
    rateXml(source.fps, '      '),
    `      <media>`,
    `        <video>`,
    `          <format>`,
    `            <samplecharacteristics>`,
    rateXml(source.fps, '              '),
    `              <width>${source.width}</width>`,
    `              <height>${source.height}</height>`,
    `            </samplecharacteristics>`,
    `          </format>`,
    `          <track>`,
    clipitemXml(whole, source, 'cv-master', 'file-master', 'source', true, false, '            '),
    `          </track>`,
    `        </video>`,
    `        <audio>`,
    `          <track>`,
    clipitemXml(whole, source, 'ca-master', 'file-master', 'source', false, true, '            '),
    `          </track>`,
    `        </audio>`,
    `      </media>`,
    ...markers,
    `    </sequence>`
  ].join('\n')
}

export function buildProject(
  clips: PremiereClip[],
  suggestions: SuggestedClip[],
  source: PremiereSource
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="4">',
    '  <project>',
    `    <name>${escapeXml(basename(source.path))} · Chop Shop</name>`,
    '    <children>',
    buildMasterSequence(suggestions, source),
    ...clips.map((c, i) => buildSequence(c, source, i)),
    '    </children>',
    '  </project>',
    '</xmeml>'
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
