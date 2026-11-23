import { sceneWithPaths } from '../three/spec'
import type { TrackClip } from './schema'

/**
 * What a clip's `src` names: a file on this computer by its path, or the
 * edit's own material by id (an asset, a2; a recording, s2), the way the
 * planner knows it. Resolved where the clip is drawn or heard, so a clip made
 * by name plays the file the edit holds.
 */

export interface ClipMedia {
  path: string
  /** How long it runs, when known. */
  durationSec: number | null
}

/** The edit's material by id: assets and recordings. */
export function mediaOf(
  assets: { id: string; path: string; durationSec?: number | null }[],
  sources: { id: string; path: string; durationSec: number }[]
): Map<string, ClipMedia> {
  const out = new Map<string, ClipMedia>()
  for (const s of sources) out.set(s.id, { path: s.path, durationSec: s.durationSec })
  for (const a of assets) out.set(a.id, { path: a.path, durationSec: a.durationSec ?? null })
  return out
}

/** Whether a src names material by id rather than a path. */
export const isMediaId = (src: string): boolean => /^[A-Za-z][A-Za-z0-9_]*$/.test(src) && !src.includes('/')

/** The clip with its src as a path, and its file's length filled in when the edit knows it. */
export function resolveClip(clip: TrackClip, media?: Map<string, ClipMedia>): TrackClip {
  // A 3D clip's cards and models name material the same way.
  if (clip.scene && media) clip = { ...clip, scene: sceneWithPaths(clip.scene, (id) => (isMediaId(id) ? media.get(id)?.path : undefined)) }
  if (!clip.src || !media || !isMediaId(clip.src)) return clip
  const m = media.get(clip.src)
  if (!m) return clip
  return { ...clip, src: m.path, ...(clip.fileSec === undefined && m.durationSec ? { fileSec: m.durationSec } : {}) }
}
