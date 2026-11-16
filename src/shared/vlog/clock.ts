import type { Gps } from './schema'
import { placeDistance } from './moments'

/**
 * When each clip was really recorded. Phones set their clocks from the
 * network; an action camera or a drone often has its clock hours off (a
 * time zone never set) or years off (a clock that was never set), and some
 * files carry no time at all. Ordering by the times the files give would
 * put the GoPro's morning after the phone's evening.
 *
 * The camera with the most clips is taken as right. Another camera's clips
 * are matched with the reference camera's by where they were (the same
 * palette, the same place on the map): when two or more matches agree on how
 * far apart the clocks are, that camera's clips all move by it. A clip with
 * no time, or from a camera that matches nothing, goes with the clips it
 * looks like; failing that, it keeps its place among its own camera's files.
 */

export interface ClockInput {
  id: string
  name: string
  camera: string
  recordedAt: string | null
  durationSec: number
  look: number[]
  gps: Gps | null
}

export interface ClockResult {
  /** Seconds since 1970, clocks lined up; null when nothing places the clip. */
  at: Map<string, number | null>
  /** What each camera's clock was moved by. */
  fixes: { camera: string; offsetSec: number; clips: number }[]
  /** Clips placed by their look, having no usable time of their own. */
  placed: string[]
  /** One sentence for each fix and each placed clip. */
  notes: string[]
}

/** Two clips this alike in palette were most likely recorded in the same place. */
const SAME_PLACE = 0.12
/** Clocks closer than this are the same clock: nobody notices ten minutes. */
const MIN_FIX_SEC = 10 * 60
/** Matches that agree within this are one offset. */
const AGREE_SEC = 30 * 60
/** A camera whose clips are all this far from the reference's day is off by days, not hours. */
const FAR_SEC = 2 * 24 * 3600

const parse = (iso: string | null): number | null => {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms / 1000 : null
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Metres between two places. */
export function metres(a: Gps, b: Gps): number {
  const r = 6371000
  const toRad = Math.PI / 180
  const dLat = (b.lat - a.lat) * toRad
  const dLon = (b.lon - a.lon) * toRad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** "7 hours", "2 hours 15 minutes", "40 minutes", "3 days". */
export function spanWords(sec: number): string {
  const s = Math.abs(sec)
  if (s >= 2 * 86400) return `${Math.round(s / 86400)} days`
  const total = Math.round(s / 60)
  const h = Math.floor(total / 60)
  const m = total - h * 60
  const hours = h === 1 ? '1 hour' : `${h} hours`
  const minutes = m === 1 ? '1 minute' : `${m} minutes`
  if (h === 0) return minutes
  return m === 0 ? hours : `${hours} ${minutes}`
}

export function lineUpClocks(clips: ClockInput[]): ClockResult {
  const own = new Map(clips.map((c) => [c.id, parse(c.recordedAt)]))
  const byCamera = new Map<string, ClockInput[]>()
  for (const c of clips) byCamera.set(c.camera, [...(byCamera.get(c.camera) ?? []), c])
  const timedCount = (list: ClockInput[]): number => list.filter((c) => own.get(c.id) !== null).length
  const cameras = [...byCamera.entries()].sort((a, b) => timedCount(b[1]) - timedCount(a[1]))
  const at = new Map<string, number | null>()
  const fixes: ClockResult['fixes'] = []
  const notes: string[] = []
  if (cameras.length === 0) return { at, fixes, placed: [], notes }

  const [refCamera, refClips] = cameras[0]
  const reference = refClips.filter((c) => own.get(c.id) !== null)
  for (const c of refClips) at.set(c.id, own.get(c.id) ?? null)
  const refTimes = reference.map((c) => own.get(c.id) as number)
  const refMid = refTimes.length ? median(refTimes) : null

  for (const [camera, list] of cameras.slice(1)) {
    const timed = list.filter((c) => own.get(c.id) !== null)
    // Matches with the reference by place: each says how far this clock is off.
    const offsets: number[] = []
    for (const c of timed) {
      let best: { d: number; t: number } | null = null
      for (const r of reference) {
        const d = placeDistance(c.look, r.look)
        const near = c.gps && r.gps ? metres(c.gps, r.gps) < 300 : null
        if (near === false) continue
        if (d < SAME_PLACE && (!best || d < best.d)) best = { d, t: own.get(r.id) as number }
      }
      if (best) offsets.push(best.t - (own.get(c.id) as number))
    }
    let offset: number | null = null
    if (offsets.length >= 2) {
      const m = median(offsets)
      const agreeing = offsets.filter((o) => Math.abs(o - m) <= AGREE_SEC)
      if (agreeing.length >= Math.max(2, offsets.length / 2)) offset = median(agreeing)
    }
    const far =
      refMid !== null && timed.length > 0 && timed.every((c) => Math.abs((own.get(c.id) as number) - refMid) > FAR_SEC)
    if (offset !== null && Math.abs(offset) >= MIN_FIX_SEC) {
      // A clock off by a time zone is off by whole hours, or halves: within a few
      // minutes of one, that is what it is.
      const half = Math.round(offset / 1800) * 1800
      const fix = Math.abs(offset - half) <= 6 * 60 ? half : Math.round(offset)
      for (const c of list) {
        const t = own.get(c.id)
        at.set(c.id, t === null || t === undefined ? null : t + fix)
      }
      fixes.push({ camera, offsetSec: fix, clips: timed.length })
      notes.push(
        `${capital(cameraName(camera))}'s clock was ${spanWords(fix)} ${fix > 0 ? 'behind' : 'ahead of'} ${cameraName(refCamera)}'s, so I moved its ${timed.length === 1 ? 'clip' : `${timed.length} clips`} to when they really happened.`
      )
    } else if (far && offset === null) {
      // Days away from everything else and matching nothing: its clock was never set.
      for (const c of list) at.set(c.id, null)
    } else {
      for (const c of list) at.set(c.id, own.get(c.id) ?? null)
    }
  }

  // Clips with nothing to place them go with the timed clips they look most like.
  const placed: string[] = []
  const timedNow = clips.filter((c) => at.get(c.id) !== null && at.get(c.id) !== undefined)
  const unplaced = clips.filter((c) => at.get(c.id) === null || at.get(c.id) === undefined)
  // Among themselves they keep their file order.
  unplaced.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  let lastPlaced: number | null = null
  for (const c of unplaced) {
    let best: { d: number; t: number } | null = null
    for (const r of timedNow) {
      const d = placeDistance(c.look, r.look)
      if (d < SAME_PLACE && (!best || d < best.d)) best = { d, t: (at.get(r.id) as number) + r.durationSec }
    }
    if (best) {
      at.set(c.id, best.t + 1)
      lastPlaced = best.t + 1
    } else if (lastPlaced !== null) {
      // Next to the clip before it in the camera's own numbering.
      lastPlaced += c.durationSec + 1
      at.set(c.id, lastPlaced)
    } else if (timedNow.length > 0) {
      const end = Math.max(...timedNow.map((r) => (at.get(r.id) as number) + r.durationSec))
      lastPlaced = end + 60
      at.set(c.id, lastPlaced)
    }
    placed.push(c.id)
  }
  const untimed = unplaced.filter((c) => own.get(c.id) === null)
  if (untimed.length > 1 && untimed.length === clips.length)
    notes.push(
      `None of the ${untimed.length} clips has a recording time, so they go in the order of their names, in scenes by how they look.`
    )
  else if (untimed.length === 1)
    notes.push(`${untimed[0].name} has no recording time, so it goes with the clips that look like it.`)
  else if (untimed.length > 1)
    notes.push(`${untimed.length} clips have no recording time, so they go with the clips they look like.`)
  return { at, fixes, placed, notes }
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** A camera as a person names it: "your GoPro", "your iPhone 15 Pro", "your other camera". */
export function cameraName(camera: string): string {
  if (!camera || camera === 'camera') return 'your other camera'
  // File families are not names: IMG is a phone's way of naming files.
  if (/^[A-Z]{2,4}$/.test(camera) && !['DJI'].includes(camera)) return `your ${camera} camera`
  return `your ${camera.replace(/^Apple /, '')}`
}
