import { coverWindow } from './camera'
import { applyOps, type OpContext } from './ops'
import { pictureSpan, resolveCut, type Piece, type Resolved } from './resolve'
import type { Beat, Cut, Op, Source } from './schema'

/**
 * Jump cuts, hidden the way an editor hides them.
 *
 * Cutting a retake, a false start or a long pause out of one continuous shot
 * leaves the speaker in a different place either side of the join: the head
 * and hands jump. Editors hide it by changing the framing on the cut, wide
 * then close then wide, so each join reads as a cut between two shots rather
 * than a glitch. Here a join is a jump when the picture after it comes from
 * the same recording, more than a second later (or earlier) than where the
 * picture before it stopped, with nothing between: a short pause taken out
 * barely moves anyone, and a cutaway, another camera or a transition over the
 * join already hides it.
 *
 * The punch is a static 1.15 about the middle of the frame, the same punch a
 * beat's own zoom gives, so the preview, the export and Premiere all show it
 * from one number per piece. A piece whose beat has a punch-in or camera move
 * of its own keeps it; so does a picture already cropped close (a wide
 * recording in a vertical frame), where going closer would show the pixels.
 *
 * Only an edit that says so (Cut.punchJumps) is punched. The app turns it on
 * the first time a change makes a jump, when Settings say to (jumpOpsFor).
 */

/** How close the picture after a jump goes. */
export const JUMP_PUNCH = 1.15

/** Less of the recording skipped than this is a pause taken out: the speaker has hardly moved. */
export const MIN_JUMP_SEC = 1

/**
 * A stretch shorter than this between two jumps keeps the framing it comes in on: punched in for a
 * third of a second and straight out again reads as a stutter, not a cut.
 */
export const MIN_HOLD_SEC = 0.8

/** A crop keeping less of the recording than this is already close; a punch on top would show the pixels. */
const MIN_KEPT_AREA = 0.45

/** A join the picture jumps across: the piece after it, where in the recording the picture leaves and lands, and how much was left out. */
export interface JumpJoin {
  piece: number
  source: string
  fromSec: number
  toSec: number
  skippedSec: number
}

/** The shape of the finished frame, width over height. */
function frameAspect(cut: Pick<Cut, 'aspect'>, source: Pick<Source, 'width' | 'height'>): number {
  if (cut.aspect === 'vertical') return 9 / 16
  if (cut.aspect === 'wide') return 16 / 9
  if (cut.aspect === 'square') return 1
  return source.width / Math.max(1, source.height)
}

/** Whether a piece shows the speaker's own picture, filling the frame on its own. */
function ownPicture(beat: Beat | undefined): boolean {
  const t = beat?.treatment
  return !!t && t.frame === 'speaker' && !t.grid && !t.angle
}

/**
 * Every join in the cut where the picture jumps: one recording on both sides,
 * a second or more of it left out (or gone back over), and nothing laid over
 * the join to hide it.
 */
export function jumpJoins(cut: Cut, resolved: Resolved): JumpJoin[] {
  const beats = new Map(cut.beats.map((b) => [b.id, b]))
  const joins: JumpJoin[] = []
  let prev: Piece | null = null
  resolved.pieces.forEach((p, i) => {
    if (!ownPicture(beats.get(p.beat))) {
      // A cutaway, a grid or another camera in between: coming back to the speaker is no jump.
      prev = null
      return
    }
    const still = p.hold !== undefined || p.reverse || (prev !== null && (prev.hold !== undefined || prev.reverse))
    if (prev && prev.source === p.source && !p.transition && !still) {
      const fromSec = pictureSpan(prev).srcEnd
      const toSec = pictureSpan(p).srcStart
      const skipped = toSec - fromSec
      if (skipped >= MIN_JUMP_SEC || skipped < -0.05) joins.push({ piece: i, source: p.source, fromSec, toSec, skippedSec: skipped })
    }
    prev = p
  })
  return joins
}

/**
 * How close each piece is shown to hide the jumps, in playing order: 1 for as
 * it is, JUMP_PUNCH after every other jump. All 1 unless the edit says to
 * punch its jumps. The framing holds across a join that is not a jump, so a
 * beat split in the middle of a sentence does not punch in on its own.
 */
export function jumpZooms(cut: Cut, resolved: Resolved, sources: Pick<Source, 'id' | 'width' | 'height'>[]): number[] {
  const out = resolved.pieces.map(() => 1)
  if (cut.punchJumps !== true) return out
  const joins = jumpJoins(cut, resolved)
  if (joins.length === 0) return out
  // Each jump changes the framing, unless what follows it lasts too little before the next jump or the end.
  const at = new Set<number>()
  joins.forEach((j, k) => {
    const start = resolved.pieces[j.piece].outStart
    const next = joins[k + 1]
    const end = next ? resolved.pieces[next.piece].outStart : (resolved.pieces[resolved.pieces.length - 1]?.outEnd ?? start)
    if (end - start >= MIN_HOLD_SEC) at.add(j.piece)
  })
  const beats = new Map(cut.beats.map((b) => [b.id, b]))
  const bySource = new Map(sources.map((s) => [s.id, s]))
  let close = false
  let prev: Piece | null = null
  resolved.pieces.forEach((p, i) => {
    const beat = beats.get(p.beat)
    if (!ownPicture(beat)) {
      close = false
      prev = null
      return
    }
    if (prev && prev.source !== p.source) close = false
    if (at.has(i)) close = !close
    prev = p
    if (!close || !beat) return
    const t = beat.treatment
    // A punch-in, a move or a freeze of the beat's own stays as it was made.
    if (t.camera || t.zoom > 1.001 || p.hold !== undefined) return
    const source = bySource.get(p.source)
    if (!source || source.width <= 0 || source.height <= 0) return
    const { fw, fh } = coverWindow(source.width / source.height, frameAspect(cut, source))
    if (fw * fh < MIN_KEPT_AREA) return
    out[i] = JUMP_PUNCH
  })
  return out
}

/** How many joins a cut punches: its jumps where the framing changes, which is all of them once it punches any. */
export function punchedJumps(cut: Cut, resolved: Resolved, sources: Pick<Source, 'id' | 'width' | 'height'>[]): number {
  const zooms = jumpZooms({ ...cut, punchJumps: true }, resolved, sources)
  if (!zooms.some((z) => z > 1)) return 0
  return jumpJoins(cut, resolved).length
}

/**
 * The op that turns punched jumps on, when a change is about to make the
 * edit's first jump cuts and the person's Settings say to hide them. Nothing
 * when the edit already says either way, when the change says so itself, or
 * when no jump it makes could be punched.
 */
export function jumpOpsFor(before: Cut, proposed: Op[], context: OpContext, on: boolean): Op[] {
  if (!on || before.punchJumps !== undefined || proposed.some((o) => o.op === 'punch-jumps')) return []
  const trial = applyOps(before, proposed, context)
  if (trial.applied.length === 0 || trial.cut.punchJumps !== undefined) return []
  // A jump this change makes: a join that was not there before. Striking a retake between two pauses
  // the first cut already skipped can leave fewer joins than before, and still one new jump.
  const key = (j: JumpJoin): string => `${j.source}|${j.fromSec.toFixed(2)}|${j.toSec.toFixed(2)}`
  const had = new Set(jumpJoins(before, resolveCut(before, context.words, context.sources)).map(key))
  const after = resolveCut(trial.cut, context.words, context.sources)
  if (!jumpJoins(trial.cut, after).some((j) => !had.has(key(j)))) return []
  return punchedJumps(trial.cut, after, context.sources) > 0 ? [{ op: 'punch-jumps', on: true }] : []
}

/** What a punch-jumps op did, as part of a version's summary. */
export function describeJumps(on: boolean, count: number): string {
  if (!on) return 'the jump cuts are left as they are, with no punch-in'
  if (count <= 0) return 'jump cuts punch in, so they read as cuts'
  if (count === 1) return 'the jump cut punches in, so it reads as a cut'
  return `the ${count} jump cuts switch between wide and close, so they read as cuts`
}
