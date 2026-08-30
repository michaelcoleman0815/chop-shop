import type { Timeline, TimelineClip } from './types'

/** Shared so the renderer's timeline and the renderer of record agree. */
export function clipLength(clip: TimelineClip): number {
  return Math.max(0, clip.sourceOutSec - clip.sourceInSec)
}

export function timelineDuration(timeline: Timeline): number {
  return timeline.clips.reduce((end, c) => Math.max(end, c.timelineStartSec + clipLength(c)), 0)
}

/** The clip visible at a moment, from the topmost track that covers it. */
export function clipAt(timeline: Timeline, atSec: number): TimelineClip | null {
  const covering = timeline.clips.filter(
    (c) => atSec >= c.timelineStartSec && atSec < c.timelineStartSec + clipLength(c)
  )
  if (covering.length === 0) return null
  return covering.reduce((top, c) => (c.track > top.track ? c : top))
}

export type MediaKind = 'video' | 'audio' | 'image'

/**
 * Clip colour follows the source media, not the track it sits on, which is how
 * Premiere does it: the linked audio of a video clip stays the video's colour,
 * so a glance down a track tells you what the material is.
 */
export function mediaKind(path: string): MediaKind {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  if (['mp3', 'm4a', 'aac', 'wav', 'aiff', 'flac', 'ogg'].includes(ext)) return 'audio'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) return 'image'
  return 'video'
}
