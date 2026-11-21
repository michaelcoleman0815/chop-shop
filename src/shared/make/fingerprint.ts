import type { Draft } from './draft'

/**
 * A fingerprint of what a quote was for: the brief, the script, what is
 * kept, where it goes, the services that make it and its total. The window
 * keeps it beside each quote's button and sends it back when the button is
 * pressed; the main process works it out again from the draft it is sent and
 * makes nothing when the two differ, so a button only ever makes the very
 * draft, at the very price, it showed.
 */
export function draftFingerprint(d: Draft): string {
  const round = (n: number | undefined): number => Math.round((n ?? 0) * 10000) / 10000
  const what = {
    id: d.id,
    brief: d.brief,
    script: d.script,
    phrases: d.phrases,
    sections: d.sections,
    scriptCost: round(d.scriptCost),
    spentBefore: round(d.spentBefore),
    unwritten: !!d.unwritten,
    into: d.into?.docId ?? null,
    narration: d.kept?.narration
      ? [d.kept.narration.path, d.kept.narration.voice.engine, d.kept.narration.voice.id]
      : null,
    shots: d.kept?.shots ? d.kept.shots.shots.map((s) => [s.phrase, s.file]) : null,
    plan: d.plan
      ? [d.plan.shots.map((s) => [s.phrase, s.visual.kind]), d.plan.made.map((s) => [s.phrase, s.file])]
      : null,
    quote: [round(d.quote.total), d.quote.images, d.quote.clips, d.quote.size, d.quote.voice.engine, d.quote.voice.id]
  }
  return hash(stable(what))
}

/** JSON with every object's keys in order, so the same draft always reads the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** A 53-bit string hash (cyrb53), as hex: enough to tell two drafts apart, and the same in both processes. */
function hash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}
