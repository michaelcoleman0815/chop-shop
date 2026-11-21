/**
 * The first number in what follows a command, as people type it: "2", "0.5",
 * ".5", "1.5x", "50%", "-0.2", "0.3s". `text` is what was matched, so the
 * caller can take it out and read the words that are left. Null when there is
 * no number.
 */
export function numberIn(rest: string): { value: number; unit: '%' | 'x' | 's' | null; text: string } | null {
  const m = /(?:^|[^\w.])([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(%|x|×|secs?|seconds?|s)?(?![\w.])/i.exec(rest)
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value)) return null
  const raw = m[2]?.toLowerCase() ?? null
  const unit = raw === null ? null : raw === '%' ? '%' : raw === 'x' || raw === '×' ? 'x' : 's'
  return { value, unit, text: m[0].replace(/^[^\d+.-]/, '') }
}

/** A speed: "2", "2x", "0.5", ".5", or a percentage of normal speed, "50%". */
export function speedIn(rest: string): number | null {
  const n = numberIn(rest)
  if (!n || n.value <= 0) return null
  return n.unit === '%' ? n.value / 100 : n.value
}

/** Seconds: "0.3", ".3", "0.3s", "2 seconds". */
export function secondsIn(rest: string): number | null {
  const n = numberIn(rest)
  if (!n || n.unit === '%' || n.unit === 'x' || n.value < 0) return null
  return n.value
}

/**
 * How close a camera move gets: "1.2" or "1.2x" as a scale; a percentage
 * under 100 as how much closer ("20%" is 1.2), and from 100 up as the scale
 * itself ("120%" is 1.2). Null when there is no number.
 */
export function zoomIn(rest: string): number | null {
  const n = numberIn(rest)
  if (!n || n.value <= 0) return null
  if (n.unit === '%') return n.value >= 100 ? n.value / 100 : 1 + n.value / 100
  return n.value
}
