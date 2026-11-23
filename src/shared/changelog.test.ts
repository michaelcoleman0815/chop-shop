import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { changesFor, parseChangelog, shippedOn } from './changelog'

const root = join(__dirname, '../..')
const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }

describe('the changelog', () => {
  it('has a section for the version in package.json, so a release never goes out without one', () => {
    const own = changesFor(text, version)
    expect(own, `CHANGELOG.md has no "## ${version} — date" section`).not.toBeNull()
    expect(own?.changes.length).toBeGreaterThan(0)
    expect(own?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('lists versions newest first, each with its changes, and leaves Unreleased out', () => {
    const all = parseChangelog(text)
    expect(all.length).toBeGreaterThan(5)
    expect(all.map((v) => v.version)).not.toContain('Unreleased')
    const numbers = all.map((v) => v.version.split('.').map(Number))
    for (let i = 1; i < numbers.length; i++) {
      const [a, b] = [numbers[i - 1], numbers[i]]
      expect(a[0] * 1e6 + a[1] * 1e3 + a[2]).toBeGreaterThan(b[0] * 1e6 + b[1] * 1e3 + b[2])
    }
    for (const v of all) expect(v.changes.length, v.version).toBeGreaterThan(0)
  })

  it('reads headings, dashes, wrapped changes and a tag with its v', () => {
    const sample = [
      '# Changelog',
      '',
      'Intro.',
      '',
      '## Unreleased',
      '- Not yet',
      '',
      '## 1.2.0 — 2026-01-02',
      '- One',
      '- Two that wraps',
      '  onto a second line',
      '',
      '## 1.1.0 - 2025-12-30',
      '* Three',
      '',
      'Older versions are elsewhere.'
    ].join('\n')
    expect(parseChangelog(sample)).toEqual([
      { version: '1.2.0', date: '2026-01-02', changes: ['One', 'Two that wraps onto a second line'] },
      { version: '1.1.0', date: '2025-12-30', changes: ['Three'] }
    ])
    expect(changesFor(sample, 'v1.1.0')?.changes).toEqual(['Three'])
    expect(changesFor(sample, '9.9.9')).toBeNull()
  })

  it('gives the release workflow the same changes the app shows, and nothing for a version it lacks', () => {
    const script = join(root, 'scripts/release-notes.mjs')
    const notes = execFileSync(process.execPath, [script, `v${version}`], { encoding: 'utf8' })
    expect(notes.trim().split('\n')).toEqual((changesFor(text, version)?.changes ?? []).map((c) => `- ${c}`))
    expect(() => execFileSync(process.execPath, [script, 'v99.0.0'], { stdio: 'pipe' })).toThrow()
  })

  it('says the day a version shipped in words', () => {
    expect(shippedOn('2026-11-23')).toBe('23 November 2026')
    expect(shippedOn(null)).toBe('')
  })
})
