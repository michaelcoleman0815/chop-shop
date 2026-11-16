import { currentCut } from './edit/doc'
import { applyOps, type OpContext } from './edit/ops'
import type { Asset, Cut, EditDoc, Op, Treatment } from './edit/schema'
import { SFX_KINDS, type Sfx } from './edit/sfx'
import { parseTransition, type TransitionKind } from './edit/transitions'
import { MOTION_KINDS, type MotionKind } from './motion/schema'

/**
 * What a channel never wants, by brand: "never use whooshes", "no
 * transitions on this channel". The list is short and names things
 * Cutalong actually does: sound effects, transitions, music beds, looks,
 * punch-ins, camera moves, motion graphics, B-roll from outside, captions
 * and black and white, each whole or, for the first two and graphics, by
 * kind ("zoom transitions", "lower thirds").
 *
 * The list is kept with what Cutalong learns from chats (shared/memory, in
 * never.json of its own), so a rule said in a chat and one added on the
 * Brand page are the same thing.
 * Every change respects it: /all leaves those things out and says so, a
 * command for one answers that the channel never uses it, the planner is
 * told, and whatever any change would add from the list is left out of the
 * version (neverGuard).
 */

/** An entry: a thing ("transition"), or one kind of it ("transition:zoom"). */
export type NeverItem = string

interface Thing {
  /** For the list on the Brand page. */
  name: string
  /** In a sentence: "Field Notes never uses whooshes." */
  said: string
  /** "are" or "is", for "whooshes are fine again". */
  plural: boolean
}

const THINGS: Record<string, Thing> = {
  sfx: { name: 'Sound effects', said: 'sound effects', plural: true },
  transition: { name: 'Transitions', said: 'transitions', plural: true },
  music: { name: 'Music beds', said: 'music beds', plural: true },
  look: { name: 'Looks and LUTs', said: 'looks and LUTs', plural: true },
  'punch-in': { name: 'Punch-ins', said: 'punch-ins', plural: true },
  camera: { name: 'Camera moves', said: 'camera moves', plural: true },
  motion: { name: 'Motion graphics', said: 'motion graphics', plural: true },
  broll: { name: 'B-roll from outside', said: 'B-roll from outside', plural: false },
  captions: { name: 'Captions', said: 'captions', plural: true },
  bw: { name: 'Black and white', said: 'black and white', plural: false }
}

/** The things, in the order the Brand page offers them. */
export const NEVER_THINGS = Object.keys(THINGS)

const SFX_NAMES: Record<string, string> = {
  whoosh: 'whooshes',
  pop: 'pops',
  click: 'clicks',
  riser: 'risers',
  hit: 'hits',
  ding: 'dings'
}

/** Transitions by family, as an editor says them. */
const TRANSITION_NAMES: Record<string, string> = {
  dissolve: 'dissolves',
  dip: 'dips to black or white',
  flash: 'flashes',
  whip: 'whip pans',
  push: 'push transitions',
  slide: 'slide transitions',
  wipe: 'wipes',
  zoom: 'zoom transitions',
  circle: 'circle and door transitions',
  blur: 'blur and pixelate transitions'
}

/** Graphics by kind; charts and market charts are one kind here. */
const MOTION_NAMES: Record<string, string> = {
  callout: 'callouts',
  'lower-third': 'lower thirds',
  keyword: 'keyword pops',
  banner: 'hook banners',
  'end-card': 'end cards',
  title: 'kinetic titles',
  versus: 'versus cards',
  list: 'list graphics',
  price: 'price tags',
  chart: 'charts',
  counter: 'counters',
  progress: 'progress bars',
  steps: 'step graphics',
  sticker: 'stickers',
  logo: 'logo pops',
  screenshot: 'screenshots',
  device: 'phone graphics'
}

/** The family a transition belongs to on the list: every whip is a whip pan. */
export function transitionFamily(kind: TransitionKind): string {
  if (kind.startsWith('dip-')) return 'dip'
  if (kind.startsWith('smooth-') || kind === 'clock') return 'wipe'
  if (kind === 'squeeze') return 'zoom'
  if (kind === 'doors-open' || kind.startsWith('circle-')) return 'circle'
  if (kind === 'pixelate') return 'blur'
  return kind.split('-')[0]
}

/** The kind a graphic is on the list: market charts are charts. */
export function motionFamily(kind: MotionKind): string {
  return kind === 'market' ? 'chart' : kind
}

/** Whether an entry is one this version knows. */
export function isNeverItem(item: string): boolean {
  const [thing, kind] = item.split(':')
  if (!THINGS[thing]) return false
  if (kind === undefined) return true
  if (thing === 'sfx') return (SFX_KINDS as readonly string[]).includes(kind)
  if (thing === 'transition') return kind in TRANSITION_NAMES
  if (thing === 'motion') return kind in MOTION_NAMES
  return false
}

function info(item: NeverItem): Thing {
  const [thing, kind] = item.split(':')
  const base = THINGS[thing] ?? { name: item, said: item, plural: true }
  if (!kind) return base
  const said =
    (thing === 'sfx' ? SFX_NAMES[kind] : thing === 'transition' ? TRANSITION_NAMES[kind] : MOTION_NAMES[kind]) ?? kind
  return { name: said.charAt(0).toUpperCase() + said.slice(1), said, plural: true }
}

/** "Zoom transitions", for the list. */
export function neverName(item: NeverItem): string {
  return info(item).name
}

/** "zoom transitions", in a sentence. */
export function neverSaid(item: NeverItem): string {
  return info(item).said
}

/** The entry on the list that rules a thing out: itself, or the whole of what it is a kind of. */
export function covering(never: NeverItem[], item: NeverItem): NeverItem | null {
  if (never.includes(item)) return item
  const thing = item.split(':')[0]
  return thing !== item && never.includes(thing) ? thing : null
}

/** "a and b", "a, b or c". */
export function listWords(words: string[], last: 'and' | 'or' = 'and'): string {
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} ${last} ${words[words.length - 1]}`
}

// ---------- Reading what someone said ----------

/** Each phrase, longest first, and the entry it names. */
const PHRASES: [RegExp, NeverItem][] = [
  [/\bzoom transitions?\b/, 'transition:zoom'],
  [/\bwhip(?:[- ]?pan)?s?\b/, 'transition:whip'],
  [/\bcross ?fades?\b|\bdissolves?\b/, 'transition:dissolve'],
  [/\bdips?(?: to (?:black|white))?\b|\bfades? to (?:black|white)\b/, 'transition:dip'],
  [/\b(?:white )?flash(?:es)?\b/, 'transition:flash'],
  [/\bpush transitions?\b|\bpushes\b/, 'transition:push'],
  [/\bslide transitions?\b/, 'transition:slide'],
  [/\b(?:smooth )?wipes?\b/, 'transition:wipe'],
  [/\b(?:circle|iris|door) transitions?\b/, 'transition:circle'],
  [/\b(?:blur|pixelate) transitions?\b/, 'transition:blur'],
  [/\btransitions?\b/, 'transition'],
  [/\bwhoosh(?:es)?\b|\bswoosh(?:es)?\b/, 'sfx:whoosh'],
  [/\bkeyword pops?\b|\bword pops?\b/, 'motion:keyword'],
  [/\blogo pops?\b/, 'motion:logo'],
  [/\bpop sounds?\b|\bpops\b/, 'sfx:pop'],
  [/\bclick sounds?\b|\bclicks\b/, 'sfx:click'],
  [/\brisers?\b/, 'sfx:riser'],
  [/\b(?:hit|impact) sounds?\b|\bimpacts\b/, 'sfx:hit'],
  [/\bdings?\b|\bding sounds?\b/, 'sfx:ding'],
  [/\bsound effects?\b|\bsfx\b|\bsound fx\b/, 'sfx'],
  [/\bmusic beds?\b|\bbackground music\b|\bmusic\b|\bsoundtracks?\b|\bbackground tracks?\b/, 'music'],
  [/\bcolou?r grad(?:e|es|ing)\b|\bgrad(?:es|ing)\b|\bluts?\b|\blooks?\b|\bfilters?\b/, 'look'],
  [/\bpunch[- ]?ins?\b|\bzoom[- ]?ins?\b|\bzooms\b|\bzooming\b|\bzoom\b/, 'punch-in'],
  [
    /\bcamera (?:moves?|movements?|motion)\b|\bken burns\b|\bpush[- ]ins?\b|\bpull[- ]?outs?\b|\bpans\b|\bpanning\b|\b(?:camera |screen )?shakes?\b/,
    'camera'
  ],
  [/\blower[- ]thirds?\b/, 'motion:lower-third'],
  [/\bcall[- ]?outs?\b/, 'motion:callout'],
  [/\b(?:hook )?banners?\b/, 'motion:banner'],
  [/\bend (?:cards?|screens?)\b/, 'motion:end-card'],
  [/\bkinetic titles?\b|\btitle cards?\b|\banimated titles?\b|\bon-?screen titles?\b/, 'motion:title'],
  [/\b(?:market )?charts?\b|\bgraphs?\b/, 'motion:chart'],
  [/\bscreenshots?\b/, 'motion:screenshot'],
  [/\bstickers?\b|\bemojis?\b/, 'motion:sticker'],
  [/\bphone (?:graphics?|mock-?ups?)\b/, 'motion:device'],
  [/\bprice tags?\b/, 'motion:price'],
  [/\bcounters?\b/, 'motion:counter'],
  [/\bprogress bars?\b/, 'motion:progress'],
  [
    /\bmotion graphics?\b|\bgraphics\b|\banimations?\b|\banimated text\b|\btext animations?\b|\bbig words?\b/,
    'motion'
  ],
  [
    /\bb-?roll from (?:outside|youtube|the (?:internet|web)|stock sites?|other (?:channels|people))\b|\bb-?roll\b|\bstock (?:footage|clips?|videos?)\b|\boutside (?:footage|clips?|material)\b/,
    'broll'
  ],
  [/\bcaptions?\b|\bsubtitles?\b|\bsubs\b/, 'captions'],
  [/\bblack[- ]and[- ]white\b|\bb ?& ?w\b|\bmonochrome\b|\bgr[ae]yscale\b/, 'bw']
]

/** The things named in a stretch of words, each once, in the order said. */
function thingsIn(span: string): NeverItem[] {
  let text = ` ${span.toLowerCase()} `
  const found: { at: number; item: NeverItem }[] = []
  for (const [re, item] of PHRASES) {
    const all = new RegExp(re.source, 'g')
    for (let m = all.exec(text); m; m = all.exec(text)) {
      found.push({ at: m.index, item })
      // Blanked out, so "zoom transitions" is not also a zoom.
      text = text.slice(0, m.index) + ' '.repeat(m[0].length) + text.slice(m.index + m[0].length)
      all.lastIndex = m.index + m[0].length
    }
  }
  const out: NeverItem[] = []
  for (const f of found.sort((a, b) => a.at - b.at)) if (!out.includes(f.item)) out.push(f.item)
  return out
}

/** The phrases, each anchored to the start of some words, to read a list of things from its start. */
const AT_START: [RegExp, NeverItem][] = PHRASES.map(([re, item]) => [new RegExp(`^(?:${re.source})`), item])

/** The longest thing named at the very start of some words. */
function thingAt(text: string): { item: NeverItem; length: number } | null {
  let best: { item: NeverItem; length: number } | null = null
  for (const [re, item] of AT_START) {
    const m = re.exec(text)
    if (m && m[0].length > 0 && (!best || m[0].length > best.length)) best = { item, length: m[0].length }
  }
  return best
}

/** Words before a thing that leave it whole: "any music", "more whooshes", "any of the transitions". */
const BEFORE_THING = /^(?:(?:any|more|the|those|these|some|other|a|an|of|all)\s+)+/

/** An amount is not the thing: "too many captions", "enough B-roll" are about how much. */
const AMOUNT = /^(?:too (?:many|much)|so (?:many|much)|enough|plenty)\b/

/**
 * The things some words start with, as a list ("any whooshes, pops or zoom
 * transitions"), and the words after it; null when they start with
 * anything else, or with an amount.
 */
function thingList(text: string): { items: NeverItem[]; after: string } | null {
  let rest = text.trimStart()
  const items: NeverItem[] = []
  for (;;) {
    if (AMOUNT.test(rest)) return null
    const bare = rest.replace(BEFORE_THING, '')
    if (AMOUNT.test(bare)) return null
    const hit = thingAt(bare)
    if (!hit) break
    if (!items.includes(hit.item)) items.push(hit.item)
    rest = bare.slice(hit.length).trimStart()
    const join = /^(?:,\s*(?:and\s+|or\s+|nor\s+)?|and\s+|or\s+|nor\s+|&\s*|\/\s*)/.exec(rest)
    if (!join) break
    // A join with no thing after it ends the list: "whooshes, and keep it short".
    const next = rest.slice(join[0].length)
    if (!thingAt(next.replace(BEFORE_THING, ''))) break
    rest = next
  }
  return items.length ? { items, after: rest } : null
}

/** Where a rule holds: the channel, every video, from now on. */
const SCOPE =
  /^(?:(?:on|for|in|across) (?:all |any |every )?(?:of )?(?:this|my|our|the) (?:channel|brand|videos|edits|shorts|uploads|content)\b|from now on\b|going forward\b|ever again\b|ever\b)/

/**
 * Words after the things that leave a rule whole: where and when it holds,
 * who it is on ("zoom in on me"), "in", "again", "please".
 */
const TAIL =
  /^(?:[\s,.!]*(?:(?:on|for|in|across) (?:all |any |every )?(?:of )?(?:this|my|our|the) (?:channel|brand|videos|edits|shorts|uploads|content)|on (?:me|us|my face|the speaker)|from now on|going forward|ever again|ever|again|anymore|any more|at all|whatsoever|in the future|in future|now|in|please|thanks|thank you|ok|okay|either|period))*[\s,.!]*$/

/** What may follow the things: nothing that limits them, or a clause of its own. What a clause asks for besides is passed on. */
function ruleTail(after: string): { ok: boolean; also: string } {
  if (TAIL.test(after)) return { ok: true, also: '' }
  // The tail words first, then the clause: "again, and keep the hook short".
  const tail = /^(?:[\s,.!]*(?:again|ever|anymore|any more|at all|please|now)\b)*\s*/.exec(after)?.[0] ?? ''
  const clause = after.slice(tail.length)
  // Another request in the same sentence: "never use whooshes and keep it short".
  const more = /^(?:[,;:]|[-–—])?\s*(?:and then|and also|and|but|then|also|plus)\s+(.+)$/.exec(clause)
  if (more) return { ok: true, also: more[1] }
  // Why, or what counts: "they're cheesy", "because…", "like ken burns".
  if (/^(?:[,;:]|[-–—])\s*\S/.test(clause)) return { ok: true, also: '' }
  if (/^(?:because|since|as|cause|'cause|cuz|like|such as|e\.?g\.?|including|especially)\b/.test(clause))
    return { ok: true, also: '' }
  return { ok: false, also: '' }
}

/** Saying a thing is used: "never use", "don't ever put". */
const USE =
  /^(?:use|uses|using|add|adds|adding|put|puts|putting|include|includes|including|want|wants|have|has|having|show|shows|showing|play|plays|playing|give me|gives me|do|does|doing|throw in|throws in)\b\s*/

/** Words that open a sentence and change nothing: "please", "and", "from now on,". */
const LEAD = /^(?:(?:please|pls|and|also|just|so|ok|okay|alright|oh|but|then|now|remember|from now on|going forward)\b[\s,]*)*/

/** Who a never is about: the person, a "you should", or the channel. Anyone else is not a rule ("the edit never uses whooshes"). */
const RULER =
  /^(?:(?:i|we)(?:'d|'ll| will| would)?(?: really| just| basically| literally)?|you (?:should|must|shall)|(?:this|my|our|the) (?:channel|brand)(?: should| will)?)\s*$/

interface Ruled {
  items: NeverItem[]
  /** What else the sentence asks for, in the same words: "keep it short". */
  also: string
}

/** The things a stretch rules out, from its start: a list, then nothing that limits it. */
function ruledFrom(text: string, needScope: boolean): Ruled | null {
  const list = thingList(text)
  if (!list) return null
  let after = list.after
  if (needScope) {
    const unlisted = after.replace(/^,\s*/, '')
    const scoped = SCOPE.exec(unlisted)
    if (!scoped) return null
    after = unlisted.slice(scoped[0].length)
  }
  const tail = ruleTail(after)
  return tail.ok ? { items: list.items, also: tail.also } : null
}

/**
 * Rules that rule things out. Each needs the thing said as what is used:
 * "never use whooshes", "never any music", "don't ever put zoom transitions
 * in", "this channel never uses lower thirds", "no transitions on this
 * channel". Not "I never noticed the music", "don't ever let the music drown
 * me out" or "you can never have too many captions".
 */
const NEVER_RULES: ((s: string) => Ruled | null)[] = [
  // "never use whooshes", "I never want black and white again", "this channel never uses lower thirds".
  (s) => {
    const m = /^(.*?)\b(?:never|don'?t ever|do not ever)\b\s*(.*)$/.exec(s)
    if (!m || /^mind\b/.test(m[2])) return null
    const before = m[1].replace(LEAD, '')
    if (before && !RULER.test(before)) return null
    const verb = USE.exec(m[2])
    return ruledFrom(verb ? m[2].slice(verb[0].length) : m[2], false)
  },
  // "this channel doesn't use captions".
  (s) => {
    const m =
      /^(?:.*?\b)?(?:this|my|our|the) (?:channel|brand) (?:doesn'?t|does not|won'?t|will not|shouldn'?t|should not)\s+(.*)$/.exec(
        s
      )
    const verb = m ? USE.exec(m[1]) : null
    return m && verb ? ruledFrom(m[1].slice(verb[0].length), false) : null
  },
  // "no transitions on this channel", "no more whooshes, ever": the things, then where the rule holds.
  (s) => {
    const m = /^(?:(?:i|we) want |there should be |there will be |there'?ll be )?(?:no|zero)\s+(.*)$/.exec(
      s.replace(LEAD, '')
    )
    return m ? ruledFrom(m[1], true) : null
  },
  // "don't use whooshes on this channel", "I don't want music in my videos": only with where the rule holds.
  (s) => {
    const m = /^(?:(?:i|we)\s+)?(?:don'?t|do not)\s+(.*)$/.exec(s.replace(LEAD, ''))
    const verb = m ? USE.exec(m[1]) : null
    return m && verb ? ruledFrom(m[1].slice(verb[0].length), true) : null
  }
]

/** Rules that take things off the list again. */
const ALLOW_RULES: ((s: string) => Ruled | null)[] = [
  // "take music beds off the never list".
  (s) => {
    const m =
      /\b(?:take|remove|drop|delete)\b(.*?)\b(?:off|from) (?:the|my|our|this channel'?s|the channel'?s) never list\b/.exec(s)
    const items = m ? thingsIn(m[1]) : []
    return items.length ? { items, also: '' } : null
  },
  // "whooshes are fine again": the things alone, then fine.
  (s) => {
    const m = /^(.*?)\s+(?:is|are)\s+(?:fine|ok|okay|allowed|back|good)\b(.*)$/.exec(s.replace(LEAD, ''))
    if (!m) return null
    const list = thingList(m[1])
    if (!list || list.after.trim()) return null
    const tail = ruleTail(m[2])
    return tail.ok ? { items: list.items, also: tail.also } : null
  },
  // "you can use transitions on this channel", "feel free to add music again", "allow B-roll from outside".
  (s) => {
    const opened = s.replace(LEAD, '')
    const m =
      /^(?:you can|you may|you're allowed to|you are allowed to|it'?s (?:fine|ok|okay) to|it is (?:fine|ok|okay) to|feel free to|go ahead and|start|allow)\s+(.*)$/.exec(
        opened
      )
    if (!m) return null
    const verb = USE.exec(m[1])
    if (!verb && !/^allow\b/.test(opened)) return null
    return ruledFrom(verb ? m[1].slice(verb[0].length) : m[1], false)
  }
]

export interface NeverSaid {
  /** Things said never to use. */
  never: NeverItem[]
  /** Things said to be fine again. Only these when they are on the list; the caller knows the list. */
  allow: NeverItem[]
  /** What else was said, without the rules: for the planner, as a request. */
  rest: string
}

/**
 * The rules in what someone said, sentence by sentence. A rule says a thing
 * is never used: "never" or "don't ever" with a word for using it, or the
 * thing itself ("never whooshes"), or "no" with where it holds ("no
 * transitions on this channel"). Anything else, "no transitions" for this
 * edit or "I never noticed the music was so loud", is a request, and goes to
 * the planner as one. What a rule's sentence asks for besides ("and keep it
 * short") goes too.
 */
export function readNever(text: string): NeverSaid {
  const sentences = text.split(/(?<=[.!?;])\s+|\n+/)
  const never: NeverItem[] = []
  const allow: NeverItem[] = []
  const rest: string[] = []
  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (!trimmed) continue
    const s = trimmed.toLowerCase().replace(/[’‘]/g, "'")
    const ruled = firstOf(NEVER_RULES, s)
    const allowed = ruled ? null : firstOf(ALLOW_RULES, s)
    const found = ruled ?? allowed
    if (!found) {
      rest.push(trimmed)
      continue
    }
    const into = ruled ? never : allow
    for (const i of found.items) if (!into.includes(i)) into.push(i)
    // What else it asks for, in the words it was said in when lower case kept every letter in place.
    if (found.also) rest.push(s.length === trimmed.length ? trimmed.slice(s.length - found.also.length) : found.also)
  }
  return { never, allow, rest: rest.join(' ') }
}

function firstOf(rules: ((s: string) => Ruled | null)[], s: string): Ruled | null {
  for (const rule of rules) {
    const r = rule(s)
    if (r && r.items.length) return r
  }
  return null
}

/** The words with every rule about the list taken out, so a sentence of rules is never also counted as a request. */
export function withoutNever(text: string): string {
  return readNever(text).rest
}

// ---------- What a cut has ----------

export interface NeverContext {
  /** The edit's material, to tell B-roll from outside from the person's own. */
  assets: Pick<Asset, 'path' | 'origin'>[]
}

/** Material from outside the person's own files that a cutaway can show: a fetched clip or a picture from a link. */
function outside(path: string, ctx: NeverContext): boolean {
  const a = ctx.assets.find((x) => x.path === path)
  return !!a && (a.origin.type === 'video' || a.origin.type === 'link')
}

function sfxItem(s: Sfx): NeverItem {
  return s.kind ? `sfx:${s.kind}` : 'sfx'
}

/**
 * What a cut has of each entry on the list, as keys that stay the same while
 * the thing is unchanged: the same whoosh made louder is the same whoosh, a
 * new one is new.
 */
function present(cut: Cut, entry: NeverItem, ctx: NeverContext): Set<string> {
  const keys = new Set<string>()
  const [thing] = entry.split(':')
  const covers = (item: NeverItem): boolean => covering([entry], item) !== null
  for (const b of cut.beats) {
    const t = b.treatment
    if (thing === 'sfx')
      for (const s of b.sfx ?? []) if (covers(sfxItem(s))) keys.add(`${b.id}|${s.kind ?? s.path}|${s.word ?? ''}`)
    if (thing === 'transition' && b.transition && covers(`transition:${transitionFamily(b.transition.kind)}`))
      keys.add(`${b.id}|${b.transition.kind}`)
    if (thing === 'punch-in') {
      if (t.zoom > 1.001) keys.add(`${b.id}|zoom`)
      if (t.camera?.kind === 'punch-in') keys.add(`${b.id}|camera|${t.camera.word ?? ''}`)
      if (t.broll?.camera?.kind === 'punch-in') keys.add(`${b.id}|cutaway|${t.broll.camera.word ?? ''}`)
    }
    if (thing === 'camera') {
      if (t.camera && t.camera.kind !== 'punch-in') keys.add(`${b.id}|camera|${JSON.stringify(t.camera)}`)
      if (t.broll?.camera && t.broll.camera.kind !== 'punch-in')
        keys.add(`${b.id}|cutaway|${JSON.stringify(t.broll.camera)}`)
    }
    if (thing === 'motion' && entry === 'motion' && t.bigWord) keys.add(`${b.id}|big|${t.bigWord}`)
    if (thing === 'broll' && t.broll && t.frame !== 'speaker' && outside(t.broll.path, ctx))
      keys.add(`${b.id}|${t.broll.path}`)
    if (thing === 'bw' && t.bw) keys.add(b.id)
  }
  if (thing === 'motion')
    for (const m of cut.motion ?? []) if (covers(`motion:${motionFamily(m.kind)}`)) keys.add(m.id)
  if (thing === 'music' && cut.music) keys.add(cut.music.path)
  if (thing === 'look' && cut.look) keys.add(JSON.stringify(cut.look))
  if (thing === 'captions' && cut.captions.on) keys.add('on')
  return keys
}

/** The entries on the list a change from `before` to `after` adds something of. */
export function addedFromList(before: Cut, after: Cut, never: NeverItem[], ctx: NeverContext): NeverItem[] {
  return never.filter((entry) => {
    const had = present(before, entry, ctx)
    for (const key of present(after, entry, ctx)) if (!had.has(key)) return true
    return false
  })
}

/** The entries on the list a cut has something of. */
export function inCut(cut: Cut, never: NeverItem[], ctx: NeverContext): NeverItem[] {
  return never.filter((entry) => present(cut, entry, ctx).size > 0)
}

// ---------- Keeping changes off the list ----------

/** A treatment change without what the list rules out. */
function treatWithout(set: Partial<Treatment>, never: NeverItem[], ctx: NeverContext, left: Set<NeverItem>): Partial<Treatment> {
  const next: Partial<Treatment> = { ...set }
  const rule = (item: NeverItem): boolean => {
    const c = covering(never, item)
    if (c) left.add(c)
    return c !== null
  }
  if ((next.zoom ?? 1) > 1.001 && rule('punch-in')) delete next.zoom
  if (next.bw === true && rule('bw')) delete next.bw
  if (next.bigWord && rule('motion')) delete next.bigWord
  if (next.camera) {
    const item = next.camera.kind === 'punch-in' ? 'punch-in' : 'camera'
    if (rule(item)) delete next.camera
  }
  if (next.broll) {
    if (outside(next.broll.path, ctx) && rule('broll')) {
      delete next.broll
      if (next.frame === 'broll' || next.frame === 'split') delete next.frame
    } else if (next.broll.camera) {
      const item = next.broll.camera.kind === 'punch-in' ? 'punch-in' : 'camera'
      if (rule(item)) {
        const { camera: _c, ...broll } = next.broll
        next.broll = broll
      }
    }
  }
  return next
}

/** Each op without what the list rules out; ops left with nothing to do are dropped. */
export function neverFilter(ops: Op[], never: NeverItem[], ctx: NeverContext): { ops: Op[]; left: NeverItem[] } {
  const left = new Set<NeverItem>()
  const rule = (item: NeverItem): boolean => {
    const c = covering(never, item)
    if (c) left.add(c)
    return c !== null
  }
  const out: Op[] = []
  for (const op of ops) {
    switch (op.op) {
      case 'sfx':
        if (op.add && rule(sfxItem(op.add))) continue
        break
      case 'transition':
        if (op.kind !== 'cut' && rule(`transition:${transitionFamily(op.kind)}`)) continue
        break
      case 'music':
        if (op.set?.path && rule('music')) continue
        break
      case 'look':
        if (op.set !== null && rule('look')) continue
        break
      case 'camera':
        if (op.move && rule(op.move.kind === 'punch-in' ? 'punch-in' : 'camera')) continue
        break
      case 'motion-add':
        if (rule(`motion:${motionFamily(op.kind)}`)) continue
        break
      case 'captions':
        if (op.set.on === true && rule('captions')) {
          const { on: _on, ...set } = op.set
          if (Object.keys(set).length === 0) continue
          out.push({ ...op, set })
          continue
        }
        break
      case 'treat': {
        const set = treatWithout(op.set, never, ctx, left)
        if (Object.keys(set).length === 0) continue
        out.push({ ...op, set })
        continue
      }
      case 'insert': {
        const treatment = op.beat.treatment ? treatWithout(op.beat.treatment, never, ctx, left) : undefined
        out.push(treatment ? { ...op, beat: { ...op.beat, treatment } } : op)
        continue
      }
    }
    out.push(op)
  }
  return { ops: out, left: [...left] }
}

/**
 * Ops checked against the list on the cut they change: whatever they would
 * add from it is left out, and the entries that ruled it out come back. What
 * the cut already had, and changes to it (a sound made louder), stay.
 */
export function neverGuard(
  cut: Cut,
  ops: Op[],
  never: NeverItem[],
  context: OpContext & NeverContext
): { ops: Op[]; left: NeverItem[] } {
  if (never.length === 0 || ops.length === 0) return { ops, left: [] }
  const trial = applyOps(cut, ops, context)
  const grew = addedFromList(cut, trial.cut, never, context)
  if (grew.length === 0) return { ops, left: [] }
  const kept = neverFilter(ops, grew, context)
  return { ops: kept.ops, left: kept.left.length ? kept.left : grew }
}

/**
 * Ops that take out of a cut everything on the list it already has: sounds,
 * transitions, the music bed, the look, punch-ins, camera moves, graphics,
 * B-roll from outside, captions and black and white. For a brand put on an
 * edit, or "take them out" after a rule is said.
 */
export function neverStrip(cut: Cut, never: NeverItem[], ctx: NeverContext): { ops: Op[]; items: NeverItem[] } {
  const ops: Op[] = []
  const items = new Set<NeverItem>()
  const rule = (item: NeverItem): boolean => {
    const c = covering(never, item)
    if (c) items.add(c)
    return c !== null
  }
  const silent: string[] = []
  const hard: string[] = []
  const wide: string[] = []
  const still: string[] = []
  const stillCutaway: string[] = []
  const own: string[] = []
  const colour: string[] = []
  const small: { beat: string; ops: Op[] }[] = []
  for (const b of cut.beats) {
    const t = b.treatment
    const sounds = b.sfx ?? []
    const keep = sounds.filter((s) => !rule(sfxItem(s)))
    if (keep.length < sounds.length) {
      if (keep.length === 0) silent.push(b.id)
      else
        small.push({
          beat: b.id,
          ops: [{ op: 'sfx', beats: [b.id], add: null }, ...keep.map((s): Op => ({ op: 'sfx', beats: [b.id], add: s }))]
        })
    }
    if (b.transition && rule(`transition:${transitionFamily(b.transition.kind)}`)) hard.push(b.id)
    if (t.zoom > 1.001 && rule('punch-in')) wide.push(b.id)
    if (t.camera && rule(t.camera.kind === 'punch-in' ? 'punch-in' : 'camera')) still.push(b.id)
    if (t.broll?.camera && rule(t.broll.camera.kind === 'punch-in' ? 'punch-in' : 'camera')) stillCutaway.push(b.id)
    if (t.broll && t.frame !== 'speaker' && outside(t.broll.path, ctx) && rule('broll')) own.push(b.id)
    if (t.bw && rule('bw')) colour.push(b.id)
    if (t.bigWord && rule('motion')) ops.push({ op: 'treat', beats: [b.id], set: { bigWord: null } })
  }
  if (silent.length) ops.push({ op: 'sfx', beats: silent, add: null })
  for (const s of small) ops.push(...s.ops)
  if (hard.length) ops.push({ op: 'transition', beats: hard, kind: 'cut' })
  if (wide.length) ops.push({ op: 'treat', beats: wide, set: { zoom: 1 } })
  if (still.length) ops.push({ op: 'camera', beats: still, move: null, of: 'beat' })
  if (stillCutaway.length) ops.push({ op: 'camera', beats: stillCutaway, move: null, of: 'cutaway' })
  if (own.length) ops.push({ op: 'treat', beats: own, set: { broll: null } })
  if (colour.length) ops.push({ op: 'treat', beats: colour, set: { bw: false } })
  const graphics = (cut.motion ?? []).filter((m) => rule(`motion:${motionFamily(m.kind)}`)).map((m) => m.id)
  if (graphics.length) ops.push({ op: 'motion-remove', ids: graphics })
  if (cut.music && rule('music')) ops.push({ op: 'music', set: null })
  if (cut.look && rule('look')) ops.push({ op: 'look', set: null })
  if (cut.captions.on && rule('captions')) ops.push({ op: 'captions', set: { on: false } })
  return { ops, items: [...items] }
}

/** neverStrip on an edit's current version. */
export function stripDoc(doc: EditDoc, never: NeverItem[]): { ops: Op[]; items: NeverItem[] } {
  return neverStrip(currentCut(doc), never, { assets: doc.assets })
}

// ---------- Commands ----------

const OFF = /^(off|none|no|remove|stop|still|quieter|softer|down|louder|up|normal)\b/i

/** Commands that put a look on the picture. */
const LOOK_WORDS = new Set([
  'look',
  'lut',
  'exposure',
  'contrast',
  'saturation',
  'warmth',
  'tint',
  'grain',
  'vignette',
  'sharpen'
])

/**
 * What a slash command would put in, when that is something the list can
 * rule out: /sfx whoosh is a whoosh, /transition zoom a zoom transition,
 * /music a music bed. Taking things off ("/music off", "/transition cut")
 * and turning them up or down is never ruled out. `looks` names the
 * commands that are named looks (/warm, /cinematic), `graphic` the kind a
 * graphics command places, `captions` whether it is a caption style.
 */
export function commandThing(
  command: string,
  rest: string,
  extra: { looks?: Set<string>; graphic?: MotionKind | null; captions?: boolean } = {}
): NeverItem | null {
  const words = rest.trim().toLowerCase()
  if (OFF.test(words) && command !== 'transition') return null
  switch (command) {
    case 'sfx': {
      if (/^(transitions?|whooshes)$/.test(words)) return 'sfx:whoosh'
      const kind = SFX_KINDS.find((k) => new RegExp(`^${k}e?s?\\b`).test(words))
      return kind ? `sfx:${kind}` : 'sfx'
    }
    case 'transition': {
      const secs = words.replace(/\d*\.?\d+\s*s?\b/g, ' ').trim()
      const kind = secs ? parseTransition(secs) : 'dissolve'
      return kind && kind !== 'cut' ? `transition:${transitionFamily(kind)}` : null
    }
    case 'music':
      return 'music'
    case 'punchin':
      return 'punch-in'
    case 'kenburns':
    case 'pushin':
    case 'pullout':
    case 'pan':
    case 'shake':
    case 'focus':
      return 'camera'
    case 'broll':
      return 'broll'
    case 'captions':
      return 'captions'
  }
  if (LOOK_WORDS.has(command) || extra.looks?.has(command)) return 'look'
  if (extra.graphic && (MOTION_KINDS as readonly string[]).includes(extra.graphic))
    return `motion:${motionFamily(extra.graphic)}`
  if (extra.captions) return 'captions'
  return null
}

// ---------- Sentences ----------

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** "Field Notes never uses whooshes now. ..." when rules are added. */
export function neverAddedReply(brand: string, added: NeverItem[], already: NeverItem[]): string {
  const parts: string[] = []
  if (added.length) {
    const said = listWords(added.map(neverSaid))
    const them = added.length === 1 && !info(added[0]).plural ? 'it' : 'them'
    parts.push(
      `${brand} never uses ${said} now. I'll leave ${them} out of every change from here on, /all and Claude's included. The never list is on the Brand page.`
    )
  }
  if (already.length) parts.push(`${brand} already never uses ${listWords(already.map(neverSaid))}.`)
  return parts.join(' ')
}

/** "Whooshes are fine on Field Notes again." */
export function neverAllowedReply(brand: string, allowed: NeverItem[]): string {
  const said = listWords(allowed.map(neverSaid))
  const are = allowed.length === 1 && !info(allowed[0]).plural ? 'is' : 'are'
  return `${cap(said)} ${are} fine on ${brand} again.`
}

/** A command for something on the list: no version, and how to change that. */
export function neverBlockedReply(brand: string, item: NeverItem): string {
  const said = neverSaid(item)
  const it = info(item).plural ? 'them' : 'it'
  const are = info(item).plural ? 'are' : 'is'
  return `${brand} never uses ${said}, so I left this edit as it is. To use ${it}, take ${said} off the never list on the Brand page, or say “${said} ${are} fine on this channel”.`
}

/** What a change left out, in one sentence: "I left out the punch-ins, as Field Notes never uses them." */
export function neverLeftOut(brand: string, left: NeverItem[]): string {
  if (left.length === 0) return ''
  const them = left.length === 1 && !info(left[0]).plural ? 'it' : 'them'
  return `I left out the ${listWords(left.map(neverSaid))}, as ${brand} never uses ${them}.`
}

/** /all, in one sentence: "Field Notes never uses whooshes or music beds, so I left them out." */
export function neverFinishNote(brand: string, left: NeverItem[]): string {
  if (left.length === 0) return ''
  const them = left.length === 1 && !info(left[0]).plural ? 'it' : 'them'
  return `${brand} never uses ${listWords(left.map(neverSaid), 'or')}, so I left ${them} out.`
}

/** The list, as a line for the planner. */
export function neverForPlanner(never: NeverItem[]): string[] {
  return never.map((item) => neverSaid(item))
}
