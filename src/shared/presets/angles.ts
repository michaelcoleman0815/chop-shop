import { currentCut } from '../edit/doc'
import type { EditDoc, Op, Source } from '../edit/schema'
import { LAYOUT_INFO, type Angle, type AngleLayout } from '../edit/angles'

/**
 * The /angle command: another camera of the same take. On its own it lines
 * one up (the app asks for the file and listens for the offset) or shows the
 * one there is on the beat under the playhead; "pip" and "side" put it in a
 * box over the picture or beside it; "off" shows the recording again; "sync"
 * moves the camera by seconds or frames when the ear got it wrong. Read here,
 * apart from the app, so every phrasing is tested.
 */

export type AngleCommandResult =
  | { ops: Op[]; say?: string }
  | { say: string }
  /** A camera file to choose and line up with this recording, then show on these beats in this layout. */
  | { file: { of: string; beats: string[]; layout: AngleLayout } }

/** An offset between cameras, to the hundredth: a frame is 0.03 s, so 1.35 s says more than 1.4 s. */
export function syncSeconds(sec: number): string {
  return `${Number(Math.abs(sec).toFixed(2))} s`
}

/** What /angle can do, for /angle help. */
export function angleHelp(): string {
  return (
    'Another camera of the same take. /angle lines one up and shows it on the beat under the playhead, ' +
    '/angle pip puts it in a box over you, /angle side beside you, /angle off shows your recording again, ' +
    'and /angle sync +2f or /angle sync -0.1 moves it when it is out of step.'
  )
}

/**
 * A camera by how the person names it: "2" is the first camera after the
 * recording, "s3" by its id, "pov-3" or "teo" by a word of its file's name
 * that only it has.
 */
function pick(cameras: Angle[], word: string | undefined, sources: Source[] = []): Angle | null {
  if (!word) return cameras[0] ?? null
  const byId = cameras.find((c) => c.source === word)
  if (byId) return byId
  const n = Number(word)
  if (Number.isInteger(n)) return n >= 2 ? (cameras[n - 2] ?? null) : null
  const named = cameras.filter((c) => {
    const path = sources.find((s) => s.id === c.source)?.path ?? ''
    return word.length >= 2 && path.replace(/^.*[\\/]/, '').toLowerCase().includes(word.toLowerCase())
  })
  return named.length === 1 ? named[0] : null
}

/**
 * Reads /angle. `beat` is the beat under the playhead in the editor; in the
 * thread there is none, and the command acts on every beat of the recording.
 */
export function angleCommand(doc: EditDoc, rest: string, beat: string | null): AngleCommandResult {
  const cut = currentCut(doc)
  if (cut.beats.length === 0) return { say: 'There is nothing in the cut to show another camera on.' }
  const here = cut.beats.find((b) => b.id === beat) ?? null
  const recording = here?.source ?? cut.beats[0].source
  const targets = here ? [here.id] : cut.beats.filter((b) => b.source === recording).map((b) => b.id)
  const cameras = (cut.angles ?? []).filter((a) => a.of === recording)
  const words = rest.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const name = (a: Angle): string => `camera ${cameras.indexOf(a) + 2}`

  if (words[0] === 'help') return { say: angleHelp() }

  if (words[0] === 'sync') {
    const camera = pick(cameras, words[2] ? words[1] : undefined, doc.sources)
    if (!camera) return { say: 'There is no other camera to move yet. /angle lines one up.' }
    const amount = /^([+-]?)(\d+(?:\.\d+)?)(f|s)?$/.exec(words[words.length - 1] ?? '')
    if (!amount)
      return {
        say: 'Say how far: /angle sync +2f moves it two frames later, /angle sync -0.1 a tenth of a second earlier.'
      }
    const fps = doc.sources.find((s) => s.id === camera.source)?.fps ?? 30
    const size = Number(amount[2]) / (amount[3] === 'f' ? fps : 1)
    // A signed amount moves it; a bare one sets it.
    const offsetSec = amount[1] ? camera.offsetSec + (amount[1] === '-' ? -size : size) : size
    const moved = Math.round(offsetSec * 1e6) / 1e6
    return {
      ops: [{ op: 'sync', source: camera.source, of: recording, offsetSec: moved }],
      say: `C${name(camera).slice(1)} is ${syncSeconds(moved)} ${moved >= 0 ? 'ahead of' : 'behind'} the recording now.`
    }
  }

  if (words[0] === 'off') {
    const showing = targets.filter((id) => cut.beats.find((b) => b.id === id)?.treatment.angle)
    if (showing.length === 0)
      return { say: here ? 'This beat already shows your recording.' : 'No beat shows another camera.' }
    return { ops: [{ op: 'angle', beats: showing, source: null }] }
  }

  if (words[0] === 'remove') {
    const camera = pick(cameras, words[1], doc.sources)
    if (!camera) return { say: 'There is no other camera to take out.' }
    return { ops: [{ op: 'sync', source: camera.source, of: null }] }
  }

  const layouts: Record<string, AngleLayout> = { full: 'full', pip: 'pip', box: 'pip', side: 'side', beside: 'side' }
  const layoutWord = words.find((w) => w in layouts)
  const layout = layoutWord ? layouts[layoutWord] : (here?.treatment.angle?.layout ?? 'full')
  const cameraWord = words.find((w) => !(w in layouts))
  if (cameraWord && cameraWord !== 'new' && !pick(cameras, cameraWord, doc.sources)) {
    return {
      say: `There is no ${/^\d+$/.test(cameraWord) ? `camera ${cameraWord}` : cameraWord}. ${cameras.length ? `This recording has ${cameras.length + 1} cameras.` : '/angle lines one up.'}`
    }
  }
  // No camera yet, or a new one asked for: the app asks for the file and lines it up first.
  if (cameras.length === 0 || cameraWord === 'new') return { file: { of: recording, beats: targets, layout } }
  const camera = pick(cameras, cameraWord, doc.sources) as Angle
  const already = targets.every((id) => {
    const a = cut.beats.find((b) => b.id === id)?.treatment.angle
    return a?.source === camera.source && a.layout === layout
  })
  if (already) {
    return {
      say: `${here ? 'This beat already shows' : 'Every beat already shows'} ${name(camera)}${layout === 'full' ? '' : ` ${LAYOUT_INFO[layout].label}`}.`
    }
  }
  return { ops: [{ op: 'angle', beats: targets, source: camera.source, layout }] }
}
