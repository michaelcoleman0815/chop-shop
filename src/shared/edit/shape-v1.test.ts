import { describe, expect, it } from 'vitest'
import { docFor } from '../raw/eval'
import { bringBack, cutOnRequest, planLength } from '../raw/length'
import { amend, commit, currentCut, currentVersion, resummarize } from './doc'
import { resolveCut } from './resolve'
import type { EditDoc } from './schema'

/**
 * The words sent with dropped footage shape v1 itself (amend): the first
 * version a person sees is already what they asked for, not a v2 made from
 * the raw cut. What the recording held is still known underneath it, so a
 * later length can bring back lines and "bring back the wedding story"
 * still finds what v1 cut on request.
 */

const SCRIPT =
  "Hey everyone, welcome back. Today I'm reviewing the Pixel 9 Pro. |0.8| Let's start with the camera. The main camera is a big step up. Low light is where it shines. |1.5| Funny story, I took it to a wedding last weekend. The DJ played the same song four times. |1.5| The battery lasts about two days. Charging is fast, about thirty minutes to half. |1.5| The screen is bright enough to use outside at noon. |1.5| So should you buy it? If you shoot a lot of video, yes. |1.0| If this helped, subscribe and tell me what you want reviewed next."

const review = (): EditDoc => docFor({ name: 'review', script: SCRIPT }).doc
const said = (doc: EditDoc): string =>
  resolveCut(currentCut(doc), doc.words, doc.sources)
    .words.map((w) => w.text)
    .join(' ')
const runs = (doc: EditDoc): number => resolveCut(currentCut(doc), doc.words, doc.sources).durationSec

/** v1 as the words sent with the footage asked for it: the wedding story out by name, and under 25 seconds. */
function shaped(): EditDoc {
  let doc = review()
  doc = amend(doc, [{ op: 'remove', beats: ['b6', 'b7'], why: 'the wedding story' }], 'The wedding story is out.').doc
  const short = planLength(doc, { targetSec: 25, cut: [] })
  doc = amend(doc, short.ops, short.summary).doc
  return resummarize(doc, 'The wedding story is out, and it runs about 25 seconds.')
}

describe('a first version shaped by the words sent with the footage', () => {
  it('is v1 itself, holding every change and Claude’s summary', () => {
    const raw = review()
    const doc = shaped()
    expect(doc.versions).toHaveLength(1)
    expect(currentVersion(doc).n).toBe(1)
    expect(currentVersion(doc).summary).toBe('The wedding story is out, and it runs about 25 seconds.')
    expect(currentVersion(doc).ops.length).toBeGreaterThan(currentVersion(raw).ops.length)
    expect(said(doc)).not.toMatch(/wedding|DJ/)
    expect(runs(doc)).toBeLessThan(runs(raw))
  })

  it('adds a summary to the one before it, or replaces it when asked', () => {
    const doc = amend(review(), [{ op: 'aspect', aspect: 'vertical' }], 'It is vertical.').doc
    expect(currentVersion(doc).summary).toMatch(/It is vertical\.$/)
    const replaced = amend(doc, [{ op: 'fade', inSec: 0.5 }], 'Vertical, with a fade in.', { replace: true }).doc
    expect(currentVersion(replaced).summary).toBe('Vertical, with a fade in.')
    // Nothing applied: the edit is as it was.
    const same = amend(replaced, [{ op: 'remove', beats: ['b99'] }], 'Nothing.')
    expect(same.doc).toBe(replaced)
    expect(same.applied).toEqual([])
  })

  it('still knows the recording under it: lines come back for a longer length, and the part cut by name only when asked for', () => {
    const doc = shaped()
    expect(cutOnRequest(doc)).toEqual(['the wedding story'])
    // Longer: lines the length took come back as v2, the wedding story does not.
    const longer = planLength(doc, { targetSec: Math.round(runs(doc) + 8), cut: [] })
    expect(longer.ops.length).toBeGreaterThan(0)
    const grown = commit(doc, longer.ops, longer.summary).doc
    expect(grown.versions).toHaveLength(2)
    expect(runs(grown)).toBeGreaterThan(runs(doc))
    expect(said(grown)).not.toMatch(/wedding|DJ/)
    // Asked for by name, it comes back in the order it was said.
    const back = bringBack(grown, 'the wedding story')
    expect(back).not.toBeNull()
    const whole = commit(grown, back?.ops ?? [], back?.summary ?? '').doc
    const s = said(whole)
    expect(s).toMatch(/Funny story, I took it to a wedding/)
    expect(s.indexOf('Funny story')).toBeGreaterThan(s.indexOf('Low light'))
    expect(s.indexOf('Funny story')).toBeLessThan(s.indexOf('The battery'))
  })
})
