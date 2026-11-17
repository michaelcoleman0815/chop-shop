import { beatWords, type EditDoc } from '../../../shared/edit'

/**
 * Versions as revision pages. Film scripts print each revision on its own
 * colour of paper, in a fixed order, and mark every changed line with an
 * asterisk in the margin. Cutalong does the same: v1 is the white pages, v2
 * blue, v3 pink and so on. Each colour comes as a gentle page tint (--rev-1
 * to --rev-7, behind the script and the strip) and as a confident pastel
 * block for the version's tab (--block-*; the white pages are paper).
 */

export const REVISION_NAMES = ['white', 'blue', 'pink', 'yellow', 'green', 'goldenrod', 'salmon'] as const

/** The pastel each revision's tab is filled with: the token's own short names for goldenrod and white. */
const BLOCKS: Record<(typeof REVISION_NAMES)[number], string> = {
  white: 'var(--card)',
  blue: 'var(--block-blue)',
  pink: 'var(--block-pink)',
  yellow: 'var(--block-yellow)',
  green: 'var(--block-green)',
  goldenrod: 'var(--block-gold)',
  salmon: 'var(--block-salmon)'
}

/**
 * A version's revision colour: its name, the page tint to paint the script
 * and strip with, and the block for its tab. After salmon the colours begin again.
 */
export function revisionOf(n: number): { name: (typeof REVISION_NAMES)[number]; colour: string; block: string } {
  const i = (((Math.round(n) - 1) % REVISION_NAMES.length) + REVISION_NAMES.length) % REVISION_NAMES.length
  const name = REVISION_NAMES[i]
  return { name, colour: `var(--rev-${i + 1})`, block: BLOCKS[name] }
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
