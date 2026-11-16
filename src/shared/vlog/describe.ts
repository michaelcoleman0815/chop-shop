import { PALETTE_HUES } from './frames'
import type { Clip, Moment, Scene } from './schema'

/**
 * What is in a moment, in one line, when nothing has looked at its pictures:
 * said from the measurements alone, plainly, so a person can still tell the
 * moments apart ("a bright, steady shot, mostly green, with wind on the
 * microphone"). Claude or a model on this Mac say it better; this is what
 * there is without either. Scenes are named by their time of day, or by
 * what their moments were said to show when something looked.
 */

const HUE_NAMES = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']

/** The colour a look is mostly, in a word, or null when it is mostly grey or mixed. */
export function colourOf(look: number[]): string | null {
  if (look.length < PALETTE_HUES + 4) return null
  const hues = look.slice(0, PALETTE_HUES)
  const greys = look.slice(PALETTE_HUES, PALETTE_HUES + 4).reduce((a, b) => a + b, 0)
  let best = 0
  for (let k = 1; k < hues.length; k++) if (hues[k] > hues[best]) best = k
  if (hues[best] >= 0.4) return HUE_NAMES[best]
  if (greys >= 0.6) return look[PALETTE_HUES] + look[PALETTE_HUES + 1] > greys * 0.6 ? 'dark' : 'grey'
  return null
}

const SOUND_WORDS: Record<string, string> = {
  cheering: 'with cheering',
  laughter: 'with laughter',
  music: 'with music playing',
  wind: 'with wind on the microphone',
  speech: 'with someone talking'
}

/** One line from what a moment measured, with the first words said in it when it is talking. */
export function describeFromMeasures(m: Moment, clip: Clip | undefined, said = ''): string {
  if (m.kind === 'talk' && said.trim()) {
    const words = said.trim().split(/\s+/)
    const quote = words.length > 9 ? `${words.slice(0, 9).join(' ')} …` : words.join(' ')
    return `you talking to the camera: “${quote}”`
  }
  const light = m.light < 0.22 ? 'dark' : m.light < 0.38 ? 'dim' : m.light > 0.72 ? 'very bright' : 'bright'
  const camera = m.steady >= 0.8 ? 'steady' : m.steady >= 0.45 ? 'handheld' : 'shaky'
  const motion =
    m.motion >= 0.6
      ? 'a lot moving fast'
      : m.motion >= 0.3
        ? 'things moving'
        : m.motion >= 0.1
          ? 'a little movement'
          : 'little moving'
  const colour = clip ? colourOf(clip.look) : null
  const sound = m.sounds.map((s) => SOUND_WORDS[s]).find(Boolean) ?? (m.loud < 0.15 ? 'quiet' : '')
  const upright = clip && clip.height > clip.width ? 'upright ' : ''
  const parts = [`a ${light}, ${camera} ${upright}shot`, colour ? `mostly ${colour}` : null, motion, sound || null]
  return parts.filter(Boolean).join(', ')
}

/** Where a time was shot, as a time zone: minutes east of UTC, or null for this computer's own. */
export type ZoneAt = (at: number) => number | null

const LOCAL: ZoneAt = () => null

/**
 * The time zone of the day at a moment: the one the camera of the nearest
 * clip gave with its time (an iPhone gives it), so a day shot in Tokyo reads
 * on Tokyo's clock wherever it is edited. Null when no camera gave one.
 */
export function zoneAt(clips: { at: number | null; zoneMin?: number | null }[], at: number | null): number | null {
  if (at === null) return null
  let best: { d: number; zone: number } | null = null
  for (const c of clips) {
    if (c.at === null || typeof c.zoneMin !== 'number') continue
    const d = Math.abs(c.at - at)
    if (!best || d < best.d) best = { d, zone: c.zoneMin }
  }
  return best?.zone ?? null
}

/** A time as the clock where it was shot showed it, read with the UTC getters; this computer's clock without a zone. */
export function wallClock(at: number, zoneMin: number | null = null): Date {
  if (zoneMin !== null) return new Date((at + zoneMin * 60) * 1000)
  const d = new Date(at * 1000)
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()))
}

/** A time of day as people say it: 9:12, 13:05. */
export function timeOfDay(at: number | null, zoneMin: number | null = null): string | null {
  if (at === null) return null
  const d = wallClock(at, zoneMin)
  return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** The hours after midnight are the night before until this hour: a party at 0:50 is Saturday night, not Sunday morning. */
export const NIGHT_ENDS_HOUR = 5

function partOfDay(at: number, zoneMin: number | null): string {
  const h = wallClock(at, zoneMin).getUTCHours()
  return h < NIGHT_ENDS_HOUR ? 'Night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 21 ? 'Evening' : 'Night'
}

/** The day a time belongs to where it was shot, counted in days: the small hours go with the night before. */
function dayOf(at: number, zoneMin: number | null): number {
  return Math.floor((wallClock(at, zoneMin).getTime() / 1000 - NIGHT_ENDS_HOUR * 3600) / 86400)
}

/**
 * The day a scene was shot on, when the shoot ran past its first day:
 * "Sunday", or "3 May" for a shoot longer than a week. Null on the first day.
 */
export function dayName(
  at: number | null,
  firstAt: number | null,
  lastAt: number | null = null,
  zone: ZoneAt = LOCAL
): string | null {
  if (at === null || firstAt === null || dayOf(at, zone(at)) === dayOf(firstAt, zone(firstAt))) return null
  // Named by the day it belongs to: the small hours by the night before.
  const d = new Date(dayOf(at, zone(at)) * 86400000)
  const long = lastAt !== null && dayOf(lastAt, zone(lastAt)) - dayOf(firstAt, zone(firstAt)) >= 6
  return long
    ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })
    : d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })
}

/** Words that name a place in a line, for naming a scene from what its moments show. */
const PLACE =
  /\b(?:at|in|inside|outside|on|by|into|through|around|near|across)\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z' -]{2,40}?)(?=[,.;]|\s+(?:with|while|as|and|where|at|in)\b|$)/i

/** A place a description names: "walking into the venue, a crowd at the door" names "the venue". */
export function placeIn(line: string): string | null {
  const m = PLACE.exec(line)
  if (!m) return null
  const place = m[1].trim().replace(/\s+/g, ' ')
  if (/^(camera|frame|night|day|morning|evening|afternoon|front|back|middle|distance)$/i.test(place)) return null
  return place.split(' ').length <= 4 ? place : null
}

/**
 * A scene's name: the place its moments were said to be in most often, when
 * something looked at them, else its part of the day and when it started,
 * with the day itself on a shoot of more than one ("Sunday morning, 8:30").
 */
export function nameScene(
  scene: Scene,
  moments: Moment[],
  index: number,
  shoot: { firstAt: number | null; lastAt: number | null; zone?: ZoneAt } = { firstAt: null, lastAt: null }
): string {
  const zone = shoot.zone ?? LOCAL
  const own = new Set(scene.clips)
  const seen = moments.filter((m) => own.has(m.clip) && m.describedBy !== 'measurements')
  const counts = new Map<string, number>()
  for (const m of seen) {
    const place = placeIn(m.description)
    if (place) counts.set(place.toLowerCase(), (counts.get(place.toLowerCase()) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  const day = dayName(scene.startAt, shoot.firstAt, shoot.lastAt, zone)
  if (top && top[1] >= Math.max(1, seen.length / 4)) return `The ${top[0].replace(/^the /, '')}${day ? `, ${day}` : ''}`
  if (scene.startAt !== null) {
    const part = partOfDay(scene.startAt, zone(scene.startAt))
    return `${day ? `${day} ${part.toLowerCase()}` : part}, ${timeOfDay(scene.startAt, zone(scene.startAt))}`
  }
  return `Scene ${index + 1}`
}
