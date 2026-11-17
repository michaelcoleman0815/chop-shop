import { indexWords, type WordIndex } from '../edit/resolve'
import {
  DEFAULT_PAD_IN,
  DEFAULT_PAD_OUT,
  type Beat,
  type Cut,
  type Op,
  type Treatment,
  type Word
} from '../edit/schema'
import type { Sfx } from '../edit/sfx'
import { TRANSITION_INFO } from '../edit/transitions'
import { graphicName } from '../motion/describe'
import { parseAnchor, parseLength, type MotionItem } from '../motion/schema'

/**
 * What was done to a vlog's beats, kept when its story is told again. The
 * story puts new beats in place of the old ones, so each old beat's edits
 * (how it comes in, a J or L cut, its speed, a camera move, its sounds, its
 * padding, how it looks) go to the new beat that plays the same moment: the
 * same clip, over a stretch that overlaps; so do captions turned off over it.
 * Chapters and graphics on a beat go
 * to the beat that plays their moment now. What has no moment in the new
 * story, or no longer fits where its moment plays, is taken out rather than
 * left on a beat that plays another moment, and `leftOut` says what.
 */

/** A stretch of a clip a beat plays, in the clip's seconds. */
interface Span {
  source: string
  a: number
  b: number
}

function spanOf(beat: Beat, words: Map<string, Word>): Span | null {
  if (beat.from !== null && beat.to !== null) {
    const first = words.get(beat.from)
    const last = words.get(beat.to)
    return first && last ? { source: beat.source, a: first.startSec, b: Math.max(first.startSec, last.endSec) } : null
  }
  return beat.inSec !== null && beat.outSec !== null ? { source: beat.source, a: beat.inSec, b: beat.outSec } : null
}

/**
 * Each beat of `before` with the beat of `after` that plays most of its
 * moment, when one plays any of it; of two that play as much, the one nearer
 * its place in the cut, so a tease keeps its edits off the payoff it is from.
 */
export function sameMoments(before: Beat[], after: Beat[], words: Word[]): Map<string, Beat> {
  const byId = new Map(words.map((w) => [w.id, w]))
  const spans = after.map((beat, at) => ({ beat, at, span: spanOf(beat, byId) }))
  const out = new Map<string, Beat>()
  before.forEach((old, at) => {
    const s = spanOf(old, byId)
    if (!s) return
    let best: { beat: Beat; d: number; far: number } | null = null
    for (const n of spans) {
      if (!n.span || n.span.source !== s.source) continue
      const d = Math.min(s.b, n.span.b) - Math.max(s.a, n.span.a)
      const far = Math.abs(n.at - at)
      if (d > 0.01 && (!best || d > best.d + 1e-6 || (Math.abs(d - best.d) <= 1e-6 && far < best.far)))
        best = { beat: n.beat, d, far }
    }
    if (best) out.set(old.id, best.beat)
  })
  return out
}

/** Whether a word is one a beat plays. */
function holds(beat: Beat, word: string, index: WordIndex): boolean {
  if (beat.from === null || beat.to === null) return false
  const p = index.pos.get(word)
  const a = index.pos.get(beat.from)
  const b = index.pos.get(beat.to)
  return p !== undefined && a !== undefined && b !== undefined && p >= a && p <= b
}

/** A thing done to a beat, as the reply names it: "the dissolve", and "2 dissolves". */
export interface Named {
  one: string
  many: (n: number) => string
}

const named = (one: string, many: string): Named => ({ one, many: (n) => `${n} ${many}` })

/** A transition's name for more than one: "dissolves", "dips to black", "circles closing", "white flashes". */
function pluralOf(noun: string): string {
  const words = noun.split(' ')
  const to = words.indexOf('to')
  const head = to > 0 ? to - 1 : words[words.length - 1].endsWith('ing') ? 0 : words.length - 1
  const word = words[head]
  if (!word.endsWith('s')) words[head] = /(sh|ch|x|z)$/.test(word) ? `${word}es` : `${word}s`
  return words.join(' ')
}

/** How a beat looks, in the parts a person changes one at a time, each with the word it lands on when it has one. */
interface Look {
  name: Named
  keys: (keyof Treatment)[]
  word?: string
}

function looksOf(t: Treatment): Look[] {
  const looks: Look[] = []
  if (t.broll)
    looks.push({ name: named('the cutaway', 'cutaways'), keys: ['frame', 'broll'], word: t.broll.camera?.word })
  else if (t.frame !== 'speaker') looks.push({ name: named('the card', 'cards'), keys: ['frame'] })
  if (t.bw) looks.push({ name: named('the black and white', 'black and white shots'), keys: ['bw'] })
  if (t.zoom !== 1) looks.push({ name: named('the punch-in', 'punch-ins'), keys: ['zoom'] })
  if (t.bigWord) looks.push({ name: named('the big word', 'big words'), keys: ['bigWord'], word: t.bigWord })
  if ((t.speed !== undefined && t.speed !== 1) || t.ramp)
    looks.push({ name: named('the speed change', 'speed changes'), keys: ['speed', 'ramp'] })
  if (t.freeze) looks.push({ name: named('the freeze frame', 'freeze frames'), keys: ['freeze'], word: t.freeze.word })
  if (t.reverse) looks.push({ name: named('the reverse', 'reverses'), keys: ['reverse'] })
  if (t.camera) looks.push({ name: named('the camera move', 'camera moves'), keys: ['camera'], word: t.camera.word })
  if (t.angle) looks.push({ name: named('the other camera', 'other cameras'), keys: ['angle'] })
  if (t.framing !== undefined && t.framing !== null)
    looks.push({ name: named('the framing', 'framings'), keys: ['framing'] })
  if (t.captions === false)
    looks.push({ name: named('the stretch without captions', 'stretches without captions'), keys: ['captions'] })
  return looks
}

/** The room a new beat of this kind gets: words keep a little either side, a stretch of a shot none. */
const roomIn = (b: Beat): number => (b.from !== null ? DEFAULT_PAD_IN : 0)
const roomOut = (b: Beat): number => (b.from !== null ? DEFAULT_PAD_OUT : 0)

/** Equal as data, whatever order the keys came in. */
function same(x: unknown, y: unknown): boolean {
  if (x === y) return true
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false
  if (Array.isArray(x) !== Array.isArray(y)) return false
  const a = x as Record<string, unknown>
  const b = y as Record<string, unknown>
  const keys = (o: Record<string, unknown>): string[] => Object.keys(o).filter((k) => o[k] !== undefined)
  return keys(a).length === keys(b).length && keys(a).every((k) => same(a[k], b[k]))
}

const sameSound = (x: Sfx, y: Sfx): boolean => x.word === y.word && (x.kind ?? x.path) === (y.kind ?? y.path)

/** The edits of one beat put on the new beat that plays its moment, with those of any other old beat it plays too. */
function beatOps(target: Beat, olds: Beat[], index: WordIndex, struck: Set<string>): Op[] {
  const ops: Op[] = []
  const first = olds[0]
  const last = olds[olds.length - 1]
  // How it comes in belongs to the start of the moment.
  if (first.transition)
    ops.push({ op: 'transition', beats: [target.id], kind: first.transition.kind, sec: first.transition.sec })
  else if (first.splitEdit)
    ops.push({ op: first.splitEdit.kind === 'j' ? 'jcut' : 'lcut', beats: [target.id], sec: first.splitEdit.sec })
  const padIn = first.padIn !== roomIn(first) ? first.padIn : undefined
  const padOut = last.padOut !== roomOut(last) ? last.padOut : undefined
  if (padIn !== undefined || padOut !== undefined)
    ops.push({
      op: 'pad',
      beat: target.id,
      ...(padIn !== undefined ? { padIn } : {}),
      ...(padOut !== undefined ? { padOut } : {})
    })
  const set: Partial<Treatment> = {}
  const taken = new Set<string>()
  for (const old of olds)
    for (const look of looksOf(old.treatment)) {
      const key = look.keys.join()
      if (taken.has(key)) continue
      if (look.word && (!holds(target, look.word, index) || (look.keys[0] === 'freeze' && struck.has(look.word))))
        continue
      taken.add(key)
      for (const k of look.keys) if (old.treatment[k] !== undefined) Object.assign(set, { [k]: old.treatment[k] })
    }
  if (Object.keys(set).length) ops.push({ op: 'treat', beats: [target.id], set })
  const sounds: Sfx[] = []
  for (const old of olds)
    for (const e of old.sfx ?? []) {
      if (e.word && !holds(target, e.word, index)) continue
      if (!sounds.some((s) => sameSound(s, e)) && sounds.length < 12) sounds.push(e)
    }
  for (const e of sounds) ops.push({ op: 'sfx', beats: [target.id], add: e })
  return ops
}

/** Hand-built layers with their anchors moved, or null when one of them has nowhere to go. */
function layersMoved(layers: unknown[], move: (ref: string) => string | null): unknown[] | null {
  const out: unknown[] = []
  for (const raw of layers) {
    const layer = { ...(raw as Record<string, unknown>) }
    for (const edge of ['start', 'end'] as const) {
      const ref = layer[edge]
      if (typeof ref !== 'string') continue
      const to = move(ref)
      if (to === null) return null
      layer[edge] = to
    }
    if (Array.isArray(layer.children)) {
      const children = layersMoved(layer.children, move)
      if (!children) return null
      layer.children = children
    }
    out.push(layer)
  }
  return out
}

/**
 * The ops that carry what was done to the beats of `before` onto `told`,
 * the cut once a new story's beats are in: each beat's edits to the beat
 * that plays its moment, chapters to the beats that play theirs, graphics on
 * a beat moved to the beat that plays it, and those whose moment is gone
 * taken out. Some may not apply (a dissolve into what is now the first
 * shot); `leftOut` names whatever did not come along.
 */
export function carryOps(before: Cut, told: Cut, words: Word[]): Op[] {
  const index = indexWords(words)
  const moments = sameMoments(before.beats, told.beats, words)
  const struck = new Set(told.removed)
  const ops: Op[] = []
  for (const target of told.beats) {
    const olds = before.beats.filter((b) => moments.get(b.id) === target)
    if (olds.length) ops.push(...beatOps(target, olds, index, struck))
  }
  if (before.chapters?.length) {
    const set: { beat: string; title: string }[] = []
    for (const c of before.chapters) {
      const now = moments.get(c.beat)
      if (now && !set.some((x) => x.beat === now.id)) set.push({ beat: now.id, title: c.title })
    }
    ops.push({ op: 'chapters', set: set.length ? set : null })
  }
  // An anchor where its moment plays now: a word stays itself, a beat becomes the one that plays it.
  const covered = (cut: Cut, word: string): boolean => cut.beats.some((b) => holds(b, word, index))
  const move = (ref: string): string | null => {
    const a = parseAnchor(ref)
    if (!a || a.on === 'cut' || !a.id) return ref
    if (index.pos.has(a.id)) return covered(told, a.id) || !covered(before, a.id) ? ref : null
    const now = moments.get(a.id)
    return now ? `${now.id}${ref.trim().slice(a.id.length)}` : null
  }
  const gone: string[] = []
  for (const g of before.motion ?? []) {
    const from = move(g.from)
    const layers = layersMoved(g.layers, move)
    if (from === null || layers === null) {
      gone.push(g.id)
      continue
    }
    const end = g.to.trim() && parseLength(g.to) === null ? move(g.to) : g.to
    const items = g.items.map((row) => (row.at.trim() ? { ...row, at: move(row.at) ?? '' } : row))
    const change = {
      ...(from !== g.from ? { from } : {}),
      // An end whose moment is gone: the graphic runs its own length from where it starts.
      ...(end !== g.to ? { to: end ?? 'none' } : {}),
      ...(!same(items, g.items) ? { items } : {}),
      ...(!same(layers, g.layers) ? { layers: layers as MotionItem['layers'] } : {})
    }
    if (Object.keys(change).length) ops.push({ op: 'motion-update', id: g.id, ...change })
  }
  if (gone.length) ops.push({ op: 'motion-remove', ids: gone })
  return ops
}

/** Something done to the old cut that the new one does not have, and whether its moment is gone from it. */
export interface Lost extends Named {
  /** Its moment is not in the new cut; otherwise it is, but the edit did not fit there. */
  gone: boolean
  /** A chapter or a graphic: named one by one, up to a few of a kind. */
  kind: 'edit' | 'chapter' | 'graphic'
}

/**
 * What was done to the beats of `before` that `after` does not have where
 * the same moments play: an edit not on the beat that plays its moment, a
 * chapter not on it, a graphic taken out. Empty when everything came along.
 */
export function leftOut(before: Cut, after: Cut, words: Word[]): Lost[] {
  const moments = sameMoments(before.beats, after.beats, words)
  const lost: Lost[] = []
  const edit = (name: Named, gone: boolean): void => {
    lost.push({ ...name, gone, kind: 'edit' })
  }
  for (const old of before.beats) {
    const now = moments.get(old.id)
    if (old.transition) {
      const label = TRANSITION_INFO[old.transition.kind].label.replace(/^an? /, '')
      if (!now || !same(now.transition, old.transition)) edit(named(`the ${label}`, pluralOf(label)), !now)
    } else if (old.splitEdit && (!now || !same(now.splitEdit, old.splitEdit))) {
      const kind = old.splitEdit.kind === 'j' ? 'J' : 'L'
      edit(named(`the ${kind} cut`, `${kind} cuts`), !now)
    }
    const padded = old.padIn !== roomIn(old) || old.padOut !== roomOut(old)
    if (
      padded &&
      (!now ||
        (old.padIn !== roomIn(old) && now.padIn !== old.padIn) ||
        (old.padOut !== roomOut(old) && now.padOut !== old.padOut))
    )
      edit({ one: 'the padding', many: (n) => `the padding on ${n} beats` }, !now)
    for (const look of looksOf(old.treatment))
      if (!now || !look.keys.every((k) => same(now.treatment[k] ?? null, old.treatment[k] ?? null)))
        edit(look.name, !now)
    for (const e of old.sfx ?? [])
      if (!now || !(now.sfx ?? []).some((x) => same(x, e))) edit(named('the sound effect', 'sound effects'), !now)
  }
  for (const c of before.chapters ?? []) {
    const now = moments.get(c.beat)
    if (!now || !(after.chapters ?? []).some((x) => x.beat === now.id && x.title === c.title))
      lost.push({ one: `the chapter “${c.title}”`, many: (n) => `${n} chapters`, gone: !now, kind: 'chapter' })
  }
  const still = new Set((after.motion ?? []).map((m) => m.id))
  for (const g of before.motion ?? [])
    if (!still.has(g.id))
      lost.push({
        one: graphicName(g).replace(/^an? /, 'the '),
        many: (n) => `${n} graphics`,
        gone: true,
        kind: 'graphic'
      })
  return lost
}
