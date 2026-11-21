import { parseAnchor } from '../motion/schema'
import { effectsOf } from '../fx/apply'
import { FX_INFO } from '../fx/schema'
import { template } from '../motion/templates'
import { spanFor, timelineFor } from '../motion/timing'
import { clock } from '../presets/preset'
import { applyOps, type OpContext } from './ops'
import { indexWords, resolveCut, type Resolved } from './resolve'
import type { Cut, Op } from './schema'

/**
 * A stretch of the edit picked on the beat strip: the beats from one to
 * another in playing order, by id. While one is picked, a note or a command
 * acts on those beats rather than the one under the playhead; a plan made for
 * a note on it is checked to change nothing outside it.
 */

/** Where a pick started and where it reaches to, by beat id, either way round. */
export interface BeatPick {
  anchor: string
  focus: string
}

/** The beats a pick covers, in the cut's order; empty when either end is no longer in the cut. */
export function pickedBeats(cut: Pick<Cut, 'beats'>, pick: BeatPick | null): string[] {
  if (!pick) return []
  const a = cut.beats.findIndex((b) => b.id === pick.anchor)
  const z = cut.beats.findIndex((b) => b.id === pick.focus)
  if (a < 0 || z < 0) return []
  return cut.beats.slice(Math.min(a, z), Math.max(a, z) + 1).map((b) => b.id)
}

/**
 * The beats a note left on a stretch is about now: the stretch from its first
 * beat to its last, or, once an end is cut, from the first to the last of the
 * beats it held that are still in the cut. Empty when it was left on no
 * stretch, or none of its beats is left.
 */
export function noteBeats(
  cut: Pick<Cut, 'beats'>,
  range: { from: string; to: string; beats?: string[] } | undefined
): string[] {
  if (!range) return []
  const picked = pickedBeats(cut, { anchor: range.from, focus: range.to })
  if (picked.length > 0) return picked
  const held = new Set(range.beats ?? [])
  const left = cut.beats.filter((b) => held.has(b.id))
  if (left.length === 0) return []
  return pickedBeats(cut, { anchor: left[0].id, focus: left[left.length - 1].id })
}

/** Where a set of beats plays: from the first one's start to the last one's end. */
export function rangeTimes(resolved: Resolved, beats: string[]): { start: number; end: number } | null {
  const set = new Set(beats)
  const playing = resolved.beats.filter((b) => set.has(b.id))
  if (playing.length === 0) return null
  return { start: Math.min(...playing.map((b) => b.outStart)), end: Math.max(...playing.map((b) => b.outEnd)) }
}

/** "between 0:12 and 0:31". */
export function rangeName(times: { start: number; end: number }): string {
  return `between ${clock(times.start)} and ${clock(times.end)}`
}

/** Ops that change the whole video, whatever beats are picked. */
const WHOLE = new Set<Op['op']>([
  'captions',
  'tighten',
  'aspect',
  'loudness',
  'fade',
  'voice',
  'music',
  'look',
  'chapters',
  'sync',
  'reframe',
  'punch-jumps',
  'fill'
])

/** The beats an op acts on, or null for an op that names none (it acts on the whole video or on words). */
function beatsOf(op: Op): string[] | null {
  switch (op.op) {
    case 'remove':
    case 'treat':
    case 'transition':
    case 'jcut':
    case 'lcut':
    case 'speed':
    case 'reverse':
    case 'sfx':
    case 'angle':
    case 'framing':
    case 'camera':
      return op.beats
    case 'move':
    case 'split':
    case 'join':
    case 'pad':
    case 'freeze':
      return [op.beat]
    default:
      return null
  }
}

/** A beat id's number, to put the beats an op makes in the order it made them. */
const idNumber = (id: string): number => Number(/\d+$/.exec(id)?.[0] ?? 0)

/** The beat ids a graphic's anchor names, as its from or to: "b7", "b7.end", "b7+0.5". */
const anchorBeat = (ref: string | undefined, made: Set<string>): string | null => {
  const id = ref ? parseAnchor(ref)?.id : null
  return id && made.has(id) ? id : null
}

/** Every beat id an op names, its graphics' anchors too. */
function idsIn(op: Op, made: Set<string>): string[] {
  const named = beatsOf(op) ?? []
  if (op.op === 'motion-add' || op.op === 'motion-update' || op.op === 'fx-add' || op.op === 'fx-update') {
    for (const ref of [op.from, op.to]) {
      const id = anchorBeat(ref, made)
      if (id) named.push(id)
    }
  }
  return named
}

/** The op with the beat ids the plan meant put to the ones the cut has. */
function renamed(op: Op, rename: Map<string, string>): Op {
  if (rename.size === 0) return op
  const to = (id: string): string => rename.get(id) ?? id
  const anchor = (ref: string | undefined): string | undefined => {
    const id = ref ? parseAnchor(ref)?.id : null
    return ref && id && rename.has(id) ? `${to(id)}${ref.trim().slice(id.length)}` : ref
  }
  if ('beats' in op && Array.isArray(op.beats)) return { ...op, beats: op.beats.map(to) } as Op
  if ('beat' in op && typeof op.beat === 'string') return { ...op, beat: to(op.beat) } as Op
  if (op.op === 'motion-add' || op.op === 'fx-add')
    return { ...op, from: anchor(op.from) as string, to: anchor(op.to) as string }
  if (op.op === 'motion-update' || op.op === 'fx-update') return { ...op, from: anchor(op.from), to: anchor(op.to) }
  return op
}

/** How near the stretch's edges a graphic may start or end and still be on it, in seconds. */
const EDGE = 0.05

/**
 * Splits a plan for a picked stretch into the ops that stay inside it and
 * those that do not, each with why. The plan is followed in order: a beat
 * split off one inside, or put in among them, is inside too; a move must
 * land among them; struck words must all be words they play; and a graphic
 * must start where they play, and end there when its end is said, wherever
 * its anchor is (a word, a beat, a word less two seconds, the cut's start).
 * An op left out may have made a beat a later op names: the planner counted
 * its ids with every op in, so later ops are put to the ids the cut really
 * has, and one that names a beat an op left out would have made is left out
 * too.
 */
export function opsInside(
  cut: Cut,
  ops: Op[],
  beats: string[],
  context: OpContext
): { inside: Op[]; outside: { op: Op; reason: string }[] } {
  // The beats each op of the plan makes, as the planner checked it: every op in, in order.
  const made: string[][] = []
  let planned = cut
  for (const op of ops) {
    const before = new Set(planned.beats.map((b) => b.id))
    const r = applyOps(planned, [op], context)
    if (r.applied.length > 0) planned = r.cut
    made.push(
      planned.beats
        .filter((b) => !before.has(b.id))
        .map((b) => b.id)
        .sort((a, b) => idNumber(a) - idNumber(b))
    )
  }
  const madeAll = new Set(made.flat())
  /** The plan's ids for beats it made, put to the ids those beats have in the cut. */
  const rename = new Map<string, string>()
  /** The plan's ids for beats only an op left out would have made. */
  const dead = new Set<string>()

  const inRange = new Set(beats)
  const index = indexWords(context.words)
  let running = cut
  const inside: Op[] = []
  const outside: { op: Op; reason: string }[] = []
  /** Positions of the words the picked beats cover now. */
  const wordsInRange = (): Set<number> => {
    const set = new Set<number>()
    for (const b of running.beats) {
      if (!inRange.has(b.id) || b.from === null || b.to === null) continue
      const a = index.pos.get(b.from)
      const z = index.pos.get(b.to)
      if (a === undefined || z === undefined) continue
      for (let i = a; i <= z; i++) set.add(i)
    }
    return set
  }
  /** Where in the cut the picked beats sit now, first to last. */
  const span = (): [number, number] => {
    const at = running.beats.map((b, i) => (inRange.has(b.id) ? i : -1)).filter((i) => i >= 0)
    return at.length ? [Math.min(...at), Math.max(...at)] : [-1, -2]
  }
  /** Whether a graphic plays on the stretch in this cut: it starts there, and ends there when its end is said. */
  const onStretch = (c: Cut, id: string): boolean => {
    // A graphic, or a scene effect (fx), by its id; each starts on its anchor and runs its own length.
    const graphic = (c.motion ?? []).find((m) => m.id === id)
    const effect = graphic ? undefined : effectsOf(c).find((x) => x.id === id)
    const item = graphic ?? effect
    if (!item) return false
    const resolved = resolveCut(c, context.words, context.sources)
    const times = rangeTimes(resolved, [...inRange])
    const tpl = graphic ? template(graphic.kind) : effect ? FX_INFO[effect.kind] : undefined
    const at = spanFor(timelineFor(c, resolved, context.words), item.from, item.to, tpl?.length ?? 3, tpl?.lead ?? 0)
    if (!times || !at) return false
    if (at.at < times.start - EDGE || at.at > times.end - EDGE) return false
    // Its own length may run past the stretch, as it would on any beat; an end said outright may not.
    return item.to.trim() === '' || at.end <= times.end + EDGE
  }
  const reason = (op: Op): string | null => {
    if (WHOLE.has(op.op)) return 'It would change the whole video.'
    const named = beatsOf(op)
    if (named && !named.every((id) => inRange.has(id))) return 'It reaches outside the stretch.'
    if (op.op === 'join') {
      const at = running.beats.findIndex((b) => b.id === op.beat)
      const next = running.beats[at + 1]
      if (!next || !inRange.has(next.id)) return 'It reaches outside the stretch.'
    }
    // A beat moved lands among the picked ones; one put in may also go just after the last of them.
    if (op.op === 'move' || op.op === 'insert') {
      const [a, z] = span()
      if (op.to < a || op.to > (op.op === 'insert' ? z + 1 : z)) return 'It puts a beat outside the stretch.'
    }
    if (op.op === 'strike' || op.op === 'unstrike') {
      const words = wordsInRange()
      const a = index.pos.get(op.from)
      const z = index.pos.get(op.to)
      if (a === undefined || z === undefined) return 'It cuts words outside the stretch.'
      for (let i = Math.min(a, z); i <= Math.max(a, z); i++)
        if (!words.has(i)) return 'It cuts words outside the stretch.'
    }
    if (op.op === 'freeze') {
      const p = index.pos.get(op.word)
      if (p === undefined || !wordsInRange().has(p)) return 'It holds on a word outside the stretch.'
    }
    if (op.op === 'motion-update' || op.op === 'motion-remove') {
      const ids = op.op === 'motion-update' ? [op.id] : op.ids
      for (const id of ids) if (!onStretch(running, id)) return 'It changes a graphic outside the stretch.'
    }
    if (op.op === 'fx-update' || op.op === 'fx-remove') {
      const ids = op.op === 'fx-update' ? [op.id] : op.ids
      for (const id of ids) if (!onStretch(running, id)) return 'It changes an effect outside the stretch.'
    }
    return null
  }
  /** What the op did, checked once it is done: a graphic put on the stretch, or moved, stays on it. */
  const after = (op: Op, before: Cut, next: Cut): string | null => {
    if (op.op === 'motion-add') {
      const known = new Set((before.motion ?? []).map((m) => m.id))
      const added = (next.motion ?? []).filter((m) => !known.has(m.id))
      if (!added.every((m) => onStretch(next, m.id))) return 'It puts a graphic outside the stretch.'
    }
    if (op.op === 'motion-update' && !onStretch(next, op.id)) return 'It moves a graphic outside the stretch.'
    if (op.op === 'fx-add') {
      const known = new Set(effectsOf(before).map((x) => x.id))
      const added = effectsOf(next).filter((x) => !known.has(x.id))
      if (!added.every((x) => onStretch(next, x.id))) return 'It puts an effect outside the stretch.'
    }
    if (op.op === 'fx-update' && !onStretch(next, op.id)) return 'It moves an effect outside the stretch.'
    return null
  }
  ops.forEach((asked, k) => {
    const leftOut = (why: string): void => {
      outside.push({ op: asked, reason: why })
      for (const id of made[k]) dead.add(id)
    }
    if (idsIn(asked, madeAll).some((id) => dead.has(id))) return leftOut('It depends on a change left out.')
    const op = renamed(asked, rename)
    const why = reason(op)
    if (why) return leftOut(why)
    const before = running
    const known = new Set(running.beats.map((b) => b.id))
    const r = applyOps(running, [op], context)
    if (r.applied.length === 0) return leftOut(r.rejected[0]?.reason ?? 'It does not fit the cut.')
    const done = after(op, before, r.cut)
    if (done) return leftOut(done)
    running = r.cut
    inside.push(op)
    // A beat split off one inside, or put in among them, belongs to the stretch, by the id the cut gave it.
    const fresh = running.beats
      .filter((b) => !known.has(b.id))
      .map((b) => b.id)
      .sort((a, b) => idNumber(a) - idNumber(b))
    made[k].forEach((id, i) => (fresh[i] ? rename.set(id, fresh[i]) : dead.add(id)))
    for (const id of fresh) inRange.add(id)
  })
  return { inside, outside }
}

/**
 * Whether every op acts only on these beats: a version made of them can be
 * named by the stretch ("Between 0:12 and 0:31, four beats come in with a
 * dissolve"). Ops on the whole video, or on words, are not.
 */
export function onlyOn(ops: Op[], beats: string[]): boolean {
  const set = new Set(beats)
  return ops.length > 0 && ops.every((op) => {
    const named = beatsOf(op)
    return named !== null && named.every((id) => set.has(id))
  })
}
