import { beatWords, currentCut, resolveCut, type EditDoc } from '../edit'
import { isShort } from '../upload'
import type { BrollIntent, Moment } from './types'

/**
 * The planner's brollWanted ({ beat, search } for each moment that wants
 * B-roll) as moments the router can look for: the words said on the beat,
 * how long it runs, the output's size and whether the video is a Short.
 */

/** The output's pixels for a cut's shape, as the export makes them (main/cut-render frameSize). */
export function outputOf(aspect: string, source: { width: number; height: number } | undefined): { width: number; height: number } {
  if (aspect === 'vertical') return { width: 1080, height: 1920 }
  if (aspect === 'square') return { width: 1080, height: 1080 }
  if (aspect === 'wide' || !source || source.width <= 0 || source.height <= 0) return { width: 1920, height: 1080 }
  const long = Math.max(source.width, source.height)
  const scale = Math.min(1, 1920 / long)
  const even = (n: number): number => Math.max(2, Math.round((n * scale) / 2) * 2)
  return { width: even(source.width), height: even(source.height) }
}

export function momentsFor(
  doc: EditDoc,
  wanted: { beat: string; search: string; intent?: BrollIntent; makers?: string[] }[],
  ctx: { topic?: string; niche?: string } = {}
): Moment[] {
  const cut = currentCut(doc)
  const first = doc.sources.find((s) => s.id === cut.beats[0]?.source) ?? doc.sources[0]
  const output = outputOf(cut.aspect, first)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const length = resolved.beats.length ? resolved.beats[resolved.beats.length - 1].outEnd : 0
  const format = isShort(output.width, output.height, length) ? 'short' : 'long'
  const struck = new Set(cut.removed)
  const out: Moment[] = []
  for (const w of wanted) {
    const beat = cut.beats.find((b) => b.id === w.beat)
    if (!beat || !w.search.trim()) continue
    const rb = resolved.beats.find((b) => b.id === w.beat)
    out.push({
      beat: beat.id,
      said: beatWords(doc, beat)
        .filter((x) => !struck.has(x.id))
        .map((x) => x.text)
        .join(' '),
      search: w.search.trim(),
      topic: ctx.topic ?? doc.title,
      format,
      ...(ctx.niche ? { niche: ctx.niche } : {}),
      output,
      ...(rb ? { seconds: Math.max(0.5, rb.outEnd - rb.outStart) } : {}),
      ...(w.intent ? { intent: w.intent } : {}),
      ...(w.makers?.length ? { makers: w.makers } : {})
    })
  }
  return out
}
