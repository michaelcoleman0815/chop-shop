import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

/**
 * The app's CSS variables must say what the design system says. tokens.json
 * is copied from the published system; this fails the moment either side
 * changes without the other. Colours have a light and a dark value: light is
 * declared on :root, dark twice (for the system setting, and for an explicit
 * data-theme), and all three must match.
 */

const here = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')
const tokens = JSON.parse(here('./tokens.json'))
const css = here('./tokens.css')

/** The declarations inside the first block that opens with `opener`. */
function block(opener: string): Map<string, string> {
  const start = css.indexOf(opener)
  if (start < 0) return new Map()
  let depth = 0
  let end = start
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  const body = css.slice(start, end)
  return new Map([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)].map((m) => [m[1], m[2].trim()]))
}

const light = block(':root {')
const darkBySystem = block('@media (prefers-color-scheme: dark)')
const darkByChoice = block(":root[data-theme='dark']")
const norm = (v: string): string => v.replace(/\s+/g, '').replace(/'/g, '"').toLowerCase()

describe('design tokens', () => {
  const themes = (tokens.color.themes as { id: string }[]).map((t) => t.id)

  it('has a light and a dark theme', () => {
    expect(themes).toEqual(['light', 'dark'])
  })

  it('match every colour in light', () => {
    for (const t of tokens.color.tokens) {
      expect(norm(light.get(t.name) ?? 'missing'), t.name).toBe(norm(t.value.light))
    }
  })

  it('match every colour in dark, both ways of asking for it', () => {
    for (const t of tokens.color.tokens) {
      expect(norm(darkBySystem.get(t.name) ?? 'missing'), `${t.name} (system)`).toBe(norm(t.value.dark))
      expect(norm(darkByChoice.get(t.name) ?? 'missing'), `${t.name} (data-theme)`).toBe(norm(t.value.dark))
    }
  })

  it('match spacing, radius, shadow and motion', () => {
    for (const family of ['spacing', 'radius', 'shadow', 'motion']) {
      for (const t of tokens[family].tokens) {
        expect(norm(light.get(t.name) ?? 'missing'), t.name).toBe(norm(t.value))
      }
    }
  })

  it('keep the pastel blocks clear after dark: quiet night tints, the warm ones amber and dusty', () => {
    const dark = (name: string): { l: number; c: number; h: number } => {
      const t = (tokens.color.tokens as { name: string; value: { dark: string } }[]).find((x) => x.name === name)
      const m = t?.value.dark.match(/oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/)
      if (!m) throw new Error(`${name} has no dark oklch value`)
      return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) }
    }
    for (const name of ['blue', 'pink', 'yellow', 'green', 'gold', 'salmon', 'lavender']) {
      const { l, c } = dark(`block-${name}`)
      expect(l, name).toBeGreaterThanOrEqual(33)
      expect(l, name).toBeLessThanOrEqual(40)
      expect(c, name).toBeLessThanOrEqual(0.06)
    }
    // A dark yellow reads khaki and a dark gold olive unless both lean amber and stay soft;
    // a dark pink reads maroon unless it stays dusty.
    for (const name of ['yellow', 'gold']) {
      const { h, c } = dark(`block-${name}`)
      expect(h, name).toBeGreaterThanOrEqual(74)
      expect(h, name).toBeLessThanOrEqual(82)
      expect(c, name).toBeLessThanOrEqual(0.045)
    }
    expect(dark('block-pink').c).toBeLessThanOrEqual(0.045)
    // Yellow stays the lighter of the two, as it is by day.
    expect(dark('block-yellow').l).toBeGreaterThan(dark('block-gold').l)
  })

  it('keep the type families', () => {
    for (const [key, stack] of Object.entries(tokens.type.families as Record<string, string>)) {
      expect(norm(light.get(`font-${key}`) ?? 'missing'), key).toContain(norm(stack))
    }
  })
})
