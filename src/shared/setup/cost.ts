/**
 * What a plan costs, for the one line on the setup screen: worked out from
 * Anthropic's published prices for the model the planner uses and the size
 * of a typical plan request in this app, not guessed.
 *
 * Prices: for the model MODEL names in src/main/planner.ts, at
 * https://platform.claude.com/docs/en/about-claude/pricing, read on
 * 2026-11-16, in dollars per million tokens. When the planner moves to
 * another model, these move with it.
 *
 * Size: a plan request for a 10-minute talking head (1,500 words in 125
 * beats) with a long prompt, measured in characters on 2026-11-16: the
 * planner's instructions with the schema its answer follows, the slash
 * commands, the transcript, the cut with the ask, and the shorter request
 * that reads a message before its footage (main/triage.ts).
 * src/main/plan-cost.test.ts measures them again and fails when any of them
 * grows or shrinks by a quarter. Tokens are reckoned at about 3 characters
 * each for the instructions and commands, and about 2.3 for the transcript
 * and the cut, whose word ids take tokens of their own; the tokenizer of
 * current Claude models makes about 30% more tokens than the older one's 4
 * characters.
 *
 * What it cannot know is how long Claude thinks: a short note is answered in
 * about 1,500 tokens, plan and thinking together, and a long prompt can take
 * 7,000. The low end is a follow-up within five minutes, when the
 * instructions, commands and transcript are read from the prompt cache; the
 * high end is the first plan on new footage, when they are written to it,
 * with the message read first.
 */

export const PLANNER_PRICE = {
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  read: '2026-11-16',
  /** Dollars per million tokens. */
  input: 4,
  cacheWrite: 5,
  cacheRead: 0.2,
  output: 20
} as const

export const TYPICAL_PLAN = {
  minutes: 10,
  measured: '2026-11-22',
  chars: { instructions: 75392, commands: 5752, transcript: 20136, request: 8946, triage: 10127 },
  /** Characters per token, as reckoned above. */
  perToken: { instructions: 3, commands: 3, transcript: 2.3, request: 2.3, triage: 3 },
  /** The plan and Claude's thinking, from a short note to a long prompt. */
  outputTokens: { low: 1500, high: 7000 },
  /** Reading a message before its footage: a route, a sentence and a little thinking. */
  triageOutputTokens: 600
} as const

const tokens = (chars: number, perToken: number): number => Math.round(chars / perToken)

/** The tokens of a typical plan request, by part, and of reading its message first. */
export function typicalTokens(): {
  cached: number
  request: number
  output: { low: number; high: number }
  triage: { input: number; output: number }
} {
  const { chars, perToken } = TYPICAL_PLAN
  return {
    cached:
      tokens(chars.instructions, perToken.instructions) +
      tokens(chars.commands, perToken.commands) +
      tokens(chars.transcript, perToken.transcript),
    request: tokens(chars.request, perToken.request),
    output: TYPICAL_PLAN.outputTokens,
    triage: { input: tokens(chars.triage, perToken.triage), output: TYPICAL_PLAN.triageOutputTokens }
  }
}

/** What a typical plan costs, in dollars: a follow-up read from the cache, and a first plan written to it. */
export function planCost(): { low: number; high: number } {
  const t = typicalTokens()
  const p = PLANNER_PRICE
  const per = (n: number, price: number): number => (n * price) / 1_000_000
  return {
    low: per(t.cached, p.cacheRead) + per(t.request, p.input) + per(t.output.low, p.output),
    high:
      per(t.cached, p.cacheWrite) +
      per(t.request, p.input) +
      per(t.output.high, p.output) +
      per(t.triage.input, p.cacheWrite) +
      per(t.triage.output, p.output)
  }
}

/** Cents, rounded to the nearest 5 above ten: "5 cents", "25 cents". */
function cents(dollars: number): number {
  const c = dollars * 100
  return c > 10 ? Math.round(c / 5) * 5 : Math.max(1, Math.round(c))
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

/** The one line on what using Claude costs, with where to see it. */
export function costLine(): string {
  return `${planCostLine()} The Console’s Usage page shows what you actually spend.`
}

/** What a plan costs, in one sentence, for a row that links to the Usage page itself. */
export function planCostLine(): string {
  const { low, high } = planCost()
  return `A plan on a ${TYPICAL_PLAN.minutes}-minute video costs about ${cents(low)} to ${cents(high)} cents at Anthropic’s prices on ${spoken(PLANNER_PRICE.read)}.`
}
