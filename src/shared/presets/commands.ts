import { COMMAND_PATTERN, type Preset } from './preset'

/**
 * Slash commands in the composer: typing "/" opens the list, "/sh" narrows it,
 * and a message may start with a command followed by words for the planner
 * ("/shorts and keep the joke at the end").
 */

export interface ParsedCommand {
  command: string
  /** Everything after the command, trimmed. */
  rest: string
}

/** Reads a leading slash command. Null when the text does not start with one. */
export function parseCommand(text: string): ParsedCommand | null {
  const m = /^\s*\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text)
  if (!m) return null
  return { command: m[1].toLowerCase(), rest: (m[2] ?? '').trim() }
}

/**
 * The slash query being typed, when the caret sits in a command at the start
 * of the text: "/sho" gives "sho", "/" gives "". Null once a space follows the
 * command, because by then the person has moved on to writing.
 */
export function slashQuery(text: string): string | null {
  const m = /^\s*\/([a-z0-9-]*)$/i.exec(text)
  return m ? m[1].toLowerCase() : null
}

/**
 * Presets matching a slash query, best first: the command itself, then a
 * command starting with the query, then a title word starting with it, then
 * the query anywhere in the command. Built-ins win ties, and the list stays in
 * its own order otherwise. So "/warm" offers /warm before /warmth.
 */
export function suggestCommands(query: string, presets: Preset[], limit = 6): Preset[] {
  const q = query.toLowerCase().replace(/^\//, '')
  const rank = (p: Preset): number => {
    if (q === '' || p.command === q) return 0
    if (p.command.startsWith(q)) return 1
    if (
      p.title
        .toLowerCase()
        .split(/\s+/)
        .some((w) => w.startsWith(q))
    )
      return 2
    if (p.command.includes(q)) return 3
    return -1
  }
  return presets
    .map((p, i) => ({ p, i, r: rank(p) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || Number(b.p.builtIn) - Number(a.p.builtIn) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.p)
}

export function findPreset(command: string, presets: Preset[]): Preset | null {
  const c = command.toLowerCase().replace(/^\//, '')
  return presets.find((p) => p.command === c) ?? null
}

/** Why a name cannot be saved, as a sentence; null when it can. */
export function commandProblem(name: string, presets: Preset[]): string | null {
  const c = name.replace(/^\//, '')
  if (!COMMAND_PATTERN.test(c)) {
    return 'Use 2 to 24 lower-case letters, numbers or hyphens, starting with a letter or number.'
  }
  const taken = presets.find((p) => p.command === c)
  if (taken?.builtIn) return `/${c} is built in. Pick another name.`
  if (taken) return `/${c} is already saved. Saving again replaces it.`
  return null
}

/**
 * A command name from a channel or title: "@Field Notes" becomes "fieldnotes".
 * Adds -2, -3 and so on when the name is taken.
 */
export function suggestCommandName(seed: string, presets: Preset[]): string {
  let base = seed
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 20)
  if (base.length < 2) base = 'style'
  const taken = new Set(presets.map((p) => p.command))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}
