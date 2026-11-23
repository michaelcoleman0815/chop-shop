import { isKeyed, num, type Anim, type Ease, type Key } from '../anim'
import type { Cut } from '../edit/schema'
import { parseAnchor, parseLength } from '../motion/schema'
import type { Timeline } from '../motion/timing'
import { trackExprProblem, withExpr } from './compositing'
import { continuedParticles } from '../particles/presets'
import { isMediaId } from './media'
import { clipSpan, timeOf, tracksOf } from './resolve'
import {
  KINDS_ON,
  MAX_TRACKS,
  TrackClipSchema,
  type ClipFields,
  type ClipKind,
  type KeyedProp,
  type Track,
  type TrackClip,
  type TrackKind
} from './schema'

/**
 * The track and clip ops, applied to a cut. Each is checked the way every op
 * is: a clip on a word that is not there, a video with no file, a key on a
 * clip that does not exist, a trim past the start of the file, is refused with
 * a sentence that says why, and the cut is left as it was.
 */

export interface TrackOpContext {
  hasWord(id: string): boolean
  hasBeat(id: string): boolean
  /** Whether the edit has material by this id (an asset, a recording); absent takes any. */
  hasMedia?(id: string): boolean
  /** The edit's clock, worked out only for the ops that need it (a trim by seconds, a split). */
  timeline(): Timeline
}

export type TrackResult = { ok: true; cut: Cut } | { ok: false; reason: string }

type Op =
  | ({ op: 'track-add' } & { kind: TrackKind; name?: string; at?: number })
  | {
      op: 'track-update'
      track: string
      name?: string
      hidden?: boolean
      locked?: boolean
      mute?: boolean
      solo?: boolean
      at?: number
    }
  | { op: 'track-remove'; track: string }
  | ({ op: 'clip-add'; track?: string } & ClipFields)
  | ({ op: 'clip-update'; clip: string } & Partial<Omit<ClipFields, 'kind'>>)
  | { op: 'clip-move'; clip: string; track?: string; from?: string; to?: string }
  | { op: 'clip-trim'; clip: string; edge: 'in' | 'out' | 'slip'; to?: string; by?: number }
  | { op: 'clip-split'; clip: string; at: string }
  | { op: 'clip-remove'; clips: string[] }
  | { op: 'key-set'; clip: string; prop: KeyedProp; t: number; v: number; ease?: Ease }
  | { op: 'key-remove'; clip: string; prop: KeyedProp; t: number }
  | { op: 'clip-expr'; clip: string; prop: KeyedProp; expr: string }

class Refused extends Error {}
const refuse = (reason: string): never => {
  throw new Refused(reason)
}

/** t1, t2 … and c1, c2 … after the highest number in use. */
function nextId(prefix: string, ids: string[]): string {
  let max = 0
  for (const id of ids) {
    const n = new RegExp(`^${prefix}(\\d+)$`).exec(id)
    if (n) max = Math.max(max, Number(n[1]))
  }
  return `${prefix}${max + 1}`
}

const allClips = (tracks: Track[]): TrackClip[] => tracks.flatMap((t) => t.clips)

function findTrack(tracks: Track[], id: string): number {
  const i = tracks.findIndex((t) => t.id === id)
  if (i < 0) refuse(`There is no track ${id}.`)
  return i
}

function findClip(tracks: Track[], id: string): { t: number; c: number } {
  for (let t = 0; t < tracks.length; t++) {
    const c = tracks[t].clips.findIndex((x) => x.id === id)
    if (c >= 0) return { t, c }
  }
  return refuse(`There is no clip ${id}.`)
}

function unlocked(track: Track): void {
  if (track.locked) refuse(`${track.name} is locked. Unlock it to change its clips.`)
}

function anchorOk(ref: string, ctx: TrackOpContext, role: string): void {
  const a = parseAnchor(ref)
  if (!a) refuse(`${role} ${ref} is not a word, a beat, start or end.`)
  else if (a.on !== 'cut' && !(a.id && (ctx.hasWord(a.id) || ctx.hasBeat(a.id))))
    refuse(`${role} ${ref} names a word or beat this edit does not have.`)
}

function endOk(ref: string, ctx: TrackOpContext): void {
  const t = ref.trim()
  if (t === '' || parseLength(t) !== null) return
  anchorOk(t, ctx, 'Its end')
}

/** What a clip of each kind cannot do without. */
function wholeClip(clip: TrackClip, ctx: TrackOpContext): TrackClip {
  if ((clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'sound') && !clip.src)
    refuse(`${aClip(clip.kind)} needs its file.`)
  if (clip.src && isMediaId(clip.src) && ctx.hasMedia && !ctx.hasMedia(clip.src))
    refuse(`There is no ${clip.src} in this edit's material.`)
  if (clip.kind === 'text' && !clip.text) refuse('A title needs its words.')
  return clip
}

/** "A video clip", "An image clip". */
const aClip = (kind: ClipKind): string => `${/^[aeiou]/.test(kind) ? 'An' : 'A'} ${kind} clip`

/** An anchor moved by seconds: "w12.end+0.3" by 0.2 is "w12.end+0.5". */
export function shiftAnchor(ref: string, by: number): string {
  const a = parseAnchor(ref)
  if (!a) return ref
  const off = Math.round((a.offset + by) * 1000) / 1000
  const head = a.on === 'cut' ? a.edge : `${a.id}${a.edge === 'end' ? '.end' : ''}`
  if (Math.abs(off) < 0.0005) return head
  return `${head}${off > 0 ? '+' : '-'}${Math.abs(off)}`
}

const seconds = (sec: number): string => `${Math.max(0.05, Math.round(sec * 1000) / 1000)}s`

// ---------- Keys ----------

type NumAnim = Anim<number> | undefined

function getProp(clip: TrackClip, prop: KeyedProp): NumAnim {
  if (prop === 'rate') return clip.particles?.rate
  if (prop === 'opacity') return clip.opacity
  if (prop === 'volume') return clip.volume
  if (prop === 'pan') return clip.pan
  if (prop.startsWith('crop.')) return clip.crop?.[prop.slice(5) as 'left' | 'top' | 'right' | 'bottom']
  return clip.transform?.[prop as Exclude<KeyedProp, 'opacity' | 'volume' | 'pan' | 'rate' | `crop.${string}`>]
}

function setProp(clip: TrackClip, prop: KeyedProp, value: NumAnim): TrackClip {
  if (prop === 'rate') return { ...clip, particles: { ...clip.particles, rate: value } }
  if (prop === 'opacity') return { ...clip, opacity: value }
  if (prop === 'volume') return { ...clip, volume: value }
  if (prop === 'pan') return { ...clip, pan: value }
  if (prop.startsWith('crop.')) return { ...clip, crop: { ...clip.crop, [prop.slice(5)]: value } }
  return { ...clip, transform: { ...clip.transform, [prop]: value } }
}

const SAME_KEY = 1e-3

function withKey(anim: NumAnim, t: number, v: number, ease?: Ease): Anim<number> {
  const key: Key<number> = ease === undefined ? { t, v } : { t, v, ease }
  if (!isKeyed(anim)) return { keys: [key] }
  const keys = anim.keys.filter((k) => Math.abs(k.t - t) > SAME_KEY)
  keys.push(key)
  // An expression on the keys stays on them.
  return { ...anim, keys: keys.sort((a, b) => a.t - b.t) }
}

function withoutKey(anim: NumAnim, t: number): NumAnim {
  if (!isKeyed(anim)) return refuse(`There is no key at ${t} s to take off.`)
  const keys = anim.keys.filter((k) => Math.abs(k.t - t) > SAME_KEY)
  if (keys.length === anim.keys.length) return refuse(`There is no key at ${t} s to take off.`)
  const expr = (anim as { expr?: string }).expr
  if (expr) return { keys, expr }
  return keys.length === 0 ? undefined : { keys }
}

/** Keys moved earlier by `by` seconds, for the second half of a split: what fell before its start becomes a key at 0. */
function shiftKeys(anim: NumAnim, by: number, length: number): NumAnim {
  if (!isKeyed(anim)) return anim
  const keys = anim.keys.map((k) => ({ ...k, t: k.t - by })).filter((k) => k.t > SAME_KEY)
  const expr = (anim as { expr?: string }).expr
  // The value the keys give there, not the expression's: the expression rides on into the second half.
  const at = num({ keys: anim.keys }, by, length)
  return anim.keys.length === 0 ? anim : { ...(expr ? { expr } : {}), keys: [{ t: 0, v: at }, ...keys] }
}

const KEYED_ALL: KeyedProp[] = [
  'x',
  'y',
  'anchorX',
  'anchorY',
  'scale',
  'scaleX',
  'scaleY',
  'rotation',
  'skewX',
  'skewY',
  'opacity',
  'crop.left',
  'crop.top',
  'crop.right',
  'crop.bottom',
  'volume',
  'pan',
  'rate'
]

// ---------- The ops ----------

export function applyTrackOp(cut: Cut, op: Op, ctx: TrackOpContext): TrackResult {
  try {
    const tracks = step(tracksOf(cut), op, ctx)
    // Expressions that would not read, or would read each other in a circle, are refused with the op that made them so.
    if (op.op === 'clip-expr' || op.op === 'clip-add' || op.op === 'clip-update' || op.op === 'clip-split') {
      const problem = trackExprProblem(tracks, tracksOf(cut))
      if (problem) refuse(problem)
    }
    return { ok: true, cut: { ...cut, tracks } }
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message }
    throw err
  }
}

function step(tracks: Track[], op: Op, ctx: TrackOpContext): Track[] {
  switch (op.op) {
    case 'track-add': {
      if (tracks.length >= MAX_TRACKS) refuse(`An edit holds at most ${MAX_TRACKS} tracks.`)
      return insertTrack(tracks, op.kind, op.name, op.at)
    }

    case 'track-update': {
      const i = findTrack(tracks, op.track)
      const t = tracks[i]
      const next: Track = {
        ...t,
        name: op.name ?? t.name,
        hidden: op.hidden ?? t.hidden,
        locked: op.locked ?? t.locked,
        mute: op.mute ?? t.mute,
        solo: op.solo ?? t.solo
      }
      const out = [...tracks]
      out[i] = next
      if (op.at === undefined || op.at === i) return out
      out.splice(i, 1)
      out.splice(Math.min(op.at, out.length), 0, next)
      return out
    }

    case 'track-remove': {
      const i = findTrack(tracks, op.track)
      unlocked(tracks[i])
      return tracks.filter((_, k) => k !== i)
    }

    case 'clip-add': {
      const { op: _op, track: trackId, ...fields } = op
      anchorOk(fields.from, ctx, 'Its start')
      endOk(fields.to ?? '', ctx)
      const kind = trackKindFor(fields.kind)
      let out = tracks
      let ti: number
      if (trackId) {
        ti = findTrack(out, trackId)
        if (!KINDS_ON[out[ti].kind].includes(fields.kind)) refuse(`${out[ti].name} holds ${out[ti].kind}, not ${fields.kind}.`)
      } else {
        // The top track that takes it, when nothing there plays at the same time; otherwise a new one above.
        ti = out.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === kind && !t.locked).pop()?.i ?? -1
        if (ti >= 0 && out[ti].clips.length > 0) {
          const tl = ctx.timeline()
          const mine = clipSpan(tl, TrackClipSchema.parse({ ...fields, id: 'new' }))
          const busy = mine && out[ti].clips.some((c) => {
            const s = clipSpan(tl, c)
            return s && s.start < mine.end - 1e-6 && mine.start < s.end - 1e-6
          })
          if (busy) ti = -1
        }
        if (ti < 0) {
          if (out.length >= MAX_TRACKS) refuse(`An edit holds at most ${MAX_TRACKS} tracks.`)
          out = insertTrack(out, kind)
          ti = out.length - 1
        }
      }
      unlocked(out[ti])
      const clip = wholeClip(TrackClipSchema.parse({ ...fields, id: nextId('c', allClips(out).map((c) => c.id)) }), ctx)
      return replaceTrack(out, ti, { ...out[ti], clips: [...out[ti].clips, clip] })
    }

    case 'clip-update': {
      const { op: _op, clip: id, ...change } = op
      const at = findClip(tracks, id)
      unlocked(tracks[at.t])
      if (change.from !== undefined) anchorOk(change.from, ctx, 'Its start')
      if (change.to !== undefined) endOk(change.to, ctx)
      const was = tracks[at.t].clips[at.c]
      // Particles change setting by setting, unless a preset is named, which starts afresh from it.
      if (change.particles && !change.particles.preset) change.particles = { ...was.particles, ...change.particles }
      const clip = wholeClip(TrackClipSchema.parse({ ...was, ...change, id: was.id, kind: was.kind }), ctx)
      return replaceClip(tracks, at, clip)
    }

    case 'clip-move': {
      const at = findClip(tracks, op.clip)
      unlocked(tracks[at.t])
      if (op.from !== undefined) anchorOk(op.from, ctx, 'Its start')
      if (op.to !== undefined) endOk(op.to, ctx)
      const was = tracks[at.t].clips[at.c]
      const clip: TrackClip = { ...was, from: op.from ?? was.from, to: op.to ?? was.to }
      if (op.track === undefined || op.track === tracks[at.t].id) return replaceClip(tracks, at, clip)
      const to = findTrack(tracks, op.track)
      unlocked(tracks[to])
      if (!KINDS_ON[tracks[to].kind].includes(clip.kind)) refuse(`${tracks[to].name} holds ${tracks[to].kind}, not ${clip.kind}.`)
      const out = replaceTrack(tracks, at.t, { ...tracks[at.t], clips: tracks[at.t].clips.filter((_, k) => k !== at.c) })
      return replaceTrack(out, to, { ...out[to], clips: [...out[to].clips, clip] })
    }

    case 'clip-trim':
      return trim(tracks, op, ctx)

    case 'clip-split': {
      const at = findClip(tracks, op.clip)
      unlocked(tracks[at.t])
      anchorOk(op.at, ctx, 'Where it splits')
      const was = tracks[at.t].clips[at.c]
      const tl = ctx.timeline()
      const span = clipSpan(tl, was) ?? refuse(`${was.id} is not in the cut, so it cannot be split.`)
      const cutAt = timeOf(tl, op.at)
      if (cutAt === null || cutAt <= span.start + 0.05 || cutAt >= span.end - 0.05)
        refuse(`${op.at} is not inside ${was.id}, so it cannot be split there.`)
      const by = (cutAt as number) - span.start
      const length = span.end - span.start
      const head: TrackClip = { ...was, to: op.at }
      // An end that is a length, or its natural length, counts from the start: the second half keeps the end where it was.
      const lengthEnd = was.to.trim() === '' || parseLength(was.to.trim()) !== null
      let tail: TrackClip = {
        ...was,
        id: nextId('c', allClips(tracks).map((c) => c.id)),
        from: op.at,
        to: lengthEnd ? seconds(span.end - (cutAt as number)) : was.to,
        in: was.in + by * was.speed
      }
      for (const prop of KEYED_ALL) {
        const anim = getProp(tail, prop)
        if (isKeyed(anim)) tail = setProp(tail, prop, shiftKeys(anim, by, length))
      }
      if (tail.kind === 'particles') tail = { ...tail, particles: continuedParticles(tail.particles, by) }
      const clips = [...tracks[at.t].clips]
      clips.splice(at.c, 1, head, tail)
      return replaceTrack(tracks, at.t, { ...tracks[at.t], clips })
    }

    case 'clip-remove': {
      let out = tracks
      for (const id of op.clips) {
        const at = findClip(out, id)
        unlocked(out[at.t])
        out = replaceTrack(out, at.t, { ...out[at.t], clips: out[at.t].clips.filter((_, k) => k !== at.c) })
      }
      return out
    }

    case 'key-set': {
      const at = findClip(tracks, op.clip)
      unlocked(tracks[at.t])
      const clip = tracks[at.t].clips[at.c]
      if ((op.prop === 'volume' || op.prop === 'pan') && clip.kind !== 'sound' && clip.kind !== 'video') refuse(`${aClip(clip.kind)} has no sound to set.`)
      if (op.prop === 'pan' && (op.v < -1 || op.v > 1)) refuse('Pan goes from -1, all the way left, to 1, all the way right.')
      if (op.prop === 'rate' && clip.kind !== 'particles') refuse(`${aClip(clip.kind)} has no particles to set a rate on.`)
      return replaceClip(tracks, at, setProp(clip, op.prop, withKey(getProp(clip, op.prop), op.t, op.v, op.ease)))
    }

    case 'key-remove': {
      const at = findClip(tracks, op.clip)
      unlocked(tracks[at.t])
      const clip = tracks[at.t].clips[at.c]
      return replaceClip(tracks, at, setProp(clip, op.prop, withoutKey(getProp(clip, op.prop), op.t)))
    }

    case 'clip-expr': {
      const at = findClip(tracks, op.clip)
      unlocked(tracks[at.t])
      const clip = tracks[at.t].clips[at.c]
      if (op.prop === 'volume' && clip.kind !== 'sound' && clip.kind !== 'video') refuse(`${aClip(clip.kind)} has no sound to set.`)
      if (!op.expr.trim() && !(getProp(clip, op.prop) as { expr?: string } | undefined)?.expr)
        refuse(`${clip.id} has no expression on ${op.prop} to take off.`)
      return replaceClip(tracks, at, setProp(clip, op.prop, withExpr(getProp(clip, op.prop), op.expr)))
    }
  }
}

/** Head, tail or slip, to an anchor or by seconds. */
function trim(tracks: Track[], op: Extract<Op, { op: 'clip-trim' }>, ctx: TrackOpContext): Track[] {
  const at = findClip(tracks, op.clip)
  unlocked(tracks[at.t])
  const was = tracks[at.t].clips[at.c]
  if (op.to === undefined && op.by === undefined) refuse('Say where to trim to, or by how much.')
  if (op.edge === 'slip') {
    if (op.by === undefined) refuse('A slip moves what plays by seconds; say by how much.')
    const next = was.in + (op.by as number)
    if (next < 0) refuse(`${was.id} cannot slip before the start of its file.`)
    if (was.fileSec !== undefined && next >= was.fileSec) refuse(`${was.id} cannot slip past the end of its file.`)
    return replaceClip(tracks, at, { ...was, in: next })
  }
  if (op.to !== undefined) anchorOk(op.to, ctx, 'Where it trims to')
  const tl = ctx.timeline()
  const span = clipSpan(tl, was) ?? refuse(`${was.id} is not in the cut, so it cannot be trimmed.`)
  const target = op.to !== undefined ? timeOf(tl, op.to) : null
  if (op.to !== undefined && target === null) refuse(`${op.to} is not in the cut.`)

  if (op.edge === 'in') {
    let start = target ?? span.start + (op.by as number)
    // Its file starts where it starts: the head comes no earlier than that.
    const earliest = span.start - was.in / was.speed
    if (start < earliest - 1e-6) {
      if (op.to !== undefined) refuse(`${was.id} cannot start that early: its file starts later.`)
      start = earliest
    }
    if (start > span.end - 0.05) refuse(`${was.id} would be gone: its head would pass its tail.`)
    const moved = start - span.start
    const from = op.to ?? shiftAnchor(was.from, moved)
    // A length counts from the start, so it shrinks by what the head took.
    const to = parseLength(was.to.trim()) !== null ? seconds(span.end - start) : was.to.trim() === '' ? seconds(span.end - start) : was.to
    return replaceClip(tracks, at, { ...was, from, to, in: Math.max(0, was.in + moved * was.speed) })
  }

  // The tail.
  const end = target ?? span.end + (op.by as number)
  if (end < span.start + 0.05) refuse(`${was.id} would be gone: its tail would pass its head.`)
  if (was.fileSec !== undefined && was.in + (end - span.start) * was.speed > was.fileSec + 1e-3)
    refuse(`${was.id} cannot run that long: its file ends sooner.`)
  const to = op.to ?? (parseAnchor(was.to.trim()) && was.to.trim() !== '' ? shiftAnchor(was.to, end - span.end) : seconds(end - span.start))
  return replaceClip(tracks, at, { ...was, to })
}

function trackKindFor(kind: ClipKind): TrackKind {
  return kind === 'sound' ? 'sound' : 'picture'
}

function insertTrack(tracks: Track[], kind: TrackKind, name?: string, at?: number): Track[] {
  const id = nextId('t', tracks.map((t) => t.id))
  const n = tracks.filter((t) => t.kind === kind).length + 1
  const track: Track = {
    id,
    name: name?.trim() || (kind === 'picture' ? `Layer ${n}` : `Sound ${n}`),
    kind,
    hidden: false,
    locked: false,
    mute: false,
    solo: false,
    clips: []
  }
  const out = [...tracks]
  out.splice(at === undefined ? out.length : Math.min(at, out.length), 0, track)
  return out
}

function replaceTrack(tracks: Track[], i: number, track: Track): Track[] {
  const out = [...tracks]
  out[i] = track
  return out
}

function replaceClip(tracks: Track[], at: { t: number; c: number }, clip: TrackClip): Track[] {
  const clips = [...tracks[at.t].clips]
  clips[at.c] = clip
  return replaceTrack(tracks, at.t, { ...tracks[at.t], clips })
}
