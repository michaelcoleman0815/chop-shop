import { describe, expect, it } from 'vitest'
import { addAsset, applyOps, createDoc, currentCut, wordsFromTranscript } from '../shared/edit'
import { offerPlan } from './planner'
import { fromPlannerOp, PLANNER_SYSTEM, PlanSchema, renderRequest } from './planner-prompt'
import { TRIAGE_SYSTEM, TriageSchema } from './triage'

/**
 * The planner and grids: it is taught the op and when a grid fits, a plan
 * with one applies as a treatment of the beat, and the next request shows it
 * on the beat's line and the material it uses as shown.
 */

const words = wordsFromTranscript(
  [
    ['Here', 0.2, 0.4],
    ['are', 0.45, 0.6],
    ['both', 0.65, 0.9],
    ['edits.', 0.95, 1.4],
    ['The', 2.0, 2.1],
    ['second', 2.15, 2.5],
    ['one', 2.55, 2.7],
    ['won.', 2.75, 3.1]
  ].map(([text, startSec, endSec]) => ({ text: text as string, startSec: startSec as number, endSec: endSec as number })),
  's1'
)

function talkingWithEdit() {
  const doc = createDoc({
    id: 'd',
    title: 't',
    source: { id: 's1', path: '/take.mov', durationSec: 4, width: 1920, height: 1080, fps: 30 },
    words
  })
  return addAsset(doc, {
    kind: 'video',
    path: '/v/edited.mp4',
    title: 'Edited',
    durationSec: 9,
    width: 1920,
    height: 1080,
    origin: { type: 'file', url: null, author: null, license: null, range: null }
  }).doc
}

describe('the planner’s grid', () => {
  it('is taught the op and when a grid fits', () => {
    expect(PLANNER_SYSTEM).toContain('{"op":"grid"')
    expect(PLANNER_SYSTEM).toMatch(/Show videos in a grid only when asked/)
  })

  it('applies as a treatment of the beat, and shows on the beat’s line and in the material', () => {
    const doc = talkingWithEdit()
    const beat = currentCut(doc).beats[0].id
    const plan = PlanSchema.parse({
      ops: [
        {
          op: 'grid',
          beats: [beat],
          panels: [
            { show: '', label: 'Raw', inSec: 0 },
            { show: 'a1', label: 'Edited', inSec: 2 }
          ],
          sound: ''
        }
      ],
      summary: 'Both edits play side by side.',
      reply: 'Done.',
      notesHandled: [],
      needs: [],
      question: { text: '', options: [] }
    })
    const offered = offerPlan(doc, plan, [])
    if (!offered.ok) throw new Error(offered.message)
    expect(offered.rejected).toEqual([])
    const dry = applyOps(currentCut(doc), offered.ops, { words: doc.words, sources: doc.sources, assets: doc.assets })
    expect(dry.rejected).toEqual([])
    expect(dry.cut.beats[0].treatment.grid).toEqual({
      panels: [
        { show: '', label: 'Raw' },
        { show: 'a1', label: 'Edited', inSec: 2 }
      ]
    })
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    const request = renderRequest(after, '', [])
    expect(request).toContain('grid own "Raw", a1 "Edited" from 2.0 s')
    expect(request).toContain(`a1 video 1920x1080, 9.0 s: Edited | shown on ${beat}`)
    // No panels takes it away.
    const off = applyOps(dry.cut, [fromPlannerOp({ op: 'grid', beats: [beat], panels: [], sound: '' })], doc)
    expect(off.rejected).toEqual([])
    expect(off.cut.beats[0].treatment.grid).toBeNull()
  })

  it('cannot show what the edit does not have', () => {
    const doc = talkingWithEdit()
    const beat = currentCut(doc).beats[0].id
    const op = fromPlannerOp({
      op: 'grid',
      beats: [beat],
      panels: [
        { show: '', label: '', inSec: 0 },
        { show: 'a9', label: '', inSec: 0 }
      ],
      sound: '2'
    })
    const out = applyOps(currentCut(doc), [op], { words: doc.words, sources: doc.sources, assets: doc.assets })
    expect(out.rejected[0]?.reason).toBe('There is no recording or material a9 in this edit to put in the grid.')
  })
})

describe('reading a message before its footage (main/triage)', () => {
  it('can send files asked for as a grid to the grid, and links asked for as cards to the cards', () => {
    // Plain words are Claude's to read: "put these four in a grid with labels" and "show these as video cards".
    expect(TRIAGE_SYSTEM).toContain('- grid: play two to four videos dropped in at once')
    expect(TRIAGE_SYSTEM).toContain('cards (videos to show on screen as YouTube shows them')
    const read = { reply: '', clip: { count: 0, minSec: 0, maxSec: 0, funny: false, topic: '' }, question: { text: '', options: [] } }
    expect(TriageSchema.parse({ ...read, route: 'grid', link: 'none' }).route).toBe('grid')
    expect(TriageSchema.parse({ ...read, route: 'edit', link: 'cards' }).link).toBe('cards')
  })
})
