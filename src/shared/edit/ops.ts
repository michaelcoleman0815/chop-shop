import { addMotion, removeMotion, updateMotion, type MotionOpContext, type MotionResult } from '../motion/apply'
import { addFx, removeFx, updateFx, type FxResult } from '../fx/apply'
import { DEFAULT_MUSIC, MusicSchema, type Music } from './audio'
import { fillMode } from './fill'
import { mergeLook } from './look'
import type { Sfx } from './sfx'
import { indexWords, type WordIndex } from './resolve'
import { keptTransition, MIN_TRANSITION_SEC, TRANSITION_INFO } from './transitions'
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
  type Treatment,
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
  /** The edit's material, so graphics that show a picture can check it is there. */
  assets?: { id: string; kind: string }[]
}

export interface OpsResult {
  cut: Cut
  applied: Op[]
  rejected: { op: unknown; reason: string }[]
}

interface Ctx {
  index: WordIndex
  sources: Map<string, Source>
  /** Picture asset ids, or null when the caller did not say. */
  pictures: Set<string> | null
  /** Material a grid panel can show (footage and pictures), or null when the caller did not say. */
  material: Set<string> | null
}

function makeCtx(ctx: OpContext): Ctx {
  return {
    index: indexWords(ctx.words),
    sources: new Map(ctx.sources.map((s) => [s.id, s])),
    pictures: ctx.assets ? new Set(ctx.assets.filter((a) => a.kind === 'image').map((a) => a.id)) : null,
    material: ctx.assets
      ? new Set(ctx.assets.filter((a) => a.kind === 'image' || a.kind === 'video').map((a) => a.id))
      : null
  }
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

/**
 * A cold open's bites keep the breath before a word and the end of the last one, as the beats of the
 * conversation do: cut closer, they start and stop mid-breath.
 */
const COLD_PAD_IN = DEFAULT_PAD_IN
const COLD_PAD_OUT = DEFAULT_PAD_OUT
/** Out of a cold open and into the conversation: a short dip to black, the one transition it makes itself. */
const COLD_DIP_SEC = 0.3

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
      // A freeze frame, like a big word, belongs to the half that holds its
      // word; so does a camera move that lands on one. Other moves go on both.
      const freezeAt = beat.treatment.freeze ? ctx.index.pos.get(beat.treatment.freeze.word) : undefined
      const cameraAt = beat.treatment.camera?.word ? ctx.index.pos.get(beat.treatment.camera.word) : undefined
      const camera = (treatment: Treatment, inHead: boolean): Treatment => {
        if (cameraAt === undefined || cameraAt < s === inHead) return treatment
        const { camera: _c, ...rest } = treatment
        return rest
      }
      const inTail = (e: Sfx): boolean => !!e.word && (ctx.index.pos.get(e.word) ?? -1) >= s
      const headSfx = (beat.sfx ?? []).filter((e) => !inTail(e))
      const tailSfx = (beat.sfx ?? []).filter(inTail)
      const head: Beat = {
        ...beat,
        ...(beat.sfx ? { sfx: headSfx } : {}),
        to: ctx.index.words[s - 1].id,
        padOut: DEFAULT_PAD_OUT,
        treatment: camera(
          {
            ...beat.treatment,
            bigWord: bigAt !== undefined && bigAt < s ? beat.treatment.bigWord : null,
            ...(freezeAt !== undefined ? { freeze: freezeAt < s ? beat.treatment.freeze : null } : {})
          },
          true
        )
      }
      // The way the beat came in stays with its head; the tail carries straight on.
      const { transition: _in, splitEdit: _split, sfx: _sfx, ...rest } = beat
      const tail: Beat = {
        ...rest,
        ...(tailSfx.length ? { sfx: tailSfx } : {}),
        id: nextBeatId(cut),
        from: op.at,
        padIn: DEFAULT_PAD_IN,
        treatment: camera(
          {
            ...beat.treatment,
            bigWord: bigAt !== undefined && bigAt >= s ? beat.treatment.bigWord : null,
            ...(freezeAt !== undefined ? { freeze: freezeAt >= s ? beat.treatment.freeze : null } : {})
          },
          false
        )
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
      const kept = [...(beat.sfx ?? []), ...(next.sfx ?? []).filter((e) => e.word)]
      const joined: Beat = { ...beat, to: next.to, padOut: next.padOut, ...(kept.length ? { sfx: kept } : {}) }
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
      // A grid shows what the edit has: its recordings, and its material when the caller said what that is.
      for (const panel of op.set.grid?.panels ?? []) {
        const id = panel.show.trim()
        if (id && !ctx.sources.has(id) && ctx.material && !ctx.material.has(id))
          throw new OpError(`There is no recording or material ${id} in this edit to put in the grid.`)
      }
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

    case 'cold-open': {
      // The cold open there was goes; the conversation's first beat can have no way in, with nothing before it.
      const body = cut.beats.filter((b) => !b.coldOpen)
      const strip = (b: Beat): Beat => {
        const { transition: _t, ...rest } = b
        return rest
      }
      if (op.bites.length === 0) return { ...cut, beats: body.map((b, i) => (i === 0 ? strip(b) : b)) }
      if (body.length === 0) throw new OpError('There is no conversation to open on.')
      let n = Number(/^b(\d+)$/.exec(nextBeatId(cut))?.[1] ?? cut.beats.length + 1)
      const opened = op.bites.map((bite, i): Beat => {
        const [a] = wordRange(ctx, bite.from, bite.to)
        const beat = buildBeat({ source: ctx.index.words[a].source, from: bite.from, to: bite.to }, `b${n++}`, ctx)
        // Hard cuts between bites: a flash on a pattern lands at random (the owner, 22 November).
        return { ...beat, padIn: COLD_PAD_IN, padOut: COLD_PAD_OUT, coldOpen: true }
      })
      const [first, ...rest] = body
      return { ...cut, beats: [...opened, { ...strip(first), transition: keptTransition('dip-to-black', COLD_DIP_SEC) }, ...rest] }
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

    case 'transition': {
      const targets = op.beats.map((id) => findBeat(cut, id))
      // Nothing comes before the first beat, so nothing can transition into
      // it; the whole video fades in instead.
      const into = targets.filter((i) => i > 0)
      if (op.kind !== 'cut' && into.length === 0) {
        throw new OpError(`Nothing comes before ${cut.beats[targets[0]].id}, so it can only fade in. Use a fade.`)
      }
      const beats = [...cut.beats]
      for (const i of op.kind === 'cut' ? targets : into) {
        // A beat comes in one way: a transition replaces a J or L cut.
        const { transition: _old, splitEdit: _split, ...beat } = beats[i]
        beats[i] =
          op.kind === 'cut'
            ? { ...beat, ...(beats[i].splitEdit ? { splitEdit: beats[i].splitEdit } : {}) }
            : { ...beat, transition: keptTransition(op.kind, op.sec ?? TRANSITION_INFO[op.kind].defaultSec) }
      }
      return { ...cut, beats }
    }

    case 'speed': {
      const targets = op.beats.map((id) => findBeat(cut, id))
      const beats = [...cut.beats]
      const still = Math.abs(op.speed - 1) < 1e-6 && !(op.ramp && (op.ramp.inSec > 0 || op.ramp.outSec > 0))
      for (const i of targets) {
        const t = beats[i].treatment
        // A beat showing a cutaway speeds the cutaway: the voice under it keeps its pace.
        const of = op.of ?? (t.broll && t.frame !== 'speaker' ? 'cutaway' : 'beat')
        if (of === 'cutaway') {
          if (!t.broll) throw new OpError(`${beats[i].id} shows no cutaway to change the speed of.`)
          const { speed: _s, ramp: _r, ...broll } = t.broll
          beats[i] = {
            ...beats[i],
            treatment: { ...t, broll: still ? broll : { ...broll, speed: op.speed, ramp: op.ramp ?? null } }
          }
        } else {
          const { speed: _s, ramp: _r, ...rest } = t
          beats[i] = { ...beats[i], treatment: still ? rest : { ...rest, speed: op.speed, ramp: op.ramp ?? null } }
        }
      }
      return { ...cut, beats }
    }

    case 'freeze': {
      const i = findBeat(cut, op.beat)
      const beat = cut.beats[i]
      if (op.sec > 0) {
        const p = ctx.index.pos.get(op.word)
        if (beat.from === null || beat.to === null || p === undefined) {
          throw new OpError(`${op.word} is not a word in ${beat.id}.`)
        }
        const [a, b] = beatRange(ctx, beat)
        if (p < a || p > b) throw new OpError(`${op.word} is not a word in ${beat.id}.`)
        if (cut.removed.includes(op.word)) throw new OpError(`${op.word} is struck, so there is nothing to freeze on.`)
      }
      const { freeze: _f, ...rest } = beat.treatment
      const beats = [...cut.beats]
      beats[i] = {
        ...beat,
        treatment: op.sec > 0 ? { ...rest, freeze: { word: op.word, sec: Math.max(0.1, op.sec) } } : rest
      }
      return { ...cut, beats }
    }

    case 'reverse': {
      const targets = op.beats.map((id) => findBeat(cut, id))
      const beats = [...cut.beats]
      for (const i of targets) {
        const t = beats[i].treatment
        // Like speed: a beat showing a cutaway reverses the cutaway, not the voice under it.
        const of = op.of ?? (t.broll && t.frame !== 'speaker' ? 'cutaway' : 'beat')
        if (of === 'cutaway') {
          if (!t.broll) throw new OpError(`${beats[i].id} shows no cutaway to play backwards.`)
          const { reverse: _r, ...broll } = t.broll
          beats[i] = { ...beats[i], treatment: { ...t, broll: op.on ? { ...broll, reverse: true } : broll } }
        } else {
          const { reverse: _r, ...rest } = t
          beats[i] = { ...beats[i], treatment: op.on ? { ...rest, reverse: true } : rest }
        }
      }
      return { ...cut, beats }
    }

    case 'camera': {
      const targets = op.beats.map((id) => findBeat(cut, id))
      const beats = [...cut.beats]
      for (const i of targets) {
        const beat = beats[i]
        const t = beat.treatment
        if (op.move?.word) {
          // A punch-in or a shake lands on a word the beat plays.
          const p = ctx.index.pos.get(op.move.word)
          const [a, b] = beat.from !== null && beat.to !== null ? beatRange(ctx, beat) : [-1, -2]
          if (p === undefined || p < a || p > b) throw new OpError(`${op.move.word} is not a word in ${beat.id}.`)
        }
        // Like speed: a beat showing a cutaway moves over the cutaway.
        const of = op.of ?? (t.broll && t.frame !== 'speaker' ? 'cutaway' : 'beat')
        if (of === 'cutaway') {
          if (!t.broll) throw new OpError(`${beat.id} shows no cutaway to move over.`)
          if (t.frame === 'card' && op.move)
            throw new OpError(`${beat.id} shows its picture on a card, which stays still.`)
          const { camera: _c, ...broll } = t.broll
          beats[i] = { ...beat, treatment: { ...t, broll: op.move ? { ...broll, camera: op.move } : broll } }
        } else {
          const { camera: _c, ...rest } = t
          beats[i] = { ...beat, treatment: op.move ? { ...rest, camera: op.move } : rest }
        }
      }
      return { ...cut, beats }
    }

    case 'jcut':
    case 'lcut': {
      const targets = op.beats.map((id) => findBeat(cut, id))
      const into = targets.filter((i) => i > 0)
      if (op.sec > 0 && into.length === 0) {
        throw new OpError(`Nothing comes before ${cut.beats[targets[0]].id}, so its sound and picture start together.`)
      }
      const beats = [...cut.beats]
      for (const i of op.sec > 0 ? into : targets) {
        // A J or L cut replaces a transition: the edit is one or the other.
        const { transition: _old, splitEdit: _split, ...beat } = beats[i]
        beats[i] =
          op.sec > 0
            ? { ...beat, splitEdit: { kind: op.op === 'jcut' ? 'j' : 'l', sec: Math.max(MIN_TRANSITION_SEC, op.sec) } }
            : { ...beat, ...(beats[i].transition ? { transition: beats[i].transition } : {}) }
      }
      return { ...cut, beats }
    }

    case 'sfx': {
      const targets = op.beats.map((id) => findBeat(cut, id))
      const add = op.add
      if (add?.word) {
        if (targets.length !== 1) throw new OpError('A sound on a word belongs to one beat; name only that beat.')
        const beat = cut.beats[targets[0]]
        const p = ctx.index.pos.get(add.word)
        const inside =
          beat.from !== null && p !== undefined && p >= beatRange(ctx, beat)[0] && p <= beatRange(ctx, beat)[1]
        if (!inside) throw new OpError(`${add.word} is not a word in ${beat.id}.`)
      }
      const beats = [...cut.beats]
      for (const t of targets) {
        const { sfx: was, ...rest } = beats[t]
        if (add === null) {
          beats[t] = rest
          continue
        }
        // The same sound on the same moment is replaced, so adding it again changes it.
        const same = (e: Sfx): boolean => e.word === add.word && (e.kind ?? e.path) === (add.kind ?? add.path)
        const next = [...(was ?? []).filter((e) => !same(e)), add]
        if (next.length > 12) throw new OpError(`${beats[t].id} has as many sounds as a beat can hold.`)
        beats[t] = { ...rest, sfx: next }
      }
      return { ...cut, beats }
    }

    case 'sync': {
      const camera = ctx.sources.get(op.source)
      if (!camera) throw new OpError(`There is no recording ${op.source}.`)
      const others = (cut.angles ?? []).filter((a) => a.source !== op.source || (op.of !== null && a.of !== op.of))
      if (op.of === null) {
        // The camera leaves the edit, and every beat that showed it shows its own recording again.
        const beats = cut.beats.map((b) => {
          if (b.treatment.angle?.source !== op.source) return b
          const { angle: _a, ...treatment } = b.treatment
          return { ...b, treatment }
        })
        const { angles: _was, ...rest } = cut
        return others.length ? { ...rest, beats, angles: others } : { ...rest, beats }
      }
      if (op.of === op.source) throw new OpError('A recording cannot be another camera of itself.')
      if (!ctx.sources.has(op.of)) throw new OpError(`There is no recording ${op.of}.`)
      const was = (cut.angles ?? []).find((a) => a.source === op.source && a.of === op.of)
      const offsetSec = op.offsetSec ?? was?.offsetSec ?? 0
      return { ...cut, angles: [...others, { source: op.source, of: op.of, offsetSec }] }
    }

    case 'reframe': {
      const { reframe: _was, ...rest } = cut
      return op.on ? { ...rest, reframe: true } : rest
    }
    case 'respell': {
      const word = ctx.index.words[ctx.index.pos.get(op.word) ?? -1]
      if (!word) throw new OpError(`There is no word ${op.word}.`)
      const { [op.word]: _was, ...rest } = cut.spelled ?? {}
      // Set back to what was heard, it is no longer a correction.
      const spelled = op.text === word.text ? rest : { ...rest, [op.word]: op.text }
      if (Object.keys(spelled).length === 0) {
        const { spelled: _old, ...without } = cut
        return without
      }
      return { ...cut, spelled }
    }

    case 'punch-jumps': {
      if (cut.punchJumps === op.on) return cut
      return { ...cut, punchJumps: op.on }
    }

    case 'brand':
      return { ...cut, brand: op.id }

    case 'box': {
      const { box: _was, ...rest } = cut
      return op.set ? { ...rest, box: op.set } : rest
    }

    case 'fill':
      // Said outright, auto too: a cut that says nothing was made before the fill, and is cropped.
      return fillMode(cut) === op.mode ? cut : { ...cut, fill: op.mode }

    case 'framing': {
      const beats = [...cut.beats]
      for (const i of op.beats.map((id) => findBeat(cut, id))) {
        const { framing: _was, ...treatment } = beats[i].treatment
        beats[i] = { ...beats[i], treatment: op.x === null ? treatment : { ...treatment, framing: op.x } }
      }
      return { ...cut, beats }
    }

    case 'angle': {
      const targets = op.beats.map((id) => findBeat(cut, id))
      const beats = [...cut.beats]
      for (const i of targets) {
        const beat = beats[i]
        const { angle: was, ...treatment } = beat.treatment
        if (op.source === null) {
          beats[i] = { ...beat, treatment }
          continue
        }
        if (!(cut.angles ?? []).some((a) => a.source === op.source && a.of === beat.source)) {
          throw new OpError(`${op.source} is not lined up as a camera of ${beat.id}'s recording.`)
        }
        const layout = op.layout ?? (was?.source === op.source ? was.layout : 'full')
        beats[i] = { ...beat, treatment: { ...treatment, angle: { source: op.source, layout } } }
      }
      return { ...cut, beats }
    }

    case 'chapters': {
      const { chapters: _was, ...rest } = cut
      if (op.set === null || op.set.length === 0) return rest
      const ids = new Set(cut.beats.map((b) => b.id))
      const missing = op.set.find((c) => !ids.has(c.beat))
      if (missing) throw new OpError(`${missing.beat} is not a beat in this cut.`)
      // One chapter per beat, the later naming winning, in the cut's order.
      const byBeat = new Map(op.set.map((c) => [c.beat, { beat: c.beat, title: c.title.trim() }]))
      return { ...rest, chapters: cut.beats.filter((b) => byBeat.has(b.id)).map((b) => byBeat.get(b.id)!) }
    }

    case 'look': {
      const { look: _was, ...rest } = cut
      const look = mergeLook(cut.look, op.set, op.replace)
      return look ? { ...rest, look } : rest
    }

    case 'voice': {
      const { voice: _v, ...rest } = cut
      const room = op.room ?? cut.voice?.room ?? false
      return op.polish > 0 || room ? { ...rest, voice: { polish: op.polish, ...(room ? { room: true } : {}) } } : rest
    }

    case 'music': {
      if (op.set === null) return { ...cut, music: null }
      const was = cut.music ?? null
      if (!was && !op.set.path) throw new OpError('There is no music yet. Choose a track for the bed first.')
      // A new track brings its own beats, length and loudness, or none.
      const fresh = !!op.set.path && op.set.path !== was?.path
      const base =
        was && !fresh ? was : { ...DEFAULT_MUSIC, ...(was ? pickLevels(was) : {}), path: op.set.path as string }
      return { ...cut, music: MusicSchema.parse({ ...base, ...op.set }) }
    }

    case 'fade': {
      const was = cut.fade ?? { inSec: 0, outSec: 0, color: 'black' as const }
      const fade = { inSec: op.inSec ?? was.inSec, outSec: op.outSec ?? was.outSec, color: op.color ?? was.color }
      return { ...cut, fade: fade.inSec > 0 || fade.outSec > 0 ? fade : null }
    }

    // Graphics over the picture. The checks and the merging live in shared/motion.
    case 'motion-add': {
      const { op: _op, ...call } = op
      return motionCut(addMotion(cut, call, motionContext(cut, ctx)))
    }
    case 'motion-update': {
      const { op: _op, id, ...change } = op
      return motionCut(updateMotion(cut, id, change, motionContext(cut, ctx)))
    }
    case 'motion-remove':
      return motionCut(removeMotion(cut, op.ids))
    // Scene effects on the picture. The checks live in shared/fx.
    case 'fx-add': {
      const { op: _op, ...call } = op
      return fxCut(addFx(cut, call, motionContext(cut, ctx)))
    }
    case 'fx-update': {
      const { op: _op, id, ...change } = op
      return fxCut(updateFx(cut, id, change, motionContext(cut, ctx)))
    }
    case 'fx-remove':
      return fxCut(removeFx(cut, op.ids))
  }
}

function fxCut(result: FxResult): Cut {
  if (!result.ok) throw new OpError(result.reason)
  return result.cut
}

function motionContext(cut: Cut, ctx: Ctx): MotionOpContext {
  const pictures = ctx.pictures
  return {
    hasWord: (id) => ctx.index.pos.has(id),
    hasBeat: (id) => cut.beats.some((b) => b.id === id),
    ...(pictures ? { hasPicture: (id: string) => pictures.has(id) } : {})
  }
}

function motionCut(result: MotionResult): Cut {
  if (!result.ok) throw new OpError(result.reason)
  return result.cut
}

/** How a bed was set to sit, kept when its track is swapped for another. */
function pickLevels(m: Music): Pick<Music, 'levelDb' | 'duckDb' | 'fadeInSec' | 'fadeOutSec'> {
  return { levelDb: m.levelDb, duckDb: m.duckDb, fadeInSec: m.fadeInSec, fadeOutSec: m.fadeOutSec }
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
    return {
      id,
      source: source.id,
      from,
      to,
      inSec: null,
      outSec: null,
      padIn: DEFAULT_PAD_IN,
      padOut: DEFAULT_PAD_OUT,
      treatment
    }
  }

  const inSec = input.inSec ?? null
  const outSec = input.outSec ?? null
  if (inSec === null || outSec === null || outSec <= inSec) {
    throw new OpError('A beat without words needs a start and an end, the end after the start.')
  }
  if (inSec >= source.durationSec) throw new OpError(`${source.id} is only ${source.durationSec.toFixed(1)} s long.`)
  return {
    id,
    source: source.id,
    from: null,
    to: null,
    inSec,
    outSec: Math.min(outSec, source.durationSec),
    padIn: 0,
    padOut: 0,
    treatment
  }
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
  const graphics = new Set<string>()
  for (const m of cut.motion ?? []) {
    if (graphics.has(m.id)) problems.push(`Graphic ${m.id} appears twice.`)
    graphics.add(m.id)
  }
  return problems
}
