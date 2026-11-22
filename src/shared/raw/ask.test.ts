import { describe, expect, it } from 'vitest'
import { applyOps, commit, currentCut, resolveCut } from '../edit'
import { BUILT_IN_PRESETS, planStyle } from '../presets'
import { switchedSentence } from './ask'
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

describe('a take asked for', () => {
  // Which line and which take is Claude's to read (the planner's take step); playing it is this.
  it('switches the intro to its first take in one version, and says so', () => {
    const { doc } = fixture('the intro redone after a run of other lines')
    const v2 = commit(doc, planTakes(doc).ops, 'Takes.').doc
    const group = takesOf(v2)[0].groups[0]
    expect(switchedSentence(group, 0)).toBe('The 1st take of the intro plays now.')
    const ops = switchTakeOps(v2, group, 0)
    const dry = applyOps(currentCut(v2), ops, { words: v2.words, sources: v2.sources })
    expect(dry.rejected).toEqual([])
    expect(
      spoken(v2, dry.cut).startsWith("Hey everyone, welcome back. Today I'm reviewing the Pixel 9 Pro. Let's")
    ).toBe(true)
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
