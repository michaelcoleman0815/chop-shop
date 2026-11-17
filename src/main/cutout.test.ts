import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript } from '../shared/edit'
import { buildFxScene } from '../shared/fx'
import { covered, cutoutNeeds, findCutouts, missing, readCutouts, visionHelper, type CutoutRequest } from './cutout'
import { OBJECTS, SHAPE_CLIP, shapeHelper } from './fx-shapes'

/**
 * Cut-outs: asked of the helper only where they are not kept yet, kept by the
 * file, objects followed into steady ids across every pass, and asked for
 * only where an effect that uses them shows the speaker.
 */

let dir = ''
let clip = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cutalong-cutout-'))
  // The helper never reads the file; the cache keys on it, so it must be there.
  clip = join(dir, 'shapes.mp4')
  writeFileSync(clip, 'not really a video')
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('what is kept and what is missing', () => {
  it('reads stretches from the samples, a gap over twice the spacing ending one', () => {
    const samples = [0, 0.1, 0.2, 0.3, 1, 1.1].map((t) => ({ t, masks: [] }))
    const track = { path: 'a', kind: 'person' as const, width: 1, height: 1, samples }
    expect(covered(track, 10)).toEqual([
      { from: 0, to: 0.3 },
      { from: 1, to: 1.1 }
    ])
    expect(covered(null, 10)).toEqual([])
  })

  it('leaves out what is kept, to a sample', () => {
    const have = [
      { from: 0, to: 2 },
      { from: 3, to: 4 }
    ]
    expect(missing(have, 0.5, 1.5, 10)).toEqual([])
    expect(missing(have, 1, 3.5, 10)).toEqual([{ from: 2, to: 3 }])
    expect(missing(have, 3.5, 6, 10)).toEqual([{ from: 4, to: 6 }])
    expect(missing([], 1, 2, 10)).toEqual([{ from: 1, to: 2 }])
  })
})

describe('finding cut-outs', () => {
  it('asks only for what it has not kept, and keeps one id per object across passes', async () => {
    const asked: CutoutRequest[] = []
    const helper = shapeHelper(asked)
    const cache = join(dir, 'cache-objects')
    const first = await findCutouts({ dir: cache, helper, path: clip, kind: 'objects', from: 0, to: 2 })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: 'objects', startSec: 0, rate: 6 })
    expect(first.samples.length).toBeGreaterThanOrEqual(12)

    // Overlapping the kept stretch: only the rest is asked for.
    const second = await findCutouts({ dir: cache, helper, path: clip, kind: 'objects', from: 1, to: 3 })
    expect(asked).toHaveLength(2)
    expect(asked[1].startSec).toBeCloseTo(2, 1)
    expect(second.samples[second.samples.length - 1].t).toBeGreaterThan(2.8)

    // Inside what is kept: nothing is asked.
    await findCutouts({ dir: cache, helper, path: clip, kind: 'objects', from: 0.5, to: 2.5 })
    expect(asked).toHaveLength(2)

    // Vision numbers the objects afresh in every picture; each keeps one id through both passes.
    const ids = new Set(second.samples.flatMap((s) => s.masks.map((m) => m.id)))
    expect(ids.size).toBe(OBJECTS.length)
    for (const s of second.samples) {
      const left = s.masks.reduce((a, m) => (m.box[0] < a.box[0] ? m : a))
      expect(left.id).toBe(second.samples[0].masks.reduce((a, m) => (m.box[0] < a.box[0] ? m : a)).id)
    }

    // Kept by the file: read back as it was written.
    const kept = await readCutouts(cache, clip, 'objects')
    expect(kept?.samples.length).toBe(second.samples.length)
  })

  it('keeps the person apart from the objects', async () => {
    const cache = join(dir, 'cache-both')
    const helper = shapeHelper()
    await findCutouts({ dir: cache, helper, path: clip, kind: 'person', from: 0, to: 1 })
    expect(await readCutouts(cache, clip, 'person')).not.toBeNull()
    expect(await readCutouts(cache, clip, 'objects')).toBeNull()
  })
})

describe('the Mac helper', () => {
  it('has nothing when it is missing or older than cut-outs', async () => {
    expect(await visionHelper(join(dir, 'nowhere')).can()).toEqual({ person: false, objects: false })
    const old = join(dir, 'old-vision')
    writeFileSync(old, '#!/bin/sh\necho "usage: chopshop-vision <video>" >&2\nexit 2\n')
    chmodSync(old, 0o755)
    expect(await visionHelper(old).can()).toEqual({ person: false, objects: false })
  })

  it('says what this computer can cut out', async () => {
    const bin = join(dir, 'vision')
    writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--masks-check" ]; then echo \'{"person":true,"objects":false}\'; exit 0; fi\nexit 1\n')
    chmodSync(bin, 0o755)
    expect(await visionHelper(bin).can()).toEqual({ person: true, objects: false })
  })
})

describe('what the effects want cut out', () => {
  const words = wordsFromTranscript(
    ['Here', 'it', 'comes', 'and', 'he', 'lands', 'right', 'there.'].map((text, i) => ({
      text,
      startSec: 0.2 + i * 0.45,
      endSec: 0.5 + i * 0.45
    })),
    's1'
  )
  const needsFor = (ops: unknown[]) => {
    const source = { id: 's1', path: '/shapes.mp4', durationSec: SHAPE_CLIP.sec, width: 360, height: 640, fps: 30 }
    const doc = createDoc({ id: 'd', title: 'Shapes', source, words })
    const r = applyOps(currentCut(doc), [{ op: 'aspect', aspect: 'original' }, ...ops], { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
    const resolved = resolveCut(r.cut, doc.words, doc.sources)
    const scene = buildFxScene({ cut: r.cut, resolved, words: doc.words, sources: doc.sources, size: { width: 360, height: 640 }, fps: 30 })
    return cutoutNeeds(r.cut, resolved, doc.sources, scene.plans)
  }

  it('asks for objects for a scan of them, and the person for a blur behind them', () => {
    const needs = needsFor([
      { op: 'fx-add', kind: 'scan', from: 'w1' },
      { op: 'fx-add', kind: 'bgblur', from: 'w5' }
    ])
    expect(needs.map((n) => n.kind).sort()).toEqual(['objects', 'person'])
    const scan = needs.find((n) => n.kind === 'objects')
    // The scan's span, a little either side.
    expect(scan?.from).toBeLessThan(0.2)
    expect(scan?.to).toBeGreaterThan(1.6)
  })

  it('asks for nothing for an effect on the whole frame, or one that needs no cut-out', () => {
    expect(
      needsFor([
        { op: 'fx-add', kind: 'scan', from: 'w1', on: 'frame' },
        { op: 'fx-add', kind: 'speedlines', from: 'w3' }
      ])
    ).toEqual([])
  })

  it('merges what touches into one stretch per kind', () => {
    const needs = needsFor([
      { op: 'fx-add', kind: 'bgblur', from: 'w1', to: 'w3' },
      { op: 'fx-add', kind: 'impact', from: 'w4' }
    ])
    expect(needs).toHaveLength(1)
    expect(needs[0].kind).toBe('person')
  })
})
