import { describeLook, LOOK_RANGE, NAMED_LOOKS, type Look, type LookPatch, type LookSetting } from '../edit/look'
import type { Op } from '../edit/schema'

/**
 * The colour commands: /look and its settings, /grain, /vignette, /lut and
 * the rest. Read here, apart from the app, so every phrasing is tested; the
 * app only finds the LUT file when one is asked for.
 */

/** The commands that set one thing, and the setting each turns. */
export const LOOK_COMMANDS: Record<string, LookSetting> = {
  exposure: 'exposure',
  contrast: 'contrast',
  saturation: 'saturation',
  warmth: 'temperature',
  tint: 'tint',
  grain: 'grain',
  vignette: 'vignette',
  sharpen: 'sharpen'
}

/** The words a person may use for each setting after /look. */
const SETTING_WORDS: Record<string, LookSetting> = {
  ...LOOK_COMMANDS,
  brightness: 'exposure',
  temperature: 'temperature',
  temp: 'temperature',
  colour: 'saturation',
  color: 'saturation',
  fade: 'lift',
  faded: 'lift',
  lift: 'lift',
  sharpness: 'sharpen',
  // Old film (edit/film.ts): /look sepia 0.6, /look dust 0.3, /look weave off.
  sepia: 'sepia',
  weave: 'weave',
  gate: 'weave',
  dust: 'dust',
  scratches: 'dust',
  leak: 'leak',
  leaks: 'leak',
  flicker: 'flicker'
}

/** How much a setting gets when its command comes on its own: /grain, /vignette. */
const ON_ITS_OWN: Partial<Record<LookSetting, number>> = {
  grain: 0.3,
  vignette: 0.4,
  sharpen: 0.4,
  lift: 0.4,
  sepia: 0.6,
  weave: 0.5,
  dust: 0.4,
  leak: 0.3,
  flicker: 0.35
}

/** Plain names for the settings, in replies. */
const SPOKEN: Record<LookSetting, string> = {
  exposure: 'exposure',
  contrast: 'contrast',
  saturation: 'saturation',
  temperature: 'warmth',
  tint: 'tint',
  lift: 'faded blacks',
  sharpen: 'sharpening',
  vignette: 'vignette',
  grain: 'grain',
  sepia: 'sepia',
  weave: 'gate weave',
  dust: 'dust and scratches',
  leak: 'light leaks',
  flicker: 'flicker'
}

export type LookCommandResult =
  /** Ops to apply as a version. */
  | { ops: Op[] }
  /** Nothing to apply: a sentence to say instead. */
  | { say: string }
  /** A LUT to find: by name in the LUT folders, or chosen by hand when the name is null. */
  | { lut: { name: string | null; strength: number | null } }

const OFF = /^(off|none|no|reset|0)$/i
const MORE = /^(more|up|higher|stronger|\+)$/i
const LESS = /^(less|down|lower|weaker|-)$/i

/** A number as typed: "0.3", "+0.5", "-0.2", "40%". */
function amountOf(word: string): number | null {
  const m = /^([+-]?\d*\.?\d+)(%?)$/.exec(word)
  if (!m) return null
  const n = Number(m[1])
  return m[2] ? n / 100 : n
}

const clampTo = (k: LookSetting, v: number): number => Math.min(LOOK_RANGE[k].max, Math.max(LOOK_RANGE[k].min, v))

/**
 * One setting's new value from what was typed after it: a number, a word that
 * moves it a step, off, or nothing, which gives grain and the like a usual
 * amount. Null when the words say nothing usable.
 */
function valueFor(k: LookSetting, words: string, now: number): number | null {
  const w = words.trim()
  if (w === '') return ON_ITS_OWN[k] ?? null
  if (OFF.test(w)) return 0
  if (MORE.test(w)) return clampTo(k, now + LOOK_RANGE[k].step)
  if (LESS.test(w)) return clampTo(k, now - LOOK_RANGE[k].step)
  const n = amountOf(w.replace(/\s*stops?$/i, ''))
  return n === null ? null : clampTo(k, n)
}

const NAMES = Object.keys(NAMED_LOOKS)

/** What the colour commands can do, for /look on its own. */
export function lookHelp(current: Look | null | undefined): string {
  const now = current ? `The picture is ${describeLook(current)} now. ` : ''
  return (
    `${now}Looks: ${NAMES.map((n) => `/${n}`).join(', ')}. Or turn one thing: /look contrast 0.2, ` +
    '/exposure +0.3, /warmth 0.2, /grain, /vignette, and /lut for a LUT file. /look off takes it all off.'
  )
}

/** Reads a colour command into ops, a sentence, or a LUT to find. */
export function lookCommand(command: string, rest: string, current: Look | null | undefined): LookCommandResult {
  const words = rest.trim()
  const look = current ?? null
  const set = (patch: LookPatch, replace = false): LookCommandResult => ({
    ops: [{ op: 'look', set: patch, ...(replace ? { replace: true } : {}) }]
  })

  if (command === 'lut') {
    if (OFF.test(words)) {
      return look?.lut ? set({ lut: null }) : { say: 'There is no LUT on the picture.' }
    }
    // A strength alone changes how much of the LUT there is shows.
    const strength = amountOf(words)
    if (strength !== null) {
      const k = Math.min(1, Math.max(0, strength > 1 ? strength / 100 : strength))
      if (!look?.lut) return { say: 'Choose a LUT first: /lut on its own opens one.' }
      return set({ lut: { ...look.lut, strength: k } })
    }
    // A name, maybe with a strength after it: "/lut Kodak 2383 70%".
    const m = /^(.*?)(?:\s+(\d+(?:\.\d+)?%|0?\.\d+|1(?:\.0+)?))?$/.exec(words)
    const name = (m?.[1] ?? '').trim()
    const at = m?.[2] ? amountOf(m[2]) : null
    return { lut: { name: name || null, strength: at === null ? null : Math.min(1, Math.max(0, at)) } }
  }

  const setting = LOOK_COMMANDS[command]
  if (setting) {
    const v = valueFor(setting, words, look?.[setting] ?? 0)
    if (v === null) {
      return {
        say: `Give me an amount: /${command} 0.2 adds some${LOOK_RANGE[setting].min < 0 ? `, /${command} -0.2 takes some away` : ''}, and /${command} off takes it off.`
      }
    }
    return set({ [setting]: v })
  }

  // /look: on its own, a named look, off, or settings with amounts.
  if (words === '') return { say: lookHelp(look) }
  if (OFF.test(words)) return look ? { ops: [{ op: 'look', set: null }] } : { say: 'The picture has no look on it.' }
  const named = NAMED_LOOKS[words.toLowerCase()]
  if (named) return set(named.look, true)
  const patch: LookPatch = {}
  const parts = words.toLowerCase().split(/[\s,]+/)
  for (let i = 0; i < parts.length; i++) {
    const k = SETTING_WORDS[parts[i]]
    if (!k) continue
    // The amount is the next word, unless that is another setting.
    const next = parts[i + 1] && !SETTING_WORDS[parts[i + 1]] ? parts[i + 1] : ''
    const v = valueFor(k, next, look?.[k] ?? 0)
    if (v === null) return { say: `How much ${SPOKEN[k]}? For example /look ${parts[i]} 0.2.` }
    patch[k] = v
    if (next) i++
  }
  if (Object.keys(patch).length === 0) {
    return { say: `I don't know a look called “${words}”. ${lookHelp(look)}` }
  }
  return set(patch)
}
