import { describe, expect, it } from 'vitest'
import { applyOps, commit, currentCut, resolveCut } from '../edit'
import { BUILT_IN_PRESETS, planStyle } from '../presets'
import { acceptsOffer, parseTakeRequest, resolveTakeRequest, switchedSentence } from './ask'
import { docFor } from './eval'
import { FIXTURES } from './fixtures'
import { planTakes, takesOf, switchTakeOps } from './plan'

const fixture = (name: string): ReturnType<typeof docFor> => {
  const f = FIXTURES.find((x) => x.name === name)
  if (!f) throw new Error(`no fixture ${name}`)
  return docFor(f)
}

const spoken = (doc: ReturnType<typeof docFor>['doc'], cut = currentCut(doc)): string =>
  resolveCut(cut, doc.words, doc.sources)
    .words.map((w) => w.text)
    .join(' ')

describe('takes asked for in a sentence', () => {
  it('reads the ways people ask', () => {
    expect(parseTakeRequest('Use the second take of the intro.')).toEqual({ take: 2, line: 'intro' })
    expect(parseTakeRequest('go with take 3')).toEqual({ take: 3, line: null })
    expect(parseTakeRequest("switch to the other take of 'the battery lasts'")).toEqual({
      take: 'other',
      line: 'battery lasts'
    })
    expect(parseTakeRequest('the 1st take of the outro')).toEqual({ take: 1, line: 'outro' })
    expect(parseTakeRequest('Use the last take')).toEqual({ take: 'last', line: null })
    expect(parseTakeRequest('use the earlier take of the battery line')).toEqual({ take: 'earlier', line: 'battery' })
    expect(parseTakeRequest('make the intro punchier')).toBeNull()
    expect(parseTakeRequest('I like this take')).toBeNull()
  })

  it('knows a yes to an offer', () => {
    for (const yes of ['cut it', 'Cut them.', 'yes, cut it', 'ok cut those', 'remove it please']) {
      expect(acceptsOffer(yes), yes).toBe(true)
    }
    for (const no of ['cut the intro', "don't cut it", 'cut it shorter']) expect(acceptsOffer(no), no).toBe(false)
  })

  it('switches the intro to its first take in one version, with no planner', () => {
    const { doc } = fixture('the intro redone after a run of other lines')
    const v2 = commit(doc, planTakes(doc).ops, 'Takes.').doc
    const req = parseTakeRequest('use the first take of the intro')
    if (!req) throw new Error('not parsed')
    const answer = resolveTakeRequest(req, takesOf(v2), currentCut(v2))
    if ('problem' in answer) throw new Error(answer.problem)
    expect(switchedSentence(answer.group, answer.index)).toBe('The 1st take of the intro plays now.')
    const ops = switchTakeOps(v2, answer.group, answer.index)
    const dry = applyOps(currentCut(v2), ops, { words: v2.words, sources: v2.sources })
    expect(dry.rejected).toEqual([])
    expect(
      spoken(v2, dry.cut).startsWith("Hey everyone, welcome back. Today I'm reviewing the Pixel 9 Pro. Let's")
    ).toBe(true)
  })

  it('says why when it cannot answer', () => {
    const { doc } = fixture('whole line said twice')
    const cut = currentCut(doc)
    const a = takesOf(doc)
    const tooFar = resolveTakeRequest({ take: 5, line: null }, a, cut)
    expect(tooFar).toEqual({ problem: 'The intro has 2 takes, so there is no 5th.' })
    const unknown = resolveTakeRequest({ take: 1, line: 'the sponsor read' }, a, cut)
    expect('problem' in unknown && unknown.problem).toMatch(/^I couldn't find a line said more than once/)
    const none = resolveTakeRequest({ take: 1, line: null }, takesOf(fixture('emphasis: never, never').doc), cut)
    expect(none).toEqual({ problem: 'No line in this recording was said more than once.' })
  })
})

describe('takes inside the presets', () => {
  it('runs first inside /tighten, and its sentence leads', () => {
    const { doc } = fixture('ten takes of one line')
    const tighten = BUILT_IN_PRESETS.find((p) => p.command === 'tighten')!
    const plan = planStyle(doc, tighten.style)
    // Six of the ten were broken off mid-line and count as false starts.
    expect(plan.takes?.summary).toMatch(
      /^I kept the 4th take of the intro, the last complete one, and removed 3 other takes, 6 false starts/
    )
    expect(plan.ops.slice(0, plan.takes?.opCount).every((o) => o.op === 'strike')).toBe(true)
    expect(plan.ops[plan.takes?.opCount ?? 0]).toEqual({ op: 'tighten', set: tighten.style.tighten })
    const next = commit(doc, plan.ops, plan.takes?.summary ?? 'x').doc
    expect(spoken(next)).toBe('The M4 MacBook Air is the laptop I would buy today.')
  })

  it('runs alone as /takes and leaves pauses as they were', () => {
    const { doc } = fixture('whole line said twice')
    const plan = planStyle(doc, BUILT_IN_PRESETS.find((p) => p.command === 'takes')!.style)
    expect(plan.ops.every((o) => o.op === 'strike')).toBe(true)
    expect(plan.takes?.counts.takes).toBe(1)
  })
})
