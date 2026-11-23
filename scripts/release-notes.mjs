#!/usr/bin/env node
/**
 * Prints one version's changes from CHANGELOG.md as the release's notes, for
 * the release workflow (.github/workflows/release.yml), which GitHub shows and
 * the updater hands to the app. Prints nothing, and exits 1, when the
 * changelog has no section for it; the workflow then lets GitHub write notes
 * from the commits instead. The app reads the same file (shared/changelog).
 *
 *   node scripts/release-notes.mjs v0.4.1
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const version = (process.argv[2] ?? '').replace(/^v/, '')
const root = new URL('..', import.meta.url).pathname
const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/)
const heading = new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}(\\s|$)`)
const start = version ? lines.findIndex((l) => heading.test(l)) : -1
if (start < 0) process.exit(1)
const changes = []
for (const line of lines.slice(start + 1)) {
  if (line.startsWith('#')) break
  if (/^[-*]\s+/.test(line)) changes.push(`- ${line.replace(/^[-*]\s+/, '').trimEnd()}`)
  else if (/^\s{2,}\S/.test(line) && changes.length > 0) changes[changes.length - 1] += ` ${line.trim()}`
  else if (line.trim() && changes.length > 0) break
}
if (changes.length === 0) process.exit(1)
process.stdout.write(`${changes.join('\n')}\n`)
