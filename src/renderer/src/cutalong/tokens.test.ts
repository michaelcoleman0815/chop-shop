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

  it('keep the type families', () => {
    for (const [key, stack] of Object.entries(tokens.type.families as Record<string, string>)) {
      expect(norm(light.get(`font-${key}`) ?? 'missing'), key).toContain(norm(stack))
    }
  })
})
