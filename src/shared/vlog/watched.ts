import type { Gps } from './schema'
import type { Heard } from './sound'

/**
 * What watching a clip measured (main/vlog-watch), as it is cached beside
 * the file: the file's own facts, the picture eight times a second, and the
 * sound half a second at a time. Everything the shoot is made of downstream
 * (moments, scenes, the story) is worked out from this alone, so the same
 * logic runs on a test's invented measurements and in the browser mock.
 */

export interface ClipSeries {
  /** Seconds between measures. */
  hopSec: number
  /** The size the frames were measured at. */
  width: number
  height: number
  luma: number[]
  sat: number[]
  sharp: number[]
  dx: number[]
  dy: number[]
  diff: number[]
  change: number[]
  /** The framing once a second: 3x3 mean red, green and blue, 0 to 1. */
  grid: number[][]
  /** The palette once a second: shares of eight hues and four greys (shared/vlog/frames). */
  palette: number[][]
  /** Brightness on an 8x8 grid once a second. */
  thumb: number[][]
}

export interface WatchedClip {
  v: number
  path: string
  name: string
  durationSec: number
  /** Shown size, after any rotation the camera recorded. */
  width: number
  height: number
  rotation: number
  fps: number
  color: 'sdr' | 'hlg' | 'pq'
  hasVideo: boolean
  hasAudio: boolean
  recordedAt: string | null
  /**
   * The camera's time zone, in minutes east of UTC, when it gave one with
   * its time; null when it gave none; absent in a clip watched before it was
   * read (main/vlog-watch reads it then).
   */
  zoneMin?: number | null
  camera: string
  gps: Gps | null
  /** Null for a file with no picture. */
  series: ClipSeries | null
  /** Null for a file with no sound, or sound that could not be read. */
  heard: Heard | null
  /** The largest face's width as a share of the frame, once a second; null where faces were not looked for. */
  faces: { t: number; share: number }[] | null
}
