/**
 * Words as the aligner compares them: lower case, no punctuation, no
 * apostrophes, so "Settings," and "settings" are one word and "don't" is
 * "dont" on both sides. Two transcripts of the same sound made separately
 * still disagree now and then ("setting" for "settings"), so near misses
 * count for part of a match.
 */

export function normToken(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/** 1 minus the edit distance over the longer length: 1 is the same word. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return 0
  let prev = Array.from({ length: m + 1 }, (_, j) => j)
  for (let i = 1; i <= n; i++) {
    const cur = [i]
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return 1 - prev[m] / Math.max(n, m)
}

/** Short words must match exactly: "a" and "i" are one letter apart from everything. */
export function nearMatch(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 2 || a[0] !== b[0]) return false
  return similarity(a, b) >= 0.75
}
