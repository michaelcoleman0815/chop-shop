import { describe, expect, it } from 'vitest'
import { applyOps, commit, createDoc, currentCut, restore, undoTarget, wordsFromTranscript, type EditDoc, type Op } from './edit'
import { EditDocSchema as EditDocSchema0213 } from './edit/schema-0213.review'
import { brandPreset, EMPTY_BRAND, type Brand } from './brand'
import { brandOfCut, chatBrand, removeBrand, stampBrand, type Brands } from './brands'
import { planStyle } from './presets/plan'
import { DEFAULT_PROFILE, styleForProfile } from './raw/profiles'
import { upgradeProject } from './project-upgrade'
import type { Project } from './types'

/**
 * What this build saves for an edit after /brand (which startEdit runs on
 * every new edit whose brand has a look) or a brand switch, read by the schema
 * 0.2.13 (391798b) reads projects with (shared/project-upgrade -> EditDocSchema),
 * and the brand an edit saved by 0.2.13 is in, on both sides.
 */

const words = 'So this is the new camera. It is small. The sensor is big. Here is why that matters.'
  .split(' ')
  .map((text, i) => ({ text, startSec: 0.3 + i * 0.4, endSec: 0.6 + i * 0.4 }))

function freshDoc(): EditDoc {
  return createDoc({
    id: 'd1',
    title: 'take',
    source: { id: 's1', path: '/a.mov', durationSec: 12, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript(words, 's1')
  })
}

const A: Brand = { ...EMPTY_BRAND, id: 'brand-1', name: 'Field Notes', captions: { position: 'bottom', wordsPerScreen: 3 } }
const B: Brand = { ...EMPTY_BRAND, id: 'brand-x', name: 'Tech Corner', colors: { text: '#000000', accent: '#FF0000' } }
const list: Brands = { v: 1, default: 'brand-1', brands: [A, B] }

/** useCutalong brandPlan(d, target, look=true) without the never list, as startEdit and /brand run it. */
function brandPlanOps(d: EditDoc, target: Brand): Op[] {
  const ops: Op[] = [{ op: 'brand', id: target.id }]
  const context = { words: d.words, sources: d.sources, assets: d.assets }
  const cut = applyOps(currentCut(d), ops, context).cut
  const preset = brandPreset(target)!
  const plan = planStyle(d, styleForProfile('brand', preset.style, DEFAULT_PROFILE), cut, {})
  return [...ops, ...plan.ops]
}

/** What 0.2.13 makes of the edit in a project file: null when it cannot read it, and leaves it out. */
const readBy0213 = (doc: EditDoc): boolean => EditDocSchema0213.safeParse(JSON.parse(JSON.stringify(doc))).success

describe('the brand op and older builds', () => {
  it('a new edit after startEdit (/brand) is one 0.2.13 reads, with the brand on its cut', () => {
    // prepareCut stamps the brand on v1; startEdit then runs /brand.
    const d = stampBrand(freshDoc(), A.id)
    const trial = applyOps(currentCut(d), brandPlanOps(d, A), { words: d.words, sources: d.sources, assets: d.assets })
    expect(trial.applied[0]).toEqual({ op: 'brand', id: 'brand-1' })
    // applyAsVersion commits trial.applied: the brand op is applied, and not kept.
    const saved = commit(d, trial.applied, 'Field Notes is on.').doc
    expect(saved.versions).toHaveLength(2)
    expect(saved.versions[1].ops.some((o) => o.op === 'brand')).toBe(false)
    expect(saved.versions[1].ops.length).toBe(trial.applied.length - 1)
    expect(saved.versions[1].cut.brand).toBe('brand-1')
    expect(readBy0213(d)).toBe(true)
    expect(readBy0213(saved)).toBe(true)
  })

  it('a brand switch is a version 0.2.13 reads, and undo still brings the old brand back', () => {
    const d = stampBrand(freshDoc(), A.id)
    const switched = commit(d, [{ op: 'brand', id: B.id }], 'Tech Corner is on this edit now.').doc
    expect(switched.versions).toHaveLength(2)
    expect(switched.versions[1].ops).toEqual([])
    expect(brandOfCut(list, currentCut(switched)).id).toBe('brand-x')
    expect(readBy0213(switched)).toBe(true)
    const undone = restore(switched, undoTarget(switched)!)
    expect(brandOfCut(list, currentCut(undone)).id).toBe('brand-1')
    expect(readBy0213(undone)).toBe(true)
  })

  it('a brand op naming the brand the edit is in makes no version', () => {
    const d = stampBrand(freshDoc(), A.id)
    expect(commit(d, [{ op: 'brand', id: A.id }], 'Field Notes is on.').doc).toBe(d)
  })

  it('an edit saved with brand ops in its versions, as the first builds with brands saved it, opens without them', () => {
    const d = stampBrand(freshDoc(), A.id)
    const next = commit(d, [{ op: 'brand', id: B.id }, { op: 'captions', set: { position: 'top' } }], 'Tech Corner.').doc
    // As those builds wrote it: the brand op first in the version's ops.
    const old = JSON.parse(JSON.stringify(next)) as EditDoc
    old.versions[1].ops = [{ op: 'brand', id: B.id }, ...old.versions[1].ops]
    expect(readBy0213(old)).toBe(false)
    const clip = { ...old, id: 'clip-doc' }
    const project = {
      id: 'p',
      name: 'Talk',
      mode: 'cut',
      path: '/Talk.cutalong',
      createdAt: '2026-11-01T00:00:00.000Z',
      openedAt: '2026-11-01T00:00:00.000Z',
      primaryMedia: '/a.mov',
      mediaBytes: null,
      media: ['/a.mov'],
      clips: [],
      transcript: null,
      timeline: null,
      edit: old,
      clipping: {
        v: 1,
        runs: [],
        clips: [{ id: 'c1', run: 1, source: '/a.mov', startSec: 0, endSec: 12, title: 'take', hook: '', reason: '', score: 1, kept: true, doc: clip }]
      }
    } as unknown as Project
    const { project: read, unreadable } = upgradeProject(project)
    expect(unreadable).toBeNull()
    expect(read.edit!.versions[1].ops).toEqual([{ op: 'captions', set: { position: 'top' } }])
    expect(currentCut(read.edit!).brand).toBe('brand-x')
    expect(readBy0213(read.edit!)).toBe(true)
    expect(read.clipping!.clips[0].doc.versions[1].ops.some((o) => o.op === 'brand')).toBe(false)
    expect(readBy0213(read.clipping!.clips[0].doc)).toBe(true)
  })
})

describe('an edit saved by 0.2.13 once another brand is the default', () => {
  it('stays in brand-1, the brand it was made in, on both sides', () => {
    const legacy = freshDoc() // as 0.2.13 saved it: no brand on any version
    expect(brandOfCut(list, currentCut(legacy)).id).toBe('brand-1')
    // Brand page: "Make it the default" on Tech Corner (setDefaultBrand), nothing done to the old edit.
    const later: Brands = { ...list, default: 'brand-x' }
    expect(brandOfCut(later, currentCut(legacy)).id).toBe('brand-1') // main brandOfDoc: export, plan, never list
    expect(chatBrand(later, currentCut(legacy), null).id).toBe('brand-1') // the chat, the editor, /brand
    // A new chat still starts in the default.
    expect(chatBrand(later, null, null).id).toBe('brand-x')
  })

  it('is in the default once brand-1 is deleted', () => {
    const legacy = freshDoc()
    const without = removeBrand({ ...list, default: 'brand-x' }, 'brand-1')
    expect(brandOfCut(without, currentCut(legacy)).id).toBe('brand-x')
    expect(chatBrand(without, currentCut(legacy), 'brand-1').id).toBe('brand-x')
  })
})

describe('undo after switching the brand of an edit saved by 0.2.13', () => {
  it('leaves the chat and the export in the same brand', () => {
    const legacy = freshDoc() // no brand on any version, as 0.2.13 saved it
    // switchBrand: setChatChoice('brand-x'), then a version with { op: 'brand' }.
    const chosen = B.id
    const switched = commit(legacy, [{ op: 'brand', id: B.id }], 'Tech Corner is on this edit now.').doc
    expect(chatBrand(list, currentCut(switched), chosen).id).toBe('brand-x')
    expect(brandOfCut(list, currentCut(switched)).id).toBe('brand-x')
    // Undo: restore(undoTarget) brings v1's cut back, which names no brand.
    const undone = restore(switched, undoTarget(switched)!)
    const cut = currentCut(undone)
    const inChat = chatBrand(list, cut, chosen).id // what useCutalong's inChat / brandNow / Editor theme use
    const exported = brandOfCut(list, cut).id // what main's brandOfDoc uses for cut:render and cut:plan
    expect(cut.brand).toBeUndefined()
    expect(inChat).toBe('brand-1')
    expect(exported).toBe('brand-1')
  })
})
