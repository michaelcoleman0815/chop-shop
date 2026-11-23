/**
 * The changelog (CHANGELOG.md at the top of the repository), read into
 * versions: each `## 0.4.1 — 2026-11-23` heading and the `- ` lines under it.
 * The app shows it on its Changelog page; the release workflow sends
 * the version's own section as GitHub's release notes
 * (scripts/release-notes.mjs), which the updater then has too. "Unreleased"
 * holds what waits for the next version and is not a version of its own.
 */

export interface ChangelogVersion {
  version: string
  /** The day it shipped, as written: 2026-11-23. */
  date: string | null
  changes: string[]
}

const HEADING = /^##\s+(\S+)(?:\s+[—–-]\s+(\d{4}-\d{2}-\d{2}))?\s*$/

/** Every version in the changelog, newest first as written; Unreleased is left out. */
export function parseChangelog(text: string): ChangelogVersion[] {
  const out: ChangelogVersion[] = []
  let current: ChangelogVersion | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const heading = HEADING.exec(line)
    if (heading) {
      current = /^unreleased$/i.test(heading[1]) ? null : { version: heading[1], date: heading[2] ?? null, changes: [] }
      if (current) out.push(current)
      continue
    }
    if (line.startsWith('## ') || line.startsWith('# ')) {
      current = null
      continue
    }
    if (!current) continue
    if (/^[-*]\s+/.test(line)) current.changes.push(line.replace(/^[-*]\s+/, ''))
    // A change wrapped onto the next line, indented, belongs to the change above it.
    else if (/^\s{2,}\S/.test(raw) && current.changes.length > 0)
      current.changes[current.changes.length - 1] += ` ${line.trim()}`
  }
  return out
}

/** One version's section, or null when the changelog has none for it ("v0.4.1" or "0.4.1"). */
export function changesFor(text: string, version: string): ChangelogVersion | null {
  const want = version.replace(/^v/, '')
  return parseChangelog(text).find((v) => v.version === want) ?? null
}

/** A day as the app says it: "23 November 2026". */
export function shippedOn(date: string | null): string {
  if (!date) return ''
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
  return month ? `${d} ${month} ${y}` : date
}
