import { anchorTime, spanFor, type Timeline } from '../motion/timing'
import { resolveClip, type ClipMedia } from './media'
import type { Track, TrackClip } from './schema'

/**
 * Clips on the edit's clock. A clip starts on its anchor and runs to its own
 * end anchor, a length, or its natural length: what is left of its file at its
 * speed, or five seconds for a still, a title or a solid. A clip whose start
 * is not in the cut (its word was struck with its whole beat) is not placed.
 */

/** Seconds a still, a title or a solid lasts when nothing says otherwise. */
export const STILL_SEC = 5

/** How long a clip plays, in the edit's seconds, when nothing else says. */
export function naturalSec(clip: TrackClip, editSec: number): number {
  if (clip.kind === 'video' || clip.kind === 'sound') {
    if (clip.fileSec !== undefined) return Math.max(0.05, (clip.fileSec - clip.in) / clip.speed)
    return Math.max(0.05, editSec)
  }
  return STILL_SEC
}

export interface Span {
  start: number
  end: number
}

/** Where a clip plays on the edit, or null when its start is not in the cut. */
export function clipSpan(tl: Timeline, clip: TrackClip): Span | null {
  const span = spanFor(tl, clip.from, clip.to, naturalSec(clip, tl.duration))
  return span ? { start: span.start, end: span.end } : null
}

export interface Placed {
  clip: TrackClip
  track: Track
  /** The track's place in the stack, 0 the lowest. */
  depth: number
  start: number
  end: number
}

/** The tracks of a cut: none in one made before there were any. */
export function tracksOf(cut: { tracks?: Track[] }): Track[] {
  return cut.tracks ?? []
}

/**
 * Every clip that plays, lowest track first and, on a track, in time order.
 * For the picture, hidden tracks are left out; for the sound, muted ones, and
 * when any track of that kind is soloed, every one that is not.
 */
export function placeClips(tracks: Track[], tl: Timeline, kind?: Track['kind'], media?: Map<string, ClipMedia>): Placed[] {
  const soloed = (k: Track['kind']): boolean => tracks.some((t) => t.solo && t.kind === k)
  const out: Placed[] = []
  tracks.forEach((track, depth) => {
    if (kind && track.kind !== kind) return
    if (track.kind === 'picture' ? track.hidden : track.mute) return
    if (soloed(track.kind) && !track.solo) return
    const placed: Placed[] = []
    for (const named of track.clips) {
      const clip = resolveClip(named, media)
      const span = clipSpan(tl, clip)
      if (span) placed.push({ clip, track, depth, ...span })
    }
    out.push(...placed.sort((a, b) => a.start - b.start))
  })
  return out
}

/** The clips that make a sound: sound clips, and video clips' own sound unless the clip or its track is muted. */
export function soundingClips(tracks: Track[], tl: Timeline, media?: Map<string, ClipMedia>): Placed[] {
  const sounds = placeClips(tracks, tl, 'sound', media)
  const videos = placeClips(tracks, tl, 'picture', media).filter((p) => p.clip.kind === 'video' && !p.clip.muted && !p.track.mute)
  return [...sounds, ...videos]
}

/** The output time an anchor lands on, or null. */
export function timeOf(tl: Timeline, ref: string): number | null {
  return anchorTime(tl, ref)
}
