import { describe, expect, it } from 'vitest'
import { applyOps, commit, createDoc, currentCut, filledIn, wordsFromTranscript, type EditDoc, type Op } from './edit'
import { commandThing, isNeverItem, neverGuard, neverName, neverStrip, readNever, stripDoc } from './never'

/**
 * The blurred fill on the never list: a picture of another shape shown whole
 * on a blurred copy of itself (edit/fill). A channel that never uses it gets
 * those pictures cropped to fill the frame instead, as they were before the
 * fill, whatever asks for it: a fill, a still or a phone clip put in, or the
 * brand put on an edit.
 */

const WIDE = { id: 's1', path: '/wide.mov', durationSec: 6, width: 1920, height: 1080, fps: 30 }
const UPRIGHT = { id: 's2', path: '/phone.mov', durationSec: 6, width: 1080, height: 1920, fps: 30 }

/** A wide video, with a phone clip held upright in it: the clip sits on a blurred copy of itself. */
function wideWithPhone(): EditDoc {
  const said = (text: string, source: string, prefix: string) =>
    wordsFromTranscript(
      text.split(' ').map((t, i) => ({ text: t, startSec: 0.3 + i * 0.4, endSec: 0.6 + i * 0.4 })),
      source,
      prefix
    )
  return createDoc({
    id: 'd',
    title: 'phone',
    sources: [WIDE, UPRIGHT],
    words: [...said('So this is the new camera.', 's1', 'a'), ...said('And here it is in my hand.', 's2', 'b')]
  })
}

const contextOf = (d: EditDoc) => ({ words: d.words, sources: d.sources, assets: d.assets })

describe('the blurred fill on the never list', () => {
  it('is a thing the list has, said in a chat', () => {
    expect(isNeverItem('fill')).toBe(true)
    expect(neverName('fill')).toBe('Blurred fill')
    expect(readNever('never use the blurred fill').never).toEqual(['fill'])
    expect(readNever('no blurred backgrounds on this channel').never).toEqual(['fill'])
    // An ask for it is not a rule against it.
    expect(readNever('blur the sides').never).toEqual([])
    expect(commandThing('fill', 'blur')).toBe('fill')
    expect(commandThing('fill', 'crop')).toBeNull()
    expect(commandThing('fill', 'black')).toBeNull()
  })

  it('crops what sat on a blurred copy when the brand is put on the edit', () => {
    const doc = wideWithPhone()
    expect(currentCut(doc).fill).toBe('auto')
    expect(filledIn(doc).map((p) => p.key)).toEqual(['s2'])
    const strip = stripDoc(doc, ['fill'])
    expect(strip.items).toEqual(['fill'])
    expect(strip.ops).toEqual([{ op: 'fill', mode: 'crop' }])
    const after = commit(doc, strip.ops, 'strip').doc
    expect(filledIn(after)).toEqual([])
    // Nothing on a blurred copy, nothing to take out: an edit from before the fill, or one between bars.
    const before = { ...doc, versions: doc.versions.map((v) => ({ ...v, cut: { ...v.cut, fill: undefined } })) }
    expect(stripDoc(before, ['fill']).ops).toEqual([])
    const bars = commit(doc, [{ op: 'fill', mode: 'black' }], 'bars').doc
    expect(neverStrip(currentCut(bars), ['fill'], contextOf(bars)).ops).toEqual([])
  })

  it('leaves out a fill that would put a picture on a blurred copy, and says so', () => {
    const bars = commit(wideWithPhone(), [{ op: 'fill', mode: 'black' }], 'bars').doc
    const ops: Op[] = [{ op: 'fill', mode: 'blur' }]
    expect(neverGuard(currentCut(bars), ops, ['fill'], contextOf(bars))).toEqual({ ops: [], left: ['fill'] })
    // Bars, or the crop, are fine.
    const crop: Op[] = [{ op: 'fill', mode: 'crop' }]
    expect(neverGuard(currentCut(bars), crop, ['fill'], contextOf(bars))).toEqual({ ops: crop, left: [] })
  })

  it('crops a phone clip put into an edit instead of putting it on a blurred copy', () => {
    const doc = wideWithPhone()
    // The edit as it was before the phone clip's beats: only the wide recording.
    const wideOnly = commit(doc, [{ op: 'remove', beats: currentCut(doc).beats.filter((b) => b.source === 's2').map((b) => b.id) }], 'wide').doc
    expect(filledIn(wideOnly)).toEqual([])
    const back: Op[] = [{ op: 'insert', to: 1, beat: { source: 's2', from: 'b1', to: 'b7' } }]
    const guarded = neverGuard(currentCut(wideOnly), back, ['fill'], contextOf(wideOnly))
    expect(guarded.left).toEqual(['fill'])
    expect(guarded.ops).toEqual([...back, { op: 'fill', mode: 'crop' }])
    const after = applyOps(currentCut(wideOnly), guarded.ops, contextOf(wideOnly)).cut
    expect(filledIn(wideOnly, after)).toEqual([])
    expect(after.beats.some((b) => b.source === 's2')).toBe(true)
  })
})
