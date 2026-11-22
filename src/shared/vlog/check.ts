import { currentCut } from '../edit/doc'
import { applyOps } from '../edit/ops'
import { resolveCut } from '../edit/resolve'
import type { EditDoc } from '../edit/schema'
import { storyOps } from './build'
import { ROLES, type Role, type StoryBeat, type Vlog } from './schema'
import { onTheBeat, PACE } from './story'

/**
 * A story another model proposed, checked the way the planner's plans are:
 * every clip one Cutalong has, every shot inside its clip and its usable
 * footage, every sentence made of words that clip really has, in order.
 * Whatever does not hold is left out and counted, never guessed at. Then the
 * shots are trimmed or let run so the story meets its length, and land on
 * the music's beats when there is a bed.
 */

export interface ProposedBeat {
  clip: string
  role: string
  inSec: number
  outSec: number
  from: string
  to: string
}

export interface Checked {
  beats: StoryBeat[]
  /** Why each left-out beat was left out, for the log. */
  rejected: string[]
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000

export function checkStory(proposed: ProposedBeat[], doc: EditDoc, vlog: Vlog): Checked {
  const clips = new Map(vlog.clips.map((c) => [c.id, c]))
  const sources = new Set(doc.sources.map((s) => s.id))
  const words = new Map(doc.words.map((w, i) => [w.id, { w, i }]))
  const beats: StoryBeat[] = []
  const rejected: string[] = []
  for (const p of proposed) {
    const clip = clips.get(p.clip)
    if (!clip || !sources.has(p.clip)) {
      rejected.push(`there is no clip ${p.clip}`)
      continue
    }
    if (clip.left) {
      rejected.push(`${p.clip} is left out (${clip.left})`)
      continue
    }
    const role: Role = (ROLES as readonly string[]).includes(p.role) ? (p.role as Role) : 'action'
    if (p.from || p.to) {
      const a = words.get(p.from)
      const z = words.get(p.to)
      if (!a || !z) {
        rejected.push(`${p.clip} has no word ${!a ? p.from : p.to}`)
        continue
      }
      if (a.w.source !== p.clip || z.w.source !== p.clip) {
        rejected.push(`${p.from}-${p.to} are not words of ${p.clip}`)
        continue
      }
      if (a.i > z.i) {
        rejected.push(`${p.from} comes after ${p.to}`)
        continue
      }
      beats.push({
        clip: p.clip,
        role,
        scene: clip.scene,
        moment: null,
        inSec: null,
        outSec: null,
        from: p.from,
        to: p.to
      })
      continue
    }
    if (!Number.isFinite(p.inSec) || !Number.isFinite(p.outSec) || p.outSec - p.inSec < 0.3) {
      rejected.push(`${p.clip} ${p.inSec}-${p.outSec} is not a span`)
      continue
    }
    if (p.inSec < -0.05 || p.outSec > clip.durationSec + 0.05) {
      rejected.push(`${p.clip} is only ${clip.durationSec.toFixed(1)} s long`)
      continue
    }
    // Inside the usable footage: a shot that strays into a shaky or dark
    // stretch is pulled back inside the stretch it mostly lies in.
    const inSec = Math.max(0, p.inSec)
    const outSec = Math.min(clip.durationSec, p.outSec)
    let best: [number, number] | null = null
    let most = 0
    for (const [a, b] of clip.usable) {
      const o = Math.min(b, outSec) - Math.max(a, inSec)
      if (o > most) {
        most = o
        best = [a, b]
      }
    }
    if (!best || most < 0.5 * (outSec - inSec)) {
      rejected.push(`${p.clip} ${inSec}-${outSec} is outside its usable footage`)
      continue
    }
    const from = Math.max(best[0], inSec)
    const to = Math.min(best[1], outSec)
    const moment = vlog.moments.find((m) => m.clip === p.clip && m.inSec <= from + 0.05 && m.outSec >= from + 0.05)
    beats.push({
      clip: p.clip,
      role,
      scene: clip.scene,
      moment: moment?.id ?? null,
      inSec: round3(from),
      outSec: round3(to),
      from: null,
      to: null
    })
  }
  return { beats, rejected }
}

/**
 * Shots trimmed or let run, within their usable footage, so the story plays
 * as long as asked (talking keeps its length), then landed on the music's
 * beats. Returns the beats and how long they play.
 */
export function fitStory(
  beats: StoryBeat[],
  targetSec: number,
  doc: EditDoc,
  vlog: Vlog,
  musicBeats: number[] | null
): { beats: StoryBeat[]; totalSec: number } {
  const clips = new Map(vlog.clips.map((c) => [c.id, c]))
  const base = { ...currentCut(doc), beats: [] }
  // How long each beat plays now, talking included, as the cut resolves it.
  const lengthOf = (b: StoryBeat): number => {
    if (!b.from) return Math.max(0, (b.outSec ?? 0) - (b.inSec ?? 0))
    const cut = applyOps(base, storyOps([b], base), { words: doc.words, sources: doc.sources }).cut
    return resolveCut(cut, doc.words, doc.sources).durationSec
  }
  const items = beats.map((b) => {
    const len = lengthOf(b)
    if (b.from) return { b, len, minLen: len, maxLen: len, room: [0, 0] as [number, number], unit: true }
    const clip = clips.get(b.clip)
    const stretch = clip?.usable.find(([a, z]) => (b.inSec ?? 0) >= a - 0.05 && (b.outSec ?? 0) <= z + 0.05) ?? [
      b.inSec ?? 0,
      b.outSec ?? 0
    ]
    const space = stretch[1] - stretch[0]
    const hook = b.role === 'hook'
    const minLen = Math.min(len, hook ? PACE.hookMin : PACE.minShot)
    const maxLen = Math.min(space, Math.max(len, b.role === 'payoff' ? PACE.payoffMax : hook ? 1.6 : PACE.maxShot))
    return { b, len, minLen, maxLen, room: stretch as [number, number], unit: false }
  })
  const total = (): number => items.reduce((s, i) => s + i.len, 0)
  const shots = items.filter((i) => !i.unit)
  const over = total() - targetSec
  if (over > 0) {
    const slack = shots.reduce((s, i) => s + i.len - i.minLen, 0)
    if (slack > 0) for (const i of shots) i.len -= ((i.len - i.minLen) / slack) * Math.min(over, slack)
  } else if (over < 0) {
    const slack = shots.reduce((s, i) => s + i.maxLen - i.len, 0)
    if (slack > 0) for (const i of shots) i.len += ((i.maxLen - i.len) / slack) * Math.min(-over, slack)
  }
  if (musicBeats && musicBeats.length > 2) onTheBeat(items, musicBeats)
  const out = items.map((i) => {
    if (i.unit) return i.b
    const mid = ((i.b.inSec ?? 0) + (i.b.outSec ?? 0)) / 2
    const start = Math.max(i.room[0], Math.min(mid - i.len / 2, i.room[1] - i.len))
    return { ...i.b, inSec: round3(start), outSec: round3(Math.min(i.room[1], start + i.len)) }
  })
  return { beats: out, totalSec: round3(total()) }
}
