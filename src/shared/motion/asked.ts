/**
 * Graphics asked for in plain words, read here on the computer, so a clear
 * ask lands at once without a planner: "list the tools around me as chips",
 * "count up to a million when I say it", "a flip calendar from day 1 to day
 * 3", "put these four in a grid with labels". Each becomes the slash command
 * it stands for and what follows it; anything less clear is left for the
 * planner, which can do all of these too.
 */

export interface GraphicAsk {
  /** The command it stands for, without its slash. */
  command: string
  rest: string
}

/** A clause about timing, which the command finds for itself from the speech: "when I say it". */
const WHEN = /\s*\b(?:when|as|while|once|right as|exactly when)\b\s+(?:i|you|he|she|they|it)\b.*$/i

/** Names in a request: words written with a capital (or one inside, as in iPhone), past its first word. */
function namesIn(text: string): string[] {
  const words = text.split(/\s+/)
  const names: string[] = []
  words.forEach((raw, i) => {
    const w = raw.replace(/[^\p{L}\p{N}+.#'’]/gu, '').replace(/\.$/, '')
    if (i === 0 || !w || /^(I|I'm|I’m|I've|I’ve)$/.test(w)) return
    if (/^\p{Lu}/u.test(w) || /\p{Ll}\p{Lu}/u.test(w)) names.push(w)
  })
  return names
}

/** What follows the words that asked for it, without the timing clause. */
function after(text: string, trigger: RegExp): string {
  const m = trigger.exec(text)
  const rest = m ? text.slice(m.index + m[0].length) : text
  return rest.replace(WHEN, '').trim()
}

export function graphicAsked(text: string): GraphicAsk | null {
  const t = text.trim()
  if (!t || t.startsWith('/')) return null

  // Several videos at once, in a grid: "put these four in a grid with labels".
  if (/\b(?:grid|2\s*[x×]\s*2|two[- ]by[- ]two|four[- ]up)\b/i.test(t) && !/\bgrid\s*lines?\b/i.test(t)) {
    const labels = /\blabel(?:s|led)?\s*(?::|as)\s*(.+)$/i.exec(t)?.[1] ?? ''
    if (/\b(?:no|without)\s+labels?\b/i.test(t)) return { command: 'grid', rest: 'no labels' }
    return { command: 'grid', rest: labels.replace(WHEN, '').trim() }
  }

  // Captions with the word being said in a box.
  if (/\bcaptions?\b/i.test(t) && /\b(?:box|boxed|boxes|block)\b/i.test(t)) return { command: 'boxed', rest: '' }

  // A flip calendar: "DAY 1 flipping to DAY 2". The figures can come before the words that ask for it.
  if (/\bcalendar\b/i.test(t) || (/\bflip(?:s|ping)?\b/i.test(t) && /\b(?:day|week|month|year|days|weeks)\b/i.test(t)))
    return {
      command: 'flip',
      rest: t
        .replace(/\b(?:a\s+)?(?:flip(?:s|ping)?\s+)?calendar\b|\bflip(?:s|ping)?\b/gi, ' ')
        .replace(WHEN, '')
        .replace(/\s+/g, ' ')
        .trim()
    }

  // A number counting up: "count up to a million when I say it".
  const counting = /\b(?:count(?:s|ing)?\s+(?:it\s+)?(?:up|to|from)|roll(?:s|ing)?\s+up|tick(?:s|ing)?\s+up|counter)\b/i
  if (counting.test(t)) {
    const rest = after(t, counting)
    if (/\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion)\b/i.test(rest))
      return { command: 'count', rest }
  }

  // A map's request ("tag the cities on the map", "circle where the site is") is the planner's quick path's, not a chip or a page.
  const mapped = /\b(?:maps?|where)\b/i.test(t)

  // Chips: "list the tools around me as chips".
  if (!mapped && /\b(?:chips?|pills?|bubbles?|tags?)\b/i.test(t)) {
    const names = namesIn(t)
    if (names.length >= 2) return { command: 'chips', rest: names.join(', ') }
    if (/\b(?:list|lists|tools?|apps?|names?|around me|each|everything|things)\b/i.test(t))
      return { command: 'chips', rest: '' }
  }

  // Video cards from links: "show these as video cards".
  if (/\bvideo\s+cards?\b|\bcards?\s+for\s+(?:these|those|my|the)\s+videos\b/i.test(t)) return { command: 'videos', rest: '' }

  // A page shown with a ring round one part of it.
  if (!mapped && /\b(?:ring|circle|highlight)\b/i.test(t) && /\b(?:page|screenshot|channel|site|website|profile|post)\b/i.test(t))
    return { command: 'screenshot', rest: 'slide ring' }

  return null
}
