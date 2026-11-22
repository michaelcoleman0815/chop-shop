import { isKeyed, num } from '../shared/anim'
import type { Resolved } from '../shared/edit/resolve'
import type { Cut, Source, Word } from '../shared/edit/schema'
import { timelineFor } from '../shared/motion/timing'
import { mediaOf, soundingClips, trackLayers, tracksOf } from '../shared/tracks'
import { frameSize, type ClipSoundOptions } from './cut-render'

/**
 * What the layer tracks give the export without a canvas: the clips that
 * sound, placed for the final pass to mix with the voice, and whether any
 * clip would be drawn over the picture at all. The Mac draws the pictures
 * (layers-render.ts); a phone, whose export has no canvas, mixes the sounds
 * and says the pictures are on the Mac. Nothing here draws, so it runs on both.
 */

export interface LayerSoundsInput {
  cut: Cut
  resolved: Resolved
  words: Word[]
  sources: Source[]
  /** The edit's material, for clips that name it by id. */
  assets?: { id: string; path: string; durationSec?: number | null }[]
}

/** The clips that sound, in the mix's terms. `hasSound` says whether a video file carries any. */
export async function clipSounds(input: LayerSoundsInput, hasSound: (path: string) => Promise<boolean>): Promise<ClipSoundOptions[]> {
  const tracks = tracksOf(input.cut)
  if (tracks.every((t) => t.clips.length === 0)) return []
  const tl = timelineFor(input.cut, input.resolved, input.words)
  const sounds: ClipSoundOptions[] = []
  const heard = new Map<string, boolean>()
  for (const p of soundingClips(tracks, tl, mediaOf(input.assets ?? [], input.sources))) {
    const src = p.clip.src
    if (!src) continue
    // A video with no sound in its file has none to give.
    if (p.clip.kind === 'video') {
      if (!heard.has(src)) heard.set(src, await hasSound(src))
      if (!heard.get(src)) continue
    }
    const volume = p.clip.volume
    sounds.push({
      path: src,
      startSec: p.start,
      durationSec: p.end - p.start,
      inSec: p.clip.in,
      speed: p.clip.speed,
      gainDb: isKeyed(volume) ? 0 : num(volume, 0, p.end - p.start, 0),
      keys: isKeyed(volume) ? volume.keys.map((k) => ({ t: p.start + k.t, db: k.v })) : []
    })
  }
  return sounds
}

/** Whether any clip on a picture track that shows would be drawn over the picture. */
export function drawsOverPicture(input: LayerSoundsInput): boolean {
  const tracks = tracksOf(input.cut)
  if (!tracks.some((t) => t.kind === 'picture' && t.clips.length > 0)) return false
  const tl = timelineFor(input.cut, input.resolved, input.words)
  const first = input.sources.find((s) => s.id === input.resolved.pieces[0]?.source) ?? input.sources[0]
  const design = frameSize(input.cut.aspect, first)
  return trackLayers(input.cut, tl, design, mediaOf(input.assets ?? [], input.sources)).length > 0
}
