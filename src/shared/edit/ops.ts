import { indexWords, type WordIndex } from './resolve'
import {
  DEFAULT_PAD_IN,
  DEFAULT_PAD_OUT,
  DEFAULT_TREATMENT,
  OpSchema,
  type Beat,
  type BeatInput,
  type Cut,
  type Op,
  type Source,
  type Word
} from './schema'

/**
 * Applies ops to a cut. Pure: the cut passed in is never touched.
 *
 * A rejected op leaves the cut exactly as it was and says why in a sentence a
 * person can read, because these come back to the chat when a model proposes
 * something that cannot be done ("There is no beat b9").
 */

export class OpError extends Error {}

export interface OpContext {
  words: Word[]
  sources: Source[]
}

export interface OpsResult {
  cut: Cut
  applied: Op[]
  rejected: { op: unknown; reason: string }[]
}

interface Ctx {
  index: WordIndex
  sources: Map<string, Source>
}

function makeCtx(ctx: OpContext): Ctx {
  return { index: indexWords(ctx.words), sources: new Map(ctx.sources.map((s) => [s.id, s])) }
}

export function applyOps(cut: Cut, ops: unknown[], context: OpContext): OpsResult {
  const ctx = makeCtx(context)
  let current = cut
  const applied: Op[] = []
  const rejected: OpsResult['rejected'] = []
  for (const raw of ops) {
    const parsed = OpSchema.safeParse(raw)
    if (!parsed.success) {
      rejected.push({ op: raw, reason: `Not an op I know: ${parsed.error.issues[0]?.message ?? 'bad shape'}` })
      continue
    }
    try {
      current = step(current, parsed.data, ctx)
      applied.push(parsed.data)
    } catch (e) {
      if (!(e instanceof OpError)) throw e
      rejected.push({ op: parsed.data, reason: e.message })
    }
  }
  return { cut: current, applied, rejected }
}

/** Applies one op, throwing OpError when it cannot be done. */
export function applyOp(cut: Cut, op: Op, context: OpContext): Cut {
  return step(cut, OpSchema.parse(op), makeCtx(context))
}

function step(cut: Cut, op: Op, ctx: Ctx): Cut {
  switch (op.op) {
    case 'remove': {
      for (const id of op.beats) findBeat(cut, id)
      const drop = new Set(op.beats)
      return { ...cut, beats: cut.beats.filter((b) => !drop.has(b.id)) }
    }

    case 'strike':
    case 'unstrike': {
      const [a, b] = wordRange(ctx, op.from, op.to)
      const ids = ctx.index.words.slice(a, b + 1).map((w) => w.id)
      const removed = new Set(cut.removed)
      for (const id of ids) {
        if (op.op === 'strike') removed.add(id)
        else removed.delete(id)
      }
      // Kept in word order so equal cuts serialise identically.
      const ordered = [...removed].sort((x, y) => (ctx.index.pos.get(x) ?? 0) - (ctx.index.pos.get(y) ?? 0))
      return { ...cut, removed: ordered }
    }

    case 'move': {
      const at = findBeat(cut, op.beat)
      const beats = [...cut.beats]
      const [beat] = beats.splice(at, 1)
      beats.splice(Math.min(op.to, beats.length), 0, beat)
      return { ...cut, beats }
    }

    case 'split': {
      const at = findBeat(cut, op.beat)
      const beat = cut.beats[at]
      if (beat.from === null || beat.to === null) {
        throw new OpError(`${beat.id} has no words to split at.`)
      }
      const [a, b] = beatRange(ctx, beat)
      const s = ctx.index.pos.get(op.at)
      if (s === undefined) throw new OpError(`There is no word ${op.at}.`)
      if (s <= a || s > b) {
        throw new OpError(`${op.at} is not inside ${beat.id}, or it is already its first word.`)
      }
      const bigAt = beat.treatment.bigWord === null ? undefined : ctx.index.pos.get(beat.treatment.bigWord)
      const head: Beat = {
        ...beat,
        to: ctx.index.words[s - 1].id,
        padOut: DEFAULT_PAD_OUT,
        treatment: { ...beat.treatment, bigWord: bigAt !== undefined && bigAt < s ? beat.treatment.bigWord : null }
      }
      const tail: Beat = {
        ...beat,
        id: nextBeatId(cut),
        from: op.at,
        padIn: DEFAULT_PAD_IN,
        treatment: { ...beat.treatment, bigWord: bigAt !== undefined && bigAt >= s ? beat.treatment.bigWord : null }
      }
      const beats = [...cut.beats]
      beats.splice(at, 1, head, tail)
      return { ...cut, beats }
    }

    case 'join': {
      const at = findBeat(cut, op.beat)
      const beat = cut.beats[at]
      const next = cut.beats[at + 1]
      if (!next) throw new OpError(`${beat.id} is the last beat; there is nothing after it to join.`)
      if (beat.from === null || beat.to === null || next.from === null || next.to === null) {
        throw new OpError(`Only beats made of words can be joined.`)
      }
      if (beat.source !== next.source) throw new OpError(`${beat.id} and ${next.id} come from different recordings.`)
      const [, end] = beatRange(ctx, beat)
      const [start] = beatRange(ctx, next)
      // Joining is only honest when nothing the viewer has not seen comes back:
      // the words between the two must already be struck.
      const removed = new Set(cut.removed)
      const between = ctx.index.words.slice(end + 1, start)
      if (start <= end || between.some((w) => !removed.has(w.id))) {
        throw new OpError(`${beat.id} and ${next.id} are not next to each other in the recording.`)
      }
      const joined: Beat = { ...beat, to: next.to, padOut: next.padOut }
      const beats = [...cut.beats]
      beats.splice(at, 2, joined)
      return { ...cut, beats }
    }

    case 'pad': {
      const at = findBeat(cut, op.beat)
      const beats = [...cut.beats]
      beats[at] = {
        ...beats[at],
        padIn: op.padIn ?? beats[at].padIn,
        padOut: op.padOut ?? beats[at].padOut
      }
      return { ...cut, beats }
    }

    case 'treat': {
      const targets = op.beats.map((id) => findBeat(cut, id))
      if (op.set.bigWord !== undefined && op.set.bigWord !== null) {
        if (targets.length !== 1) throw new OpError('A big word belongs to one beat; name only that beat.')
        const beat = cut.beats[targets[0]]
        const p = ctx.index.pos.get(op.set.bigWord)
        if (beat.from === null || beat.to === null || p === undefined) {
          throw new OpError(`${op.set.bigWord} is not a word in ${beat.id}.`)
        }
        const [a, b] = beatRange(ctx, beat)
        if (p < a || p > b) throw new OpError(`${op.set.bigWord} is not a word in ${beat.id}.`)
      }
      const beats = [...cut.beats]
      for (const i of targets) {
        const treatment = { ...beats[i].treatment, ...op.set }
        const showsCutaway = treatment.frame === 'broll' || treatment.frame === 'split'
        if (showsCutaway && treatment.broll === null) {
          // Asked outright for a cutaway with none to show: refuse. A cutaway
          // taken away underneath one: the beat goes back to the speaker.
          if (op.set.frame !== undefined) {
            throw new OpError(`${beats[i].id} needs a cutaway before it can show one.`)
          }
          treatment.frame = 'speaker'
        }
        beats[i] = { ...beats[i], treatment }
      }
      return { ...cut, beats }
    }

    case 'insert': {
      const beat = buildBeat(op.beat, nextBeatId(cut), ctx)
      const beats = [...cut.beats]
      beats.splice(Math.min(op.to, beats.length), 0, beat)
      return { ...cut, beats }
    }

    case 'captions':
      return { ...cut, captions: { ...cut.captions, ...op.set } }

    case 'tighten':
      return { ...cut, tighten: op.set }

    case 'aspect':
      return { ...cut, aspect: op.aspect }

    case 'loudness':
      return { ...cut, loudness: op.lufs }
  }
}

function findBeat(cut: Cut, id: string): number {
  const i = cut.beats.findIndex((b) => b.id === id)
  if (i < 0) throw new OpError(`There is no beat ${id}.`)
  return i
}

function wordRange(ctx: Ctx, from: string, to: string): [number, number] {
  const a = ctx.index.pos.get(from)
  const b = ctx.index.pos.get(to)
  if (a === undefined) throw new OpError(`There is no word ${from}.`)
  if (b === undefined) throw new OpError(`There is no word ${to}.`)
  if (a > b) throw new OpError(`${from} comes after ${to}.`)
  if (ctx.index.words[a].source !== ctx.index.words[b].source) {
    throw new OpError(`${from} and ${to} are in different recordings.`)
  }
  return [a, b]
}

function beatRange(ctx: Ctx, beat: Beat): [number, number] {
  return wordRange(ctx, beat.from as string, beat.to as string)
}

/** b1, b2, ... continuing after the highest number in use. */
export function nextBeatId(cut: Cut): string {
  let max = 0
  for (const b of cut.beats) {
    const n = /^b(\d+)$/.exec(b.id)
    if (n) max = Math.max(max, Number(n[1]))
  }
  return `b${max + 1}`
}

function buildBeat(input: BeatInput, id: string, ctx: Ctx): Beat {
  const source = ctx.sources.get(input.source)
  if (!source) throw new OpError(`There is no recording ${input.source}.`)
  const treatment = { ...DEFAULT_TREATMENT, ...input.treatment }
  const from = input.from ?? null
  const to = input.to ?? null

  if (from !== null || to !== null) {
    if (from === null || to === null) throw new OpError('A beat made of words needs both a first and a last word.')
    const [a] = wordRange(ctx, from, to)
    if (ctx.index.words[a].source !== source.id) throw new OpError(`${from} is not in ${source.id}.`)
    return { id, source: source.id, from, to, inSec: null, outSec: null, padIn: DEFAULT_PAD_IN, padOut: DEFAULT_PAD_OUT, treatment }
  }

  const inSec = input.inSec ?? null
  const outSec = input.outSec ?? null
  if (inSec === null || outSec === null || outSec <= inSec) {
    throw new OpError('A beat without words needs a start and an end, the end after the start.')
  }
  if (inSec >= source.durationSec) throw new OpError(`${source.id} is only ${source.durationSec.toFixed(1)} s long.`)
  return { id, source: source.id, from: null, to: null, inSec, outSec: Math.min(outSec, source.durationSec), padIn: 0, padOut: 0, treatment }
}

/**
 * Problems that would make a cut play wrongly, as sentences. Empty means
 * sound. Run on anything loaded from disk or proposed from outside.
 */
export function checkCut(cut: Cut, context: OpContext): string[] {
  const ctx = makeCtx(context)
  const problems: string[] = []
  const seen = new Set<string>()
  for (const beat of cut.beats) {
    if (seen.has(beat.id)) problems.push(`${beat.id} appears twice.`)
    seen.add(beat.id)
    if (!ctx.sources.has(beat.source)) problems.push(`${beat.id} points at a missing recording.`)
    if (beat.from !== null || beat.to !== null) {
      try {
        const [a] = beatRange(ctx, beat)
        if (ctx.index.words[a].source !== beat.source) problems.push(`${beat.id}'s words are from another recording.`)
      } catch (e) {
        problems.push(`${beat.id}: ${(e as Error).message}`)
      }
    } else if (beat.inSec === null || beat.outSec === null || beat.outSec <= beat.inSec) {
      problems.push(`${beat.id} has neither words nor a start and end.`)
    }
    const big = beat.treatment.bigWord
    if (big !== null && !ctx.index.pos.has(big)) problems.push(`${beat.id}'s big word ${big} does not exist.`)
  }
  return problems
}
