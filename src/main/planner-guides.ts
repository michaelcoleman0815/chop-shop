import type { Cut } from '../shared/edit'
import { THREE_D_GUIDE } from '../shared/three/planner'

/**
 * The families of ops whose full guide is long and needed only now and then:
 * compositing and expressions, the mixer, particles and scopes, mattes and
 * keying, 3D. Each keeps a line or two always in the planner's instructions,
 * saying what it does and naming its ops, and sends its full guide with the
 * request only when the ask or the notes speak of it or the cut already uses
 * it. So the instructions stay near the size the cost line is reckoned from
 * (plan-cost.test.ts), and a plan that needs a guide still has it in front of it.
 */
export interface FamilyGuide {
  /** Its name, for the block its guide is sent in: `<guide mixer>`. */
  name: string
  /** One or two lines for the instructions, always sent: what the family does and its ops by name. */
  index: string
  /**
   * Whether this ask (the typed request and every note's text, together) or
   * this cut needs the full guide. Match words a person would use for it, not
   * common ones: "music" alone is every other request.
   */
  wanted: (ask: string, cut: Cut) => boolean
  /** The full guide: its ops as examples, one to a line, each followed by ": " and what it does. */
  guide: () => string
}

/** Every family, in the order their guides are sent. Each family's branch adds its one entry here. */
export const FAMILY_GUIDES: FamilyGuide[] = [
  // 3D clips: cards, extruded titles, shapes, models, lights and a camera (shared/three).
  THREE_D_GUIDE
]

/** The always-on lines, under a heading, or nothing while there are no families. */
export function familyIndex(families: FamilyGuide[] = FAMILY_GUIDES): string {
  if (families.length === 0) return ''
  return [
    '## More ops, guided when needed',
    'Each of these has a full guide, sent in a <guide> block with the request whenever the request or the cut needs it. Use its ops only as that guide shows them.',
    ...families.map((f) => `- ${f.index}`)
  ].join('\n')
}

/** The full guides this ask or this cut needs, each as a block for the request. */
export function familyGuides(ask: string, cut: Cut, families: FamilyGuide[] = FAMILY_GUIDES): string[] {
  return families.filter((f) => f.wanted(ask, cut)).map((f) => `<guide ${f.name}>\n${f.guide().trim()}\n</guide>`)
}
