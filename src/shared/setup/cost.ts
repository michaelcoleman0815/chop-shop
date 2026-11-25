/**
 * What a plan costs: worked out from Anthropic's published prices for the
 * model the planner uses and the size of what is sent, not guessed. Before an
 * edit starts, its own size is priced and said (main/plan-quote, planPrice
 * here), with the most it may come to, which is kept as it runs
 * (main/planner). The lines on the setup screen and in Settings are the same
 * reckoning for a typical plan.
 *
 * Prices: for the model MODEL names in src/main/planner.ts, at
 * https://platform.claude.com/docs/en/about-claude/pricing, read on
 * 2026-11-16, in dollars per million tokens. When the planner moves to
 * another model, these move with it.
 *
 * Size: a plan request for a 10-minute talking head (1,500 words in 125
 * beats) with a long prompt, measured in characters on 2026-11-24: the
 * planner's instructions with the schema its answer follows, the slash
 * commands, the transcript, the cut with the ask, and the shorter request
 * that reads a message before its footage (main/triage.ts).
 * src/main/plan-cost.test.ts measures them again and fails when any of them
 * grows or shrinks by a quarter. Characters per token were measured on real
 * runs the same day: 2.5 for the instructions and commands, and about 2.3
 * for the transcript and the cut, whose word ids take tokens of their own.
 *
 * Pictures: a frame of the footage every few seconds goes with the plan, and
 * stills of what it made go to the critic that judges it (main/plan-critic),
 * each a token for every 750 pixels. The critic's calls, the redoing of what
 * it fails and the designer's were measured on real runs on 2026-11-24 (a
 * 79-second and a 65-second explainer).
 *
 * What it cannot know is how long Claude thinks: a short note is answered in
 * about 1,500 tokens, plan and thinking together, and a long prompt can take
 * 7,000. What an answer may take at most is set on each call (MAX_OUTPUT), so
 * the most an edit may come to is known before it starts.
 *
 * Anthropic keeps the instructions, and the transcript and frames, for five
 * minutes after they are read: an edit asked for within them reads them
 * again at a twenty-fifth of the price.
 */

import { PLAN_QUALITY_INFO, type PlanQuality } from '../plan-quality'

export const PLANNER_PRICE = {
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  read: '2026-11-16',
  /** Dollars per million tokens. */
  input: 4,
  cacheWrite: 5,
  cacheRead: 0.2,
  output: 20
} as const

/** The most tokens each kind of call may answer with, thinking and all: what the API is held to. Less for a change. */
export const MAX_OUTPUT = { plan: 16000, redo: 10000, critic: 5000, design: 12000 } as const
export const MAX_CHANGE_OUTPUT = { redo: 5000, critic: 3000 } as const

/** How long Anthropic keeps what it has read, in seconds, with a little to spare. */
export const KEPT_SEC = 280

export const TYPICAL_PLAN = {
  minutes: 10,
  measured: '2026-11-24',
  chars: { instructions: 109700, commands: 5877, transcript: 20136, request: 8951, triage: 10252 },
  /** Characters per token, as reckoned above. */
  perToken: { instructions: 2.5, commands: 2.5, transcript: 2.3, request: 2.3, triage: 2.5 },
  /** The plan and Claude's thinking, from a short note to a long prompt. */
  outputTokens: { low: 1500, high: 7000 },
  /** Reading a message before its footage: a route, a sentence and a little thinking. */
  triageOutputTokens: 600,
  /** Pictures sent, in pixels: the footage's frames with the plan, and a still of the edit (main/plan-look). */
  frames: { count: 30, width: 768, height: 432 },
  still: { width: 960, height: 540 },
  /** The critic's own instructions, and each time it is asked: the stills it sees and what it answers. */
  critic: { instructions: 2400, asks: [{ stills: 10, output: 1800 }, { stills: 5, output: 1200 }, { stills: 3, output: 1000 }] },
  /** Each time the planner redoes what failed: the stills it is shown, what it reads again uncached, and its answer. */
  redos: [
    { stills: 5, input: 12500, output: 2900 },
    { stills: 3, input: 20000, output: 2400 }
  ],
  /** A change to an edit that has its graphics: what it made is looked at, and redone once. */
  change: { asks: [{ stills: 3, output: 900 }, { stills: 2, output: 700 }], redo: { stills: 2, input: 9000, output: 1600 } },
  /** Each graphic designed at the best, and the one time one is drawn again: its instructions, the shot, its answer. */
  designs: [
    { input: 1200, instructions: 3640, stills: 1, output: 6000 },
    { input: 1300, instructions: 0, stills: 1, output: 5500 }
  ]
} as const

/** Tokens in so many characters of a part of the request. */
export const tokensIn = (chars: number, part: keyof typeof TYPICAL_PLAN.perToken): number => Math.round(chars / TYPICAL_PLAN.perToken[part])
/** An image's tokens: one for every 750 pixels. */
export const pictureTokens = (p: { width: number; height: number }): number => Math.round((p.width * p.height) / 750)

/** What a plan request comes to, in tokens: what is the same for every edit, what is this footage's, and what is asked. */
export interface PlanSize {
  instructions: number
  footage: number
  request: number
}

/** What goes into a price besides its size. */
export interface PlanTerms {
  quality: PlanQuality
  /** Whether the edit has its graphics already, so this is a change to it (main/planner). */
  change?: boolean
  /** What Anthropic still keeps from a moment ago. */
  kept?: { instructions?: boolean; footage?: boolean }
}

export interface PlanPrice {
  /** What it usually comes to, in dollars. */
  about: number
  /** What it may come to at most: nothing more is begun that could take it past this. */
  most: number
  /** What it is made of, in dollars; nothing is in a part that is not done. */
  plan: number
  checks: number
  design: number
}

const per = (n: number, price: number): number => (n * price) / 1_000_000

/** Up to the next five cents. */
const upTo5 = (dollars: number): number => Math.ceil(dollars * 20 - 1e-9) / 20

/** What an edit comes to, from its own size (main/plan-quote), in dollars. */
export function planPrice(size: PlanSize, { quality, change = false, kept = {} }: PlanTerms): PlanPrice {
  const p = PLANNER_PRICE
  const still = pictureTokens(TYPICAL_PLAN.still)
  const { critic, redos, designs } = TYPICAL_PLAN
  const cached = size.instructions + size.footage
  const read =
    per(size.instructions, kept.instructions ? p.cacheRead : p.cacheWrite) +
    per(size.footage, kept.footage ? p.cacheRead : p.cacheWrite) +
    per(size.request, p.input)
  const plan = read + per(change ? TYPICAL_PLAN.outputTokens.low : TYPICAL_PLAN.outputTokens.high, p.output)
  const times = PLAN_QUALITY_INFO[quality].redos
  const again = change ? [TYPICAL_PLAN.change.redo].slice(0, times) : redos.slice(0, times)
  const asks = again.length ? (change ? TYPICAL_PLAN.change.asks : critic.asks.slice(0, again.length + 1)) : []
  // The plan judged, what failed redone, and judged again by someone new.
  const checks =
    (asks.length ? per(critic.instructions, p.cacheWrite) + per(critic.instructions, p.cacheRead) * (asks.length - 1) : 0) +
    asks.reduce((sum, a) => sum + per(a.stills * still + 500, p.input) + per(a.output, p.output), 0) +
    again.reduce((sum, r) => sum + per(cached, p.cacheRead) + per(r.input + r.stills * still, p.input) + per(r.output, p.output), 0)
  // A graphic drawn for the video alone, and drawn again when it was not good enough.
  const design = (quality === 'best' && !change ? designs : []).reduce(
    (sum, d) => sum + per(d.instructions, p.cacheWrite) + per(d.input + d.stills * still, p.input) + per(d.output, p.output),
    0
  )
  const about = plan + checks + design
  // The plan may answer as long as it is let; the rest is begun only while what is left covers the most it could come
  // to, so there is room for one thing redone at least.
  const redone = asks.length ? plan + (asks[0] ? per(asks[0].stills * still, p.input) + per(asks[0].output, p.output) : 0) + callMost('redo', cached, change) + callMost('critic', 0, change) : 0
  return { about, most: upTo5(Math.max(read + per(MAX_OUTPUT.plan, p.output), about * 1.25, redone)), plan, checks, design }
}

/** What a call could come to at most, from what it is sent, in dollars: what must be left of a ceiling to begin it. */
export function callMost(what: 'redo' | 'critic' | 'design', cached = 0, change = false): number {
  const p = PLANNER_PRICE
  const still = pictureTokens(TYPICAL_PLAN.still)
  if (what === 'critic') return per(TYPICAL_PLAN.critic.instructions, p.cacheWrite) + per((change ? 6 : 12) * still + 800, p.input) + per((change ? MAX_CHANGE_OUTPUT : MAX_OUTPUT).critic, p.output)
  if (what === 'design') return per(TYPICAL_PLAN.designs[0].instructions, p.cacheWrite) + per(TYPICAL_PLAN.designs[0].input + still, p.input) + per(MAX_OUTPUT.design, p.output)
  return per(cached, p.cacheRead) + per((change ? 12000 : 22000) + (change ? 4 : 8) * still, p.input) + per((change ? MAX_CHANGE_OUTPUT : MAX_OUTPUT).redo, p.output)
}

/** The tokens of a typical plan request, by part, and of reading its message first. */
export function typicalTokens(): PlanSize & { output: { low: number; high: number }; triage: { input: number; output: number } } {
  const { chars, frames } = TYPICAL_PLAN
  return {
    instructions: tokensIn(chars.instructions, 'instructions') + tokensIn(chars.commands, 'commands'),
    footage: tokensIn(chars.transcript, 'transcript') + frames.count * pictureTokens(frames),
    request: tokensIn(chars.request, 'request'),
    output: TYPICAL_PLAN.outputTokens,
    triage: { input: tokensIn(chars.triage, 'triage'), output: TYPICAL_PLAN.triageOutputTokens }
  }
}

/** What a typical plan costs at a quality, in dollars: a change asked for within minutes that puts nothing new on screen, and a first plan. */
export function planCost(quality: PlanQuality = 'quick'): { low: number; high: number } {
  const t = typicalTokens()
  const p = PLANNER_PRICE
  return {
    low: planPrice(t, { quality: 'quick', change: true, kept: { instructions: true, footage: true } }).about,
    high: planPrice(t, { quality }).about + per(t.triage.input, p.cacheWrite) + per(t.triage.output, p.output)
  }
}

/** Cents, rounded to the nearest 5 above ten. */
function cents(dollars: number): number {
  const c = dollars * 100
  return c > 10 ? Math.round(c / 5) * 5 : Math.max(1, Math.round(c))
}

/** Money as people say it: "8 cents", "45 cents", "$1.20". */
export function money(dollars: number): string {
  const c = cents(dollars)
  return c < 100 ? (c === 1 ? '1 cent' : `${c} cents`) : `$${(c / 100).toFixed(2)}`
}

/** The date a price was read, as people say it: "16 November 2026". */
function spoken(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const month = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ][m - 1]
  return `${d} ${month} ${y}`
}

/** When the prices were read, as said beside a price: "at Anthropic’s prices on 16 November 2026". */
export const pricesOn = (): string => `at Anthropic’s prices on ${spoken(PLANNER_PRICE.read)}`

/** The one line on what using Claude costs, with where to see it. */
export function costLine(): string {
  return `${planCostLine()} The Console’s Usage page shows what you actually spend.`
}

/** What a plan costs, in one sentence, for a row that links to the Usage page itself. */
export function planCostLine(quality: PlanQuality = 'quick'): string {
  const { low, high } = planCost(quality)
  return `A plan on a ${TYPICAL_PLAN.minutes}-minute video costs about ${cents(high) < 100 ? cents(low) : money(low)} to ${money(high)} ${pricesOn()}.`
}

/** The most a plan usually costs at a quality, as said beside the choice: "up to about $1.20". */
export function planTopLine(quality: PlanQuality): string {
  return `up to about ${money(planCost(quality).high)}`
}

/** What a quality costs over planning once, in a sentence for the choice itself (Settings). */
export function planQualityCost(quality: PlanQuality): string {
  return quality === 'quick'
    ? `A plan costs ${planTopLine('quick')}.`
    : `It costs more on your Anthropic account: ${planTopLine(quality)} a plan, where Quick is ${planTopLine('quick')}.`
}

/** An edit that should come to more than this, in dollars, waits for a yes unless Settings says otherwise (planAskOver). */
export const ASK_OVER = 0.1

/** What an edit will cost, before it starts (main/plan-quote): what it usually comes to, and the most it may. */
export interface PlanQuote extends PlanPrice {
  quality: PlanQuality
  /** Whether it waits for a yes before it starts. */
  ask: boolean
  change: boolean
  /** What planning it once would usually come to, where more than that is asked for; null where it is not. */
  quick: { about: number; most: number } | null
}

/** A quote in words: the price, then what it is made of. */
export function quoteLines(q: PlanQuote): { text: string; aside: string } {
  const parts: [number, string][] = [
    [q.plan, 'to plan it'],
    [q.design, 'to design a graphic for it'],
    [q.checks, 'to check it and redo what is not good enough']
  ]
  const made = parts.filter(([n]) => n >= 0.005)
  const list = made.map(([n, what]) => `${money(n)} ${what}`)
  const of = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}. ` : ''
  return {
    text: `${q.change ? 'This change' : 'This edit'} will cost about ${money(q.about)}, and never more than ${money(q.most)}.`,
    aside: `${of ? `That is ${of}` : ''}It goes on your Anthropic account, ${pricesOn()}, and I stop before going over.`
  }
}
