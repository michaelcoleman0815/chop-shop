import { childOf, childrenOf, decodeXml, descendantsOf, encodeXml, numberOf, parseXml, pathOf, textOf, type XmlNode } from './xml'

/**
 * A Premiere sequence as Premiere exports it (File > Export > Final Cut Pro
 * XML, the xmeml dialect): what plays where, read so Cutalong can show it and
 * add to it without moving anything Premiere placed.
 */

export interface XmemlFile {
  id: string
  name: string
  /** The file on this computer, or null when Premiere had it offline. */
  path: string | null
  durationFrames: number | null
  video: { width: number; height: number } | null
  audioChannels: number
}

export interface XmemlClip {
  id: string
  name: string
  /** A clip of a file, or something Premiere makes itself, like a title or a colour matte. */
  kind: 'clipitem' | 'generatoritem'
  enabled: boolean
  /** On the sequence's clock, in frames: the whole of it, transitions included. */
  start: number
  end: number
  /** Where it reads its file from, in frames. */
  in: number
  out: number
  /** Where it is the one seen or heard: start to end, less any transition's other half. */
  shownStart: number
  shownEnd: number
  /** The file, or null for a title, a matte or a nested sequence. */
  file: XmemlFile | null
  /** For sound: which of the file's channels it plays, from 1. */
  channel: number | null
  /**
   * Its Basic Motion, when Premiere wrote one: scale in percent of the
   * picture's own size, and where its centre is moved to, in fractions of the
   * frame's width on both axes (a real export's values come out as whole
   * pixels that way), right and down. Null is 100% in the middle.
   */
  motion: { scale: number; centerX: number; centerY: number } | null
}

export interface XmemlTrack {
  enabled: boolean
  clips: XmemlClip[]
}

export interface XmemlMarker {
  name: string
  comment: string
  in: number
  out: number
}

export interface XmemlSequence {
  name: string
  uuid: string | null
  timebase: number
  ntsc: boolean
  /** Frames a second: 29.97 for timebase 30 with ntsc. */
  fps: number
  width: number
  height: number
  durationFrames: number
  video: XmemlTrack[]
  audio: XmemlTrack[]
  markers: XmemlMarker[]
  /** Where its parts sit in the text, to write into it (addToXmeml). */
  at: {
    sequence: XmlNode
    name: XmlNode | null
    uuid: XmlNode | null
    video: XmlNode | null
    audio: XmlNode | null
  }
}

/**
 * The local path a pathurl names: file://localhost/Users/me/a%20b.mov is
 * /Users/me/a b.mov, file://localhost/C%3a/Clips/a.mov is C:\Clips\a.mov,
 * and file://server/share/a.mov is \\server\share\a.mov.
 */
export function pathFromUrl(url: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(url.trim())
  if (!m) return null
  const host = m[1].toLowerCase()
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  const path = (m[2] ?? '/').split('/').map(decode).join('/')
  // A drive, after which the slashes lean either way: Premiere encodes forward ones, other tools backslashes.
  if (/^\/[A-Za-z]:([\\/]|$)/.test(path)) return path.slice(1).replace(/\//g, '\\')
  if (host && host !== 'localhost') return `\\\\${host}${path.replace(/\//g, '\\')}`
  return path
}

/** A rate's frames a second, as xmeml writes it: timebase 30 with ntsc TRUE is 29.97. */
const fpsOf = (timebase: number, ntsc: boolean): number => (ntsc ? (timebase * 1000) / 1001 : timebase)

const isTrue = (t: string | null): boolean => (t ?? '').toUpperCase() === 'TRUE'

/**
 * The sequence in an xmeml file: the one at its top, as a sequence exported
 * on its own is, or else the longest one in a project export. Null when
 * there is none.
 */
export function parseXmeml(text: string): XmemlSequence | null {
  const doc = parseXml(text)
  const root = childOf(doc, 'xmeml')
  if (!root) return null
  const top = childOf(root, 'sequence')
  const sequence =
    top ??
    descendantsOf(root, 'sequence')
      .filter((s) => childOf(s, 'media'))
      .sort((a, b) => numberOf(b, 'duration', 0) - numberOf(a, 'duration', 0))[0]
  if (!sequence) return null

  // Every file, by id: a file is written in full once and named by its id after that.
  const files = new Map<string, XmemlFile>()
  for (const f of descendantsOf(doc, 'file')) {
    const id = f.attrs.id
    if (!id || files.has(id) || f.children.length === 0) continue
    const url = textOf(f, 'pathurl')
    const video = pathOf(f, 'media', 'video', 'samplecharacteristics')
    files.set(id, {
      id,
      name: textOf(f, 'name') ?? '',
      path: url ? pathFromUrl(decodeXml(url)) : null,
      durationFrames: childOf(f, 'duration') ? numberOf(f, 'duration', 0) : null,
      video: pathOf(f, 'media', 'video')
        ? { width: numberOf(video, 'width', 0), height: numberOf(video, 'height', 0) }
        : null,
      audioChannels: pathOf(f, 'media', 'audio')
        ? numberOf(pathOf(f, 'media', 'audio'), 'channelcount', childrenOf(pathOf(f, 'media'), 'audio').length || 2)
        : 0
    })
  }

  const rate = childOf(sequence, 'rate')
  const timebase = numberOf(rate, 'timebase', 30)
  const ntsc = isTrue(textOf(rate, 'ntsc'))
  const media = childOf(sequence, 'media')
  const videoEl = childOf(media, 'video')
  const audioEl = childOf(media, 'audio')
  const format = pathOf(videoEl, 'format', 'samplecharacteristics')

  const tracksOf = (el: XmlNode | null): XmemlTrack[] =>
    childrenOf(el, 'track').map((track) => {
      const items = track.children.filter((c) => c.name === 'clipitem' || c.name === 'generatoritem' || c.name === 'transitionitem')
      const clips: XmemlClip[] = []
      items.forEach((item, i) => {
        if (item.name === 'transitionitem') return
        const prev = items[i - 1]?.name === 'transitionitem' ? items[i - 1] : null
        const next = items[i + 1]?.name === 'transitionitem' ? items[i + 1] : null
        const inF = numberOf(item, 'in', 0)
        const outF = numberOf(item, 'out', inF)
        let start = numberOf(item, 'start', -1)
        let end = numberOf(item, 'end', -1)
        // A clip in a transition has -1 there: the transition says where it begins or ends.
        if (start < 0 && prev) start = numberOf(prev, 'start', -1)
        if (end < 0 && next) end = numberOf(next, 'end', -1)
        if (start < 0 && end >= 0) start = end - (outF - inF)
        if (end < 0 && start >= 0) end = start + (outF - inF)
        // Seen until the cut inside a transition: its middle, or the edge it is aligned to.
        const cutIn = (t: XmlNode): number => {
          const a = numberOf(t, 'start', start)
          const b = numberOf(t, 'end', end)
          const align = (textOf(t, 'alignment') ?? 'center').toLowerCase()
          return align.startsWith('start') ? a : align.startsWith('end') ? b : Math.round((a + b) / 2)
        }
        const fileEl = childOf(item, 'file')
        const nested = childOf(item, 'sequence') !== null
        const file = !nested && fileEl ? (files.get(fileEl.attrs.id) ?? null) : null
        const source = childOf(item, 'sourcetrack')
        clips.push({
          id: item.attrs.id ?? '',
          name: textOf(item, 'name') ?? file?.name ?? '',
          kind: item.name === 'generatoritem' ? 'generatoritem' : 'clipitem',
          enabled: textOf(item, 'enabled') === null || isTrue(textOf(item, 'enabled')),
          start,
          end,
          in: inF,
          out: outF,
          shownStart: numberOf(item, 'start', -1) < 0 && prev ? Math.max(start, cutIn(prev)) : start,
          shownEnd: numberOf(item, 'end', -1) < 0 && next ? Math.min(end, cutIn(next)) : end,
          file,
          channel: source ? numberOf(source, 'trackindex', 1) : null,
          motion: basicMotion(item)
        })
      })
      return { enabled: textOf(track, 'enabled') === null || isTrue(textOf(track, 'enabled')), clips }
    })

  return {
    name: textOf(sequence, 'name') ?? 'Sequence',
    uuid: textOf(sequence, 'uuid'),
    timebase,
    ntsc,
    fps: fpsOf(timebase, ntsc),
    width: numberOf(format, 'width', 1920),
    height: numberOf(format, 'height', 1080),
    durationFrames: numberOf(sequence, 'duration', 0),
    video: tracksOf(videoEl),
    audio: tracksOf(audioEl),
    markers: childrenOf(sequence, 'marker').map((m) => ({
      name: textOf(m, 'name') ?? '',
      comment: textOf(m, 'comment') ?? '',
      in: numberOf(m, 'in', 0),
      out: numberOf(m, 'out', -1)
    })),
    at: {
      sequence,
      name: childOf(sequence, 'name'),
      uuid: childOf(sequence, 'uuid'),
      video: videoEl,
      audio: audioEl
    }
  }
}

/**
 * A clip's Basic Motion: its scale and centre, from the first keyframe when
 * they move. Rotation and the anchor are left out: a preview does not need them.
 */
function basicMotion(item: XmlNode): XmemlClip['motion'] {
  for (const filter of childrenOf(item, 'filter')) {
    const effect = childOf(filter, 'effect')
    if (textOf(effect, 'effectid') !== 'basic' || textOf(filter, 'enabled') === 'FALSE') continue
    const param = (id: string): XmlNode | null => {
      const p = childrenOf(effect, 'parameter').find((x) => textOf(x, 'parameterid') === id) ?? null
      return childOf(p, 'value') ?? childOf(childOf(p, 'keyframe'), 'value')
    }
    const scale = param('scale')
    const center = param('center')
    const percent = scale ? Number(scale.text.trim()) : 100
    return {
      scale: Number.isFinite(percent) && percent > 0 ? percent : 100,
      centerX: numberOf(center, 'horiz', 0),
      centerY: numberOf(center, 'vert', 0)
    }
  }
  return null
}

/** Every file the sequence plays, once each, in the order it first plays them. */
export function sequenceFiles(seq: XmemlSequence): XmemlFile[] {
  const seen = new Map<string, XmemlFile>()
  for (const track of [...seq.video, ...seq.audio])
    for (const c of track.clips) if (c.file && !seen.has(c.file.id)) seen.set(c.file.id, c.file)
  return [...seen.values()]
}

/** What is added to a sequence: tracks and markers, each already written as xmeml. */
export interface XmemlAdditions {
  video: string[]
  audio: string[]
  markers: string[]
  /** The sequence's new name, and a new uuid so it imports beside the one it came from. */
  name?: string
  uuid?: string
}

/**
 * The xmeml with the additions written into its sequence: the tracks after
 * its own, the markers at its end, and its name and uuid, when given,
 * changed. Everything else is the text as it was.
 */
export function addToXmeml(text: string, seq: XmemlSequence, add: XmemlAdditions): string {
  const edits: { at: number; to: number; text: string }[] = []
  const indentBefore = (pos: number): string => {
    const line = text.lastIndexOf('\n', pos - 1)
    return /^[\t ]*/.exec(text.slice(line + 1, pos))?.[0] ?? ''
  }
  const insertBeforeClose = (el: XmlNode | null, items: string[], what: string): void => {
    if (items.length === 0) return
    if (!el || el.innerEnd === el.end) throw new Error(`The sequence has no ${what} to add to.`)
    // Indented one step in from the element's own end tag, as Premiere indents.
    const pad = indentBefore(el.innerEnd)
    const body = items.map((s) => s.replace(/^/gm, `${pad}\t`)).join('\n')
    const atLineStart = text.lastIndexOf('\n', el.innerEnd - 1)
    const lineStart = atLineStart + 1
    const onOwnLine = /^[\t ]*$/.test(text.slice(lineStart, el.innerEnd))
    edits.push(
      onOwnLine
        ? { at: lineStart, to: lineStart, text: `${body}\n` }
        : { at: el.innerEnd, to: el.innerEnd, text: `\n${body}\n${pad}` }
    )
  }
  insertBeforeClose(seq.at.video, add.video, 'picture')
  insertBeforeClose(seq.at.audio, add.audio, 'sound')
  insertBeforeClose(seq.at.sequence, add.markers, 'sequence')
  if (add.name !== undefined && seq.at.name) {
    edits.push({ at: seq.at.name.innerStart, to: seq.at.name.innerEnd, text: encodeXml(add.name) })
  }
  if (add.uuid !== undefined && seq.at.uuid) {
    edits.push({ at: seq.at.uuid.innerStart, to: seq.at.uuid.innerEnd, text: encodeXml(add.uuid) })
  }
  // From the end back, so each offset is still where it was read.
  let out = text
  for (const e of edits.sort((a, b) => b.at - a.at || b.to - a.to)) out = out.slice(0, e.at) + e.text + out.slice(e.to)
  return out
}
