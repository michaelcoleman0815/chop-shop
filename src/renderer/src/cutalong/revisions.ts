import { beatWords, type EditDoc } from '../../../shared/edit'

/**
 * Versions as revision pages. Film scripts print each revision on its own
 * colour of paper, in a fixed order, and mark every changed line with an
 * asterisk in the margin. Cutalong does the same: v1 is the white pages, v2
 * blue, v3 pink and so on, each a gentle tint (tokens.css, --rev-1 to --rev-6).
 */

export const REVISION_NAMES = ['white', 'blue', 'pink', 'yellow', 'green', 'goldenrod'] as const

/** A version's revision colour: its name, and the CSS colour to paint with. After goldenrod the colours begin again. */
export function revisionOf(n: number): { name: (typeof REVISION_NAMES)[number]; colour: string } {
  const i = (((Math.round(n) - 1) % REVISION_NAMES.length) + REVISION_NAMES.length) % REVISION_NAMES.length
  return { name: REVISION_NAMES[i], colour: `var(--rev-${i + 1})` }
}

/**
 * The beats the version on screen changed, for the asterisks in the script's
 * margin: a beat that is new, whose cut differs, or whose words were struck
 * or brought back, compared with the version before it. The first version
 * changed nothing.
 */
export function changedBeats(doc: EditDoc): Set<string> {
  const last = doc.versions.length - 1
  if (last < 1) return new Set()
  const now = doc.versions[last].cut
  const before = doc.versions[last - 1].cut
  const was = new Map(before.beats.map((b) => [b.id, b]))
  const struckNow = new Set(now.removed)
  const struckBefore = new Set(before.removed)
  const changed = new Set<string>()
  for (const beat of now.beats) {
    const old = was.get(beat.id)
    if (!old || JSON.stringify(old) !== JSON.stringify(beat)) {
      changed.add(beat.id)
      continue
    }
    if (beatWords(doc, beat).some((w) => struckNow.has(w.id) !== struckBefore.has(w.id))) changed.add(beat.id)
  }
  return changed
}
