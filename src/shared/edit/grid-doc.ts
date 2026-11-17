import { addAsset, commit, createDoc, currentCut } from './doc'
import { gridHeard, type Grid, type GridPanel } from './grid'
import type { Asset, EditDoc, Op } from './schema'

/**
 * Grids in words: an edit made of several finished videos playing at once,
 * from files dropped in ("put these four in a grid with labels", /grid), and
 * /grid on an edit already open: a grid on the beat under the playhead, its
 * labels and its sound changed, or taken off.
 */

/** A file to show in a grid, as probing it found it. */
export interface GridFile {
  path: string
  durationSec: number
  width: number
  height: number
  fps: number
  /** A picture rather than footage. */
  still: boolean
  /** Has a sound of its own. */
  sound: boolean
  color?: 'sdr' | 'hlg' | 'pq'
}

/** A label from a file's name: "Talking head v3.mp4" is "Talking head", "faceless_doc-final" is "Faceless doc". */
export function labelFor(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, '')
  const words = name
    .replace(/[_-]+/g, ' ')
    .replace(/\b(?:v\d+|final|export|edit|copy|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{2})\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const text = words || name
  return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 40)
}

/** "a", "a and b", "a, b and c". */
const listOf = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

const NUMBERS = ['no', 'one', 'two', 'three', 'four']

/**
 * An edit that is several videos at once. The longest video is the recording
 * the edit plays, one beat over the whole of it, so no panel is cut short;
 * every other file is material shown in its own panel, in the order the
 * files came. Labels are the ones given, else the files' names. The sound is
 * the panel asked for, the first by default, or none.
 */
export function gridDoc(input: {
  id: string
  files: GridFile[]
  labels?: string[]
  sound?: number | 'none'
  at?: string
}): EditDoc {
  const files = input.files.slice(0, 4)
  if (files.length < 2) throw new Error('A grid needs two to four videos.')
  const videos = files.map((f, i) => ({ f, i })).filter(({ f }) => !f.still)
  if (videos.length === 0) throw new Error('A grid needs at least one video to play.')
  const main = videos.reduce((a, b) => (b.f.durationSec > a.f.durationSec + 0.01 ? b : a))
  const m = main.f
  let doc = createDoc({
    id: input.id,
    title: '',
    source: {
      id: 's1',
      path: m.path,
      durationSec: m.durationSec,
      width: m.width,
      height: m.height,
      fps: m.fps > 0 ? m.fps : 30,
      ...(m.color && m.color !== 'sdr' ? { color: m.color } : {})
    },
    words: [],
    at: input.at
  })
  const shown: string[] = []
  for (const [i, f] of files.entries()) {
    if (i === main.i) {
      shown.push('')
      continue
    }
    const added = addAsset(doc, {
      kind: f.still ? 'image' : 'video',
      path: f.path,
      title: labelFor(f.path),
      durationSec: f.still ? null : f.durationSec,
      width: f.width,
      height: f.height,
      origin: { type: 'file', url: null, author: null, license: null, range: null }
    })
    doc = added.doc
    shown.push(added.asset.id)
  }
  const labels = files.map((f, i) => (input.labels?.[i] ?? labelFor(f.path)).trim().slice(0, 40))
  const asked = input.sound ?? 0
  const sound: Grid['sound'] = asked === 'none' ? 'none' : asked === main.i ? 'own' : Math.min(files.length - 1, asked)
  const grid: Grid = { panels: shown.map((show, i): GridPanel => ({ show, label: labels[i] })), sound }
  const tall = files.every((f) => f.height > f.width)
  const said = labels.filter(Boolean)
  const ops: Op[] = [
    { op: 'aspect', aspect: tall ? 'vertical' : 'wide' },
    { op: 'captions', set: { on: false } },
    { op: 'treat', beats: [currentCut(doc).beats[0].id], set: { grid } }
  ]
  const summary = `${NUMBERS[files.length] ?? files.length} videos play at once in a grid${said.length ? `, labelled ${listOf(said)}` : ''}.`
  const made = commit(doc, ops, summary.charAt(0).toUpperCase() + summary.slice(1))
  if (made.rejected.length) throw new Error(made.rejected[0].reason)
  // The grid is what this edit is from the start: one version, v1, rather than the longest file on its own first.
  const first = { ...made.doc.versions[made.doc.versions.length - 1], n: 1 }
  return {
    ...made.doc,
    title: said.length ? `Grid: ${listOf(said)}`.slice(0, 80) : `Grid of ${files.length}`,
    versions: [first]
  }
}

/** What /grid is asked to do with the words after it. */
export type GridAsk =
  | { off: true }
  | { sound: number | 'none' }
  | { labels: string[] }
  | { noLabels: true }
  | { make: string[] }

const ORDINALS: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, one: 0, two: 1, three: 2, four: 3 }

/** The words after /grid: "off", "sound from the second", "music", "no labels", or labels in order. */
export function readGridAsk(rest: string): GridAsk {
  const t = rest.trim()
  if (/^(?:off|none|remove|undo)$/i.test(t)) return { off: true }
  if (/^(?:no labels?|without labels?|labels? off)$/i.test(t)) return { noLabels: true }
  if (/^(?:music|music only|no sound|silent|mute)$/i.test(t)) return { sound: 'none' }
  const sound = /^(?:sound|audio)\s+(?:from\s+)?(?:the\s+)?(?:panel\s+)?(\d|first|second|third|fourth|one|two|three|four)\b/i.exec(t)
  if (sound) {
    const n = /\d/.test(sound[1]) ? Number(sound[1]) - 1 : ORDINALS[sound[1].toLowerCase()]
    return { sound: Math.max(0, Math.min(3, n)) }
  }
  const labels = t
    .split(/\s*[,;|]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
  return labels.length ? { labels } : { make: [] }
}

/**
 * /grid on an edit already open, as ops on the beat under the playhead: on a
 * beat that is a grid, its labels or its sound change, or it comes off; on
 * any other, a grid of the beat's own picture and the newest footage brought
 * in, up to four, labelled with what was said or with their names.
 */
export function gridOps(doc: EditDoc, beatId: string | null, rest: string): { ops: Op[]; summary: string } | { problem: string } {
  const cut = currentCut(doc)
  const beat = cut.beats.find((b) => b.id === beatId) ?? cut.beats[0]
  if (!beat) return { problem: 'There is no beat to put a grid on.' }
  const ask = readGridAsk(rest)
  const grid = beat.treatment.grid
  if (grid) {
    if ('off' in ask) return { ops: [{ op: 'treat', beats: [beat.id], set: { grid: null } }], summary: 'The grid is gone.' }
    if ('sound' in ask) {
      const sound = ask.sound
      const next: Grid = { ...grid, sound }
      const heard = gridHeard(next)
      const said =
        heard === 'none'
          ? 'The grid plays with no sound but the music.'
          : `The sound is from ${grid.panels[heard === 'own' ? grid.panels.findIndex((p) => !p.show.trim()) : heard]?.label.trim() || 'that panel'} now.`
      return { ops: [{ op: 'treat', beats: [beat.id], set: { grid: next } }], summary: said }
    }
    const labels = 'noLabels' in ask ? grid.panels.map(() => '') : 'labels' in ask ? ask.labels : null
    if (!labels) return { problem: 'This is a grid already. Give me its labels, like /grid Talking head, Map.' }
    const next: Grid = { ...grid, panels: grid.panels.map((p, i) => ({ ...p, label: (labels[i] ?? p.label).slice(0, 40) })) }
    return {
      ops: [{ op: 'treat', beats: [beat.id], set: { grid: next } }],
      summary: 'noLabels' in ask ? 'The grid has no labels now.' : `The grid is labelled ${listOf(labels.slice(0, 4))}.`
    }
  }
  if ('off' in ask) return { problem: 'There is no grid here to take off.' }
  // The newest footage brought in, then the beat's own picture first among them.
  const footage = doc.assets.filter((a: Asset) => a.kind === 'video').slice(-3)
  if (footage.length === 0)
    return { problem: 'Bring in the videos to put in the grid first: drop them here, then /grid.' }
  // Labels as given, the names of what is shown when none are, or none at all when asked for none.
  const given = 'labels' in ask ? ask.labels : []
  const named = (label: string): string => ('noLabels' in ask ? '' : label.slice(0, 40))
  const source = doc.sources.find((s) => s.id === beat.source)
  const panels: GridPanel[] = [
    { show: '', label: named(given[0] ?? labelFor(source?.path ?? 'This video')) },
    ...footage.map((a, i) => ({ show: a.id, label: named(given[i + 1] ?? labelFor(a.title || a.path)) }))
  ]
  const labels = panels.map((p) => p.label).filter(Boolean)
  return {
    ops: [{ op: 'treat', beats: [beat.id], set: { grid: { panels } } }],
    summary: `This part plays as a grid of ${NUMBERS[panels.length] ?? panels.length}, ${labels.length ? `labelled ${listOf(labels)}` : 'with no labels'}.`
  }
}
