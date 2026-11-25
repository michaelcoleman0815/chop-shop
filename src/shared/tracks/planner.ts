import { z } from 'zod'
import { isKeyed, num } from '../anim'
import { exprOf } from '../motion/anim'
import type { Resolved } from '../edit/resolve'
import type { Cut, Word } from '../edit/schema'
import { timelineFor } from '../motion/timing'
import { liftParticles, particleSlots, particleWords } from '../particles/planner'
import type { ParticleSpec } from '../particles/schema'
import { BLEND_MODES, EASE_NAMES } from '../motion/types'
import { sceneLine, sceneRefusal } from '../three/planner'
import { Scene3DPatchSchema } from '../three/spec'
import { clipSpan, tracksOf } from './resolve'
import { ROTO_CHANGE, withoutCleared } from './roto'
import { rotoBits } from './roto-words'
import { ClipFieldsSchema, CLIP_KINDS, KEYED_PROPS, type TrackClip } from './schema'

/**
 * The layer tracks as the planner writes them. Every slot is required, as the
 * planner's schema asks ('' , 0 and [] are the usual, or no change), and what
 * would make the schema deep (a clip's transform, its crop, a title's style)
 * travels in `spec`, a string of JSON checked against the clip's own schema,
 * so the plan's schema stays flat (main/planner-prompt).
 */

const flag = (): z.ZodEnum<{ '': ''; on: 'on'; off: 'off' }> => z.enum(['', 'on', 'off'])

export const TRACK_PLANNER_OPS = [
  z.object({
    op: z.literal('track'),
    action: z.enum(['add', 'update', 'remove']),
    track: z.string(),
    kind: z.enum(['', 'picture', 'sound']),
    name: z.string(),
    at: z.number(),
    hidden: flag(),
    mute: flag(),
    solo: flag(),
    locked: flag()
  }),
  z.object({
    op: z.literal('clip-add'),
    kind: z.enum(CLIP_KINDS),
    track: z.string(),
    src: z.string(),
    text: z.string(),
    color: z.string(),
    from: z.string(),
    to: z.string(),
    in: z.number(),
    speed: z.number(),
    fit: z.enum(['', 'contain', 'cover', 'fill']),
    blend: z.enum(['', ...BLEND_MODES]),
    opacity: z.number(),
    volume: z.number(),
    spec: z.string()
  }),
  z.object({ op: z.literal('clip-update'), clip: z.string(), track: z.string(), from: z.string(), to: z.string(), spec: z.string() }),
  z.object({ op: z.literal('clip-trim'), clip: z.string(), edge: z.enum(['in', 'out', 'slip']), to: z.string(), by: z.number() }),
  z.object({ op: z.literal('clip-split'), clip: z.string(), at: z.string() }),
  z.object({ op: z.literal('clip-remove'), clips: z.array(z.string()) }),
  z.object({
    op: z.literal('key-set'),
    clip: z.string(),
    prop: z.enum(KEYED_PROPS),
    t: z.number(),
    v: z.number(),
    ease: z.enum(['', ...EASE_NAMES])
  }),
  z.object({ op: z.literal('key-remove'), clip: z.string(), prop: z.enum(KEYED_PROPS), t: z.number() }),
  z.object({ op: z.literal('trim'), beat: z.string(), edge: z.enum(['in', 'out']), word: z.string(), sec: z.number() })
] as const

export const TRACK_PLANNER_OP_NAMES = ['track', 'clip-add', 'clip-update', 'clip-trim', 'clip-split', 'clip-remove', 'key-set', 'key-remove', 'trim'] as const

type PlannerTrackOp = z.infer<(typeof TRACK_PLANNER_OPS)[number]>

/** What `spec` may carry: any of a clip's settings, the deep ones (transform, crop, a title's style) included. */
const SpecSchema = ClipFieldsSchema.omit({ kind: true, scene: true }).partial().extend({
  // Masks, a matte, a key and following (tracks/roto); null takes a matte, key or follow off.
  ...ROTO_CHANGE,
  // A 3D clip's scene (shared/three): whole for a new clip, its objects and lights by id for a change.
  scene: Scene3DPatchSchema.optional(),
  text: z
    .object({
      value: z.string().optional(),
      size: z.number().optional(),
      color: z.string().optional(),
      font: z.string().optional(),
      weight: z.number().optional(),
      align: z.enum(['left', 'center', 'right']).optional(),
      maxWidth: z.number().optional()
    })
    .optional()
})

/** The settings in `spec`, or a sentence saying why it could not be read. */
export function readSpec(spec: string, kind?: string): { ok: true; spec: Record<string, unknown> } | { ok: false; reason: string } {
  const text = spec.trim()
  if (!text) return { ok: true, spec: {} }
  let raw: unknown
  try {
    // A particles clip's settings are written flat; they belong under `particles` (shared/particles/planner).
    raw = liftParticles(JSON.parse(text), kind)
  } catch {
    return { ok: false, reason: 'Its spec is not JSON.' }
  }
  const r = SpecSchema.safeParse(raw)
  if (!r.success) return { ok: false, reason: `Its spec does not fit: ${r.error.issues[0]?.path.join('.') ?? ''} ${r.error.issues[0]?.message ?? ''}`.trim() }
  // Only what it says: the schema's defaults would otherwise overwrite the op's own slots.
  const said = raw && typeof raw === 'object' ? Object.keys(raw) : []
  return { ok: true, spec: Object.fromEntries(Object.entries(r.data as Record<string, unknown>).filter(([k]) => said.includes(k))) }
}

const onOff = (f: '' | 'on' | 'off'): boolean | undefined => (f === '' ? undefined : f === 'on')

/**
 * A track op as the planner writes it, as the edit takes it. A spec that
 * cannot be read comes back as `{ refused }`, which the caller reports
 * rather than applying.
 */
export function fromTrackPlannerOp(op: PlannerTrackOp): unknown {
  switch (op.op) {
    case 'track': {
      if (op.action === 'add')
        return { op: 'track-add', kind: op.kind || 'picture', ...(op.name ? { name: op.name } : {}), ...(op.at >= 0 && op.at > 0 ? { at: op.at } : {}) }
      if (op.action === 'remove') return { op: 'track-remove', track: op.track }
      const set = {
        ...(op.name ? { name: op.name } : {}),
        ...(onOff(op.hidden) !== undefined ? { hidden: onOff(op.hidden) } : {}),
        ...(onOff(op.mute) !== undefined ? { mute: onOff(op.mute) } : {}),
        ...(onOff(op.solo) !== undefined ? { solo: onOff(op.solo) } : {}),
        ...(onOff(op.locked) !== undefined ? { locked: onOff(op.locked) } : {}),
        ...(op.at > 0 ? { at: op.at } : {})
      }
      return { op: 'track-update', track: op.track, ...set }
    }
    case 'clip-add': {
      const read = readSpec(op.spec, op.kind)
      if (!read.ok) return { refused: read.reason }
      const { text: style, ...rest } = read.spec as { text?: Record<string, unknown>; particles?: ParticleSpec; scene?: unknown }
      const unbuilt = op.kind === '3d' ? sceneRefusal(rest.scene) : null
      if (unbuilt) return { refused: unbuilt }
      return {
        op: 'clip-add',
        kind: op.kind,
        from: op.from,
        to: op.to,
        in: Math.max(0, op.in),
        speed: op.speed > 0 ? op.speed : 1,
        ...(op.track ? { track: op.track } : {}),
        ...(op.src ? { src: op.src } : {}),
        ...(op.kind === 'text' ? { text: { ...style, value: op.text || (style?.value as string | undefined) || '' } } : {}),
        ...(op.color && op.kind !== 'particles' ? { color: op.color } : {}),
        ...(op.fit ? { fit: op.fit } : {}),
        ...(op.blend ? { blend: op.blend } : {}),
        ...(op.opacity > 0 && op.opacity < 1 ? { opacity: op.opacity } : {}),
        ...(op.volume !== 0 ? { volume: op.volume } : {}),
        // Nothing to take off a clip that is new.
        ...withoutCleared(rest),
        ...(op.kind === 'particles' ? { particles: particleSlots(op, rest.particles) } : {})
      }
    }
    case 'clip-update': {
      const read = readSpec(op.spec)
      if (!read.ok) return { refused: read.reason }
      const moves = op.from || op.to
      // Onto another track, with nothing else to change: a move.
      if (op.track && Object.keys(read.spec).length === 0)
        return { op: 'clip-move', clip: op.clip, track: op.track, ...(op.from ? { from: op.from } : {}), ...(op.to ? { to: op.to } : {}) }
      return { op: 'clip-update', clip: op.clip, ...(moves && op.from ? { from: op.from } : {}), ...(op.to ? { to: op.to } : {}), ...read.spec }
    }
    case 'clip-trim':
      return { op: 'clip-trim', clip: op.clip, edge: op.edge, ...(op.to ? { to: op.to } : { by: op.by }) }
    case 'clip-split':
      return { op: 'clip-split', clip: op.clip, at: op.at }
    case 'clip-remove':
      return { op: 'clip-remove', clips: op.clips }
    case 'key-set':
      return { op: 'key-set', clip: op.clip, prop: op.prop, t: Math.max(0, op.t), v: op.v, ...(op.ease ? { ease: op.ease } : {}) }
    case 'key-remove':
      return { op: 'key-remove', clip: op.clip, prop: op.prop, t: Math.max(0, op.t) }
    case 'trim':
      return { op: 'trim', beat: op.beat, edge: op.edge, ...(op.word ? { word: op.word } : { sec: Math.max(0, op.sec) }) }
  }
}

/** The guide the planner reads: what tracks are and how each op reads, briefly. */
export function tracksGuide(): string {
  return `## Layer tracks
Picture tracks stack clips over the edit (a later track on top); sound tracks mix under it. Use them for picture-in-picture, a clip or image over the speaker, a title or a coloured solid over a stretch, a sound under a moment, and anything asked of "layers", "keyframes", "blend", "opacity" or "trim".
- {"op":"clip-add","kind":"video","track":"","src":"a3","text":"","color":"","from":"w12","to":"w20.end","in":0,"speed":0,"fit":"","blend":"","opacity":0,"volume":0,"spec":"{\\"transform\\":{\\"scale\\":0.4,\\"x\\":760,\\"y\\":420}}"}: kinds video, image, text (its words in "text"), solid (its "color"), sound. "src" is material or a recording by id. "track":"" puts it on the top track of its kind, or a new one. "to" is an anchor, a length like "4s", or "" for its natural length. "in" is where in its file it starts; "speed" 0 is 1. "fit" contain (the default), cover or fill. "blend" any of ${BLEND_MODES.join(', ')}. "opacity" 0 is full. "volume" in dB, 0 as recorded.
- "spec" is a string of JSON for anything else: "transform" (x, y: where its centre sits, in pixels of the full-size frame; scale, scaleX, scaleY, rotation in degrees, anchorX, anchorY, skewX, skewY), "crop" (left, top, right, bottom as shares 0 to 1), "text" (size, color, font, weight, align, maxWidth, shadow true or {color,blur,y}, glow {color,blur,strength}, outline {color,width}, slant true or 0 to 0.5, tracking, lineHeight, uppercase), "muted" (a video's own sound), or "" for none. Any of these may be keyframes: {"keys":[{"t":0,"v":0},{"t":0.5,"v":1,"ease":"easy-ease"}]}, t in seconds from the clip's start. Eases as creators set them: a fade or a small rise out-quad over 0.3 s; a card or panel sliding in out-quint over 0.8 to 1.1 s; a row, a fill or a size change in-out-cubic over 0.3 to 0.6 s; a pop back-out over 0.4 s; a full-frame push out-expo over 0.6 s. A move done in a frame or two looks like a jump, not a glide.
- {"op":"clip-update","clip":"c2","track":"","from":"","to":"","spec":"{\\"opacity\\":0.6}"}: changes a clip by its id in <tracks>; "track" alone moves it to that track.
- {"op":"clip-trim","clip":"c2","edge":"in","to":"w14","by":0}: trims its head ("in", the file moves with it), its tail ("out"), or slips what plays inside it ("slip", "by" seconds of file). To an anchor in "to", or by seconds in "by" with "to":"".
- {"op":"clip-split","clip":"c2","at":"w18"}: splits a clip in two at an anchor.
- {"op":"clip-remove","clips":["c2"]}: takes clips away.
- {"op":"key-set","clip":"c2","prop":"opacity","t":0,"v":0,"ease":""}: sets a key on one setting (${KEYED_PROPS.join(', ')}), replacing one at that moment.
- {"op":"key-remove","clip":"c2","prop":"opacity","t":0}: takes a key off.
- {"op":"track","action":"add","track":"","kind":"picture","name":"","at":0,"hidden":"","mute":"","solo":"","locked":""}: adds a track; "update" names a track by id and sets name, at (its place, 0 lowest), hidden, mute, solo, locked ("on", "off", or "" to leave it); "remove" takes it away.
- {"op":"trim","beat":"b3","edge":"in","word":"w14","sec":0}: moves the edge of the edit's own beat to a word ("in" its first, "out" its last); "sec" instead for a beat that is a stretch of a recording.`
}

const clock = (sec: number): string => {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}

function described(clip: TrackClip, length: number): string {
  const bits: string[] = []
  if (clip.src) bits.push(`src ${clip.src}`)
  if (clip.text) bits.push(`"${clip.text.value.slice(0, 40)}"`)
  if (clip.color) bits.push(clip.color)
  if (clip.in > 0) bits.push(`in ${clip.in.toFixed(2)}`)
  if (clip.speed !== 1) bits.push(`speed ${clip.speed}`)
  if (clip.blend !== 'normal') bits.push(`blend ${clip.blend}`)
  if (clip.fit !== 'contain') bits.push(`fit ${clip.fit}`)
  if (clip.muted) bits.push('muted')
  // An adjustment's grade, setting by setting.
  if (clip.grade) {
    const grade = Object.entries(clip.grade).filter(([, v]) => v !== undefined)
    if (grade.length) bits.push(`grade ${grade.map(([k, v]) => `${k} ${v}`).join(' ')}`)
  }
  if (clip.kind === 'particles') bits.push(particleWords(clip.particles))
  bits.push(...rotoBits(clip))
  if (clip.scene) bits.push(`scene: ${sceneLine(clip.scene)}`)
  const anims: [string, unknown][] = [
    ['opacity', clip.opacity],
    ['volume', clip.volume],
    ['pan', clip.pan],
    ...Object.entries(clip.transform ?? {}),
    ...Object.entries(clip.crop ?? {}).map(([k, v]) => [`crop.${k}`, v] as [string, unknown])
  ]
  for (const [name, a] of anims) {
    if (a === undefined) continue
    const expr = exprOf(a as never)
    if (expr) bits.push(`${name} expr ${JSON.stringify(expr)}`)
    if (isKeyed(a as never) && (a as { keys: unknown[] }).keys.length === 0) continue
    if (isKeyed(a as never)) {
      const keys = (a as { keys: { t: number; v: number }[] }).keys
      bits.push(`${name} keys ${keys.map((k) => `${k.t}:${k.v}`).join(' ')}`)
    } else bits.push(`${name} ${num(a as number, 0, length)}`)
  }
  return bits.join(' | ')
}

/** The tracks and their clips, one line each, for the request. */
export function tracksLines(cut: Cut, resolved: Resolved, words: Word[]): string[] {
  const tracks = tracksOf(cut)
  if (tracks.length === 0) return []
  const tl = timelineFor(cut, resolved, words)
  const lines: string[] = []
  tracks.forEach((t, i) => {
    const state = [t.hidden ? 'hidden' : null, t.mute ? 'muted' : null, t.solo ? 'solo' : null, t.locked ? 'locked' : null].filter(Boolean)
    lines.push(`${t.id} ${t.kind} "${t.name}" (${i === 0 ? 'lowest' : `place ${i}`})${state.length ? ` ${state.join(' ')}` : ''}`)
    for (const c of t.clips) {
      const span = clipSpan(tl, c)
      const when = span ? `[${clock(span.start)}-${clock(span.end)}]` : '[not in the cut]'
      const detail = described(c, span ? span.end - span.start : 0)
      lines.push(`  ${c.id} ${c.kind} ${when} from ${c.from}${c.to ? ` to ${c.to}` : ''}${detail ? ` | ${detail}` : ''}`)
    }
  })
  return lines
}
