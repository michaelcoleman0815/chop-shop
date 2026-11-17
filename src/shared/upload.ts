import { z } from 'zod'
import { DEFAULT_DESCRIPTION } from './brand'
import { clock } from './presets/preset'
import { thisComputer } from './platform'

/**
 * What an upload needs, written beside every export: the captions as .srt and
 * .vtt with the burned-in captions' own words and times, a description (a
 * sentence or two on the video, its chapters when YouTube shows them, the
 * credits for outside material and the brand's own lines, from the brand's
 * template), three title ideas and 10 to 15 tags.
 *
 * Claude writes the titles, the description's opening and the tags when the
 * person has a key and lets it (main/upload-kit); otherwise they are made here
 * from the words, and the chat says so.
 */

/** One caption page as it is on screen, in seconds of the export. */
export interface Cue {
  start: number
  end: number
  text: string
}

/** The titles, the description's opening and the tags. */
export interface UploadWriting {
  titles: string[]
  opening: string
  tags: string[]
}

export interface UploadKit {
  titles: string[]
  description: string
  tags: string[]
  /** Who wrote the titles, the opening and the tags. */
  by: 'claude' | 'local'
  /** Why Claude did not, when it did not: no key, turned off in Settings, or it could not this time. */
  why: 'no-key' | 'off' | 'failed' | null
  /** Caption pages written, and whether they are in the picture too or only beside it. */
  captions: { pages: number; burned: boolean }
  /** Chapters in the description. */
  chapters: number
  /** A Short: vertical and three minutes or less, which YouTube shows no chapters on. */
  short: boolean
  /** Lines of credits in the description. */
  credits: number
  /** The files beside the export. */
  files: { srt: string | null; vtt: string | null; description: string; titles: string }
}

/** The files beside an export, after its name: "Talk v3.srt", "Talk v3 description.txt". */
export const UPLOAD_SUFFIXES = {
  srt: '.srt',
  vtt: '.vtt',
  description: ' description.txt',
  titles: ' titles and tags.txt'
} as const

/** YouTube's own limits. */
export const TITLE_MAX = 100
export const DESCRIPTION_MAX = 5000
const TAGS_TOTAL_MAX = 480
const TAG_MAX = 40
export const TAGS_MIN = 10
export const TAGS_MAX = 15
/** How far words said once fill the tags made here: enough, without padding. */
const FILL_TO = TAGS_MIN
const OPENING_MAX = 400

/** A Short: a portrait or square frame, three minutes or less. */
export function isShort(width: number, height: number, durationSec: number): boolean {
  return width > 0 && height >= width && durationSec <= 180
}

// ---------- Caption files ----------

function stamp(sec: number, comma: boolean): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor(ms / 60_000) % 60
  const s = Math.floor(ms / 1000) % 60
  return `${pad(h)}:${pad(m)}:${pad(s)}${comma ? ',' : '.'}${pad(ms % 1000, 3)}`
}

export function srtText(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start, true)} --> ${stamp(c.end, true)}\n${c.text}\n`)
    .join('\n')
}

export function vttText(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, false)} --> ${stamp(c.end, false)}\n${c.text}\n`).join('\n')}`
}

/** Cues read back from an .srt or .vtt, for checking one against what is on screen. */
export function readCues(text: string): Cue[] {
  const time = (t: string): number => {
    const m = /(\d+):(\d\d):(\d\d)[,.](\d{3})/.exec(t)
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : NaN
  }
  const cues: Cue[] = []
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0) continue
    const [a, b] = lines[at].split('-->')
    cues.push({ start: time(a), end: time(b), text: lines.slice(at + 1).join('\n') })
  }
  return cues
}

// ---------- The description ----------

/** An empty line or two at most, and no spaces left at the ends of lines. */
const tidyLines = (text: string): string =>
  text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** Words up to a length, cut where a word ends. */
function wordsUpTo(text: string, length: number): string {
  if (text.length <= length) return text
  const cut = text.slice(0, Math.max(0, length))
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, '')
}

/**
 * The brand's template with the parts made for this video: {opening},
 * {chapters} and {credits}. A part the template leaves out still goes in, so
 * no description lacks what YouTube or the credits need: the opening first,
 * chapters after it, credits at the end. An empty part takes its line with it.
 * Each part goes in as written: a dollar sign is a dollar sign.
 *
 * Past YouTube's 5,000 characters, the brand's own lines give way first,
 * whole and from the last, then the opening, at a word; the chapters and the
 * credits never do.
 */
export function fillDescription(
  template: string,
  parts: { opening: string; chapters: string[]; credits: string[] }
): string {
  let text = template.trim() ? template : DEFAULT_DESCRIPTION
  const made: Record<string, string> = {
    '{chapters}': parts.chapters.join('\n'),
    '{credits}': parts.credits.length ? `Credits\n${parts.credits.join('\n')}` : ''
  }
  if (!text.includes('{opening}')) text = `{opening}\n\n${text}`
  if (!text.includes('{chapters}')) text = text.replace('{opening}', () => '{opening}\n\n{chapters}')
  if (!text.includes('{credits}')) text = `${text}\n\n{credits}`
  // The template's own text between the parts, line by line; the parts at the odd places.
  const pieces = text.split(/(\{(?:opening|chapters|credits)\})/)
  const own = pieces.map((piece, i) => (i % 2 === 0 ? piece.split('\n') : null))
  const fill = (opening: string): string =>
    tidyLines(
      pieces.map((piece, i) => (i % 2 === 1 ? (piece === '{opening}' ? opening : made[piece]) : own[i]!.join('\n'))).join('')
    )
  let opening = parts.opening.trim()
  let out = fill(opening)
  for (let i = own.length - 1; i >= 0 && out.length > DESCRIPTION_MAX; i--) {
    const lines = own[i]
    if (!lines) continue
    for (let j = lines.length - 1; j >= 0 && out.length > DESCRIPTION_MAX; j--) {
      if (!lines[j].trim()) continue
      lines[j] = ''
      out = fill(opening)
    }
  }
  if (out.length > DESCRIPTION_MAX) {
    opening = wordsUpTo(opening, opening.length - (out.length - DESCRIPTION_MAX))
    out = fill(opening)
  }
  return out
}

// ---------- Writing them from the words ----------

const STOP = new Set(
  (
    'a an and are as at be been being but by can could did do does doing for from had has have having he her hers him ' +
    'his how i if in into is it its itself just me my myself no nor not of off on once only or other our ours out over ' +
    'own same she should so some such than that the their theirs them then there these they this those through to too ' +
    'under until up very was we were what when where which while who whom why will with would you your yours yourself ' +
    "i'm it's that's don't can't won't you're we're they're i've you've we've here's there's what's let's isn't aren't " +
    "doesn't didn't wasn't i'll you'll we'll i'd you'd okay ok yeah yes right um uh uhm umm er hmm like really " +
    'actually basically literally gonna wanna gotta kind sort thing things stuff lot lots way get got go going goes ' +
    'make makes made know think see say said look looks also even still much many more most all any every each ' +
    'after before again about above below across along around because while though ever always often maybe ' +
    'something anything everything nothing someone anyone everyone better best worse worst bit little ' +
    'honestly seriously totally definitely probably pretty super quite thing here never let lets ' +
    "one two three first last now today video guys hey hi hello welcome thanks thank channel subscribe let's"
  ).split(' ')
)

/** Words before a thing's name: what follows them is most likely what the video is about. */
const DETERMINERS = new Set('a an the this that these those my your our his her their its one each every another'.split(' '))

/** Words between those and the name, passed over: "the real upgrade" is about the upgrade. */
const DESCRIBING = new Set(
  'real whole new old big small good great little other same only last next first full main own favourite favorite'.split(' ')
)

/** Words that open a sentence without saying anything: left off a title. */
const LEADS = new Set(
  'so okay ok now right well and but alright um uh yeah also honestly basically'.split(' ')
)

const clean = (w: string): string =>
  w
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, '')

/** A word with its first capital dropped, unless it is all capitals ("AI"). */
const lower = (s: string): string => (/^\p{Lu}\p{Ll}/u.test(s) && !/^\p{Lu}{2}/u.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s)

/**
 * The words without a stretch said twice in a row, as a retake or a stumble
 * leaves it: "the camera is the real the camera is the real upgrade" reads
 * "the camera is the real upgrade". The later saying is the one kept.
 */
export function withoutRepeats(words: string[]): string[] {
  const out: string[] = []
  const keys: string[] = []
  for (const w of words) {
    out.push(w)
    keys.push(clean(w))
    for (let k = Math.min(8, Math.floor(keys.length / 2)); k >= 1; k--) {
      const n = keys.length
      let same = true
      for (let j = 0; j < k && same; j++) same = !!keys[n - k + j] && keys[n - k + j] === keys[n - 2 * k + j]
      if (same) {
        out.splice(n - 2 * k, k)
        keys.splice(n - 2 * k, k)
        break
      }
    }
  }
  return out
}

/** Sentences as said, each a list of words. */
function sentencesOf(words: string[]): string[][] {
  const out: string[][] = []
  let cur: string[] = []
  for (const w of words) {
    cur.push(w)
    if (/[.!?]["')\]’”]*$/.test(w)) {
      out.push(cur)
      cur = []
    }
  }
  if (cur.length) out.push(cur)
  return out
}

/**
 * A sentence as a title: no opening "so", no full stop, no longer than about
 * 70 characters. A long one ends at its last comma or colon that fits, or
 * else at a word that carries meaning, never on "the" or "if".
 */
function asLine(sentence: string[], max = 70): string {
  const words = [...sentence]
  while (words.length > 3 && LEADS.has(clean(words[0]))) words.shift()
  let text = words.join(' ').replace(/[.,;:!?]+$/, '')
  if (text.length > max) {
    const clause = Math.max(text.lastIndexOf(',', max), text.lastIndexOf(':', max), text.lastIndexOf(';', max))
    if (clause > 24) text = text.slice(0, clause)
    else {
      const kept = text.slice(0, max + 1).split(' ').slice(0, -1)
      while (kept.length > 3 && (STOP.has(clean(kept[kept.length - 1])) || !clean(kept[kept.length - 1]))) kept.pop()
      text = kept.join(' ').replace(/[,;:]+$/, '')
    }
  }
  return text.charAt(0).toUpperCase() + text.slice(1)
}

interface Term {
  text: string
  key: string
  n: number
  score: number
}

/** The meaningful words and pairs said most, with the casing they were said in. */
export function topTerms(words: string[], boost: string[] = []): Term[] {
  const counts = new Map<string, { n: number; forms: Map<string, number> }>()
  const add = (key: string, form: string): void => {
    const c = counts.get(key) ?? { n: 0, forms: new Map<string, number>() }
    c.n++
    c.forms.set(form, (c.forms.get(form) ?? 0) + 1)
    counts.set(key, c)
  }
  for (const sentence of sentencesOf(words)) {
    // A capital that only opens the sentence is not a name's.
    const tokens = sentence.map((w, i) => {
      const form = w.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, '')
      return { key: clean(w), form: i === 0 ? lower(form) : form }
    })
    tokens.forEach((t, i) => {
      const meaningful = (x: { key: string }): boolean =>
        !!x.key && !STOP.has(x.key) && (x.key.length >= 3 || /\d/.test(x.key))
      if (!meaningful(t)) return
      add(t.key, t.form)
      const next = tokens[i + 1]
      if (next && meaningful(next)) add(`${t.key} ${next.key}`, `${t.form} ${next.form}`)
    })
  }
  const boosted = new Set(boost.map((b) => b.toLowerCase()))
  const terms: Term[] = []
  for (const [key, c] of counts) {
    const pair = key.includes(' ')
    if (pair && c.n < 2) continue
    const form = [...c.forms.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const score = c.n * (pair ? 2.2 : 1) + (boosted.has(key) ? 4 : 0) + (/^\p{Lu}/u.test(form) ? 0.3 : 0)
    terms.push({ text: form, key, n: c.n, score })
  }
  // A word inside a pair said as often as the pair adds nothing of its own.
  const pairs = terms.filter((t) => t.key.includes(' '))
  return terms
    .filter((t) => t.key.includes(' ') || !pairs.some((p) => p.key.split(' ').includes(t.key) && p.n >= t.n))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
}

/** Tags for a kind of video, from raw/profiles. */
const KIND_TAGS: Record<string, string[]> = {
  tech: ['tech', 'review'],
  gaming: ['gaming'],
  podcast: ['podcast'],
  livestream: ['stream highlights'],
  church: ['sermon'],
  vlog: ['vlog'],
  asmr: ['asmr']
}

export interface WritingInput {
  /** The words as the video says them, in order. */
  words: string[]
  /** Chapter titles, when the video shows chapters. */
  chapters: string[]
  brand: { name: string; products: string[] }
  /** The kind of video, as a cutting profile id. */
  kind: string | null
  short: boolean
  durationSec: number
}


/**
 * Titles, an opening and tags from the words alone: the hook line, the chapter
 * titles and the meaningful words said most. Nothing is sent anywhere.
 */
export function writeLocally(input: WritingInput): UploadWriting {
  // A line said twice in a row counts once, and reads once in a title.
  const words = withoutRepeats(input.words)
  const sentences = sentencesOf(words).filter((s) => s.length >= 3)
  const terms = topTerms(words, input.brand.products)
  const spoken = new Set(words.map(clean))
  // What it is about: one of the creator's own names when it is said, else what is said most.
  const product = input.brand.products.find((p) => p.split(/\s+/).every((w) => spoken.has(clean(w))))
  const topic = product ?? terms[0]?.text ?? input.brand.name.trim()
  const hook = sentences[0] ? asLine(sentences[0]) : topic
  // A title says the most in the fewest words: words that mean something, the ones said again and again most of all.
  const said2 = new Set(terms.filter((t) => t.n >= 2).flatMap((t) => t.key.split(' ')))
  const weight = (w: string): number => {
    const k = clean(w)
    if (!k || STOP.has(k) || (k.length < 3 && !/\d/.test(k))) return 0
    return said2.has(k) ? 3 : 1
  }
  const dense = sentences
    .slice(1)
    .map((s, i) => ({ s, i, d: s.reduce((sum, w) => sum + weight(w), 0) / Math.sqrt(s.length) }))
    .sort((a, b) => b.d - a.d || a.i - b.i)
    .map((x) => asLine(x.s))
  const chapters = input.short ? [] : input.chapters.filter((c) => c.trim())
  // What the chapters are about, without one that only opens the video.
  const topics = chapters.filter((c) => !/^(intro|introduction|opening|the hook|hook|welcome|start)$/i.test(c.trim()))
  const titles: string[] = []
  const offer = (t: string): void => {
    const text = t.trim()
    if (text.length < 8 || text.length > TITLE_MAX) return
    if (!titles.some((x) => x.toLowerCase() === text.toLowerCase())) titles.push(text)
  }
  offer(hook)
  if (topics.length >= 2 && topic) {
    offer(`${topic.charAt(0).toUpperCase()}${topic.slice(1)}: ${listOf(topics.slice(0, 3).map(lower))}`)
  }
  for (const line of dense) {
    if (titles.length >= 3) break
    offer(line)
  }
  if (titles.length < 3 && topic) offer(`${topic.charAt(0).toUpperCase()}${topic.slice(1)} in ${clock(input.durationSec)}`)
  if (titles.length < 3 && terms.length >= 2) offer(`${terms[0].text} and ${terms[1].text}`)

  // The second sentence only when there is something to say it covers: chapters, or words said again and again.
  const repeated = terms.filter((t) => t.n >= 2 && !/^[\d.,%$€£]+$/.test(t.key)).slice(0, 3)
  const about = topics.length >= 2 ? topics.slice(0, 3).map(lower) : repeated.map((t) => lower(t.text))
  const first = sentences[0] ? `${asLine(sentences[0], 160)}.` : ''
  const opening = [first, about.length >= 2 ? `It covers ${listOf(about)}.` : ''].filter(Boolean).join(' ')

  const tags: string[] = []
  const tag = (t: string): void => {
    const text = t.trim().replace(/^#/, '')
    if (!text || text.length > TAG_MAX) return
    if (!tags.some((x) => x.toLowerCase() === text.toLowerCase())) tags.push(text)
  }
  const said = spoken
  // The creator's own names first, when they are said; then what is said most.
  const named = new Set<string>()
  for (const p of input.brand.products) {
    if (!p.split(/\s+/).every((w) => said.has(clean(w)))) continue
    tag(p)
    for (const w of p.split(/\s+/)) named.add(clean(w))
  }
  // A number alone, or a piece of a name already tagged, says nothing a tag can.
  const useful = (t: Term): boolean =>
    !/^[\d.,%$€£]+$/.test(t.key) && !t.key.split(' ').every((k) => named.has(k)) && !/ly$/.test(t.key)
  for (const t of terms) if (t.n >= 2 && useful(t)) tag(t.text)
  for (const c of topics) tag(c)
  for (const k of KIND_TAGS[input.kind ?? ''] ?? []) tag(k)
  if (input.brand.name.trim()) tag(input.brand.name.trim())
  // Words said once fill a short list: names first, then things named ("the camera"), then the longest;
  // never a word that only says how something was done.
  const things = namedThings(words)
  const rank = (t: Term): number => (/^\p{Lu}/u.test(t.text) ? 2 : things.has(t.key) ? 1 : 0)
  const once = terms
    .filter((t) => t.n < 2 && useful(t) && !t.key.includes(' ') && !/(ed|ing)$/.test(t.key))
    .sort((a, b) => rank(b) - rank(a) || b.text.length - a.text.length || a.key.localeCompare(b.key))
  for (const t of once) {
    if (tags.length >= FILL_TO) break
    tag(t.text)
  }
  return { titles: titles.slice(0, 3), opening, tags: fitTags(tags) }
}

/** Words that follow "the", "this", "my" and the like: most likely the things a video is about. */
function namedThings(words: string[]): Set<string> {
  const keys = words.map(clean)
  const out = new Set<string>()
  keys.forEach((k, i) => {
    if (!DETERMINERS.has(k)) return
    let j = i + 1
    while (j < keys.length && DESCRIBING.has(keys[j])) j++
    const w = keys[j]
    if (w && !STOP.has(w) && (w.length >= 3 || /\d/.test(w))) out.add(w)
  })
  return out
}

/** Tags within YouTube's limits: at most 15, together under 500 characters. */
function fitTags(tags: string[]): string[] {
  const out: string[] = []
  let total = 0
  for (const t of tags) {
    if (out.length >= TAGS_MAX || total + t.length + 1 > TAGS_TOTAL_MAX) break
    out.push(t)
    total += t.length + 1
  }
  return out
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// ---------- Claude's answer ----------

/** What Claude is asked for. Checked again by checkWriting, whatever came back. */
export const UploadAnswerSchema = z.object({
  titles: z.array(z.string()).describe('Exactly three title ideas, each under 70 characters.'),
  opening: z.string().describe("One or two sentences for the top of the description, in the creator's voice."),
  tags: z.array(z.string()).describe('Between 10 and 15 tags, most useful first.')
})
export type UploadAnswer = z.infer<typeof UploadAnswerSchema>

const tidy = (s: string): string =>
  s
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .trim()

/**
 * Claude's answer as it is used: titles trimmed, distinct and within
 * YouTube's length; an opening of one or two sentences; 10 to 15 distinct
 * tags without hashes. Whatever falls short is filled from what was written
 * locally, so a thin answer still gives a full kit; `used` says whether
 * enough of Claude's own came through to call it Claude's.
 */
export function checkWriting(answer: unknown, local: UploadWriting): { writing: UploadWriting; used: boolean } {
  const parsed = UploadAnswerSchema.safeParse(answer)
  if (!parsed.success) return { writing: local, used: false }
  const a = parsed.data
  const titles: string[] = []
  for (const t of a.titles.map(tidy)) {
    if (t.length < 4 || t.length > TITLE_MAX) continue
    if (!titles.some((x) => x.toLowerCase() === t.toLowerCase())) titles.push(t)
  }
  const fromClaude = titles.length
  for (const t of local.titles) if (titles.length < 3 && !titles.some((x) => x.toLowerCase() === t.toLowerCase())) titles.push(t)

  let opening = tidy(a.opening)
  const sentences = opening.match(/[^.!?]+[.!?]+["')\]’”]*/g) ?? (opening ? [opening] : [])
  opening = sentences
    .slice(0, 2)
    .map((x) => x.trim())
    .join(' ')
  const goodOpening = opening.length >= 12 && opening.length <= OPENING_MAX && !/https?:\/\//.test(opening)

  const tags: string[] = []
  for (const t of a.tags.map((x) => tidy(x).replace(/^#+/, ''))) {
    if (!t || t.length > TAG_MAX || /[<>]/.test(t)) continue
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t)
  }
  const ownTags = tags.length
  for (const t of local.tags) if (tags.length < TAGS_MIN && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t)

  return {
    writing: { titles: titles.slice(0, 3), opening: goodOpening ? opening : local.opening, tags: fitTags(tags) },
    used: fromClaude >= 2 && goodOpening && ownTags >= 5
  }
}

// ---------- In the chat ----------

const NUMBER = ['no', 'one', 'two', 'three']

/** The reply under an export: a sentence, three facts, the rest behind Details. */
export function uploadMessage(kit: UploadKit): {
  text: string
  chips: string[]
  details: { label: string; value: string }[]
  aside: string | null
} {
  const n = NUMBER[kit.titles.length] ?? String(kit.titles.length)
  const wrote = `${n} title${kit.titles.length === 1 ? '' : 's'}, the description's opening and ${kit.tags.length} tags`
  const who = kit.by === 'claude' ? `Claude wrote ${wrote} from what you say` : `I wrote ${wrote} from your words`
  const captions =
    kit.captions.pages === 0
      ? 'nothing is said, so there are no captions'
      : kit.captions.burned
        ? 'the captions match the ones in the picture'
        : 'the captions are beside it for viewers to turn on'
  const text = `Ready to upload. ${who}, and ${captions}.`
  const chips = [
    `${kit.titles.length} titles`,
    `${kit.tags.length} tags`,
    kit.chapters > 0 ? `${kit.chapters} chapters` : kit.captions.pages > 0 ? '.srt and .vtt' : null
  ].filter((c): c is string => !!c)
  const files = [kit.files.srt, kit.files.vtt, kit.files.description, kit.files.titles]
    .filter((f): f is string => !!f)
    .map((f) => f.split(/[\\/]/).pop() ?? f)
  const details = [
    ...kit.titles.map((t, i) => ({ label: `Title ${i + 1}`, value: t })),
    { label: 'Description', value: kit.description },
    { label: 'Tags', value: kit.tags.join(', ') },
    { label: 'Files', value: files.join('\n') }
  ]
  const asides: string[] = []
  if (kit.by === 'local') {
    asides.push(
      kit.why === 'off'
        ? `I made these on ${thisComputer} without Claude, as Settings asks.`
        : kit.why === 'failed'
          ? `Claude couldn't write them this time, so I made them from your words on ${thisComputer}.`
          : `I made these on ${thisComputer} without Claude. With your Anthropic key in Settings, Claude writes them.`
    )
  }
  if (kit.short) asides.push("It's a Short, so the description has no chapters.")
  return { text, chips, details, aside: asides.join(' ') || null }
}

/**
 * One reply for many exports at once, as /clipping's Export all makes them:
 * a sentence, each one's titles behind Details, and who wrote them. "The 6
 * clips are ready to upload: captions, a description, titles and tags beside
 * each."
 */
export function uploadSetMessage(kits: { name: string; kit: UploadKit }[]): {
  text: string
  details: { label: string; value: string }[]
  aside: string | null
} {
  const n = kits.length
  const captioned = kits.filter((k) => k.kit.files.srt).length
  const what =
    captioned === n
      ? 'captions, a description, titles and tags beside each'
      : captioned === 0
        ? 'a description, titles and tags beside each'
        : `a description, titles and tags beside each, and captions beside the ${captioned} with words`
  const text = `The ${n} clips are ready to upload: ${what}.`
  const details = kits.map(({ name, kit }) => ({ label: name, value: kit.titles.join('\n') }))
  const local = kits.filter((k) => k.kit.by === 'local')
  const why = local[0]?.kit.why
  const aside =
    local.length === 0
      ? 'Claude wrote the titles, the openings and the tags from what you say.'
      : local.length < n
        ? local.length === 1
          ? `Claude couldn't write one of them, so I made that one from your words on ${thisComputer}.`
          : `Claude couldn't write ${local.length} of them, so I made those from your words on ${thisComputer}.`
        : why === 'off'
          ? `I made these on ${thisComputer} without Claude, as Settings asks.`
          : why === 'failed'
            ? `Claude couldn't write them this time, so I made them from your words on ${thisComputer}.`
            : `I made these on ${thisComputer} without Claude. With your Anthropic key in Settings, Claude writes them.`
  return { text, details, aside }
}

/** The titles, for copying: one a line. */
export function titlesText(kit: Pick<UploadKit, 'titles'>): string {
  return kit.titles.join('\n')
}

/** The titles and tags file beside the export. */
export function titlesFile(kit: Pick<UploadKit, 'titles' | 'tags'>): string {
  return `Titles\n${kit.titles.map((t) => `- ${t}`).join('\n')}\n\nTags\n${kit.tags.join(', ')}\n`
}
