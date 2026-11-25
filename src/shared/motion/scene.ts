import { captionedWords, type Resolved } from '../edit/resolve'
import type { Cut, Source, Word } from '../edit/schema'
import { facesThrough } from '../faces'
import { showsSpeaker } from '../plan-talk'
import { captionLayers, facesNear, SEAM_FRAC, type CaptionBand, type CaptionCover, type FaceSample } from './captions'
import { followPath, type FollowPicture } from './follow'
import { pushed, withFx } from './fx'
import { leaveOf, leaving } from './leave'
import type { MotionItem, MotionKind } from './schema'
import { template } from './templates'
import { OWN_RIM } from './templates/boards'
import { TIMING } from './templates/kit'
import { directed, frameFor, type Frame, type MotionTheme } from './theme'
import { anchorTime, spanFor, timelineFor, type Timeline } from './timing'
import { sampleTransform } from './draw'
import { windowDuring, type ScreenBox } from '../screen'
import type { Layer, Size } from './types'

/**
 * The cut's graphics on the output clock. Every call is checked, placed and
 * built into layers with absolute times; what does not fit the cut (its
 * anchor's beat is gone, or it would start after the end) is left out and
 * says why, for the editor to show.
 */

export interface SceneItem {
  id: string
  kind: MotionKind
  /** The moment its anchor lands on. */
  at: number
  start: number
  end: number
  layers: Layer[]
  /** The same, as it is drawn: with the way it leaves (motion/leave). Absent where it ends as it was built. */
  leaves?: Layer[]
  /** How it meets the captions: its template's, or this call's own. */
  covers?: 'backdrop' | 'card'
  /** The stretch of the frame's height it holds while up, in pixels, that captions keep out of (Template.band). */
  band?: { top: number; bottom: number }
}

export interface MotionScene {
  size: Size
  frame: Frame
  duration: number
  /** Everything to draw, bottom first. */
  layers: Layer[]
  items: SceneItem[]
  /** Graphics in the doc that are not drawn, with the reason. */
  hidden: { id: string; reason: string }[]
}

export interface SceneInput {
  cut: Cut
  resolved: Resolved
  words: Word[]
  /** The full-size output frame: design pixels. */
  size: Size
  theme: MotionTheme
  /** Faces through the cut, from face tracking, for drawn captions to keep off. */
  faces?: FaceSample[]
  /** How strongly each word is stressed, 0 to 1, by word id, for which caption words go big. */
  emphasis?: Record<string, number>
  /** The edit's pictures, for graphics that show one at its own shape. */
  assets?: { id: string; kind: string; width: number | null; height: number | null }[]
  /** The edit's recordings with their sizes, for graphics that follow an object in one (motion/follow). */
  pictures?: FollowPicture[]
}

/** What a graphic that follows an object needs to find it on screen. */
interface FollowContext {
  cut: Cut
  resolved: Resolved
  pictures: FollowPicture[]
}

/** The window the speaker is kept in on the screen recording playing at a moment of the output, if it holds one. */
function speakerWindow(f: FollowContext, at: number): ScreenBox | null {
  const piece = f.resolved.pieces.find((p) => p.outStart <= at + 1e-6 && at < p.outEnd) ?? f.resolved.pieces.find((p) => p.outStart >= at)
  const screen = piece ? f.pictures.find((p) => p.id === piece.source)?.screen : undefined
  return piece && screen ? windowDuring(screen, piece.srcStart, piece.srcEnd) : null
}

/** How much two boxes share: their overlap over their union. */
function overlapShare(a: ScreenBox, b: ScreenBox): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])
  const shared = Math.max(0, w) * Math.max(0, h)
  return shared / Math.max(1e-9, a[2] * a[3] + b[2] * b[3] - shared)
}

/** Builds every graphic in the cut. Never throws on a bad call: it is hidden instead. */
export function buildScene(given: SceneInput): MotionScene {
  // The video's own look over the house's, or the brand's.
  const input: SceneInput = { ...given, theme: directed(given.theme, given.cut.direction) }
  const frame = frameFor(input.size)
  const tl = timelineFor(input.cut, input.resolved, input.words)
  const items: SceneItem[] = []
  const hidden: MotionScene['hidden'] = []
  const following: FollowContext = { cut: input.cut, resolved: input.resolved, pictures: input.pictures ?? [] }
  // The faces in frame, for graphics to keep off: as found by face tracking, else as the recordings were read.
  const faces = input.faces ?? facesThrough(input.cut, input.resolved, (input.pictures ?? []) as Source[], input.size)
  for (const item of input.cut.motion ?? []) {
    const built = buildItem(item, tl, frame, input.theme, faces, input.assets ?? [], following)
    if ('reason' in built) hidden.push({ id: item.id, reason: built.reason })
    else items.push(built)
  }
  // A card that comes in while graphics round the speaker are up takes the screen from them:
  // they are built again to leave as it arrives, rather than staying on top of the page.
  const cards = items.filter((i) => i.covers === 'card')
  items.forEach((built, n) => {
    if (!template(built.kind)?.aroundSpeaker) return
    const card = cards.find((c) => c.start > built.start + 0.05 && c.start < built.end)
    const item = card ? (input.cut.motion ?? []).find((m) => m.id === built.id) : undefined
    if (!card || !item) return
    const again = buildItem(item, tl, frame, input.theme, faces, input.assets ?? [], following, card.start + TIMING.exit)
    if (!('reason' in again)) items[n] = again
  })
  // One after another: what stands beside or under the speaker is out of the way before the next of them comes in,
  // where the two would only cross for a moment.
  const takesRoom = (id: string): MotionItem | undefined => (input.cut.motion ?? []).find((m) => m.id === id && ONE_AT_A_TIME.has(m.kind))
  items.forEach((built, n) => {
    const item = takesRoom(built.id)
    if (!item) return
    const next = items
      .filter((o) => o.id !== built.id && takesRoom(o.id) && o.start > built.start + 1.5 && o.start < built.end && built.end - o.start < CROSS_SEC)
      .sort((a, b) => a.start - b.start)[0]
    if (!next) return
    const again = buildItem(item, tl, frame, input.theme, faces, input.assets ?? [], following, next.start + 0.1, true)
    if (!('reason' in again)) items[n] = again
  })
  // A board's window over a screen recording is the speaker's own window, as read off the picture: a box a hair
  // off it would show the recording's rim beside the board's.
  items.forEach((built, n) => {
    if (built.kind !== 'board') return
    const item = (input.cut.motion ?? []).find((m) => m.id === built.id)
    const box = item?.box && item.box.length === 4 ? (item.box as ScreenBox) : null
    const own = box ? speakerWindow(following, built.start) : null
    if (!item || !box || !own || overlapShare(own, box) < 0.5) return
    // The recording frames its window already: the board cuts the hole and draws no rim of its own.
    const snapped = { ...item, box: [...own], fx: [...(item.fx ?? []).filter((f) => f !== OWN_RIM), OWN_RIM] }
    const again = buildItem(snapped, tl, frame, input.theme, faces, input.assets ?? [], following)
    if (!('reason' in again)) items[n] = again
  })
  // A paper board shows nothing of its own: it comes up with the first graphic set on it, never as empty paper.
  items.forEach((board, n) => {
    if (board.kind !== 'board') return
    const on = items.filter((c) => c !== board && c.kind !== 'board' && c.start < board.end && c.end > board.start + 0.05)
    const first = Math.min(...on.map((c) => firstShown(c.layers, c.start, c.end)))
    if (!Number.isFinite(first) || first <= board.start + 0.25 || first >= board.end - 0.1) return
    items[n] = { ...board, start: first, layers: board.layers.map((l) => ({ ...l, start: Math.max(l.start, first) })) }
  })
  const covers: CaptionCover[] = items.flatMap((i) => (i.covers ? [{ start: i.start, end: i.end, kind: i.covers }] : []))
  const captions = captionLayers({
    spec: input.cut.captions,
    // Beats whose captions are off are left out of drawn captions as of subtitles.
    resolved: captionedWords(input.cut, input.resolved),
    frame,
    theme: input.theme,
    duration: tl.duration,
    faces: input.faces,
    emphasis: input.emphasis,
    speakers: speakersOf(input.words),
    covers,
    bands: graphicBands(items),
    sits: seamSits(input.cut, input.resolved)
  })
  // Backdrops replace the picture, so they go under the captions; everything else goes over. Cards hold
  // the screen, so what stands beside one (a counter by a page) goes over it, whichever came first.
  return {
    size: input.size,
    frame,
    duration: tl.duration,
    layers: [
      ...items.filter((i) => i.covers === 'backdrop').flatMap((i) => i.leaves ?? i.layers),
      ...captions,
      ...items.filter((i) => i.covers === 'card').flatMap((i) => i.leaves ?? i.layers),
      ...items.filter((i) => !i.covers).flatMap((i) => i.leaves ?? i.layers)
    ],
    items,
    hidden
  }
}

function buildItem(
  item: MotionItem,
  tl: Timeline,
  frame: Frame,
  theme: MotionTheme,
  faces: FaceSample[] | undefined,
  assets: NonNullable<SceneInput['assets']>,
  following: FollowContext,
  /** Gone by this time on the output clock, whatever its call says (a card took the screen). */
  until?: number,
  /** Whether it still leaves the way it does, for that: making way, rather than covered. */
  makesWay = false
): SceneItem | { reason: string } {
  const tpl = template(item.kind)
  if (!tpl) return { reason: `There is no ${item.kind} graphic.` }
  const problem = tpl.check(item)
  if (problem) return { reason: problem }
  const whole = spanFor(tl, item.from, item.to, tpl.length, tpl.lead)
  if (!whole) return { reason: 'What it was on is no longer in the cut.' }
  const held = tpl.room?.(item) ? withItsShots(whole, following.resolved, following.pictures as Source[]) : whole
  const span = until !== undefined && until < held.end ? { ...held, end: Math.max(held.start + 0.1, until) } : held
  // An object to move with: where it is when the graphic lands, and how it moves from there.
  const path = item.follow
    ? followPath({ follow: item.follow, ...following, frame, at: span.at, start: span.start, end: span.end })
    : null
  // A graphic that points at something, told nothing to point at, points at the object.
  const pointsAt = path && item.box.length === 0 && tpl.fields?.some((f) => f.slot === 'box')
  const call = pointsAt && path ? { ...item, box: [...path.land] } : item
  const ctx = {
    item: call,
    frame,
    theme,
    span,
    tl,
    time: (ref: string) => anchorTime(tl, ref),
    faces: facesNear(faces, span.at),
    picture: (id: string) => {
      const a = assets.find((x) => x.id === id && x.kind === 'image')
      return a ? { width: a.width ?? 0, height: a.height ?? 0 } : null
    }
  }
  let layers: Layer[]
  let leaves: Layer[] | null = null
  // What it holds of the frame's height, unless it moves with an object.
  let band: SceneItem['band'] | null = null
  try {
    // The fx any graphic takes (motion/fx), on top of what its template makes of its own.
    layers = pushed(withFx(tpl.build(ctx), call.fx ?? [], theme, frame.u, tpl.ownFx), call.fx ?? [], frame.height)
    band = path ? null : (tpl.band?.(ctx) ?? null)
    // It leaves by moving, unless a card took the screen from it or the template ends it on a cut.
    const leave = (until === undefined || makesWay) && !path ? leaveOf(call) : null
    if (leave) leaves = leaving(layers, leave, frame, span)
  } catch (err) {
    return { reason: `It could not be drawn: ${err instanceof Error ? err.message : String(err)}` }
  }
  // The whole graphic moves with the object, its own animation inside the move.
  if (path && [...path.x, ...path.y].some((k) => Math.abs(k.v) > 0.5)) {
    layers = [
      {
        kind: 'group',
        start: span.start,
        end: span.end,
        transform: { x: { keys: path.x }, y: { keys: path.y } },
        children: layers
      }
    ]
  }
  const covers = tpl.coversFor ? tpl.coversFor(item) : tpl.covers
  return {
    id: item.id,
    kind: item.kind,
    at: span.at,
    start: span.start,
    end: span.end,
    layers,
    ...(leaves && leaves !== layers ? { leaves } : {}),
    ...(covers ? { covers } : {}),
    ...(band && !covers ? { band } : {})
  }
}

/** Graphics that take a part of the picture to themselves, so two are never up in passing. */
const ONE_AT_A_TIME: ReadonlySet<MotionKind> = new Set(['aside', 'band', 'layers'])
/** Up together for less than this, two of them are only crossing. */
const CROSS_SEC = 1

/** How little of a shot a graphic beside the speaker may be up for before it is not up in that shot at all, in seconds. */
const SPILL = 0.6

/**
 * A graphic beside the speaker comes and goes with the shots reframed for it (edit/room): over the start of a shot
 * that was not, where the speaker stands elsewhere, it would lie across their face. Where the take runs on, the shot
 * glides with it and nothing need be held to the cut.
 */
function withItsShots<T extends { start: number; end: number }>(span: T, resolved: Resolved, sources: Source[]): T {
  const last = resolved.beats.find((b) => b.outStart < span.end && span.end <= b.outEnd + 1e-6)
  const first = resolved.beats.find((b) => b.outStart > span.start && b.outStart - span.start < SPILL)
  const end = last && last.outStart > span.start + 0.8 && span.end - last.outStart < SPILL && cutInto(last, resolved, sources) ? last.outStart : span.end
  const start = first && first.outStart < end - 0.8 && cutInto(first, resolved, sources) ? first.outStart : span.start
  return { ...span, start, end }
}

/** Whether a beat begins with a cut that shows: another recording, part of this one left out, or footage cut into it. */
function cutInto(beat: { id: string }, resolved: Resolved, sources: Source[]): boolean {
  const n = resolved.beats.findIndex((b) => b.id === beat.id)
  if (n > 0) {
    const was = showsSpeaker(resolved.beats[n - 1], resolved, sources)
    const is = showsSpeaker(resolved.beats[n], resolved, sources)
    if (was !== null && is !== null && was !== is) return true
  }
  const at = resolved.pieces.findIndex((p) => p.beat === beat.id)
  const before = resolved.pieces[at - 1]
  const piece = resolved.pieces[at]
  return !before || !piece || before.source !== piece.source || Math.abs(piece.srcStart - before.srcEnd) >= 0.3
}

/** The first moment any of a graphic's layers can be seen, in thirtieths of a second; Infinity when never. */
function firstShown(layers: Layer[], start: number, end: number): number {
  for (let t = start; t < end; t += 1 / 30)
    if (layers.some((l) => l.start <= t && t < l.end && sampleTransform(l.transform, t - l.start, l.end - l.start).opacity > 0.05)) return t
  return Infinity
}

/** Every stretch of output time when something is drawn, merged where gaps are short. */
export function activeSpans(layers: Layer[], duration: number, mergeGap = 0.25): { start: number; end: number }[] {
  const spans = layers
    .map((l) => ({ start: Math.max(0, l.start), end: Math.min(duration, l.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
  const out: { start: number; end: number }[] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end + mergeGap) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** The graphics on screen at t, topmost last. */
export function itemsAt(scene: MotionScene, t: number): SceneItem[] {
  return scene.items.filter((i) => t >= i.start && t < i.end)
}

/** The stretches of the frame graphics hold while they are up, on the output clock, for captions to keep out of. */
export function graphicBands(items: Pick<SceneItem, 'start' | 'end' | 'band'>[]): CaptionBand[] {
  return items.flatMap((i) => (i.band ? [{ start: i.start, end: i.end, top: i.band.top, bottom: i.band.bottom }] : []))
}

/** The words said over a split (b-roll stacked with the speaker), by id, seated on its seam (SEAM_FRAC). */
function seamSits(cut: Cut, resolved: Resolved): Record<string, number> | undefined {
  const split = new Set(cut.beats.filter((b) => b.treatment.frame === 'split' && b.treatment.broll).map((b) => b.id))
  if (split.size === 0) return undefined
  return Object.fromEntries(resolved.words.filter((w) => split.has(w.beat)).map((w) => [w.id, SEAM_FRAC]))
}

/** Who says each word, by word id, when the speakers were told apart. */
function speakersOf(words: Word[]): Record<string, number> | undefined {
  const known = words.filter((w) => w.speaker !== undefined)
  return known.length ? Object.fromEntries(known.map((w) => [w.id, w.speaker as number])) : undefined
}
