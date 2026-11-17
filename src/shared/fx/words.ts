import type { Cut } from '../edit/schema'
import { effectsOf } from './apply'
import type { CutoutKind } from './masks'
import { FX_INFO, type FxItem } from './schema'

/**
 * Scene effects in words: what a version did to them, and what an effect
 * does instead on a computer that cannot cut the person or the objects out.
 */

/** The cut-out an effect works from, if any: a scan brings in objects or the person; a hit lands on the person unless it is put somewhere; a blur goes behind them. */
export function cutoutFor(item: FxItem): CutoutKind | null {
  const on = item.on === 'auto' ? FX_INFO[item.kind].target : item.on
  switch (item.kind) {
    case 'scan':
      return on === 'objects' ? 'objects' : on === 'subject' ? 'person' : null
    case 'impact':
      return item.at.length === 2 ? null : 'person'
    case 'bgblur':
      return on === 'frame' ? null : 'person'
    default:
      return null
  }
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const count = (n: number, one: string, many: string): string => `${NUMBER_WORDS[n] ?? n} ${n === 1 ? one : many}`

/** What one effect does, as a clause: "a pixel scan brings the objects in". */
export function fxClause(item: FxItem): string {
  const on = item.on === 'auto' ? FX_INFO[item.kind].target : item.on
  switch (item.kind) {
    case 'scan':
      return on === 'objects'
        ? 'a pixel scan brings the objects in'
        : on === 'subject'
          ? 'a pixel scan brings you in'
          : 'a pixel scan brings the picture in'
    case 'impact':
      return 'an impact lands'
    case 'speedlines':
      return 'speed lines rush past'
    case 'bgblur':
      return on === 'frame' ? 'the edges of the frame blur' : 'the background blurs behind you'
  }
}

interface OpLike {
  op: string
}

/** Clauses for describePlan: "a pixel scan brings the objects in", "one effect is gone". */
export function fxPhrases(ops: OpLike[]): string[] {
  const said: string[] = []
  // An op may leave out where it works and its point; the edit fills them in as auto and none.
  const added = ops.filter((o) => o.op === 'fx-add') as (OpLike & Partial<FxItem> & Pick<FxItem, 'kind'>)[]
  if (added.length > 0 && added.length <= 3)
    for (const o of added) said.push(fxClause({ ...o, on: o.on ?? 'auto', at: o.at ?? [] } as FxItem))
  else if (added.length > 3) said.push(`${count(added.length, 'effect', 'effects')} come in`)
  const changed = ops.filter((o) => o.op === 'fx-update').length
  if (changed > 0) said.push(`${count(changed, 'effect', 'effects')} ${changed === 1 ? 'changes' : 'change'}`)
  const removed = ops.reduce(
    (n, o) => n + (o.op === 'fx-remove' ? ((o as { ids?: string[] }).ids?.length ?? 0) : 0),
    0
  )
  if (removed > 0) said.push(`${count(removed, 'effect', 'effects')} ${removed === 1 ? 'is' : 'are'} gone`)
  return said
}

/** What an effect does without the cut-out it wants. */
function without(item: FxItem): string {
  const on = item.on === 'auto' ? FX_INFO[item.kind].target : item.on
  switch (item.kind) {
    case 'scan':
      return on === 'objects'
        ? 'the scan brings in the whole frame rather than each object'
        : 'the scan brings in the whole frame rather than you alone'
    case 'bgblur':
      return 'the blur softens the edges and keeps the middle sharp'
    default:
      return 'the impact lands in the middle'
  }
}

/**
 * One sentence when a version adds or changes an effect that wants a cut-out
 * this computer cannot make: what it does instead. Null otherwise.
 */
export function fxNotice(before: Cut, after: Cut, can: { person: boolean; objects: boolean }): string | null {
  const was = new Map(effectsOf(before).map((x) => [x.id, JSON.stringify(x)]))
  const short = effectsOf(after).filter((x) => {
    if (was.get(x.id) === JSON.stringify(x)) return false
    const kind = cutoutFor(x)
    return kind !== null && !can[kind]
  })
  if (short.length === 0) return null
  const clauses = [...new Set(short.map(without))]
  const list = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`
  return `Cut-outs need Vision on a Mac, so ${list}.`
}
