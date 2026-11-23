import { onlyRoto, rotoPhrases } from './roto-words'

/**
 * Clauses for describePlan (shared/presets/plan): what a plan did to the
 * layer tracks, in the app's voice. "a video goes over the edit", "one clip
 * is trimmed", "two keys are set".
 */

type OpLike = { op: string } & Record<string, unknown>

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const count = (n: number, one: string, many: string): string => `${NUMBER_WORDS[n] ?? n} ${n === 1 ? one : many}`

const NOUN: Record<string, string> = { video: 'a video', image: 'a picture', text: 'a title', solid: 'a colour', sound: 'a sound' }

export function trackPhrases(ops: OpLike[]): string[] {
  const said: string[] = []
  const of = (name: string): OpLike[] => ops.filter((o) => o.op === name)
  const added = of('clip-add')
  if (added.length > 0 && added.length <= 2)
    for (const o of added) said.push(o.kind === 'sound' ? `${NOUN.sound} plays under the edit` : `${NOUN[String(o.kind)] ?? 'a clip'} goes over the edit`)
  else if (added.length > 2) said.push(`${count(added.length, 'clip', 'clips')} go on the tracks`)
  // Masks, mattes, keys and following are said by their own clauses (tracks/roto-words).
  const changed = of('clip-update').filter((o) => !onlyRoto(o)).length + of('clip-move').length
  if (changed > 0) said.push(`${count(changed, 'clip', 'clips')} ${changed === 1 ? 'changes' : 'change'}`)
  const trimmed = of('clip-trim').length + of('trim').length
  if (trimmed > 0) said.push(`${count(trimmed, 'edge is', 'edges are')} trimmed`)
  const split = of('clip-split').length
  if (split > 0) said.push(`${count(split, 'clip is', 'clips are')} split`)
  const removed = of('clip-remove').reduce((n, o) => n + ((o.clips as string[] | undefined)?.length ?? 0), 0)
  if (removed > 0) said.push(`${count(removed, 'clip is', 'clips are')} gone`)
  const keyed = of('key-set').length
  if (keyed > 0) said.push(`${count(keyed, 'key is', 'keys are')} set`)
  const unkeyed = of('key-remove').length
  if (unkeyed > 0) said.push(`${count(unkeyed, 'key comes', 'keys come')} off`)
  const tracks = of('track-add').length
  if (tracks > 0) said.push(`${count(tracks, 'track is', 'tracks are')} added`)
  const restacked = of('track-update').length + of('track-remove').length
  if (restacked > 0) said.push(`${count(restacked, 'track changes', 'tracks change')}`)
  said.push(...rotoPhrases(ops))
  return said
}
