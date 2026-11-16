import { z } from 'zod'
import {
  GRAPHIC_KINDS,
  STILL_MOVES,
  BibleSchema,
  ShotSchema,
  type Bible,
  type Brief,
  type Character,
  type ImageService,
  type MakeFormat,
  type Shot,
  type StillMove,
  type Visual
} from './schema'
import { clipCost, needs, stillCost } from './quote'
import { PRICES } from './prices'

/**
 * The shot list: one visual for each phrase of the narration, planned in a
 * style bible, checked before anything is made.
 *
 * Claude answers in a flat shape (every field required, no unions), which
 * keeps the structured-output schema small; here it becomes the shot list's
 * own schema, phrase by phrase. A shot list that skips a phrase, repeats one
 * or names a character the bible does not have is mended, never trusted.
 * Without Claude the shots are planned on this Mac from the words alone.
 */

// ---------- What Claude answers ----------

export const ShotAnswerSchema = z.object({
  phrase: z.number(),
  kind: z.enum(['still', 'clip', 'map', 'card', 'broll', 'graphic']),
  /** The picture for a still or a clip; the search for B-roll; empty otherwise. */
  prompt: z.string(),
  move: z.enum(STILL_MOVES),
  /** What moves in a clip. */
  motion: z.string(),
  characters: z.array(z.string()),
  /** The place, for a map. */
  place: z.string(),
  /** A year or a place set big over the shot, and a smaller line; both empty for none. */
  titleBig: z.string(),
  titleSmall: z.string(),
  graphic: z.enum(['', ...GRAPHIC_KINDS]),
  text: z.array(z.string()),
  values: z.array(z.number()),
  items: z.array(z.object({ label: z.string(), value: z.string() })),
  callouts: z.array(z.object({ label: z.string(), value: z.string(), x: z.number(), y: z.number() }))
})
export type ShotAnswer = z.infer<typeof ShotAnswerSchema>

export const ShotListAnswerSchema = z.object({
  style: z.string(),
  palette: z.string(),
  era: z.string(),
  characters: z.array(z.object({ id: z.string(), name: z.string(), look: z.string() })),
  shots: z.array(ShotAnswerSchema)
})
export type ShotListAnswer = z.infer<typeof ShotListAnswerSchema>

/** What Claude writes a script as: a title and sections of paragraphs. */
export const ScriptAnswerSchema = z.object({
  title: z.string(),
  sections: z.array(z.object({ heading: z.string(), paragraphs: z.array(z.string()) }))
})
export type ScriptAnswer = z.infer<typeof ScriptAnswerSchema>

/** A script answer as the text the person sees and edits: headings as "## " lines, paragraphs between. */
export function scriptText(answer: ScriptAnswer): string {
  const parts: string[] = []
  if (answer.title.trim()) parts.push(`# ${answer.title.trim()}`)
  for (const s of answer.sections) {
    const body = s.paragraphs.map((p) => p.trim()).filter(Boolean)
    if (body.length === 0) continue
    if (s.heading.trim()) parts.push(`## ${s.heading.trim()}`)
    parts.push(...body)
  }
  return parts.join('\n\n')
}

const clampText = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max)
const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.5))

/** A character id the bible can use: "the-oilman" from "The Oilman". */
export function characterId(name: string, taken: Set<string>): string {
  let base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || 'character'
  if (!/^[a-z]/.test(base)) base = `c-${base}`.slice(0, 20)
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

export interface CheckedShots {
  bible: Bible
  shots: Shot[]
  /** What was mended, for whoever reads the log. */
  mended: string[]
}

/** A visual made from one answered shot, or null when the answer cannot be one. */
function visualOf(a: ShotAnswer, known: Set<string>): Visual | null {
  const characters = a.characters.filter((c) => known.has(c)).slice(0, 4)
  const prompt = clampText(a.prompt, 1200)
  switch (a.kind) {
    case 'still':
      return prompt ? { kind: 'still', prompt, move: a.move, characters } : null
    case 'clip':
      return prompt ? { kind: 'clip', prompt, motion: clampText(a.motion, 400), characters } : null
    case 'map': {
      const place = clampText(a.place || a.prompt, 160)
      return place ? { kind: 'map', place } : null
    }
    case 'card': {
      const big = clampText(a.titleBig || a.text[0] || '', 40)
      return big ? { kind: 'card', big, small: clampText(a.titleSmall || a.text[1] || '', 80) } : null
    }
    case 'broll':
      return prompt ? { kind: 'broll', search: clampText(prompt, 160) } : null
    case 'graphic':
      return a.graphic
        ? {
            kind: 'graphic',
            graphic: a.graphic,
            text: a.text.map((t) => clampText(t, 120)).filter(Boolean).slice(0, 6),
            values: a.values.filter((v) => Number.isFinite(v)).slice(0, 12),
            items: a.items.slice(0, 8).map((i) => ({ label: clampText(i.label, 80), value: clampText(i.value, 40) }))
          }
        : null
  }
}

/** A still for a phrase when nothing better was planned: the words themselves as the picture. */
function fallbackStill(phrase: string, i: number, format: MakeFormat): Visual {
  const moves: StillMove[] =
    format === 'documentary' ? ['push-in', 'ken-burns', 'pan-right', 'drift', 'pull-out', 'pan-left'] : ['drift', 'push-in', 'ken-burns']
  return { kind: 'still', prompt: clampText(phrase, 600), move: moves[i % moves.length], characters: [] }
}

/**
 * Claude's shot list made safe: exactly one shot for every phrase, in order;
 * characters only from the bible; clips held to `maxClips`, maps dropped
 * when none were wanted; titles and callouts tidied. Phrases with no usable
 * shot get a still of their own words.
 */
export function checkShotList(
  answer: ShotListAnswer,
  phrases: string[],
  opts: { format: MakeFormat; maxClips: number; maps: boolean }
): CheckedShots {
  const mended: string[] = []
  const taken = new Set<string>()
  const rename = new Map<string, string>()
  const characters: Character[] = []
  for (const c of answer.characters.slice(0, 4)) {
    const name = clampText(c.name, 60)
    const look = clampText(c.look, 600)
    if (!name || !look) continue
    const id = /^[a-z][a-z0-9-]{0,23}$/.test(c.id) && !taken.has(c.id) ? (taken.add(c.id), c.id) : characterId(name, taken)
    if (id !== c.id) rename.set(c.id, id)
    characters.push({ id, name, look })
  }
  const known = new Set(characters.map((c) => c.id))
  const bible = BibleSchema.parse({
    style: clampText(answer.style, 900) || (opts.format === 'documentary' ? 'Photoreal archival photograph.' : 'Flat, bright cartoon.'),
    palette: clampText(answer.palette, 240),
    era: clampText(answer.era, 160),
    characters
  })

  const byPhrase = new Map<number, ShotAnswer>()
  for (const a of answer.shots) {
    const i = Math.round(a.phrase)
    if (!Number.isFinite(i) || i < 0 || i >= phrases.length) {
      mended.push(`a shot for phrase ${a.phrase}, which does not exist`)
      continue
    }
    if (byPhrase.has(i)) {
      mended.push(`a second shot for phrase ${i}`)
      continue
    }
    byPhrase.set(i, { ...a, characters: a.characters.map((c) => rename.get(c) ?? c) })
  }

  let clips = 0
  const shots: Shot[] = phrases.map((phrase, i) => {
    const a = byPhrase.get(i)
    let visual = a ? visualOf(a, known) : null
    if (!a) mended.push(`no shot for phrase ${i}`)
    else if (!visual) mended.push(`an unusable ${a.kind} for phrase ${i}`)
    if (visual?.kind === 'map' && !opts.maps) {
      mended.push(`a map at phrase ${i}, when no maps were wanted`)
      visual = null
    }
    if (visual?.kind === 'clip') {
      if (clips >= opts.maxClips) {
        visual = { kind: 'still', prompt: visual.prompt, move: 'push-in', characters: visual.characters }
        mended.push(`a clip past the ${opts.maxClips} allowed, at phrase ${i}`)
      } else clips++
    }
    const big = a ? clampText(a.titleBig, 40) : ''
    const title = big && visual?.kind !== 'card' ? { big, small: a ? clampText(a.titleSmall, 80) : '' } : null
    const callouts = (a?.callouts ?? [])
      .filter((c) => clampText(c.label, 60))
      .slice(0, 3)
      .map((c) => ({ label: clampText(c.label, 60), value: clampText(c.value, 40), x: clamp01(c.x), y: clamp01(c.y) }))
    return ShotSchema.parse({ phrase: i, visual: visual ?? fallbackStill(phrase, i, opts.format), title, callouts })
  })
  return { bible, shots, mended }
}

/** A year or decade a phrase names, for a title over its shot: "1954", "The 1950s". */
function yearOf(phrase: string): string | null {
  const m = /\b(1[5-9]\d\d|20[0-4]\d)(s?)\b/.exec(phrase)
  if (!m) return null
  return m[2] ? `The ${m[1]}s` : m[1]
}

/** The style bible for a format and topic when Claude has not written one. */
export function defaultBible(brief: Brief): Bible {
  if (brief.format === 'documentary')
    return {
      style:
        'A photoreal archival photograph, as if found in a national archive: shot on period 35 mm black-and-white or early colour film stock with a standard 50 mm lens, natural light, deep shadows, real people in period clothes, nothing modern in frame.',
      palette: 'warm amber, sepia browns, soft creams and deep blacks',
      era: brief.topic,
      characters: []
    }
  return {
    style:
      'A bright, friendly 2D cartoon in a flat vector style with soft shading, clean rounded shapes, thick dark outlines and simple expressive faces, on an uncluttered background.',
    palette: 'cheerful primaries on warm off-white: coral red, sunny yellow, sky blue and leaf green',
    era: '',
    characters: []
  }
}

/** The shots planned on this Mac from the words alone, when Claude cannot be asked. */
export function localShotList(brief: Brief, phrases: string[]): CheckedShots {
  const shots: Shot[] = phrases.map((phrase, i) => {
    const year = brief.format === 'documentary' ? yearOf(phrase) : null
    return {
      phrase: i,
      visual: fallbackStill(phrase, i, brief.format),
      title: year && i > 0 ? { big: year, small: '' } : null,
      callouts: []
    }
  })
  // A documentary opens on its subject as a title card.
  if (brief.format === 'documentary' && shots.length > 2)
    shots[0] = { ...shots[0], visual: { kind: 'card', big: titleCase(brief.topic).slice(0, 40), small: '' }, title: null }
  return { bible: defaultBible(brief), shots, mended: [] }
}

function titleCase(s: string): string {
  return s.replace(/^the\s+/i, '').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * The prompt a still is made from: the shot's own picture, the characters it
 * shows as their sheets describe them, then the bible's style and palette,
 * then what must never be in it. Text in the picture is ruled out: titles
 * and labels are drawn by the edit, sharp and in the right font.
 */
export function promptFor(visual: Visual, bible: Bible, format: MakeFormat, aspect: 'wide' | 'vertical' = 'wide'): string {
  const subject = visual.kind === 'still' || visual.kind === 'clip' ? visual.prompt : ''
  const cast = (visual.kind === 'still' || visual.kind === 'clip' ? visual.characters : [])
    .map((id) => bible.characters.find((c) => c.id === id))
    .filter((c): c is Character => !!c)
    .map((c) => `${c.name}: ${c.look}`)
  const frame = aspect === 'vertical' ? 'Vertical 9:16 composition.' : 'Wide 16:9 composition.'
  const never =
    format === 'documentary'
      ? 'No text, captions, logos, watermarks, borders or modern objects.'
      : 'No text, letters, logos or watermarks.'
  return [
    subject.trim().replace(/\.?$/, '.'),
    cast.length ? `Characters, drawn exactly as described: ${cast.join(' ')}` : '',
    bible.era ? `Setting: ${bible.era}.` : '',
    `Style: ${bible.style}`,
    bible.palette ? `Palette: ${bible.palette}.` : '',
    frame,
    never
  ]
    .filter(Boolean)
    .join(' ')
}

/** The prompt a character sheet is made from: one figure, the front and side, plain ground. */
export function sheetPrompt(character: Character, bible: Bible): string {
  return [
    `A character reference sheet of ${character.name}: ${character.look}.`,
    'The same character shown twice side by side, from the front and from the side, full body, standing, neutral pose, evenly lit, on a plain light background.',
    `Style: ${bible.style}`,
    bible.palette ? `Palette: ${bible.palette}.` : '',
    'No text, labels or watermarks.'
  ]
    .filter(Boolean)
    .join(' ')
}

/** Dollars a shot costs to make at a service: its still, and its clip if it has one. */
export function shotCost(
  visual: Visual,
  images: ImageService | null,
  clips: ImageService | null,
  opts: { size?: string; clipSeconds?: number; references?: number } = {}
): number {
  const n = needs(visual)
  if (!images || n.stills === 0) return 0
  const size = opts.size ?? PRICES.images[images].size
  const still = stillCost(images, size, opts.references ?? 0)
  const clip = n.clips > 0 && clips ? clipCost(clips, opts.clipSeconds ?? 5) : 0
  return Math.round((still + clip) * 10000) / 10000
}

/**
 * Shots fitted to what was agreed: while they would cost more than `total`,
 * the most expensive clip becomes a still with a push-in. Stills are never
 * dropped; if stills alone cost more, the caller makes fewer of them.
 */
export function fitShots(
  shots: Shot[],
  total: number,
  cost: (s: Shot) => number
): { shots: Shot[]; total: number; downgraded: number } {
  const out = shots.map((s) => ({ ...s }))
  let sum = out.reduce((n, s) => n + cost(s), 0)
  let downgraded = 0
  while (sum > total + 1e-9) {
    let worst = -1
    let worstCost = 0
    out.forEach((s, i) => {
      if (s.visual.kind !== 'clip') return
      const c = cost(s)
      if (c > worstCost) {
        worst = i
        worstCost = c
      }
    })
    if (worst < 0) break
    const v = out[worst].visual as Extract<Visual, { kind: 'clip' }>
    out[worst] = { ...out[worst], visual: { kind: 'still', prompt: v.prompt, move: 'push-in', characters: v.characters } }
    downgraded++
    sum = out.reduce((n, s) => n + cost(s), 0)
  }
  return { shots: out, total: Math.round(sum * 10000) / 10000, downgraded }
}
