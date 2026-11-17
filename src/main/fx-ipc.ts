import { app, ipcMain } from 'electron'
import { join } from 'path'
import { currentCut, EditDocSchema, resolveCut, type Cut, type Resolved, type Source, type Word } from '../shared/edit'
import { effectsOf, type CutoutKind, type CutoutTrack } from '../shared/fx'
import { designSize } from '../shared/motion'
import { frameRate } from './cut-render'
import { cutoutNeeds, findCutouts, visionHelper, type CutoutHelper } from './cutout'
import { FFMPEG_PATH } from './ffmpeg'
import { fxSceneFor, renderCutFx, type CutFx } from './fx-render'
import { VISION_PATH } from './track'

/**
 * Scene effects' half of the main process: what this computer can cut out,
 * the cut-outs an edit's effects want (made by Vision on a Mac, and kept),
 * and the effects' files for an export. The editor's preview draws the same
 * effects from the same cut-outs (renderer FxLayers).
 */

const cutoutsDir = (): string => join(app.getPath('userData'), 'cutouts')

let helper: CutoutHelper | null = null
const cutoutHelper = (): CutoutHelper => (helper ??= visionHelper(VISION_PATH()))

/** The first recording the cut shows: its shape and rate are the edit's. */
function firstSource(resolved: Resolved, sources: Source[]): Source | undefined {
  return sources.find((s) => s.id === resolved.pieces[0]?.source) ?? sources[0]
}

/**
 * The cut-outs an edit's effects want: made where they are missing and this
 * computer can make them, read where they are kept. What could not be had is
 * named, so the effects that wanted it do their version without one.
 */
export async function cutoutsFor(
  cut: Cut,
  resolved: Resolved,
  words: Word[],
  sources: Source[],
  signal?: AbortSignal
): Promise<{ tracks: CutoutTrack[]; missing: CutoutKind[] }> {
  if (effectsOf(cut).length === 0) return { tracks: [], missing: [] }
  const first = firstSource(resolved, sources)
  if (!first) return { tracks: [], missing: [] }
  const scene = fxSceneFor({ cut, resolved, words, sources }, designSize(cut.aspect, first), frameRate(first.fps ?? 30))
  const needs = cutoutNeeds(cut, resolved, sources, scene.plans)
  if (needs.length === 0) return { tracks: [], missing: [] }
  const can = await cutoutHelper().can()
  const kept = new Map<string, CutoutTrack>()
  const missing = new Set<CutoutKind>()
  for (const need of needs) {
    if (!can[need.kind]) {
      missing.add(need.kind)
      continue
    }
    try {
      const track = await findCutouts({ dir: cutoutsDir(), helper: cutoutHelper(), ...need, signal })
      // A later stretch of the same recording comes back with the earlier ones in it.
      kept.set(`${need.path}\n${need.kind}`, track)
    } catch (err) {
      console.warn(`[fx] no ${need.kind} cut-out of ${need.path}:`, err instanceof Error ? err.message : err)
      missing.add(need.kind)
    }
  }
  return { tracks: [...kept.values()], missing: [...missing] }
}

/** An export's scene effects, as cut-render reads them; null when the edit has none. */
export async function renderEditFx(opts: {
  cut: Cut
  resolved: Resolved
  words: Word[]
  sources: Source[]
  quality: 'preview' | 'final'
  workDir: string
  onProgress?: (fraction: number) => void
}): Promise<{ passes: CutFx['passes']; overlays: CutFx['overlays'] } | null> {
  if (effectsOf(opts.cut).length === 0) return null
  const { tracks } = await cutoutsFor(opts.cut, opts.resolved, opts.words, opts.sources)
  const fx = await renderCutFx({ ...opts, ffmpeg: FFMPEG_PATH, tracks })
  return fx.passes.length + fx.overlays.length > 0 ? { passes: fx.passes, overlays: fx.overlays } : null
}

export function registerFxIpc(mediaUrlFor: (path: string) => string): void {
  // What this computer can cut out; none off a Mac, or on one too old for it.
  ipcMain.handle('fx:can', () => cutoutHelper().can())

  // The cut-outs the preview draws an edit's effects from, each mask as the window loads it.
  ipcMain.handle('fx:cutouts', async (_e, req: { doc: unknown }) => {
    const parsed = EditDocSchema.safeParse(req.doc)
    if (!parsed.success) return { tracks: [], missing: [] }
    const doc = parsed.data
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const { tracks, missing } = await cutoutsFor(cut, resolved, doc.words, doc.sources)
    return {
      tracks: tracks.map((t) => ({
        ...t,
        samples: t.samples.map((s) => ({ ...s, masks: s.masks.map((m) => ({ ...m, file: mediaUrlFor(m.file) })) }))
      })),
      missing
    }
  })
}
