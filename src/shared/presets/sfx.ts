import { currentCut } from '../edit/doc'
import { resolveCut, type Resolved } from '../edit/resolve'
import type { EditDoc, Op } from '../edit/schema'
import { SFX_INFO, SFX_KINDS, sfxName, type Sfx, type SfxKind } from '../edit/sfx'
import { shownTransition, TRANSITION_INFO } from '../edit/transitions'

/**
 * The /sfx command: a built-in sound on the beat under the playhead, or on
 * its word, one of the person's own by name or by hand, sounds taken off or
 * turned up and down, and a whoosh through every moving transition. Read
 * here, apart from the app, so every phrasing is tested; the app only finds
 * the person's own file when one is asked for.
 */

export type SfxCommandResult =
  | { ops: Op[] }
  | { say: string }
  /** One of the person's own sounds to find: by name in the sounds folder, or chosen by hand when null. */
  | { file: { name: string | null; beat: string; word: string | null } }

/** A step louder or quieter, in dB. */
const STEP_DB = 3

/** What /sfx can do, for /sfx on its own. */
export function sfxHelp(): string {
  return (
    'Sounds: whoosh, pop, click, riser, hit and ding, made here, and any in your sounds folder by name. ' +
    '/sfx whoosh puts one on the cut into the beat under the playhead, /sfx pop on the word under it, ' +
    '/sfx transitions a whoosh through every moving transition, /sfx file one of your own, ' +
    '/sfx louder or quieter, and /sfx off takes this beat’s away.'
  )
}

/**
 * Reads /sfx. `beat` and `at` are the beat and the moment under the
 * playhead, in the editor; in the thread there are none, and a sound goes on
 * the first beat.
 */
export function sfxCommand(doc: EditDoc, rest: string, beat: string | null, at: number | null): SfxCommandResult {
  const cut = currentCut(doc)
  const words = rest.trim().toLowerCase()
  const resolved = resolveCut(cut, doc.words, doc.sources)
  // Only beats that play: one cut to a take that was not kept has no moment to sound on.
  const playing = resolved.beats.map((b) => b.id)
  if (playing.length === 0) return { say: 'There is nothing in the cut to put a sound on.' }
  const target = beat && playing.includes(beat) ? beat : playing[0]
  const here = cut.beats.find((b) => b.id === target)!

  if (words === '') return { say: sfxHelp() }

  if (/^(off|none|remove)\s+(all|every(thing)?)$/.test(words)) {
    const ops = cut.beats.filter((b) => b.sfx?.length).map((b) => ({ op: 'sfx' as const, beats: [b.id], add: null }))
    return ops.length ? { ops } : { say: 'There are no sounds to take off.' }
  }
  if (/^(off|none|remove)$/.test(words)) {
    return here.sfx?.length ? { ops: [{ op: 'sfx', beats: [target], add: null }] } : { say: 'This beat has no sounds.' }
  }

  if (/^(louder|up|quieter|softer|down)$/.test(words)) {
    const sounds = here.sfx ?? []
    if (!sounds.length) return { say: 'This beat has no sounds to turn up or down.' }
    const step = /^(louder|up)$/.test(words) ? STEP_DB : -STEP_DB
    const ops: Op[] = [{ op: 'sfx', beats: [target], add: null }]
    for (const s of sounds) {
      const gainDb = Math.min(12, Math.max(-30, (s.gainDb ?? 0) + step))
      ops.push({ op: 'sfx', beats: [target], add: { ...s, gainDb } })
    }
    return { ops }
  }

  if (/^(transitions?|whooshes)$/.test(words)) {
    // A whoosh belongs on a transition that moves: a whip, a push, a slide, a zoom. A dissolve or a dip is quiet.
    const MOVES = new Set(['whip', 'slide', 'cover', 'zoom'])
    const moving = cut.beats.filter((b) => b.transition && MOVES.has(TRANSITION_INFO[shownTransition(b.transition)].preview))
    const fresh = moving.filter((b) => !(b.sfx ?? []).some((s) => s.kind === 'whoosh' && !s.word))
    if (moving.length === 0) return { say: 'There is no moving transition for a whoosh. /transition whip adds one.' }
    if (fresh.length === 0) return { say: 'Every moving transition already has a whoosh.' }
    return { ops: fresh.map((b) => ({ op: 'sfx' as const, beats: [b.id], add: { kind: 'whoosh' as const } })) }
  }

  // The word under the playhead, for sounds that land on one.
  const wordHere =
    at === null
      ? null
      : (resolved.words.find((w) => w.beat === target && at >= w.outStart - 0.05 && at <= w.outEnd + 0.05) ?? null)

  const kind = SFX_KINDS.find((k) => k === words) as SfxKind | undefined
  if (kind) {
    const add: Sfx = { kind }
    if (SFX_INFO[kind].onWord && wordHere) add.word = wordHere.id
    return { ops: [{ op: 'sfx', beats: [target], add }] }
  }
  if (/^(file|choose|mine|my own)$/.test(words))
    return { file: { name: null, beat: target, word: wordHere?.id ?? null } }
  return { file: { name: rest.trim(), beat: target, word: wordHere?.id ?? null } }
}

/** "4", "4 and 6", "4, 6 and 9". */
function listOf(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '')
}

/**
 * What the sound ops in a plan did, in a few words each: "a whoosh plays on
 * the cut into beats 4 and 6", "a pop plays on “settings”", "beat 2 has no
 * sounds now". A beat's sounds taken off and put back, as /sfx louder does,
 * read as the sounds put back.
 */
export function describeSfx(ops: Op[], after: Resolved): string[] {
  const sfx = ops.filter((o): o is Extract<Op, { op: 'sfx' }> => o.op === 'sfx')
  const position = (id: string): string => String((after.beats.find((b) => b.id === id)?.index ?? -1) + 1)
  const wordOf = (id: string): string =>
    `“${after.words.find((w) => w.id === id)?.text.replace(/[^\p{L}\p{N}'’-]/gu, '') ?? id}”`
  const added = new Map<string, { what: string; how: string; beats: string[]; words: string[] }>()
  const cleared = new Set<string>()
  const refilled = new Set<string>()
  for (const o of sfx) {
    if (o.add === null) {
      o.beats.forEach((b) => cleared.add(b))
      continue
    }
    o.beats.forEach((b) => refilled.add(b))
    const gain = o.add.gainDb ? ` at ${o.add.gainDb > 0 ? '+' : ''}${o.add.gainDb} dB` : ''
    const how = o.add.word ? 'on' : o.add.kind === 'riser' ? 'into' : 'on the cut into'
    const what = `${sfxName(o.add)}${gain}`
    const key = `${what}|${how}`
    const entry = added.get(key) ?? { what, how, beats: [], words: [] }
    if (o.add.word) entry.words.push(wordOf(o.add.word))
    else entry.beats.push(...o.beats.map(position))
    added.set(key, entry)
  }
  const said: string[] = []
  for (const { what, how, beats, words } of added.values()) {
    const where = words.length ? listOf(words) : `${beats.length > 1 ? 'beats' : 'beat'} ${listOf(beats)}`
    said.push(`${what} plays ${how} ${where}`)
  }
  const gone = [...cleared].filter((b) => !refilled.has(b))
  if (gone.length === 1) said.push(`beat ${position(gone[0])} has no sounds now`)
  else if (gone.length > 1) said.push(`${gone.length} beats have no sounds now`)
  return said
}
