import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

/**
 * The app's CSS variables must say what the design system says. tokens.json
 * is copied from the published system; this fails the moment either side
 * changes without the other.
 */

const here = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')
const tokens = JSON.parse(here('./tokens.json'))
const css = here('./tokens.css')

const declared = new Map([...css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)].map((m) => [m[1], m[2].trim()]))
const norm = (v: string): string => v.replace(/\s+/g, '').replace(/'/g, '"').toLowerCase()

describe('design tokens', () => {
  const theme = tokens.color.themes[0].id as string

  it('match every colour', () => {
    for (const t of tokens.color.tokens) {
      expect(norm(declared.get(t.name) ?? 'missing'), t.name).toBe(norm(t.value[theme]))
    }
  })

  it('match spacing, radius and shadow', () => {
    for (const family of ['spacing', 'radius', 'shadow']) {
      for (const t of tokens[family].tokens) {
        expect(norm(declared.get(t.name) ?? 'missing'), t.name).toBe(norm(t.value))
      }
    }
  })

  it('keep the type families', () => {
    for (const [key, stack] of Object.entries(tokens.type.families as Record<string, string>)) {
      expect(norm(declared.get(`font-${key}`) ?? 'missing'), key).toContain(norm(stack))
    }
  })
})
