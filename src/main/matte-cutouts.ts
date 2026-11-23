import type { Cut, Resolved, Source, Word } from '../shared/edit'
import { cutoutView, type CutoutTrack } from '../shared/fx'
import { createCanvas } from '@napi-rs/canvas'
import { designSize, timelineFor, type DrawResources } from '../shared/motion'
import { cutoutMattes, matteWants } from '../shared/tracks/mattes'
import { stretchesFor, type CutoutNeed } from './cutout'
import { loadMasks } from './fx-render'

/**
 * The cut-outs the layer tracks' mattes and the graphics drawn behind the
 * person want (shared/tracks/mattes), as stretches of the recordings for
 * Vision to cut out (main/cutout, through fx-ipc's cutoutsFor), and, once
 * made, as the export's mattes: the same masks the preview draws from, placed
 * in the frame the same way.
 */

/** What to cut out for the edit's mattes: only what each stretch that wants one shows. */
export function matteNeeds(cut: Cut, resolved: Resolved, words: Word[], sources: Source[]): CutoutNeed[] {
  const wants = matteWants(cut, timelineFor(cut, resolved, words))
  return wants.length > 0 ? stretchesFor(cut, resolved, sources, wants, true) : []
}

/** The export's mattes from the cut-outs made for it; none when there are none. */
export async function exportMattes(
  cut: Cut,
  resolved: Resolved,
  sources: Source[],
  tracks: CutoutTrack[] | undefined
): Promise<DrawResources['mattes'] | undefined> {
  if (!tracks || tracks.length === 0) return undefined
  const first = sources.find((s) => s.id === resolved.pieces[0]?.source) ?? sources[0]
  if (!first) return undefined
  const view = cutoutView({ cut, resolved, sources, frame: designSize(cut.aspect, first), tracks, loaded: await loadMasks(tracks) })
  return cutoutMattes(view, (w, h) => createCanvas(w, h) as unknown as ReturnType<NonNullable<DrawResources['createCanvas']>>)
}
