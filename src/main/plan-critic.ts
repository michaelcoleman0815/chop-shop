import { z } from 'zod'
import {
  applyOps,
  beatPicture,
  cameraClock,
  cameraPlan,
  currentCut,
  resolveCut,
  type EditDoc,
  type Op
} from '../shared/edit'
import { template } from '../shared/motion/templates'
import { pageRoom } from '../shared/screen'
import { sceneForCut } from './motion-scene'
import { clock } from './plan-frames'
import type { PlannerOp } from './planner-prompt'

/**
 * The critic: whoever made an edit is the last to see what is wrong with it, so each piece of a planned edit (a
 * graphic, a camera move) is scored by a model that never saw the plan, only how it looks, what was asked for and
 * what is being said. Eight out of ten passes. What passes is locked; what fails goes back to the planner with its
 * one biggest problem, and a new critic, who has not seen the first try either, scores what came back.
 *
 * Here: which pieces a plan has and when to look at them, what the critic is told and how its verdict is read, and
 * how a plan handed back is held to changing only what failed. The calls are the planner's (main/planner).
 */

/** The score a piece ships at. */
export const PASS = 8
/** The most pieces judged in one go, spread over the edit, and stills sent. */
const MAX_PIECES = 14
const MAX_STILLS = 20

/** An applied op and the plan's op (by index) it came from. */
export interface MadeOp {
  op: Op
  from: number
  /** Made to give another op its room (edit/room), so it is judged with that one, not as a piece of its own. */
  room?: boolean
}

/** One piece of a planned edit: what a critic scores. */
export interface Piece {
  /** Its number to the critic and the planner: its op's place in the plan, from 1. */
  n: number
  /** Its op in the plan, by index. */
  op: number
  /** What it is, in a few words. */
  what: string
  /** The plan's op for the board it sits on, when it sits on one. */
  board: number | null
  /** Moments to look at it, in the edit's seconds. */
  at: number[]
  /** What is said while it is up. */
  said: string
  /** For a camera move, what is being said at the moment it is looked at. */
  now?: string
  /** Why it does not show at all, when it does not. */
  hidden: string | null
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The pieces a plan adds: its graphics (a board is judged with what is on it) and its camera moves, in order. */
export function piecesOf(doc: EditDoc, made: MadeOp[]): Piece[] {
  const context = { words: doc.words, sources: doc.sources, assets: doc.assets }
  let cut = currentCut(doc)
  const graphics: { id: string; from: number }[] = []
  for (const m of made) {
    const had = new Set((cut.motion ?? []).map((i) => i.id))
    cut = applyOps(cut, [m.op], context).cut
    if (m.op.op === 'motion-add') for (const i of cut.motion ?? []) if (!had.has(i.id)) graphics.push({ id: i.id, from: m.from })
  }
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const scene = sceneForCut({ cut, resolved, words: doc.words, sources: doc.sources, brand: null })
  const said = (from: number, to: number): string =>
    resolved.words
      .filter((w) => w.outEnd > from && w.outStart < to)
      .slice(0, 40)
      .map((w) => w.text)
      .join(' ')
  const boards = graphics.flatMap((g) => {
    const item = scene.items.find((i) => i.id === g.id && i.kind === 'board')
    return item ? [{ from: g.from, start: item.start, end: item.end }] : []
  })
  const pieces: Piece[] = []
  for (const g of graphics) {
    const call = (cut.motion ?? []).find((i) => i.id === g.id)
    if (!call || call.kind === 'board') continue
    const name = template(call.kind)?.name(call) ?? call.kind
    const what = `${call.kind} (${name})`
    const item = scene.items.find((i) => i.id === g.id)
    if (!item) {
      const why = scene.hidden.find((h) => h.id === g.id)?.reason ?? 'it has nowhere to show'
      pieces.push({ n: g.from + 1, op: g.from, what, board: null, at: [], said: '', hidden: why })
      continue
    }
    const length = item.end - item.start
    // Once everything on it has come in and before it starts to go, and as it arrives when it is up for a while.
    const settled = item.start + clamp(length * 0.72, Math.min(0.5, length / 2), Math.max(length / 2, length - 0.4))
    const early = item.start + Math.min(0.8, length * 0.25)
    const board = boards.find((b) => b.start < item.end - 0.05 && b.end > item.start + 0.05)
    pieces.push({
      n: g.from + 1,
      op: g.from,
      what,
      board: board?.from ?? null,
      at: length > 2.6 ? [early, settled] : [settled],
      said: said(item.start, item.end),
      hidden: null
    })
  }
  for (const m of made) {
    if (m.room || m.op.op !== 'camera' || !m.op.move || m.op.of === 'cutaway') continue
    const beat = m.op.beats.find((id) => resolved.beats.some((b) => b.id === id))
    const span = beat ? beatPicture(resolved, beat) : null
    const piece = beat ? resolved.pieces.find((p) => p.beat === beat) : undefined
    const source = piece && doc.sources.find((s) => s.id === piece.source)
    if (!beat || !span || !piece || !source) continue
    // As close as the move gets: at its last key, or the beat's end.
    const at0 = cameraClock(resolved, beat, span.start, m.op.move.word)
    const room = source.screen ? pageRoom(source.screen, piece.srcStart, piece.srcEnd) : null
    const aspect = scene.size.width / Math.max(1, scene.size.height)
    const plan = cameraPlan(m.op.move, span.end - span.start, at0?.wordAt ?? null, source.width / Math.max(1, source.height), aspect, room)
    const last = plan.keys[plan.keys.length - 1].t
    const at = span.start + clamp(last + 0.05, 0.1, Math.max(0.1, span.end - span.start - 0.08))
    const many = m.op.beats.length > 1 ? `, on ${m.op.beats.length} beats` : ''
    pieces.push({
      n: m.from + 1,
      op: m.from,
      what: `camera (${m.op.move.kind}${many})`,
      board: null,
      at: [at],
      said: said(span.start, span.end),
      now: said(at - 0.4, at + 0.6),
      hidden: null
    })
  }
  return pieces.sort((a, b) => (a.at[0] ?? 0) - (b.at[0] ?? 0))
}

/** The pieces to judge: all of them, or as many as fit spread over the edit, with the stills each is looked at in. */
export function looksAt(pieces: Piece[]): { piece: Piece; at: number; label: string }[] {
  const shown = pieces.filter((p) => p.at.length > 0)
  const some =
    shown.length <= MAX_PIECES
      ? shown
      : Array.from({ length: MAX_PIECES }, (_, i) => shown[Math.floor((i * shown.length) / MAX_PIECES)])
  const all = some.flatMap((piece) =>
    piece.at.map((at, i) => ({
      piece,
      at,
      early: piece.at.length > 1 && i === 0,
      label: `Piece ${piece.n}, ${piece.what}, at ${clock(at)}${piece.at.length > 1 ? (i === 0 ? ', as it arrives' : ', once it is all in') : ''}. Said while it is up: "${piece.said}"${piece.now ? `; right then: "${piece.now}"` : ''}`
    }))
  )
  // Too many: the arrivals go first.
  const kept = all.length <= MAX_STILLS ? all : all.filter((l) => !l.early).slice(0, MAX_STILLS)
  return kept.map(({ piece, at, label }) => ({ piece, at, label }))
}

// ---------- What the critic is told, and its verdict ----------

export const VERDICT_TOOL = 'verdict'
const VerdictSchema = z.object({
  pieces: z.array(z.object({ piece: z.number(), score: z.number(), problem: z.string(), fix: z.string() })),
  missing: z.string()
})
const { $schema: _draft, ...verdictInput } = z.toJSONSchema(VerdictSchema) as Record<string, unknown>
export const VERDICT_SCHEMA = verdictInput as { type: 'object' } & Record<string, unknown>
export const VERDICT_DESCRIPTION =
  'Hand over the verdict: for every piece its number, its score from 1 to 10, its one biggest problem and the smallest change that would fix it (both empty for a piece scored 8 or more), and the one moment that plainly needs showing and is not, or an empty string.'

/** The critic's instructions; `styles` is what the named creators' videos are like (planner-prompt STYLE_CARDS). */
export function criticSystem(styles: string): string {
  return `You are the last person to look at a video edit before it goes out: an editor who has cut for the best channels on YouTube. You did not make this edit and owe it nothing. You are shown stills of it: the footage at a moment with one piece of the edit up (a graphic, or a camera move), what the person asked for, and what is being said. You score each piece from 1 to 10 and call the ${VERDICT_TOOL} tool once.

## The scale
- 9 or 10: people would copy it.
- 8: you would ship it as it is.
- 7: fine. Fine does not ship.
- 5 or 6: a template anyone could have used, or a good idea in the wrong place or size.
- 4 or less: the video is better without it.
A simple piece that does its one job cleanly is an 8 or a 9: do not mark a piece down for being plain, or look for a fault to have one. Do not mark it up for being busy or for the effort in it. Two pieces are rarely worth the same: say which is stronger.

## What to look at
1. It reads at once. On a phone, at arm's length, in a second: big enough, enough contrast with what is behind it, few enough words, nothing cut off by the frame's edge or running into something else.
2. It covers nothing that matters: the speaker's face, the window they are kept in, words on the screen being talked about, graphics already in the footage.
3. It sits well: sized for the room it has and lined up with it, not small in a corner of an empty board, not crowding an edge.
4. It earns its place: it shows what the words alone do not (a structure, a comparison, a number, the thing itself). Only repeating a phrase as it is said is a 6 at best, unless captions or that style of video were asked for. What it says is what is being said, figures and names right. A figure of speech drawn as an object (a wheel for "spinning your wheels", a track for "the race"), and anything laid over footage that already shows the point, is a 3: its fix is "Take it out."
5. It belongs to this video, and to no other: it fits the footage's own look and any style the person named, and it looks like someone thought about this moment. If it could be dropped into any video, it is a 6 at best. The same kind of graphic a second time in the edit, in the same clothes, is a 6 at best too, unless it is a series that is meant to come back (a chapter marker, a list being ticked off); say which one to keep.
6. It is up at the right time: the words given beside it are the words it is about.
A camera move is judged by what it frames: is the thing being talked about clearer and nearer, whole, and not cut off in a way that reads badly. One that gets hardly any closer, or that hides part of what is being read (behind the speaker's window, off the edge), does nothing a still frame would not: its fix is "Take it out." unless there is a smaller thing in the same place worth framing.

## What not to judge
Motion, sound and the footage itself: you cannot see or hear them. Words set behind the speaker are drawn in front of them in these stills; that is not a fault. What the person asked for in words is right, whatever you would have done.

## The verdict
For a piece under 8: "problem" is the one biggest thing wrong, where in the frame it is, in one sentence. "fix" is the smallest change that would take it to an 8, as what should be seen, in one sentence; "Take it out." when the video is better without it. For 8 or more, leave both empty.
"missing": the one moment among those said that plainly needs showing and has nothing, in one sentence, or an empty string. Most edits have none.

${styles}`
}

export function criticAsk(request: string, pieces: Piece[]): string {
  const asked = request.trim() || 'the notes on the cut carried out'
  return `<request>\n${asked}\n</request>\n\nThe pieces to score: ${pieces.map((p) => p.n).join(', ')}. The stills follow, each labelled with its piece.`
}

export interface Verdict {
  scores: Map<number, { score: number; problem: string; fix: string }>
  missing: string
}

/** A verdict as the critic handed it over; null when there is none to read. */
export function readVerdict(content: { type: string; name?: string; input?: unknown }[]): Verdict | null {
  const call = content.find((b) => b.type === 'tool_use' && b.name === VERDICT_TOOL)
  const o = call?.input as { pieces?: unknown; missing?: unknown } | undefined
  if (!o || !Array.isArray(o.pieces)) return null
  const scores: Verdict['scores'] = new Map()
  for (const raw of o.pieces) {
    const p = raw as { piece?: unknown; score?: unknown; problem?: unknown; fix?: unknown }
    const n = Number(p?.piece)
    const score = Number(p?.score)
    if (!Number.isInteger(n) || !Number.isFinite(score)) continue
    const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
    scores.set(n, { score: clamp(Math.round(score), 1, 10), problem: text(p.problem), fix: text(p.fix) })
  }
  return scores.size ? { scores, missing: typeof o.missing === 'string' ? o.missing.trim() : '' } : null
}

// ---------- Redoing what failed, and nothing else ----------

/** What a piece scored, for the one that failed to be told and for the log. */
export interface Judged {
  n: number
  what: string
  score: number
  problem: string
  fix: string
}

/** Every piece with its score: one that does not show scores 1, one the critic left out passes. */
export function judgedOf(pieces: Piece[], verdict: Verdict): (Judged & { piece: Piece })[] {
  return pieces.map((piece) => {
    const s = piece.hidden ? { score: 1, problem: `It does not show: ${piece.hidden}`, fix: '' } : verdict.scores.get(piece.n)
    return { piece, n: piece.n, what: piece.what, score: s?.score ?? PASS, problem: s?.problem ?? '', fix: s?.fix ?? '' }
  })
}

/**
 * The plan's ops that stay as they are: everything but what failed, its board when nothing that passed is on it,
 * and sounds, which go with what they sound on.
 */
export function lockedOps(ops: PlannerOp[], judged: (Judged & { piece: Piece })[]): Set<number> {
  const failed = new Set(judged.filter((j) => j.score < PASS).map((j) => j.piece.op))
  const kept = new Set(judged.filter((j) => j.score >= PASS).flatMap((j) => (j.piece.board === null ? [] : [j.piece.board])))
  for (const j of judged) if (j.score < PASS && j.piece.board !== null && !kept.has(j.piece.board)) failed.add(j.piece.board)
  return new Set(ops.map((_, i) => i).filter((i) => !failed.has(i) && ops[i].op !== 'sfx'))
}

/** What the planner hears: what passed, and for each piece that did not, its score, its problem, the fix and its op. */
export function redoAsk(judged: (Judged & { piece: Piece })[], missing: string, ops: PlannerOp[], bare: string[] = []): string {
  const failed = judged.filter((j) => j.score < PASS)
  const passed = judged.filter((j) => j.score >= PASS)
  const line = (j: Judged & { piece: Piece }): string =>
    `- Piece ${j.n}, ${j.what}: ${j.score}/10. ${j.problem || 'Not good enough to ship.'}${j.fix ? ` ${j.fix}` : ''}\n  As it stands: ${JSON.stringify(ops[j.piece.op]).slice(0, 700)}`
  return [
    'Your edit was drawn and judged by an editor who has not seen your plan, only how it looks. A piece ships at 8 out of 10.',
    passed.length
      ? `Passed and locked: ${passed.map((j) => `${j.what} (${j.score})`).join(', ')}. Those, and everything in the plan not listed below, stay exactly as they are.`
      : 'Everything in the plan not listed below stays exactly as it is.',
    failed.length ? `Not passed:\n${failed.map(line).join('\n')}` : '',
    missing ? `Also said: ${missing} Add something for it only if you agree.` : '',
    bare.length
      ? `Left bare, the speaker talking with nothing new on screen:\n${bare.map((b) => `- ${b}`).join('\n')}\nAdd a graphic in each for what is said there (a figure, the companies named, a list, a line worth quoting), of a kind not used yet, unless nothing in it can be shown.`
      : '',
    `${failed.length ? 'Redo each piece that did not pass so its biggest problem is gone: another size, place, moment, wording or kind of graphic, or take it out when the video is better without it. Do not swap one template for another only to look different. ' : ''}Then call the plan tool with the whole plan.`
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Ops a redone plan may add or change: what is seen, and the sounds on it. */
const REDOABLE = new Set(['motion-add', 'camera', 'sfx', 'design'])

/** What an op is the same thing as, whatever its settings: a graphic by its kind and where it comes in, others by what they act on. */
function sameThing(op: PlannerOp): string {
  const o = op as unknown as Record<string, unknown>
  const on = ['kind', 'from', 'beat', 'beats', 'id', 'ids', 'of', 'word', 'to'].filter((k) => k in o && !(k === 'kind' && o.op === 'camera') && !(k === 'to' && (o.op === 'camera' || o.op === 'motion-add' || o.op === 'design')))
  return JSON.stringify([o.op, ...on.map((k) => o[k])])
}

/**
 * A plan handed back after a verdict, held to it: every locked op exactly as it was and in its order, whatever the
 * plan handed back did to it, with only new graphics, camera moves and sounds let in, each after the locked op it
 * follows in the plan handed back.
 */
export function holdTo(before: PlannerOp[], locked: Set<number>, back: PlannerOp[]): PlannerOp[] {
  const free = [...locked].sort((a, b) => a - b)
  const taken = new Set<number>()
  const find = (op: PlannerOp): number | undefined => {
    const text = JSON.stringify(op)
    const exact = free.find((i) => !taken.has(i) && JSON.stringify(before[i]) === text)
    if (exact !== undefined) return exact
    const same = sameThing(op)
    return free.find((i) => !taken.has(i) && sameThing(before[i]) === same)
  }
  const out: { op: PlannerOp; was: number | null }[] = []
  for (const op of back) {
    const i = find(op)
    if (i !== undefined) {
      taken.add(i)
      out.push({ op: before[i], was: i })
    } else if (REDOABLE.has(op.op)) out.push({ op, was: null })
  }
  // The locked ones it left out go back after the one they followed.
  for (const i of free) {
    if (taken.has(i)) continue
    let at = 0
    out.forEach((o, k) => {
      if (o.was !== null && o.was < i) at = k + 1
    })
    out.splice(at, 0, { op: before[i], was: i })
    taken.add(i)
  }
  // Locked ops in the order they were, the new ones where they stand among them.
  const order = out.filter((o) => o.was !== null).sort((a, b) => a.was! - b.was!)
  let k = 0
  return out.map((o) => (o.was === null ? o.op : order[k++].op))
}

/** At this or under, the video is better without a piece: the critic's own scale (criticSystem). */
export const HURTS = 4

/**
 * The plan without what the critic would take out, after the last try: a piece that still fails and whose fix is to
 * lose it, or that scores where the video is better without it, with its board when nothing else is on it. The last
 * piece left stays, since a person who asked for graphics would rather have one they can change than none.
 */
export function withoutTakenOut(ops: PlannerOp[], judged: (Judged & { piece: Piece })[]): PlannerOp[] {
  const out = judged
    .filter((j) => j.score <= HURTS || (j.score < PASS && /^take (it|this) out\b/i.test(j.fix)))
    .sort((a, b) => b.score - a.score)
  const gone = new Set((out.length < judged.length ? out : out.slice(1)).map((j) => j.piece.op))
  if (gone.size === 0) return ops
  const onBoard = new Set(judged.filter((j) => !gone.has(j.piece.op)).flatMap((j) => (j.piece.board === null ? [] : [j.piece.board])))
  for (const j of judged) if (gone.has(j.piece.op) && j.piece.board !== null && !onBoard.has(j.piece.board)) gone.add(j.piece.board)
  return ops.filter((_, i) => !gone.has(i))
}

/**
 * What a set of pieces is worth to the edit: each one's score over a 7, so one that hurts counts against it and one
 * taken out counts for nothing. A try that loses three bad graphics is better than one that keeps them.
 */
export const worth = (scores: number[]): number => scores.reduce((a, b) => a + (b - 7), 0)
