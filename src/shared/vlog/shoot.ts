import { lineUpClocks } from './clock'
import { lookOf, readClip, sharpnessOf, type MomentDraft } from './moments'
import { findRepeats, groupScenes } from './scenes'
import { isTalking } from './sound'
import type { Clip, LeftOut, Moment, Scene } from './schema'
import type { WatchedClip } from './watched'

/**
 * A shoot, understood from what watching measured: every clip placed in the
 * day with camera clocks lined up, grouped into scenes, its usable stretches
 * and moments found, near-identical takes collapsed, and the talking clips
 * marked to be heard word by word. Pure, so it runs the same on a test's
 * invented clips, in the browser mock and in the main process.
 */

export interface ShootPart {
  clips: Clip[]
  moments: Moment[]
  scenes: Scene[]
  /** Clock fixes and clips placed by their look, in sentences. */
  clockNotes: string[]
}

export interface AssembleOptions {
  /** Source ids already given to files, kept as they are: a shoot added to keeps its ids. */
  ids?: Map<string, string>
  /** The next source number to give a new clip: s{n}. */
  nextSource?: number
  /** The next moment number. */
  nextMoment?: number
  /** The next scene number. */
  nextScene?: number
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000

/** Clips that are out whatever their scene: nothing in them to show. */
const OUTRIGHT: string[] = ['pocket', 'dark', 'short', 'unreadable']

/**
 * The shoot from its watched clips. Clips are numbered in the order of the
 * day; a clip left out gets a c-number instead of a source id, since it never
 * becomes part of the edit.
 */
export function assembleShoot(watched: WatchedClip[], opts: AssembleOptions = {}): ShootPart {
  const pictures = watched.filter((w) => w.hasVideo && w.series)
  const looks = new Map(pictures.map((w) => [w.path, lookOf(w.series)]))
  const clock = lineUpClocks(
    pictures.map((w) => ({
      id: w.path,
      name: w.name,
      camera: w.camera,
      recordedAt: w.recordedAt,
      durationSec: w.durationSec,
      look: looks.get(w.path) ?? [],
      gps: w.gps
    }))
  )
  const atOf = (w: WatchedClip): number | null => clock.at.get(w.path) ?? null

  // Scenes first on the whole clips, so each clip's sharpness is judged against
  // its scene's best. A pocket recording or a black clip says nothing about
  // where the day went: it joins the scene nearest in time afterwards.
  const outright = new Set(
    pictures.filter((w) => OUTRIGHT.includes(readClip(w).left ?? 'short-of-nothing')).map((w) => w.path)
  )
  const first = groupScenes(
    pictures
      .filter((w) => !outright.has(w.path))
      .map((w) => ({ id: w.path, at: atOf(w), durationSec: w.durationSec, look: looks.get(w.path) ?? [], gps: w.gps }))
  )
  for (const w of pictures.filter((p) => outright.has(p.path))) {
    const t = atOf(w)
    let best = first.length - 1
    let gap = Infinity
    first.forEach((paths, k) => {
      for (const p of paths) {
        const other = pictures.find((x) => x.path === p)
        const u = other ? atOf(other) : null
        if (t !== null && u !== null && Math.abs(t - u) < gap) {
          gap = Math.abs(t - u)
          best = k
        }
      }
    })
    if (best < 0) first.push([w.path])
    else first[best].push(w.path)
  }
  const sceneOf = new Map<string, number>()
  first.forEach((paths, k) => paths.forEach((p) => sceneOf.set(p, k)))
  const sharpRef = first.map((paths) => {
    const values = paths
      .map((p) => sharpnessOf(pictures.find((w) => w.path === p)?.series ?? null))
      .filter((v) => v > 0)
      .sort((a, b) => a - b)
    return values.length ? values[Math.floor(0.75 * (values.length - 1))] : 0
  })

  const readings = new Map(pictures.map((w) => [w.path, readClip(w, { sharpRef: sharpRef[sceneOf.get(w.path) ?? 0] })]))
  // The look again, over the usable stretches only: a dark start does not make a different place.
  for (const w of pictures) {
    const usable = readings.get(w.path)?.usable ?? []
    if (usable.length) looks.set(w.path, lookOf(w.series, usable))
  }
  const quality = (w: WatchedClip): number => {
    const ms = readings.get(w.path)?.moments ?? []
    return ms.length
      ? ms.reduce((s, m) => s + m.quality * (m.outSec - m.inSec), 0) / ms.reduce((s, m) => s + m.outSec - m.inSec, 0)
      : 0
  }
  const repeats = findRepeats(
    pictures
      .filter((w) => !readings.get(w.path)?.left && !isTalking(w.heard ?? { speechSec: 0 }, w.durationSec))
      .map((w) => ({
        id: w.path,
        scene: String(sceneOf.get(w.path) ?? ''),
        at: atOf(w),
        durationSec: w.durationSec,
        look: looks.get(w.path) ?? [],
        quality: quality(w),
        camera: w.camera,
        shape: w.height > 0 ? w.width / w.height : 0
      }))
  )
  const keeper = (path: string): string => {
    let p = path
    for (let guard = 0; guard < 50 && repeats.has(p); guard++) p = repeats.get(p) as string
    return p
  }

  // Ids in the order of the day.
  const order = [...pictures].sort((a, b) => {
    const ta = atOf(a)
    const tb = atOf(b)
    if (ta === null && tb === null) return a.name.localeCompare(b.name, undefined, { numeric: true })
    if (ta === null) return 1
    if (tb === null) return -1
    return ta - tb
  })
  const ids = new Map(opts.ids ?? [])
  let nextSource = opts.nextSource ?? 1
  let nextLeft = 1
  const leftOf = (w: WatchedClip): LeftOut | null =>
    readings.get(w.path)?.left ?? (repeats.has(w.path) ? 'duplicate' : null)
  for (const w of order) {
    if (ids.has(w.path)) continue
    ids.set(w.path, leftOf(w) ? `c${nextLeft++}` : `s${nextSource++}`)
  }
  // A left-out clip numbered c1 must not take an id an earlier shoot already used.
  const used = new Set(opts.ids?.values() ?? [])
  for (const [path, id] of ids) {
    if (opts.ids?.has(path)) continue
    if (id.startsWith('c') && used.has(id)) {
      let n = nextLeft++
      while (used.has(`c${n}`)) n = nextLeft++
      ids.set(path, `c${n}`)
    }
  }

  let nextScene = opts.nextScene ?? 1
  const scenes: Scene[] = first.map((paths) => {
    const timed = paths.map((p) => pictures.find((w) => w.path === p) as WatchedClip)
    const times = timed.map(atOf).filter((t): t is number => t !== null)
    const ends = timed
      .map((w) => {
        const t = atOf(w)
        return t === null ? null : t + w.durationSec
      })
      .filter((t): t is number => t !== null)
    const gps = timed.find((w) => w.gps)?.gps ?? null
    return {
      id: `sc${nextScene++}`,
      name: '',
      clips: paths.map((p) => ids.get(p) as string),
      startAt: times.length ? Math.min(...times) : null,
      endAt: ends.length ? Math.max(...ends) : null,
      place: gps
    }
  })
  const sceneId = (path: string): string | null => scenes[sceneOf.get(path) ?? -1]?.id ?? null

  const clips: Clip[] = order.map((w) => {
    const reading = readings.get(w.path)
    const left = leftOf(w)
    const fix = clock.fixes.find((f) => f.camera === w.camera)
    return {
      id: ids.get(w.path) as string,
      path: w.path,
      name: w.name,
      durationSec: round3(w.durationSec),
      recordedAt: w.recordedAt,
      at: atOf(w),
      ...(fix ? { clockFixSec: fix.offsetSec } : {}),
      ...(typeof w.zoneMin === 'number' ? { zoneMin: w.zoneMin } : {}),
      camera: w.camera,
      gps: w.gps,
      width: w.width,
      height: w.height,
      talking: isTalking(w.heard ?? { speechSec: 0 }, w.durationSec),
      speech: round3(Math.min(1, (w.heard?.speechSec ?? 0) / Math.max(0.1, w.durationSec))),
      usable: reading?.usable ?? [],
      left,
      ...(left === 'duplicate' ? { duplicateOf: ids.get(keeper(w.path)) } : {}),
      scene: sceneId(w.path),
      look: looks.get(w.path) ?? []
    }
  })

  let nextMoment = opts.nextMoment ?? 1
  const moments: Moment[] = []
  for (const clip of clips) {
    if (clip.left) continue
    const drafts: MomentDraft[] = readings.get(clip.path)?.moments ?? []
    for (const d of drafts)
      moments.push({ id: `m${nextMoment++}`, clip: clip.id, ...d, description: '', describedBy: 'measurements' })
  }
  return { clips, moments, scenes, clockNotes: clock.notes }
}
