import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { currentCut, currentVersion, resolveCut, type EditDoc } from '../shared/edit'
import { showsSpeaker } from '../shared/plan-talk'

/**
 * The cuts a recording already has in it. A video that was edited before it came here (cutaways between stretches of
 * talk) is cut into beats at its sentences, whose edges fall a few frames either side of its own cuts: a camera move
 * on one beat then lets two frames of the shot before it through. Here each beat's edge is set on the cut itself, and
 * the pauses that edit left in are played: they are somebody's timing, not silence to take out.
 */

/** A change of picture this great between two frames is a cut. */
const CUT = 0.2
/** The most places looked at. */
const MOST = 48
/** A pause longer than this is let go as any other. */
const LONGEST_KEPT = 1.6

/** The cuts in a recording within `half` seconds of a moment, in its own seconds. */
export function cutsNear(ffmpeg: string, path: string, at: number, half: number): Promise<number[]> {
  const from = Math.max(0, at - half)
  return new Promise((resolve) =>
    execFile(
      ffmpeg,
      ['-hide_banner', '-nostats', '-ss', from.toFixed(3), '-t', (half * 2).toFixed(3), '-i', path, '-an', '-vf', `scale=320:-2,select='gt(scene,${CUT})',showinfo`, '-f', 'null', '-'],
      { maxBuffer: 8 << 20 },
      (_err, _out, err) => resolve([...String(err).matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => from + Number(m[1])))
    )
  )
}

/** An edit just made from footage, its beats' edges set on the footage's own cuts; as it was where none are found. */
export async function onItsOwnCuts(ffmpeg: string, doc: EditDoc): Promise<EditDoc> {
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const index = new Map(doc.words.map((w, i) => [w.id, i]))
  const beatOf = new Map(cut.beats.map((b) => [b.id, b]))
  const seams = resolved.beats.slice(1).flatMap((next, i) => {
    const a = beatOf.get(resolved.beats[i].id)
    const b = beatOf.get(next.id)
    if (!a || !b || a.source !== b.source || a.to === null || b.from === null) return []
    const last = index.get(a.to)
    const first = index.get(b.from)
    if (last === undefined || first !== last + 1) return []
    const from = doc.words[last].endSec
    const to = doc.words[first].startSec
    const before = showsSpeaker(resolved.beats[i], resolved, doc.sources)
    const after = showsSpeaker(next, resolved, doc.sources)
    return to >= from ? [{ a, b, from, to, turns: before !== null && after !== null && before !== after }] : []
  })
  const turns = seams.filter((s) => s.turns).length
  // Talk throughout: nothing was cut into it.
  if (turns < 2) return doc
  const pads = new Map<string, { padIn?: number; padOut?: number }>()
  const set = (id: string, pad: { padIn?: number; padOut?: number }): void => void pads.set(id, { ...pads.get(id), ...pad })
  const capped = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000
  let looked = 0
  for (const s of seams) {
    const gap = s.to - s.from
    const path = doc.sources.find((x) => x.id === s.a.source)?.path
    const cuts = s.turns && path && existsSync(path) && looked++ < MOST ? await cutsNear(ffmpeg, path, (s.from + s.to) / 2, gap / 2 + 0.4) : []
    const on = cuts.find((c) => c >= s.from - 0.03 && c <= s.to + 0.03)
    if (on !== undefined) {
      set(s.a.id, { padOut: capped(on - s.from) })
      set(s.b.id, { padIn: capped(s.to - on) })
    } else if (gap <= LONGEST_KEPT) {
      set(s.a.id, { padOut: capped(gap / 2) })
      set(s.b.id, { padIn: capped(gap / 2) })
    }
  }
  if (pads.size === 0) return doc
  const beats = cut.beats.map((b) => ({ ...b, ...pads.get(b.id) }))
  const version = currentVersion(doc)
  return { ...doc, versions: doc.versions.map((v) => (v.n === version.n ? { ...v, cut: { ...v.cut, beats } } : v)) }
}
