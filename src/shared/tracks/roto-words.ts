import { isKeyed, num } from '../anim'
import type { ClipFollow, ClipMask } from './roto'
import type { TrackClip } from './schema'

/**
 * A clip's masks, matte, key and following in words: for the planner's
 * <tracks> lines (short, with each mask's path while it is short enough to
 * be changed by hand), and for describePlan's sentence about a plan.
 */

/** A mask path longer than this, as JSON, is said by its size rather than written out. */
const PATH_CHARS = 360

const said = (v: unknown): string => (isKeyed(v as never) ? `keys ${(v as { keys: { t: number }[] }).keys.map((k) => k.t).join(' ')}` : String(num(v as number, 0, 0)))

function maskWords(m: ClipMask, i: number): string {
  const bits = [`mask ${i + 1} ${m.mode}`]
  if (m.invert) bits.push('inverted')
  if (isKeyed(m.feather) || m.feather !== 0) bits.push(`feather ${said(m.feather)}`)
  if (isKeyed(m.expand) || m.expand !== 0) bits.push(`expand ${said(m.expand)}`)
  if (isKeyed(m.opacity) || m.opacity !== 1) bits.push(`opacity ${said(m.opacity)}`)
  if (m.follow) bits.push(followWords(m.follow))
  const path = JSON.stringify(m.path)
  if (path.length <= PATH_CHARS) bits.push(`path ${path}`)
  else if (isKeyed(m.path)) bits.push(`a drawn path keyed at ${(m.path as { keys: { t: number }[] }).keys.map((k) => k.t).join(' ')}`)
  else bits.push(`a drawn path of ${(m.path as unknown[]).length} points`)
  return bits.join(' ')
}

const followWords = (f: ClipFollow): string =>
  `follows an object${f.scale ? ' and its size' : ''}${f.path ? '' : ' (not found yet)'}`

/** What a clip is cut to and what is taken out of it, as bits of its <tracks> line. */
export function rotoBits(clip: TrackClip): string[] {
  const bits: string[] = []
  for (const [i, m] of (clip.masks ?? []).entries()) bits.push(maskWords(m, i))
  if (clip.matte) {
    const m = clip.matte
    const behind = m.from === 'person' && m.invert
    bits.push(`matte ${m.from}${m.mode === 'luma' ? ' luma' : ''}${m.invert ? ' inverted' : ''}${behind ? ' (behind the person)' : ''}`)
  }
  if (clip.key) bits.push(`key ${clip.key.colour} tolerance ${clip.key.tolerance} softness ${clip.key.softness} spill ${clip.key.spill}`)
  if (clip.follow) bits.push(followWords(clip.follow))
  return bits
}

type OpLike = { op: string } & Record<string, unknown>

/** Whether an op only cuts a clip or keys it or makes it follow: said by these phrases rather than as a change. */
export function onlyRoto(op: OpLike): boolean {
  if (op.op !== 'clip-update') return false
  const keys = Object.keys(op).filter((k) => k !== 'op' && k !== 'clip')
  return keys.length > 0 && keys.every((k) => k === 'masks' || k === 'matte' || k === 'key' || k === 'follow')
}

/** Clauses for describePlan: "a clip goes behind you", "the green comes out of a clip", "a mask goes on a clip". */
export function rotoPhrases(ops: OpLike[]): string[] {
  const out: string[] = []
  const clipOps = ops.filter((o) => o.op === 'clip-add' || o.op === 'clip-update')
  const count = (test: (o: OpLike) => boolean): number => clipOps.filter(test).length
  const matte = (o: OpLike): { from?: string; invert?: boolean } | null => (o.matte && typeof o.matte === 'object' ? (o.matte as { from?: string; invert?: boolean }) : null)
  const behind = count((o) => matte(o)?.from === 'person' && matte(o)?.invert === true)
  const onPerson = count((o) => !!matte(o) && !(matte(o)?.from === 'person' && matte(o)?.invert === true))
  const masked = count((o) => Array.isArray(o.masks) && (o.masks as unknown[]).length > 0)
  const unmasked = count((o) => Array.isArray(o.masks) && (o.masks as unknown[]).length === 0)
  const keyed = count((o) => !!o.key && typeof o.key === 'object')
  const following = count((o) => !!o.follow && typeof o.follow === 'object')
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
  const one = (n: number, a: string, many: string): string => (n === 1 ? a : many.replace('#', words[n] ?? String(n)))
  if (behind > 0) out.push(one(behind, 'a clip goes behind you', '# clips go behind you'))
  if (onPerson > 0) out.push(one(onPerson, 'a clip is cut to a matte', '# clips are cut to mattes'))
  if (masked > 0) out.push(one(masked, 'a clip is masked', '# clips are masked'))
  if (unmasked > 0) out.push(one(unmasked, 'a mask comes off', 'masks come off # clips'))
  if (keyed > 0) out.push(one(keyed, 'a colour is keyed out of a clip', 'a colour is keyed out of # clips'))
  if (following > 0) out.push(one(following, 'a clip follows something in the picture', '# clips follow something in the picture'))
  return out
}
