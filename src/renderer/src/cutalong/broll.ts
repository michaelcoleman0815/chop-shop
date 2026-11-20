import type { MomentResult, Plan } from '../../../shared/broll/route'
import type { WebQuote } from '../../../shared/broll/settings'
import { listOf } from '../../../shared/broll/text'
import { SOURCE_NAMES, type Candidate, type Moment, type SourceId } from '../../../shared/broll/types'
import type { Asset } from '../../../shared/edit'
import type { Action } from './components/Message'
import { clock } from './format'

/**
 * How the chat and the editor offer B-roll found by the router
 * (main/broll, through api.brollFind): a plain sentence, the best few as
 * buttons named for what each is and where it is from, the reasons behind
 * Details, and what was left out in one or two sentences. A paid search is
 * a button of its own with its price on it, and runs only when tapped.
 */

/** Where a choice is offered, and where picking it reports: the chat, or the editor's notes panel. */
export type BrollWhere = 'thread' | 'panel'

/** What a B-roll button carries, so picking it can fetch it and cut to it. */
export interface BrollPick {
  candidate: Candidate
  /** The beat it goes on, or the beats of a stretch picked on the strip; null to find one by its words. */
  beat: string | string[] | null
  /** The words it was looked for with, to find a beat when the moment named none. */
  hint: string
  seconds?: number
  output?: { width: number; height: number }
  where: BrollWhere
  /** The edit it was found for: it goes into that one only. */
  docId?: string
}

/** What the paid button carries: the moment to look for again, on the web this time. */
export interface BrollWebAsk {
  moment: Moment
  where: BrollWhere
  /** The edit it was asked for: the web is looked in for that one only. */
  docId?: string
}

/** What a source is called on a button or a switch (SOURCE_NAMES is how a sentence says it). */
export const SOURCE_LABEL: Record<SourceId, string> = {
  library: 'Your folders',
  'own-uploads': 'Your earlier videos',
  youtube: 'YouTube',
  openverse: 'Openverse',
  wikimedia: 'Wikimedia Commons',
  nasa: 'NASA',
  archive: 'Internet Archive',
  steam: 'Steam',
  bluesky: 'Bluesky',
  logos: 'Simple Icons',
  pexels: 'Pexels',
  pixabay: 'Pixabay',
  unsplash: 'Unsplash',
  giphy: 'GIPHY',
  freesound: 'Freesound',
  web: 'The web',
  generated: 'Generated'
}

const KIND: Record<Candidate['kind'], string> = {
  video: 'clip',
  image: 'photo',
  gif: 'GIF',
  logo: 'logo',
  page: 'page',
  post: 'post',
  audio: 'sound'
}

function short(text: string, max = 44): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/**
 * A choice's button in two parts: what it is, which a narrow column may
 * shorten further, and where it is from, which stays whole after it.
 * "Rocket launch" + " · NASA"; "Your clip: city at night" alone.
 */
export function choiceParts(c: Candidate, compact = false): { label: string; tail?: string } {
  // The editor's panel is narrow: shorter names, and a source by its first word.
  const max = compact ? 22 : 44
  if (c.source === 'library') return { label: `Your ${KIND[c.kind]}: ${short(c.title, max - 4)}` }
  if (c.source === 'own-uploads') return { label: `Your earlier video: ${short(c.title, max - 10)}` }
  if (c.source === 'logos') return { label: `The ${short(c.title, max - 14)} logo` }
  const from = compact ? SOURCE_LABEL[c.source].replace(/^Internet /, '').split(' ')[0] : SOURCE_LABEL[c.source]
  return { label: short(c.title, max), tail: ` · ${from}` }
}

/** A choice's button as one line: what it is and where it is from, short. "Rocket launch · NASA", "Your clip: city at night". */
export function choiceLabel(c: Candidate, compact = false): string {
  const { label, tail } = choiceParts(c, compact)
  return label + (tail ?? '')
}

/** "3 to 12 cents", "$1.20 to $2.40": a paid search's price, for its button. */
export function priceRange(q: WebQuote): string {
  const cents = (d: number): number => Math.max(1, Math.round(d * 100))
  if (q.high < 1) return `${cents(q.low)} to ${cents(q.high)} cents`
  return `$${q.low.toFixed(2)} to $${q.high.toFixed(2)}`
}

/** Whether the web was left out only for want of a yes to its price: it is on, set up and would have been asked. */
export function webWaits(plan: Plan): boolean {
  return plan.skipped.some((s) => s.id === 'web' && s.why === 'it costs money and waits for your yes')
}

/** The sources that would look too with a free key, by name. */
function wantKeys(plan: Plan): string[] {
  return plan.skipped.filter((s) => s.why === 'it needs a free key, added in Settings').map((s) => SOURCE_NAMES[s.id])
}

const NOTHING = 'Nothing I found fits this moment closely enough.'

/**
 * The reply for one moment: its sentence, the choices as buttons (the
 * first primary), their reasons as Details, and an aside that says what
 * is someone else's, what was left out, what a key would add, and what
 * looking on the web costs when that is on offer.
 */
export function offerReply(
  r: MomentResult,
  ctx: {
    moment: string | null
    where: BrollWhere
    webQuote?: WebQuote | null
    primary?: boolean
    /** Where a pick goes when it is not the moment's own beat: a stretch picked on the strip. */
    beats?: string[] | null
    /** The edit these were found for, carried by every choice. */
    docId?: string
  }
): {
  text: string
  aside: string | null
  details: { label: string; value: string }[]
  actions: Action[]
  /** The reply in a sentence or two, for the editor's panel. */
  brief: string
} {
  // A line quoted mid-sentence keeps its words, not its full stop: “… feels great”, here is …
  const said = ctx.moment?.replace(/[.!?]+$/, '') ?? null
  const named = said ?? r.moment.search
  const found = r.results.length > 0
  const text = found
    ? said
      ? `For “${said}”, here is B-roll to pick from.`
      : `Here is B-roll for “${r.moment.search}” to pick from.`
    : `I found no B-roll for “${named}”.`
  const actions: Action[] = r.results.map((x, i) => {
    const pick: BrollPick = {
      candidate: x.candidate,
      beat: ctx.beats?.length ? ctx.beats : (r.moment.beat ?? null),
      hint: r.moment.search,
      ...(r.moment.seconds ? { seconds: r.moment.seconds } : {}),
      output: r.moment.output,
      where: ctx.where,
      ...(ctx.docId ? { docId: ctx.docId } : {})
    }
    const { label, tail } = choiceParts(x.candidate, ctx.where === 'panel')
    return {
      kind: 'add-broll',
      label,
      ...(tail ? { tail } : {}),
      primary: i === 0 && ctx.primary !== false,
      payload: JSON.stringify(pick)
    }
  })
  const web = ctx.webQuote && webWaits(r.plan) ? ctx.webQuote : null
  if (web) {
    const ask: BrollWebAsk = { moment: r.moment, where: ctx.where, ...(ctx.docId ? { docId: ctx.docId } : {}) }
    actions.push({
      kind: 'broll-web',
      label: `Look on the web too, ${priceRange(web)}`,
      primary: !found && ctx.primary !== false,
      payload: JSON.stringify(ask)
    })
  }
  const theirs = r.results.filter((x) => x.candidate.license.monetized === 'your-call').length
  const outside = r.results.some((x) => x.candidate.source !== 'library' && x.candidate.source !== 'own-uploads')
  const keys = wantKeys(r.plan)
  // Beside the reply: what is someone else's, the credit, and the price of the web when it is on offer.
  // What was left out and what a key would add are behind Details, with each choice's reason.
  const notes = r.notes.filter((n) => !(n === NOTHING && !found))
  const aside = [
    theirs
      ? `${theirs === r.results.length ? (theirs === 1 ? 'It is' : 'They are') : theirs === 1 ? 'One is' : `${theirs} are`} someone else’s: credited, a short stretch at most, and whether that is fair use is your call.`
      : '',
    outside ? 'Whatever you pick is credited in the upload kit.' : '',
    web ? `${web.said} It runs only if you tap it.` : '',
    // With nothing to pick, the reason is the reply's news, not a detail.
    found ? '' : notes.join(' ')
  ].filter(Boolean)
  const brief = found
    ? [
        'Here is other B-roll, best first.',
        theirs ? 'What is someone else’s is credited, and whether it is fair use is your call.' : outside ? 'It is credited in the upload kit.' : ''
      ]
        .filter(Boolean)
        .join(' ')
    : [text, ...notes].join(' ')
  return {
    text,
    brief,
    aside: aside.length ? aside.join(' ') : null,
    details: [
      // A short label, so the reasons have the room: the source, then which one and why.
      ...r.results.map((x) => ({ label: SOURCE_LABEL[x.candidate.source], value: `${short(x.candidate.title, 60)}: ${x.reason}` })),
      ...(found && notes.length ? [{ label: 'Left out', value: notes.join(' ') }] : []),
      ...(keys.length ? [{ label: 'With a free key', value: `I could also look on ${listOf(keys)}. Settings has the steps.` }] : [])
    ],
    actions
  }
}

/** What to say once a pick is in: its credit, and the stretch used when it is part of a longer video. */
export function pickedAside(asset: Omit<Asset, 'id'>, c: Candidate): string | null {
  if (c.source === 'library' || c.source === 'own-uploads') return null
  const range = asset.origin.range
  return [
    range ? `Only ${clock(range.startSec)} to ${clock(range.endSec)} of it is used.` : '',
    asset.origin.credit ? `It is credited in the upload kit: ${asset.origin.credit}.` : 'It is credited in the upload kit.',
    c.license.monetized === 'your-call' ? 'Whether that is fair use is your call.' : ''
  ]
    .filter(Boolean)
    .join(' ')
}

/** Words a camera or a download names a file with, which say nothing about what is in it. */
const NAMELESS = new Set(['img', 'dsc', 'dscn', 'dscf', 'mvi', 'gopr', 'gp', 'dji', 'pxl', 'vid', 'mov', 'clip', 'file', 'untitled', 'final', 'copy', 'download'])

/** The B-roll a beat cuts to now, as the words to look for others with: its name, or what is said there when its name says nothing. */
export function swapWords(asset: { title: string } | undefined, said: string): string {
  const title = (asset?.title ?? '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  const telling = title.split(' ').some((w) => /^[a-z]{3,}$/i.test(w) && !NAMELESS.has(w.toLowerCase()))
  return telling ? title : said.split(/\s+/).slice(0, 8).join(' ')
}
