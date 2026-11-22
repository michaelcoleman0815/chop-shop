import { metres } from './clock'
import { frameDistance, placeDistance } from './moments'
import type { Gps } from './schema'

/**
 * The scenes of a day: clips recorded close together, in one place, that
 * look alike. A new scene starts at a long gap in time, at a move of more
 * than a few hundred metres, or where the look changes and some time has
 * passed. A clip on its own between two parts of one scene, or close in time
 * and look to the scene next to it, joins it rather than standing alone.
 */

export interface SceneInput {
  id: string
  /** Seconds since 1970, clocks lined up; null when nothing places the clip. */
  at: number | null
  durationSec: number
  look: number[]
  gps: Gps | null
}

/** Over this long without a clip is a new part of the day. */
export const SCENE_GAP_SEC = 40 * 60
/** A palette this different, with a few minutes gone, is somewhere else. */
const NEW_LOOK = 0.3
/** Different enough to be somewhere else straight away. */
const OTHER_PLACE = 0.5
const SOME_TIME_SEC = 3 * 60
/** Further than this on the map is another place. */
const MOVED_M = 400

const centre = (looks: number[][]): number[] =>
  looks.length === 0 ? [] : looks[0].map((_, i) => looks.reduce((s, l) => s + (l[i] ?? 0), 0) / looks.length)

/** Clip ids grouped into scenes, in the order of the day. */
export function groupScenes(clips: SceneInput[]): string[][] {
  const order = [...clips].sort((a, b) => {
    // Clips nothing places keep the camera's own numbering.
    if (a.at === null && b.at === null) return a.id.localeCompare(b.id, undefined, { numeric: true })
    if (a.at === null) return 1
    if (b.at === null) return -1
    return a.at - b.at
  })
  const scenes: SceneInput[][] = []
  let place: Gps | null = null
  for (const c of order) {
    const scene = scenes[scenes.length - 1]
    const prev = scene?.[scene.length - 1]
    if (!scene || !prev) {
      scenes.push([c])
      place = c.gps
      continue
    }
    const gap = c.at !== null && prev.at !== null ? c.at - (prev.at + prev.durationSec) : 0
    // The scene's look so far: its last few clips, so a slow change of light is followed.
    const looks = scene.slice(-4).map((s) => s.look)
    const d = placeDistance(c.look, centre(looks))
    const moved = c.gps && place ? metres(c.gps, place) > MOVED_M : false
    // With no time on one of them, only where it looks to be, or is on the map, says it is somewhere else.
    const untimed = c.at === null || prev.at === null
    const fresh =
      gap > SCENE_GAP_SEC ||
      (moved && (gap > 60 || untimed)) ||
      (d > NEW_LOOK && (gap > SOME_TIME_SEC || untimed)) ||
      (d > OTHER_PLACE && gap > 30)
    if (fresh) {
      scenes.push([c])
      place = c.gps
    } else {
      scene.push(c)
      place = place ?? c.gps
    }
  }
  // A clip alone, close in time and look to a neighbouring scene, belongs to it.
  for (let k = 0; k < scenes.length; k++) {
    if (scenes[k].length !== 1 || scenes.length === 1) continue
    const c = scenes[k][0]
    const score = (other: SceneInput[] | undefined, before: boolean): number => {
      if (!other) return Infinity
      const edge = before ? other[other.length - 1] : other[0]
      const gap =
        c.at !== null && edge.at !== null ? Math.abs(before ? c.at - (edge.at + edge.durationSec) : edge.at - c.at) : 0
      if (gap > 15 * 60) return Infinity
      const d = placeDistance(c.look, centre(other.map((o) => o.look)))
      return d < NEW_LOOK ? d : Infinity
    }
    const left = score(scenes[k - 1], true)
    const right = score(scenes[k + 1], false)
    if (left === Infinity && right === Infinity) continue
    if (left <= right) scenes[k - 1].push(c)
    else scenes[k + 1].unshift(c)
    scenes.splice(k, 1)
    k--
  }
  return scenes.map((s) => s.map((c) => c.id))
}

/**
 * Near-identical takes: two clips of one scene, recorded within a few
 * minutes, with the same palette and the same framing, about as long as each
 * other. The better one stays; the others are said once and left out.
 */
export function findRepeats(
  clips: {
    id: string
    scene: string | null
    at: number | null
    durationSec: number
    look: number[]
    quality: number
    /** Repeats come from one camera, held the same way. */
    camera?: string
    shape?: number
  }[]
): Map<string, string> {
  const repeats = new Map<string, string>()
  const byScene = new Map<string, typeof clips>()
  for (const c of clips) if (c.scene) byScene.set(c.scene, [...(byScene.get(c.scene) ?? []), c])
  for (const list of byScene.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        if (repeats.has(a.id) || repeats.has(b.id)) continue
        const close = a.at === null || b.at === null || Math.abs(a.at - b.at) <= 6 * 60
        const ratio = Math.max(a.durationSec, b.durationSec) / Math.max(0.1, Math.min(a.durationSec, b.durationSec))
        if (!close || ratio > 2) continue
        if (a.camera !== b.camera || Math.abs((a.shape ?? 0) - (b.shape ?? 0)) > 0.05) continue
        if (placeDistance(a.look, b.look) > 0.06 || frameDistance(a.look, b.look) > 0.03) continue
        // The better take stays; on a tie, the first, and the repeat goes.
        const keepB =
          b.quality > a.quality + 0.02 || (Math.abs(b.quality - a.quality) <= 0.02 && (b.at ?? 0) < (a.at ?? 0))
        if (keepB) repeats.set(a.id, b.id)
        else repeats.set(b.id, a.id)
      }
    }
  }
  return repeats
}
