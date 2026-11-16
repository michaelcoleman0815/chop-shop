import { clock } from '../presets/preset'
import { applyOps, type OpContext } from './ops'
import { indexWords, type Resolved } from './resolve'
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

/**
 * Splits a plan for a picked stretch into the ops that stay inside it and
 * those that do not, each with why. The plan is followed in order: a beat
 * split off one inside, or put in among them, is inside too; a move must
 * land among them; struck words and graphics must be words they play.
 */
export function opsInside(
  cut: Cut,
  ops: Op[],
  beats: string[],
  context: OpContext
): { inside: Op[]; outside: { op: Op; reason: string }[] } {
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
  const reason = (op: Op): string | null => {
    if (WHOLE.has(op.op)) return 'It would change the whole video.'
    const named = beatsOf(op)
    if (named && !named.every((id) => inRange.has(id))) return 'It reaches outside the stretch.'
    if (op.op === 'join') {
      const at = running.beats.findIndex((b) => b.id === op.beat)
      const next = running.beats[at + 1]
      if (!next || !inRange.has(next.id)) return 'It reaches outside the stretch.'
    }
    if (op.op === 'move' || op.op === 'insert') {
      const [a, z] = span()
      if (op.to < a || op.to > z + 1) return 'It puts a beat outside the stretch.'
    }
    if (op.op === 'strike' || op.op === 'unstrike') {
      const words = wordsInRange()
      const a = index.pos.get(op.from)
      const z = index.pos.get(op.to)
      if (a === undefined || z === undefined || !words.has(a) || !words.has(z)) return 'It cuts words outside the stretch.'
    }
    if (op.op === 'freeze') {
      const p = index.pos.get(op.word)
      if (p === undefined || !wordsInRange().has(p)) return 'It holds on a word outside the stretch.'
    }
    if (op.op === 'motion-add') {
      const p = index.pos.get(op.from)
      if (p === undefined || !wordsInRange().has(p)) return 'It puts a graphic outside the stretch.'
    }
    if (op.op === 'motion-update' || op.op === 'motion-remove') {
      const ids = op.op === 'motion-update' ? [op.id] : op.ids
      const words = wordsInRange()
      for (const id of ids) {
        const item = (running.motion ?? []).find((m) => m.id === id)
        const p = item ? index.pos.get(item.from) : undefined
        if (p === undefined || !words.has(p)) return 'It changes a graphic outside the stretch.'
      }
    }
    return null
  }
  for (const op of ops) {
    const why = reason(op)
    if (why) {
      outside.push({ op, reason: why })
      continue
    }
    const before = new Set(running.beats.map((b) => b.id))
    const r = applyOps(running, [op], context)
    if (r.applied.length === 0) {
      outside.push({ op, reason: r.rejected[0]?.reason ?? 'It does not fit the cut.' })
      continue
    }
    running = r.cut
    inside.push(op)
    // A beat split off one inside, or put in among them, belongs to the stretch.
    for (const b of running.beats) if (!before.has(b.id)) inRange.add(b.id)
  }
  return { inside, outside }
}

/** "Cut this", "cut it out", "remove these", "delete that part": the picked stretch out, said in words. */
export function cutsPicked(text: string): boolean {
  const it = String.raw`(this|that|these|those|it|them)(\s+(part|bit|stretch|section|beats?))?`
  return new RegExp(
    String.raw`^(please\s+)?((cut|remove|delete|drop|lose|get rid of)\s+${it}(\s+out)?|take\s+${it}\s+out)(\s+please)?[.!]*$`,
    'i'
  ).test(text.trim())
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
