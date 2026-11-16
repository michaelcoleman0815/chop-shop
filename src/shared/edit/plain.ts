import { currentCut } from './doc'
import type { EditDoc } from './schema'

/**
 * Words for the person, not the document. The planner thinks in ids (w12,
 * s2w4, b3, s1, a2), and a sentence from it, or from a check that refused one
 * of its ops, can still carry one. Shown as is, "b3" or "s1" means nothing to
 * anyone, so each id becomes what it stands for: the words themselves, the
 * beat's place in the cut, the file's name, the material's title.
 */
export function plainIds(doc: EditDoc, text: string): string {
  if (!text) return text
  const words = new Map(doc.words.map((w) => [w.id, w.text]))
  const beats = new Map(currentCut(doc).beats.map((b, i) => [b.id, i + 1]))
  const sources = new Map(doc.sources.map((s) => [s.id, fileName(s.path)]))
  const assets = new Map(doc.assets.map((a) => [a.id, a.title]))
  const said = (id: string): string => clean(words.get(id) ?? '')
  const word = '(?:s\\d+)?w\\d+'

  return (
    text
      // A run of words: "w12-w15" or "w12 to w15".
      .replace(new RegExp(`\\b(${word})\\s*(?:-|–|—|to)\\s*(${word})\\b`, 'g'), (all, a: string, b: string) =>
        words.has(a) && words.has(b) ? `“${said(a)} … ${said(b)}”` : all
      )
      .replace(new RegExp(`\\b${word}\\b`, 'g'), (id) => (words.has(id) ? `“${said(id)}”` : id))
      .replace(/\bb\d+\b/g, (id) => (beats.has(id) ? `beat ${beats.get(id)}` : id))
      .replace(/\bs\d+\b/g, (id) => sources.get(id) ?? id)
      .replace(/\ba\d+\b/g, (id) => assets.get(id) ?? id)
      // A sentence that now opens on "beat 3" still opens with a capital.
      .replace(/(^|[.!?]\s+)beat (\d)/g, (_all, lead: string, n: string) => `${lead}Beat ${n}`)
  )
}

/** One full sentence: trimmed, starting with a capital and ending with a stop. */
export function sentence(text: string): string {
  const t = text.trim()
  if (!t) return ''
  const first = t[0].toUpperCase() + t.slice(1)
  return /[.!?…]["'”’)\]]*$/.test(first) ? first : `${first}.`
}

function clean(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
