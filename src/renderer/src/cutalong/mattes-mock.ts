import { currentCut, resolveCut, type EditDoc } from '../../../shared/edit'
import type { CutoutKind, CutoutTrack } from '../../../shared/fx'
import { timelineFor } from '../../../shared/motion'
import { matteWants } from '../../../shared/tracks'

/**
 * The browser mock's cut-out of the person, standing in for the one Vision
 * makes on a Mac: the speaker in the sample footage (public/sample.mp4), head
 * and shoulders, drawn once as a grey mask. Given only to an edit whose
 * mattes want it, so the effects keep doing without one as they always have
 * here.
 */

let drawn: string | null = null

/** The speaker's shape in the sample, as a PNG: white where they are. */
function personMask(w: number, h: number): string {
  if (drawn) return drawn
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#FFFFFF'
  ctx.beginPath()
  ctx.ellipse(w * 0.6, h * 0.3, w * 0.17, h * 0.13, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  const body: [number, number][] = [
    [0.5, 0.4],
    [0.72, 0.4],
    [0.78, 0.48],
    [1, 0.56],
    [1, 1],
    [0.3, 1],
    [0.3, 0.6],
    [0.4, 0.5]
  ]
  body.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * w, y * h) : ctx.lineTo(x * w, y * h)))
  ctx.closePath()
  ctx.fill()
  drawn = c.toDataURL('image/png')
  return drawn
}

export function mockCutouts(raw: unknown): { tracks: CutoutTrack[]; missing: CutoutKind[] } {
  const doc = raw as EditDoc
  if (!doc?.sources?.length) return { tracks: [], missing: [] }
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const wants = matteWants(cut, timelineFor(cut, resolved, doc.words)).filter((w) => w.kind === 'person')
  const behind = (cut.motion ?? []).some((m) => (m.layers ?? []).some((l) => (l as { behind?: boolean }).behind))
  if (wants.length === 0 && !behind) return { tracks: [], missing: [] }
  const source = doc.sources[0]
  const w = 288
  const h = Math.round((w * (source.height || 16)) / (source.width || 9))
  const file = personMask(w, h)
  const mask = { id: 1, file, box: [0.3, 0.17, 0.7, 0.83] as [number, number, number, number] }
  return {
    tracks: [{ path: source.path, kind: 'person', width: w, height: h, samples: [{ t: 0, masks: [mask] }, { t: source.durationSec, masks: [mask] }] }],
    missing: []
  }
}
