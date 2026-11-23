import { z } from 'zod'
import { animWords, fxWords, isNeutral, stripsOf, type MixCut } from './bus'
import { AudioFxSchema, FX_KINDS, MAX_EFFECTS, type AudioFx } from './schema'

/**
 * The mixer as the planner writes it. Every slot is required, as the
 * planner's schema asks ('', [] are the usual, or no change), and the effects
 * travel in `spec`, a string of JSON checked against the effects' own schema,
 * so the plan's schema stays flat (main/planner-prompt). Every enum is made
 * fresh where it is used, so the schema never refers to one twice.
 */

const flag = (): z.ZodEnum<{ '': ''; on: 'on'; off: 'off' }> => z.enum(['', 'on', 'off'])
const setting = (): z.ZodEnum<{ gainDb: 'gainDb'; pan: 'pan' }> => z.enum(['gainDb', 'pan'])

export const MIX_PLANNER_OPS = [
  z.object({
    op: z.literal('mix'),
    target: z.string(),
    set: z.array(z.object({ key: setting(), value: z.number() })),
    keys: z.array(z.object({ key: setting(), t: z.number(), v: z.number() })),
    mute: flag(),
    solo: flag(),
    effects: z.enum(['', 'add', 'replace', 'remove']),
    spec: z.string()
  })
] as const

type PlannerMixOp = z.infer<(typeof MIX_PLANNER_OPS)[number]>

const onOff = (f: '' | 'on' | 'off'): boolean | undefined => (f === '' ? undefined : f === 'on')

/** The effects in `spec`, a list or one alone, each at its usual settings where it leaves one out. */
export function readFxSpec(spec: string): { ok: true; effects: AudioFx[] } | { ok: false; reason: string } {
  const text = spec.trim()
  if (!text) return { ok: true, effects: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'Its spec is not JSON.' }
  }
  const list = Array.isArray(raw) ? raw : [raw]
  const r = z.array(AudioFxSchema).max(MAX_EFFECTS).safeParse(list)
  if (!r.success) {
    const issue = r.error.issues[0]
    return { ok: false, reason: `Its effects do not fit: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim() }
  }
  return { ok: true, effects: r.data }
}

/** What `spec` names to take off: kinds, or places counting from 1. */
function readRemoval(spec: string): { ok: true; remove: (number | AudioFx['kind'])[] } | { ok: false; reason: string } {
  let raw: unknown
  try {
    raw = JSON.parse(spec.trim() || '[]')
  } catch {
    return { ok: false, reason: 'Its spec is not JSON.' }
  }
  const list = Array.isArray(raw) ? raw : [raw]
  const r = z.array(z.union([z.number().int().min(1), z.enum(FX_KINDS)])).min(1).safeParse(list)
  if (!r.success) return { ok: false, reason: 'Say which effects to take off: their kinds, or their places counting from 1.' }
  return { ok: true, remove: r.data }
}

/**
 * The mix op as the planner writes it, as the edit takes it. A spec that
 * cannot be read comes back as `{ refused }`, which the caller reports rather
 * than applying.
 */
export function fromMixPlannerOp(op: PlannerMixOp): unknown {
  const out: Record<string, unknown> = { op: 'mix', target: op.target.trim() }
  for (const s of op.set) out[s.key] = s.value
  for (const key of ['gainDb', 'pan'] as const) {
    const keys = op.keys.filter((k) => k.key === key).sort((a, b) => a.t - b.t)
    if (keys.length > 0) out[key] = { keys: keys.map((k) => ({ t: Math.max(0, k.t), v: k.v })) }
  }
  const mute = onOff(op.mute)
  const solo = onOff(op.solo)
  if (mute !== undefined) out.mute = mute
  if (solo !== undefined) out.solo = solo
  if (op.effects === 'remove') {
    const read = readRemoval(op.spec)
    if (!read.ok) return { refused: read.reason }
    out.remove = read.remove
  } else if (op.effects === 'add' || op.effects === 'replace') {
    const read = readFxSpec(op.spec)
    if (!read.ok) return { refused: read.reason }
    out[op.effects === 'add' ? 'add' : 'effects'] = read.effects
  }
  return out
}

/** The always-on line: what the mixer does and its op by name. */
export const MIX_INDEX =
  'mixer: op mix sets a strip’s level, pan, mute, solo and effects (EQ, high- and low-pass, compressor, gate, de-esser, noise reduction, reverb, echo, limiter); the strips are the voice, the music and each track that sounds.'

/** The full guide the planner reads when the ask or the cut needs it. */
export function mixGuide(): string {
  return `## Mixing
Every sound has a strip: "voice" (the edit's own sound), "music" (the bed) and each track that sounds, by its id in <tracks> (a sound track, or a picture track whose videos carry sound). <mix> lists them. A strip's effects run in order, then its level (its fader: -60 to +12 dB, 0 as it comes) and its pan (-1 left to 1 right). The voice's effects run before its loudness is set, as the polish does; its level after. Mute and solo hold in the export too: while any strip is soloed, only soloed strips are heard. Louder or quieter for a sound means its level, 3 to 6 dB at a time.
- {"op":"mix","target":"t2","set":[{"key":"gainDb","value":-6}],"keys":[],"mute":"","solo":"","effects":"","spec":""}: sets a strip's level or pan, naming only what changes; a value replaces any keys it had.
- {"op":"mix","target":"music","set":[],"keys":[{"key":"gainDb","t":30,"v":0},{"key":"gainDb","t":32,"v":-18}],"mute":"","solo":"","effects":"","spec":""}: moves a level or pan along keys at seconds of the video, in straight ramps, held before the first and after the last; they replace the keys it had.
- {"op":"mix","target":"voice","set":[],"keys":[],"mute":"","solo":"","effects":"add","spec":"[{\\"kind\\":\\"highpass\\",\\"freq\\":90},{\\"kind\\":\\"compressor\\",\\"thresholdDb\\":-20,\\"ratio\\":3}]"}: adds effects at the end of a strip's chain.
- {"op":"mix","target":"t2","set":[],"keys":[],"mute":"","solo":"","effects":"replace","spec":"[{\\"kind\\":\\"reverb\\",\\"room\\":0.6,\\"mix\\":0.25}]"}: replaces the whole chain; "spec":"[]" takes every effect off.
- {"op":"mix","target":"t2","set":[],"keys":[],"mute":"","solo":"","effects":"remove","spec":"[\\"reverb\\",2]"}: takes effects off by kind, or by place (1 the first).
- {"op":"mix","target":"t3","set":[],"keys":[],"mute":"on","solo":"","effects":"","spec":""}: mutes a strip ("on", "off", or "" to leave it); "solo" the same way.
- {"op":"key-set","clip":"c4","prop":"pan","t":0,"v":-0.5,"ease":""}: one clip's own pan, keyed as its level is.
Effects in "spec", each a JSON object with its "kind"; a setting left out takes its usual value, and "bypass":true keeps an effect without hearing it:
- eq: "bands", up to 6, each {"type":"peak","freq":3000,"gainDb":-4,"q":1.4}; types peak, lowshelf, highshelf and notch (a notch takes its band out). Hum: notches at 60, 120 and 180 Hz, or 50, 100 and 150 where the mains are 50 Hz.
- highpass {"freq":80} takes out rumble below; lowpass {"freq":12000} hiss above, or makes a sound muffled and far off at 1500 or so.
- compressor {"thresholdDb":-18,"ratio":3,"attackMs":10,"releaseMs":150,"makeupDb":0}; gate {"thresholdDb":-45,"rangeDb":-30,"attackMs":5,"releaseMs":200}; limiter {"ceilingDb":-1,"releaseMs":50}.
- deesser {"amount":0.5} softens esses; noise {"reduceDb":12,"floorDb":-50} takes steady hiss and hum down.
- reverb {"room":0.5,"mix":0.2}: room 0 a small room to 1 a hall, mix how much of it is heard; delay {"timeMs":250,"feedback":0.3,"mix":0.25}: an echo, each repeat feedback of the one before.`
}

const SOUND = /\b(sounds?|audio|voice|vocals?|music|songs?|tracks?|stereo|ears?|channels?|mic|bed)\b/i
const ALWAYS =
  /\b(mix|mixer|mixing|remix|eq|eqs|equali[sz](e|er|ers|ing|ation)|reverb|reverbs|echo|echoes|echoey|compress|compressor|compression|gate|gated|de-?ess(er|ing)?|noise|noisy|hiss|hissy|hum|humming|buzz|buzzing|limiter|fader|faders|delay)\b/i
const PAN = /\bpan(ned|ning|s)?\b/i
const LEVEL = /\b(louder|quieter|softer|turn(ed|ing)?\b.{0,30}?\b(up|down))\b/i

/** Whether a cut has been mixed at all: a strip with a level, pan or effects, or one muted or soloed. */
export function hasMix(cut: MixCut): boolean {
  return stripsOf(cut).some((s) => !isNeutral(s.mix) || s.mix.effects.length > 0 || (s.kind !== 'track' && (s.mute || s.solo)))
}

/**
 * Whether this ask, or this cut, needs the mixer's guide: words a person uses
 * for mixing, panning or turning a sound up or down, or a cut that is already
 * mixed. "music" alone is every other request, so it never does by itself.
 */
export function wantsMix(ask: string, cut: MixCut): boolean {
  if (hasMix(cut)) return true
  if (ALWAYS.test(ask)) return true
  return (PAN.test(ask) || LEVEL.test(ask)) && SOUND.test(ask)
}

/** The strips, one line each, for the request: every one when `all`, otherwise only those mixed. */
export function mixLines(cut: MixCut, all: boolean): string[] {
  const lines: string[] = []
  for (const s of stripsOf(cut)) {
    const touched = !isNeutral(s.mix) || s.mix.effects.length > 0 || s.mute || s.solo
    if (!all && !touched) continue
    const name = s.kind === 'track' ? `${s.target} "${s.name}"` : s.target
    const state = [s.mute ? 'muted' : null, s.solo ? 'solo' : null].filter(Boolean)
    const fx = s.mix.effects.map((f, i) => `${i + 1} ${fxWords(f)}`).join(', ')
    lines.push(
      `${name} level ${animWords(s.mix.gainDb)} pan ${animWords(s.mix.pan)}${state.length ? ` ${state.join(' ')}` : ''} | ${fx ? `effects ${fx}` : 'no effects'}`
    )
  }
  return lines
}
