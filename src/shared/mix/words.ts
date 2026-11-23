import { FX_LABEL } from './bus'
import type { FxKind } from './schema'

/**
 * Clauses for describePlan (shared/presets/plan): what a plan did in the
 * mixer, in the app's voice. "the voice gets a compressor", "the music is
 * muted", "two tracks are mixed".
 */

type OpLike = { op: string } & Record<string, unknown>

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** "a compressor", "an EQ", "an echo". */
const aFx = (kind: FxKind): string => {
  const label = kind === 'eq' ? 'EQ' : FX_LABEL[kind].toLowerCase()
  return `${/^[aeiouAEIOU]/.test(label) ? 'an' : 'a'} ${label}`
}

const list = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

export function mixPhrases(ops: OpLike[]): string[] {
  const said: string[] = []
  const mixes = ops.filter((o) => o.op === 'mix')
  if (mixes.length === 0) return said
  const who = (target: unknown): string => (target === 'voice' ? 'the voice' : target === 'music' ? 'the music' : 'a track')
  const plain: string[] = []
  for (const o of mixes) {
    const w = who(o.target)
    const added = (o.add as { kind: FxKind }[] | undefined) ?? []
    const chain = o.effects as unknown[] | undefined
    if (added.length > 0) said.push(`${w} gets ${list([...new Set(added.map((f) => f.kind))].map(aFx))}`)
    // A whole chain sent again (the Mix tab sends one for every setting) says only that it changed.
    else if (chain) said.push(chain.length === 0 ? `${w} loses its effects` : `${w}’s effects change`)
    else if (Array.isArray(o.remove) && o.remove.length > 0) said.push(`${w} loses ${o.remove.length === 1 ? 'an effect' : 'some effects'}`)
    else if (o.mute !== undefined) said.push(o.mute ? `${w} is muted` : `${w} is heard again`)
    else if (o.solo !== undefined) said.push(o.solo ? `${w} plays alone` : `${w} no longer plays alone`)
    else if (o.gainDb !== undefined && o.pan === undefined) said.push(`${w}’s level changes`)
    else if (o.pan !== undefined && o.gainDb === undefined) said.push(`${w} moves between the speakers`)
    else plain.push(String(o.target))
  }
  const tracks = plain.filter((t) => t !== 'voice' && t !== 'music')
  const named = plain.filter((t) => t === 'voice' || t === 'music').map(who)
  if (tracks.length === 1) named.push('a track')
  else if (tracks.length > 1) named.push(`${NUMBER_WORDS[tracks.length] ?? tracks.length} tracks`)
  if (named.length > 0) said.push(`${list(named)} ${named.length === 1 && tracks.length <= 1 ? 'is' : 'are'} mixed`)
  return said
}
