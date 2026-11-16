import { lengthIn } from './brief'
import { normalWord } from './script'
import type { Make, MakeFormat, MadeShot, VoiceChoice } from './schema'
import { voiceFromWords } from './voices'

/**
 * Asks of a made video that make something again: "make this shot a close-up
 * of his hands" (that shot), "use a different voice" (the narration), "make
 * it an explainer instead" (every picture, in a new style), "swap this shot
 * for B-roll", "make it 8 minutes" (a new script). Each becomes a new version
 * and costs only what it makes again, said before anything is spent.
 *
 * Everything else asked of a made video (cuts, music, the look, captions,
 * titles) is an ordinary edit and goes to the planner like any other.
 */

export type MakeAsk =
  | { kind: 'reshoot'; phrase: number; want: string }
  | { kind: 'voice'; voice: VoiceChoice | null; own: boolean }
  | { kind: 'restyle'; format: MakeFormat }
  | { kind: 'length'; seconds: number }
  | { kind: 'broll'; phrase: number; search: string }

/** The words of a description that say what is in it, not how to ask for it. */
const STOP = new Set(
  'a an the this that these those of in on at to for with and or but it its his her their my your our shot shots image picture frame scene one make made makes turn change instead into be is are was show showing please can could would like more less again new different same so just'.split(
    ' '
  )
)

function contentWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalWord)
    .filter((w) => w.length > 2 && !STOP.has(w))
}

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  last: -1
}

/**
 * The shot the words point at: by number ("shot 3", "the third shot"), by
 * what it shows ("the derrick shot"), or the one on screen ("this shot")
 * when the editor says which beat that is. Null when it cannot tell.
 */
export function shotMeant(make: Make, text: string, onScreen: string | null): MadeShot | null {
  const t = text.toLowerCase()
  const numbered = /\b(?:shot|scene|picture|image)\s*(?:#|number\s*)?(\d{1,3})\b/.exec(t)
  if (numbered) return make.shots[Number(numbered[1]) - 1] ?? null
  const ord = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+(?:shot|scene|picture|image)\b/.exec(t)
  if (ord) {
    const n = ORDINALS[ord[1]]
    return n === -1 ? (make.shots[make.shots.length - 1] ?? null) : (make.shots[n - 1] ?? null)
  }
  if (/\b(this|that|current|the one (?:on screen|here))\s+(?:shot|scene|picture|image|one)\b/.test(t) || /\bthis\b/.test(t)) {
    const here = onScreen ? make.shots.find((s) => s.beat === onScreen) : undefined
    if (here) return here
  }
  // "the derrick shot", "the picture of the crowd": the shot whose own words share the most with these.
  const said = new Set(contentWords(t.replace(/\b(?:make|turn|change|swap|replace)\b.*$/, '')))
  const of = /\b(?:the|that)\s+([\w\s-]{3,40}?)\s+(?:shot|scene|picture|image)\b|\b(?:shot|picture|image) of (?:the |a |an )?([\w\s-]{3,40})/.exec(t)
  const key = new Set(contentWords(of ? (of[1] ?? of[2] ?? '') : ''))
  const pool = key.size ? key : said
  if (pool.size === 0) return null
  let best: MadeShot | null = null
  let bestScore = 0
  for (const s of make.shots) {
    const v = s.visual
    const words = contentWords(
      v.kind === 'still' || v.kind === 'clip'
        ? v.prompt
        : v.kind === 'map'
          ? v.place
          : v.kind === 'card'
            ? `${v.big} ${v.small}`
            : v.kind === 'broll'
              ? v.search
              : v.text.join(' ')
    )
    const score = words.filter((w) => pool.has(w)).length
    if (score > bestScore) {
      best = s
      bestScore = score
    }
  }
  return key.size ? best : null
}

/** What the person wants a shot to show instead, from the words after "make … a", "show", "into". */
export function wantedPicture(text: string): string | null {
  const t = text.trim().replace(/[.!?]+$/, '')
  const m =
    /\b(?:make|turn|change|redo|regenerate)\s+(?:(?:this|that|the|it|one)\s+)?(?:(?:[\w-]+\s+){0,3}?(?:shot|scene|picture|image)(?:\s+\d+)?\s+)?(?:into\s+|to\s+|show\s+|be\s+)?(?:a\s+|an\s+)?(.{4,})$/i.exec(t) ??
    /\b(?:show|instead show|replace it with|swap it for)\s+(?:a\s+|an\s+)?(.{4,})$/i.exec(t)
  if (!m) return null
  const want = m[1].replace(/^(?:a|an|the)\s+/i, '').trim()
  // "for B-roll" or "for real footage" is a swap, not a picture to make.
  if (/^(?:for\s+)?(?:b-?roll|stock footage|real footage)$/i.test(want)) return null
  return want.length >= 4 ? want : null
}

/** Reads an ask of a made video. Null when it asks nothing that makes something again. */
export function readMakeAsk(make: Make, text: string, onScreen: string | null = null): MakeAsk | null {
  const t = text.trim()
  if (!t) return null
  const lower = t.toLowerCase()

  // A new style: every picture made again.
  const restyle = /\b(?:make it|turn it into|as|redo it as|instead,?)\s+(?:an?\s+)?(?:(?:animated\s+)?explainer|(?:cinematic\s+)?documentary|cartoon|animation)\b|\b(?:explainer|documentary|cartoon) instead\b/i.exec(t)
  if (restyle) {
    const format: MakeFormat = /explainer|cartoon|animation/i.test(restyle[0]) ? 'explainer' : 'documentary'
    if (format !== make.brief.format) return { kind: 'restyle', format }
  }

  // A new length: a new script, its narration and its shots.
  if (/\b(?:make it|cut it to|turn it into|i want it|longer|shorter)\b/i.test(t)) {
    const seconds = lengthIn(t)
    if (seconds && Math.abs(seconds - make.brief.seconds) >= 10 && make.brief.from === 'topic')
      return { kind: 'length', seconds }
  }

  // A new voice.
  if (/\bvoice\b|\bnarrat(?:or|ion)\b|\bread (?:it|by)\b|\bmy own recording\b/i.test(t)) {
    const own = /\b(?:my (?:own )?voice|my recording|i(?:'ll| will) (?:record|narrate))\b/i.test(t)
    const voice = own ? null : voiceFromWords(t, make.brief.format, make.narration.voice)
    if (own || voice || /\b(?:different|another|other|new)\b/.test(lower)) return { kind: 'voice', voice, own }
  }

  // A shot swapped for real footage.
  if (/\b(?:b-?roll|stock footage|real footage)\b/i.test(t) && /\b(?:swap|replace|use|change|instead|make)\b/i.test(t)) {
    const shot = shotMeant(make, t, onScreen)
    if (shot) {
      const v = shot.visual
      const search = v.kind === 'still' || v.kind === 'clip' ? v.prompt.split(/[.,;]/)[0] : v.kind === 'broll' ? v.search : make.phrases[shot.phrase]
      return { kind: 'broll', phrase: shot.phrase, search: search.slice(0, 120) }
    }
  }

  // One shot made again, showing something else.
  if (/\b(?:shot|scene|picture|image|this|that)\b/i.test(t) && /\b(?:make|turn|change|redo|regenerate|replace|show|again)\b/i.test(t)) {
    const shot = shotMeant(make, t, onScreen)
    const want = wantedPicture(t)
    if (shot && (want || /\b(?:again|redo|regenerate)\b/i.test(t)))
      return { kind: 'reshoot', phrase: shot.phrase, want: want ?? '' }
  }
  return null
}

/** A shot's number as the person counts them, from 1. */
export function shotNumber(make: Make, phrase: number): number {
  return make.shots.findIndex((s) => s.phrase === phrase) + 1
}
