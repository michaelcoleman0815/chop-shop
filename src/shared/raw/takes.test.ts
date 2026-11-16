import { describe, expect, it } from 'vitest'
import { applyOps, commit, currentCut, EditDocSchema, OpSchema, resolveCut } from '../edit'
import { docFor, evaluate, evaluateVariants, evalTable } from './eval'
import { FIXTURES } from './fixtures'
import { analyzeTakes, choose, ordinal, type Take } from './takes'
import { planTakes, playingTake, switchTakeOps } from './plan'
import { isCue, meantRepeat, normWord, sameWord } from './text'

const fixture = (name: string): ReturnType<typeof docFor> => {
  const f = FIXTURES.find((x) => x.name === name)
  if (!f) throw new Error(`no fixture ${name}`)
  return docFor(f)
}

const spoken = (doc: ReturnType<typeof docFor>['doc'], ops = planTakes(doc).ops): string => {
  const cut = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources }).cut
  return resolveCut(cut, doc.words, doc.sources)
    .words.map((w) => w.text)
    .join(' ')
}

describe('words as takes see them', () => {
  it('writes numbers, contractions and cut-off stems one way', () => {
    expect(normWord('Three,')).toBe('3')
    expect(normWord('3')).toBe('3')
    expect(normWord("I'm")).toBe('im')
    expect(sameWord('ye', 'years', true)).toBe(true)
    expect(sameWord('ye', 'years')).toBe(false)
    expect(sameWord('camera', 'cameras')).toBe(true)
  })

  it('knows repetition people mean and the cues people say', () => {
    expect(meantRepeat('again and again and again')).toBe(true)
    expect(meantRepeat('never, never')).toBe(true)
    expect(meantRepeat('the best camera for the best camera for')).toBe(false)
    expect(isCue(['Sorry,', 'let', 'me', 'say', 'that', 'again.'])).toBe(true)
    expect(isCue(['Okay,', 'cut.'])).toBe(true)
    expect(isCue(['The', 'battery', 'lasts'])).toBe(false)
  })
})

describe('finding takes', () => {
  it('removes a mid-sentence restart and keeps what came before it', () => {
    const { doc } = fixture('back up a few words, cut-off word missing')
    expect(spoken(doc)).toBe('So the best camera for beginners is the Sony ZV-E10.')
  })

  it('removes the cut-off stem and the restart words, keeping the continuation', () => {
    const { doc } = fixture('back up a few words, cut-off stem')
    expect(spoken(doc)).toBe("I've been using this phone for three years now, and the battery still lasts all day.")
  })

  it('keeps the last complete take of a line said many times', () => {
    const { doc } = fixture('many takes, broken off, a groan, two complete')
    const [group] = planTakes(doc).analyses[0].groups
    expect(group.takes.length).toBeGreaterThanOrEqual(2)
    expect(spoken(doc)).toBe('The RTX 5090 is the fastest graphics card you can buy right now.')
  })

  it('handles ten takes of one line', () => {
    const { doc } = fixture('ten takes of one line')
    expect(spoken(doc)).toBe('The M4 MacBook Air is the laptop I would buy today.')
  })

  it('matches a reworded take and keeps the later wording', () => {
    const { doc } = fixture('reworded take')
    expect(spoken(doc)).toBe("This laptop has the best battery life I've tested all year.")
  })

  it('treats a take broken off by a laugh or a groan as unfinished', () => {
    expect(spoken(fixture('broken off by a laugh').doc)).toBe('The battery life is honestly kind of amazing.')
    expect(spoken(fixture('broken off by a sigh word').doc)).toBe(
      'The screen is bright, but the colours are a little cold.'
    )
  })

  it('moves an intro redone at the end of the session to the front', () => {
    const { doc } = fixture('the intro redone after a run of other lines')
    const plan = planTakes(doc)
    expect(plan.ops.some((o) => o.op === 'move')).toBe(true)
    expect(spoken(doc, plan.ops)).toBe(
      "Hey everyone, welcome back. Today I'm reviewing the Pixel 9 Pro. Let's start with the camera. The main camera is a big step up. Low light is where it shines."
    )
    // Two sentences redone together are one take of the intro, not two lines.
    expect(plan.summary).toMatch(/^I kept the 2nd take of the intro, the last complete one, and removed 1 other take/)
  })

  it('treats a retake of several sentences as one take', () => {
    // The second take carries on further, so it is a restart of both sentences.
    expect(spoken(fixture('retake spanning two sentences').doc)).toBe(
      'Okay so this is the new iPhone. It has a titanium frame and a new button.'
    )
    // Said again word for word, the two sentences are one group of two takes.
    const { doc } = docFor({
      name: 'two sentences said twice',
      script:
        'Okay so this is the new iPhone. It has a titanium frame. |1.0| Okay so this is the new iPhone. It has a titanium frame. Now the cameras.'
    })
    const groups = planTakes(doc).analyses[0].groups
    expect(groups).toHaveLength(1)
    expect(groups[0].takes).toHaveLength(2)
    expect(planTakes(doc).summary).toMatch(
      /^I kept the 2nd take of the intro, the last complete one, and removed 1 other take/
    )
    expect(spoken(doc)).toBe('Okay so this is the new iPhone. It has a titanium frame. Now the cameras.')
  })

  it('picks an earlier take when the last one stumbles badly', () => {
    const { doc } = fixture('two clean takes, the earlier one clearly better')
    expect(spoken(doc)).toBe("Today I'm reviewing the Pixel 9 Pro and the Watch.")
    const [group] = planTakes(doc).analyses[0].groups
    expect(group.reason).toBe('the only one without a stumble')
    // Dead air is what went beyond the words themselves: the pauses around and inside the lost take.
    expect(planTakes(doc).summary).toBe(
      'I kept the 1st take of the intro, the only one without a stumble, and removed 1 other take and 1.5 s of dead air.'
    )
  })

  it('cuts set-up talk at the head and the tail', () => {
    expect(spoken(fixture('set-up talk at the head').doc)).toBe(
      "Hey everyone, welcome back to the channel. Today it's the Pixel 9 Pro."
    )
    expect(spoken(fixture('set-up talk at the tail').doc)).toBe("That's it for today, I'll see you in the next one.")
  })

  it('never cuts repetition that is meant', () => {
    for (const f of FIXTURES.filter((x) => x.nearMiss)) {
      const { doc } = docFor(f)
      const plan = planTakes(doc)
      expect(plan.ops, f.name).toEqual([])
    }
  })

  it('offers a near-identical line instead of cutting it', () => {
    const { doc } = fixture('a near-identical line that swaps the last word')
    const plan = planTakes(doc)
    expect(plan.ops).toEqual([])
    expect(plan.offers).toHaveLength(1)
    expect(plan.offerText).toMatch(/^I left one possible retake in at 0:0\d\. Say “cut it” and it goes\.$/)
    // Saying "cut it" applies exactly the offered ops.
    const after = applyOps(currentCut(doc), plan.offers[0].ops, { words: doc.words, sources: doc.sources })
    expect(after.rejected).toEqual([])
    expect(spoken(doc, plan.offers[0].ops)).toBe('I love this phone because it is light.')
  })

  it('scores precision and recall over the whole fixture set', () => {
    const r = evaluate()
    // Printed so the report can quote it.
    console.log(evalTable(r))
    expect(r.precision).toBeGreaterThanOrEqual(0.97)
    expect(r.recall).toBeGreaterThanOrEqual(0.95)
  })

  it('holds up when the writing and timing change', () => {
    for (const { variant, result } of evaluateVariants()) {
      const misses = result.scores
        .filter((s) => !s.ambiguous && (s.cutWrong.length || s.missed.length))
        .map((s) => `${s.name}: wrong [${s.cutWrong.join(' ')}] missed [${s.missed.join(' ')}]`)
      console.log(
        `${variant}: precision ${(result.precision * 100).toFixed(1)}%, recall ${(result.recall * 100).toFixed(1)}%` +
          (misses.length ? `\n  ${misses.join('\n  ')}` : '')
      )
      // Nothing may be cut wrongly in any variant. A run with no pauses and
      // no punctuation hides one restart: three words said again with a
      // tenth of a second between them, which only the sound can tell from
      // emphasis.
      expect(result.precision, variant).toBeGreaterThanOrEqual(0.99)
      expect(result.recall, variant).toBeGreaterThanOrEqual(variant.startsWith('run-on') ? 0.95 : 0.99)
    }
  })
})

describe('choosing a take', () => {
  const take = (complete: boolean, fluency: number): Take => ({
    from: 'w1',
    to: 'w2',
    startSec: 0,
    endSec: 1,
    complete,
    fluency,
    issues: [],
    span: { from: 'w1', to: 'w2' }
  })

  it('keeps the last complete take by default', () => {
    expect(choose([take(true, 1), take(false, 0.4), take(true, 0.95)])).toEqual({
      index: 2,
      reason: 'the last complete one'
    })
  })

  it('says when the keeper is the only one without a stumble', () => {
    expect(choose([take(true, 0.6), take(true, 0.7), take(true, 1)]).reason).toBe('the only one without a stumble')
  })

  it('names takes in the reply', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd'
    ])
  })
})

describe('takes as an edit', () => {
  it('only uses ops the document accepts, and saves as a version', () => {
    for (const f of FIXTURES) {
      const { doc } = docFor(f)
      const plan = planTakes(doc)
      for (const op of plan.ops) expect(OpSchema.safeParse(op).success, `${f.name}: ${JSON.stringify(op)}`).toBe(true)
      const { doc: next, rejected } = commit(doc, plan.ops, plan.summary || 'x')
      expect(rejected, f.name).toEqual([])
      expect(() => EditDocSchema.parse(next)).not.toThrow()
    }
  })

  it('switches to another take in one step, and back', () => {
    const { doc } = fixture('many takes, broken off, a groan, two complete')
    const plan = planTakes(doc)
    const v2 = commit(doc, plan.ops, plan.summary).doc
    const [group] = planTakes(v2).analyses[0].groups
    expect(playingTake(group, currentCut(v2))).toBe(group.takes.length - 1)
    // "Use the 4th take": the other complete one.
    const four = group.takes.findIndex((t, i) => t.complete && i !== group.takes.length - 1)
    const v3 = commit(v2, switchTakeOps(v2, group, four), 'Take 4.').doc
    expect(playingTake(group, currentCut(v3))).toBe(four)
    const words = resolveCut(currentCut(v3), v3.words, v3.sources).words
    expect(words.map((w) => w.text).join(' ')).toBe('The RTX 5090 is the fastest graphics card you can buy right now.')
    expect(words[0].id).toBe(group.takes[four].from)
    // And back again.
    const v4 = commit(v3, switchTakeOps(v3, group, group.takes.length - 1), 'Back.').doc
    expect(playingTake(group, currentCut(v4))).toBe(group.takes.length - 1)
  })

  it('keeps an intro swap in the intro position', () => {
    const { doc } = fixture('the intro redone after a run of other lines')
    const v2 = commit(doc, planTakes(doc).ops, 'Takes.').doc
    const groups = planTakes(v2).analyses[0].groups
    const intro = groups.filter((g) => g.intro)
    expect(intro.length).toBeGreaterThan(0)
    // Back to the first take of each intro line: it plays first, in place.
    let d = v2
    for (const g of intro) d = commit(d, switchTakeOps(d, g, 0), 'First take.').doc
    const text = resolveCut(currentCut(d), d.words, d.sources)
      .words.map((w) => w.text)
      .join(' ')
    expect(text.startsWith("Hey everyone, welcome back. Today I'm reviewing the Pixel 9 Pro. Let's start")).toBe(true)
    expect(text.endsWith('Low light is where it shines.')).toBe(true)
  })

  it('does nothing twice', () => {
    const { doc } = fixture('ten takes of one line')
    const v2 = commit(doc, planTakes(doc).ops, 'Takes.').doc
    expect(planTakes(v2).ops).toEqual([])
    expect(planTakes(v2).summary).toBe('')
  })

  it('finds nothing in a recording with no words', () => {
    const { doc } = fixture('whole line said twice')
    const empty = { ...doc, words: [] }
    expect(analyzeTakes([], 's1').groups).toEqual([])
    expect(planTakes(empty).ops).toEqual([])
  })

  it('leaves one word, music marks and a single line alone', () => {
    const at = (texts: string[]): ReturnType<typeof planTakes> => {
      const words = texts.map((text, i) => ({
        id: `w${i + 1}`,
        text,
        source: 's1',
        startSec: 0.5 + i * 0.4,
        endSec: 0.8 + i * 0.4
      }))
      const { doc } = fixture('whole line said twice')
      return planTakes({ ...doc, words })
    }
    expect(at(['Hello.']).ops).toEqual([])
    expect(at(['♪', '♪♪', '♪']).ops).toEqual([])
    expect(at(['This', 'is', 'the', 'only', 'line.']).ops).toEqual([])
  })
})
