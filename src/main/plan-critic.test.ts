import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc, type Op } from '../shared/edit'
import { criticSystem, holdTo, judgedOf, lockedOps, looksAt, piecesOf, readVerdict, redoAsk, withoutTakenOut, type MadeOp } from './plan-critic'
import { fromPlannerOp, STYLE_CARDS, type PlannerOp } from './planner-prompt'

/** Twelve sentences of four words, each a beat, over sixty seconds. */
function talk(): EditDoc {
  const words = Array.from({ length: 12 }, (_, k) => ['One', 'two', 'three', `four${k}.`].map((text, i) => ({ text, startSec: 0.5 + k * 4.5 + i * 0.5, endSec: 0.9 + k * 4.5 + i * 0.5 }))).flat()
  return createDoc({
    id: 'd',
    title: 'Talk',
    source: { id: 's1', path: '/talk.mov', durationSec: 60, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript(words, 's1')
  })
}

const graphic = (kind: string, from: string, to: string, extra: Record<string, unknown> = {}): PlannerOp =>
  ({ op: 'motion-add', kind, from, to, text: [], items: [], values: [], box: [], icon: '', style: '', place: '', color: '', fx: [], layers: [], pin: '', ...extra }) as never
const pop = (text: string, from: string): PlannerOp => graphic('keyword', from, '', { text: [text], style: 'plate' })
const strike = (from: string): PlannerOp => ({ op: 'strike', from, to: from }) as never
const sound = (beat: string): PlannerOp => ({ op: 'sfx', beats: [beat], kind: 'pop', sound: '', word: '', gainDb: 0 }) as never
const glide = (beat: string): PlannerOp =>
  ({ op: 'camera', beats: [beat], kind: 'focus', zoom: 0, to: [], word: '', sec: 0, regions: [{ at: 0.2, x: 0.1, y: 0.1, w: 0.3, h: 0.2 }], of: '' }) as never
const board = graphic('board', 'w9', 'w16.end', { style: 'wave', box: [0.77, 0.23, 0.21, 0.53] })
const topics = graphic('topics', 'w9', 'w16.end', { items: [{ label: 'Prioritise', value: 'list-ordered', note: '', mark: '', at: 'w10' }, { label: 'Triage', value: 'filter', note: '', mark: '', at: 'w11' }] })

const made = (ops: PlannerOp[]): MadeOp[] => ops.map((op, from) => ({ op: fromPlannerOp(op) as Op, from }))
const verdict = (scores: Record<number, number>) =>
  readVerdict([{ type: 'tool_use', name: 'verdict', input: { pieces: Object.entries(scores).map(([piece, score]) => ({ piece: Number(piece), score, problem: score < 8 ? 'Too small, top left.' : '', fix: score < 8 ? 'Fill the board.' : '' })), missing: '' } }])!

describe('the critic', () => {
  const ops = [strike('w2'), board, topics, pop('Settings', 'w22'), sound('b6'), glide('b8')]

  it('sees a plan as its graphics and camera moves, a board judged with what is on it, each once it is in', () => {
    const pieces = piecesOf(talk(), made(ops))
    expect(pieces.map((p) => [p.n, p.op, p.board])).toEqual([
      [3, 2, 1],
      [4, 3, null],
      [6, 5, null]
    ])
    expect(pieces[0].said).toContain('One two three four2.')
    // Up for seconds: seen as it arrives and once it is all in.
    expect(pieces[0].at).toHaveLength(2)
    // The camera once it has glided in, on its beat.
    const d = talk()
    const cut = applyOps(currentCut(d), made(ops).map((m) => m.op), { words: d.words, sources: d.sources, assets: d.assets }).cut
    const b8 = resolveCut(cut, d.words, d.sources).beats.find((b) => b.id === 'b8')!
    expect(pieces[2].at[0]).toBeGreaterThan(b8.outStart + 0.6)
    expect(pieces[2].at[0]).toBeLessThan(b8.outEnd)
    const looks = looksAt(pieces)
    expect(looks[0].label).toMatch(/^Piece 3, topics .* as it arrives\. Said while it is up: "/)
  })

  it('scores a graphic that does not show at all a one, and passes what the critic left out', () => {
    const hidden = piecesOf(talk(), made([graphic('topics', 'w900', 'w901', { items: topics && (topics as never as { items: unknown }).items })]))
    const judged = judgedOf([...hidden, ...piecesOf(talk(), made([pop('A', 'w5')]))], { scores: new Map(), missing: '' })
    for (const j of judged) expect(j.score).toBe(j.piece.hidden ? 1 : 8)
  })

  it('looks at a spread of a busy edit, not all of it', () => {
    const many = Array.from({ length: 40 }, (_, i) => pop(`Word ${i}`, `w${i + 1}`))
    const looks = looksAt(piecesOf(talk(), made(many)))
    expect(new Set(looks.map((l) => l.piece.n)).size).toBeLessThanOrEqual(14)
    expect(looks.length).toBeLessThanOrEqual(20)
    expect(Math.max(...looks.map((l) => l.piece.n))).toBeGreaterThan(30)
  })

  it('reads a verdict leniently, and none where there is none', () => {
    expect(verdict({ 3: 12, 4: 0 }).scores.get(3)!.score).toBe(10)
    expect(verdict({ 4: 0 }).scores.get(4)!.score).toBe(1)
    expect(readVerdict([{ type: 'text' }])).toBeNull()
    expect(readVerdict([{ type: 'tool_use', name: 'verdict', input: { pieces: [{ piece: 'x' }] } }])).toBeNull()
  })

  it('tells a critic the bar and the styles, and nothing of the plan', () => {
    const told = criticSystem(STYLE_CARDS)
    expect(told).toContain('Fine does not ship')
    expect(told).toContain('Ali Abdaal')
    expect(told).not.toMatch(/motion-add|"op"/)
  })

  it('locks everything but what failed, with its board when nothing that passed is on it, and the sounds', () => {
    const doc = talk()
    const failBoth = judgedOf(piecesOf(doc, made(ops)), verdict({ 3: 5, 4: 9, 6: 8 }))
    // The topics failed, so the board under them is free as well; the strike, the pop and the glide stay.
    expect([...lockedOps(ops, failBoth)]).toEqual([0, 3, 5])
    const passTopics = judgedOf(piecesOf(doc, made(ops)), verdict({ 3: 9, 4: 5, 6: 8 }))
    expect([...lockedOps(ops, passTopics)]).toEqual([0, 1, 2, 5])
    const ask = redoAsk(passTopics, 'Nothing shows the number.', ops)
    expect(ask).toContain('Piece 4, keyword')
    expect(ask).toContain('5/10. Too small, top left. Fill the board.')
    expect(ask).toContain('"text":["Settings"]')
    expect(ask).toContain('Nothing shows the number.')
    expect(ask).not.toMatch(/Piece 3, topics.*\/10/)
  })

  it('holds a plan handed back to changing only what failed, whatever else it did', () => {
    const locked = new Set([0, 1, 2, 5])
    const bigger = pop('Open the settings', 'w22')
    const back = [
      // The strike moved, the topics reworded and the glide dropped: all put back as they were.
      strike('w3'),
      board,
      { ...topics, items: [] } as never,
      bigger,
      sound('b7'),
      // A cut nobody asked for is left out; a new graphic is let in.
      { op: 'remove', beats: ['b2'], why: '' } as never,
      pop('New', 'w40')
    ]
    expect(holdTo(ops, locked, back)).toEqual([strike('w2'), board, topics, glide('b8'), bigger, sound('b7'), pop('New', 'w40')])
    // Taken out: it stays out.
    expect(holdTo(ops, locked, [strike('w2'), board, topics, glide('b8')])).toEqual([strike('w2'), board, topics, glide('b8')])
    // Handed back in another order, the locked ones keep theirs.
    expect(holdTo(ops, locked, [glide('b8'), topics, board, strike('w2')])).toEqual([strike('w2'), board, topics, glide('b8')])
  })

  it('loses what still fails and the critic would take out, with its board, but never the last piece', () => {
    const judged = judgedOf(piecesOf(talk(), made(ops)), verdict({ 3: 9, 4: 9, 6: 6 }))
    const said = (n: number, fix: string) => judged.map((j) => (j.n === n ? { ...j, score: 6, fix } : j))
    expect(withoutTakenOut(ops, said(6, 'Take it out.'))).toEqual(ops.slice(0, 5))
    // The topics take their board with them; a fix that is not to lose it loses nothing.
    expect(withoutTakenOut(ops, said(3, 'Take it out.')).map((o) => (o as { kind?: string }).kind ?? o.op)).toEqual(['strike', 'keyword', 'pop', 'focus'])
    expect(withoutTakenOut(ops, said(6, 'Make it bigger.'))).toBe(ops)
    const all = judged.map((j) => ({ ...j, score: 3, fix: 'Take it out.' }))
    expect(withoutTakenOut(ops, all).filter((o) => o.op === 'motion-add' || o.op === 'camera').length).toBeGreaterThan(0)
  })
})
