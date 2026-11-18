import type { AudioMap } from '../audio/map'
import type { PovMode } from './modes'
import {
  currentCut,
  nextSourceId,
  resolveCut,
  throughId,
  type Beat,
  type Cut,
  type EditDoc,
  type Grid,
  type Op,
  type Source
} from '../edit'

/**
 * Whose view each moment of a gaming session shows, when several players
 * recorded it (pov/lineup lines them up). The person's own view is home.
 * Every other view is another camera of home's recording (edit/angles), so
 * the edit stays one timeline on home's clock with home's sound, and a cut
 * to someone else only changes what is seen.
 *
 * What decides it is heard, not seen: each player's own microphone is the
 * loudest voice in their own recording, the others reaching it only through
 * the voice chat. So a word is said by whoever's recording has it loudest
 * against their usual speech; a laugh, a scream or a bang is theirs when it
 * is loud in their recording against their speech; and where three of them
 * react at once, everyone shows at once, in a grid.
 *
 * The modes, from words or /povs:
 * - talking: follow whoever is talking, and cut to a reaction between lines.
 * - reactions: stay home, cut to the others for their reactions, back soon.
 * - everyone: a grid of everyone where they all react together.
 * - mine: every moment back on home.
 * A view never stays less than the shortest shot, so nothing flickers.
 *
 * Pure: it reads the edit and the sound maps made for each view on home's
 * clock (main: pov:listen), and answers with ops.
 */

/** The shortest a view stays, and the longest a cut away from home lasts for a reaction. */
export const MIN_SHOT_SEC = 1.5
export const AWAY_SEC = 5
/** Who said a word: their recording has it this much louder, against their own speech, than any other's. */
const TALK_MARGIN_DB = 3
/** A laugh or a scream is someone's own when it is this loud against their speech; a bang, this. */
const LAUGH_FROM_DB = -6
const LOUD_FROM_DB = 0
const SCREAM_FROM_DB = 8
/**
 * A laugh or a bang is someone's when it is this much louder in their
 * recording than the voice chat alone would bring it in from anyone else's.
 */
const REACT_MARGIN_DB = 3
/** How far under a player's own voice the chat comes in, when too few words say. */
const CHAT_GUESS_DB = -10
/** Reactions this close together are one moment. */
const TOGETHER_SEC = 1

export interface PovView {
  /** The recording, by source id. */
  id: string
  /** What its panel in a grid says: the part of its file name that is its own. */
  label: string
  /** Home's time t is this recording's t + offsetSec; 0 for home. */
  offsetSec: number
}

export interface PovSession {
  home: PovView
  others: PovView[]
}

/** The part of each name that is its own: "Session pov-2" and "Session pov-3" are "pov-2" and "pov-3". */
export function povLabels(names: string[]): string[] {
  const bare = names.map((n) =>
    n
      .replace(/^.*[\\/]/, '')
      .replace(/\.[^.]+$/, '')
      .trim()
  )
  if (bare.length < 2) return bare.map((b) => b.slice(0, 40))
  const words = bare.map((b) => b.split(/[\s_]+/))
  let lead = 0
  while (words.every((w) => w.length > lead + 1 && w[lead] === words[0][lead])) lead++
  let tail = 0
  while (words.every((w) => w.length > lead + tail + 1 && w[w.length - 1 - tail] === words[0][words[0].length - 1 - tail]))
    tail++
  const own = words.map((w) => w.slice(lead, w.length - tail).join(' '))
  // Too little left to tell them apart: the whole names.
  const distinct = new Set(own).size === own.length && own.every((o) => o.length >= 2)
  return (distinct ? own : bare).map((o) => o.slice(0, 40))
}

/** The session an edit is, when its recording has other players' views lined up with it and heard. */
export function povSessionOf(doc: Pick<EditDoc, 'sources' | 'audio'> & { versions: EditDoc['versions'] }): PovSession | null {
  const cut = currentCut(doc as EditDoc)
  const angles = cut.angles ?? []
  for (const home of doc.sources) {
    const mine = angles.filter((a) => a.of === home.id && doc.audio?.[throughId(home.id, a.source)])
    if (mine.length === 0) continue
    const others = mine
      .map((a) => ({ angle: a, source: doc.sources.find((s) => s.id === a.source) }))
      .filter((x): x is { angle: (typeof mine)[number]; source: Source } => !!x.source)
    const labels = povLabels([home.path, ...others.map((o) => o.source.path)])
    return {
      home: { id: home.id, label: labels[0], offsetSec: 0 },
      others: others.map((o, i) => ({ id: o.source.id, label: labels[i + 1], offsetSec: o.angle.offsetSec }))
    }
  }
  return null
}

/**
 * The other players' recordings joined to an edit as views of its first
 * recording, home: each a source of its own, and a sync op lining it up the
 * way it was heard (pov/lineup). Views already in the edit are left as they are.
 */
export function joinViews(
  doc: EditDoc,
  views: { path: string; offsetSec: number; camera: Omit<Source, 'id'> }[]
): { doc: EditDoc; ops: Op[] } {
  const home = doc.sources[0]
  let next = doc
  const ops: Op[] = []
  for (const v of views) {
    if (!home || next.sources.some((s) => s.path === v.path)) continue
    const id = nextSourceId(next)
    next = { ...next, sources: [...next.sources, { ...v.camera, id }] }
    ops.push({ op: 'sync', source: id, of: home.id, offsetSec: v.offsetSec })
  }
  return { doc: next, ops }
}

/**
 * Where home's own recording's sound map is kept: under its id, unless the
 * edit's sound is another recording's (a recorder, or another player's mix),
 * when the map under its id is that sound's and its own file's goes under
 * home@home.
 */
export function ownSoundKey(home: Pick<Source, 'id' | 'audio'>): string {
  return home.audio ? throughId(home.id, home.id) : home.id
}

/** Each view's sound on home's clock: home's own recording's map, and each other's kept under home@other. */
export function povSounds(doc: Pick<EditDoc, 'audio' | 'sources'>, session: PovSession): Record<string, AudioMap> {
  const out: Record<string, AudioMap> = {}
  const home = doc.sources.find((s) => s.id === session.home.id)
  const own = (home && doc.audio?.[ownSoundKey(home)]) ?? doc.audio?.[session.home.id]
  if (own) out[session.home.id] = own
  for (const v of session.others) {
    const map = doc.audio?.[throughId(session.home.id, v.id)]
    if (map) out[v.id] = map
  }
  return out
}

export type MomentKind = 'laugh' | 'scream' | 'loud'

export interface Moment {
  /** Whose reaction it is. */
  view: string
  kind: MomentKind
  /** On home's clock. */
  startSec: number
  endSec: number
  /** How far past its threshold it is, in dB: the bigger, the more it is theirs. */
  strength: number
}

/** A word's loudness in a view against that view's usual speech, or null when it was not heard there. */
function against(map: AudioMap | undefined, word: string): number | null {
  const w = map?.words[word]
  return w && Number.isFinite(w[0]) ? w[0] - map.level.speech : null
}

/** Who said a word: the view whose recording has it loudest against its own speech, by a clear margin. */
export function talkerOf(word: string, sounds: Record<string, AudioMap>): string | null {
  const levels = Object.entries(sounds)
    .map(([id, map]) => ({ id, rel: against(map, word) }))
    .filter((x): x is { id: string; rel: number } => x.rel !== null)
    .sort((a, b) => b.rel - a.rel)
  if (levels.length === 0) return null
  if (levels.length > 1 && levels[0].rel - levels[1].rel < TALK_MARGIN_DB) return null
  return levels[0].id
}

const middle = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}

/**
 * Each player's own voice in their own recording: the middle loudness of the
 * words they said, there. A recording's usual speech is mostly the others,
 * heard through the voice chat, so a player's own words stand well above it;
 * their laughs, bangs and shouts are weighed against their own voice instead.
 * A player who hardly spoke has the loudest words heard in their recording,
 * which are their own microphone's.
 */
export function ownLevels(
  sounds: Record<string, AudioMap>,
  words: { id: string }[]
): Record<string, number> {
  const said = new Map<string, number[]>()
  for (const w of words) {
    const who = talkerOf(w.id, sounds)
    const db = who ? sounds[who].words[w.id]?.[0] : undefined
    if (who && db !== undefined && Number.isFinite(db)) said.set(who, [...(said.get(who) ?? []), db])
  }
  const out: Record<string, number> = {}
  for (const [view, map] of Object.entries(sounds)) {
    const own = said.get(view) ?? []
    if (own.length >= 3) out[view] = middle(own)
    else {
      const heard = Object.values(map.words)
        .map((x) => x[0])
        .filter(Number.isFinite)
        .sort((a, b) => a - b)
      out[view] = heard.length ? Math.max(map.level.speech, heard[Math.floor(0.9 * (heard.length - 1))]) : map.level.speech
    }
  }
  return out
}

/**
 * How much quieter what each player says comes into each other player's
 * recording, through the voice chat: in dB, the middle difference over the
 * words they said, keyed "from>to". A pair with too few words between them
 * is guessed from how far under their own voice the chat comes in for the
 * one listening, and how the two players' own voices compare.
 */
export function chatPaths(
  sounds: Record<string, AudioMap>,
  words: { id: string }[],
  own: Record<string, number>
): (from: string, to: string) => number {
  const pairs = new Map<string, number[]>()
  const heard = new Map<string, number[]>()
  for (const w of words) {
    const who = talkerOf(w.id, sounds)
    const said = who ? sounds[who].words[w.id]?.[0] : undefined
    if (!who || said === undefined || !Number.isFinite(said)) continue
    for (const [view, map] of Object.entries(sounds)) {
      const db = map.words[w.id]?.[0]
      // Outside a recording, its sound is silence: those words say nothing about the chat in it.
      if (view === who || db === undefined || !Number.isFinite(db) || db <= -90) continue
      pairs.set(`${who}>${view}`, [...(pairs.get(`${who}>${view}`) ?? []), db - said])
      heard.set(view, [...(heard.get(view) ?? []), db - own[view]])
    }
  }
  return (from, to) => {
    const d = pairs.get(`${from}>${to}`) ?? []
    if (d.length >= 3) return Math.min(-1, middle(d))
    const h = heard.get(to) ?? []
    return Math.min(-1, (h.length >= 3 ? middle(h) : CHAT_GUESS_DB) + own[to] - own[from])
  }
}

/**
 * How loud the sounds other than speech are in a recording over a stretch:
 * -Infinity when it heard nothing there, null when someone talking covers
 * it, so it cannot say.
 */
function reactionDb(map: AudioMap, a: number, b: number): number | null {
  let talked = 0
  let loudest = -Infinity
  for (const s of map.segments) {
    const o = overlap(a, b, s.startSec, s.endSec)
    if (o <= 0) continue
    if (s.kind === 'speech') talked += o
    else if (s.kind !== 'silence' && s.db !== undefined) loudest = Math.max(loudest, s.db)
  }
  return talked > 0.5 * (b - a) ? null : loudest
}

/** Every reaction heard, whoever's it is, on home's clock, in time order. */
export function momentsOf(
  sounds: Record<string, AudioMap>,
  words: { id: string; startSec: number; endSec: number }[]
): Moment[] {
  const own = ownLevels(sounds, words)
  const chat = chatPaths(sounds, words, own)
  const out: Moment[] = []
  for (const [view, map] of Object.entries(sounds)) {
    for (const seg of map.segments) {
      if (seg.db === undefined || seg.endSec - seg.startSec < 0.25) continue
      // Against this player's own voice: someone else's laugh comes in through the voice chat, under it.
      const rel = seg.db - own[view]
      const kind: MomentKind | null =
        seg.kind === 'laughter' && rel >= LAUGH_FROM_DB
          ? 'laugh'
          : (seg.kind === 'noise' || seg.kind === 'applause') && rel >= LOUD_FROM_DB
            ? 'loud'
            : null
      if (!kind) continue
      // And louder here than the chat would bring it in from any of the others: theirs, not a laugh heard.
      const brought = Object.entries(sounds)
        .filter(([u]) => u !== view)
        .map(([u, m]) => {
          const db = reactionDb(m, seg.startSec, seg.endSec)
          return db === null ? null : db + chat(u, view)
        })
        .filter((v): v is number => v !== null)
      if (brought.length > 0 && seg.db < Math.max(...brought) + REACT_MARGIN_DB) continue
      const from = kind === 'laugh' ? LAUGH_FROM_DB : LOUD_FROM_DB
      out.push({ view, kind, startSec: seg.startSec, endSec: seg.endSec, strength: rel - from })
    }
  }
  // A shout: a word far louder than its speaker's own voice, in the recording it was said into.
  for (const w of words) {
    const who = talkerOf(w.id, sounds)
    const db = who ? sounds[who].words[w.id]?.[0] : undefined
    if (!who || db === undefined || !Number.isFinite(db)) continue
    const rel = db - own[who]
    if (rel >= SCREAM_FROM_DB)
      out.push({ view: who, kind: 'scream', startSec: w.startSec, endSec: w.endSec, strength: rel - SCREAM_FROM_DB + 1 })
  }
  return out.sort((a, b) => a.startSec - b.startSec || b.strength - a.strength)
}

/** Where at least `least` views react together: each such stretch, with who reacted in it. */
export function bigMoments(moments: Moment[], least: number): { startSec: number; endSec: number; views: string[] }[] {
  const out: { startSec: number; endSec: number; views: Set<string> }[] = []
  for (const m of moments) {
    const last = out[out.length - 1]
    if (last && m.startSec <= last.endSec + TOGETHER_SEC) {
      last.endSec = Math.max(last.endSec, m.endSec)
      last.views.add(m.view)
    } else out.push({ startSec: m.startSec, endSec: m.endSec, views: new Set([m.view]) })
  }
  return out.filter((b) => b.views.size >= least).map((b) => ({ ...b, views: [...b.views] }))
}

/** A stretch of the edit on home's clock: a beat already in the cut, or a gap between them to add. */
interface Slot {
  beat: Beat | null
  /** Where it goes among the cut's beats, for a gap. */
  at: number
  srcStart: number
  srcEnd: number
  /** How long it plays. */
  sec: number
  words: string[]
}

type View = string | 'grid'

const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

/** Whether a view's recording saw the whole of a stretch of home's clock. */
function covers(v: PovView, durations: Map<string, number>, a: number, b: number): boolean {
  const d = durations.get(v.id) ?? 0
  return a + v.offsetSec >= -0.02 && b + v.offsetSec <= d + 0.02
}

/** The stretches the cut plays, beat by beat, and when asked, the gaps between them on home's clock. */
function slotsOf(cut: Cut, doc: EditDoc, home: string, fill: boolean, cutAt: number[]): Slot[] {
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const byBeat = new Map<string, { srcStart: number; srcEnd: number; sec: number }>()
  for (const p of resolved.pieces) {
    const was = byBeat.get(p.beat)
    const sec = p.outEnd - p.outStart
    if (!was) byBeat.set(p.beat, { srcStart: p.srcStart, srcEnd: p.srcEnd, sec })
    else byBeat.set(p.beat, { srcStart: Math.min(was.srcStart, p.srcStart), srcEnd: Math.max(was.srcEnd, p.srcEnd), sec: was.sec + sec })
  }
  const wordsOf = new Map(resolved.beats.map((b) => [b.id, b.words]))
  const slots: Slot[] = []
  const homeSource = doc.sources.find((s) => s.id === home)
  let reach = 0
  const gap = (from: number, to: number, at: number): void => {
    if (!fill || to - from < 0.4) return
    // Split where a reaction starts and ends, so each can be its own shot; edges in order, none a hair apart.
    const inner = [...new Set(cutAt)].filter((t) => t > from + 0.4 && t < to - 0.4).sort((a, b) => a - b)
    const edges = [from]
    for (const t of inner) if (t - edges[edges.length - 1] >= 0.2) edges.push(t)
    if (to - edges[edges.length - 1] >= 0.2) edges.push(to)
    else edges[edges.length - 1] = to
    for (let k = 1; k < edges.length; k++)
      slots.push({ beat: null, at, srcStart: edges[k - 1], srcEnd: edges[k], sec: edges[k] - edges[k - 1], words: [] })
  }
  cut.beats.forEach((beat, i) => {
    const span = byBeat.get(beat.id)
    if (beat.source !== home || !span) {
      if (span) slots.push({ beat, at: i, srcStart: span.srcStart, srcEnd: span.srcEnd, sec: span.sec, words: [] })
      return
    }
    gap(reach, span.srcStart, i)
    slots.push({ beat, at: i, srcStart: span.srcStart, srcEnd: span.srcEnd, sec: span.sec, words: wordsOf.get(beat.id) ?? [] })
    reach = Math.max(reach, span.srcEnd)
  })
  if (homeSource) gap(reach, homeSource.durationSec, cut.beats.length)
  return slots
}

export interface PovPlan {
  ops: Op[]
  /** One plain sentence about what changed. */
  summary: string
  /** How many cuts went to someone else's view, and how many grids of everyone. */
  away: number
  grids: number
}

export interface PovAsk {
  mode: PovMode
  /** The shortest a view stays, in seconds; MIN_SHOT_SEC when absent or 0. */
  minSec?: number
  /** Add the gaps between home's lines, so the play between them is in: once, when the session comes in. */
  fill?: boolean
  /** With talking or reactions, everyone at once too, where everyone reacts together. */
  everyone?: boolean
}

/** The grid of everyone a stretch can show: home first, then whoever reacted, then the rest, four at most. */
function gridFor(session: PovSession, reacted: string[], durations: Map<string, number>, a: number, b: number): Grid | null {
  const others = [...session.others].sort((x, y) => Number(reacted.includes(y.id)) - Number(reacted.includes(x.id)))
  const panels = [session.home, ...others.filter((v) => covers(v, durations, a, b))].slice(0, 4)
  if (panels.length < 2) return null
  return { panels: panels.map((v, i) => ({ show: i === 0 ? '' : v.id, label: v.label })) }
}

/** Runs of the same view, in slot order. */
function runsOf(views: View[], slots: Slot[]): { from: number; to: number; view: View; sec: number }[] {
  const runs: { from: number; to: number; view: View; sec: number }[] = []
  views.forEach((v, i) => {
    const last = runs[runs.length - 1]
    if (last && last.view === v) {
      last.to = i
      last.sec += slots[i].sec
    } else runs.push({ from: i, to: i, view: v, sec: slots[i].sec })
  })
  return runs
}

/**
 * No view shorter than the shortest shot: a short reaction or grid holds into
 * the home shots after it, as long as it stays a reaction; anything still too
 * short goes to a neighbour, a cut away back to home and a short return home
 * between two cuts away to the longer side.
 */
function steady(
  views: View[],
  slots: Slot[],
  home: string,
  minSec: number,
  shows: (view: View, slot: Slot) => boolean
): View[] {
  const out = [...views]
  // First, a short shout or grid holds on into the home shots after it rather than flashing by.
  for (let guard = 0; guard < slots.length; guard++) {
    const runs = runsOf(out, slots)
    const i = runs.findIndex((r, k) => {
      const next = runs[k + 1]
      if (r.view === home || r.sec >= minSec - 1e-6 || next?.view !== home) return false
      const slot = slots[next.from]
      const most = r.view === 'grid' ? AWAY_SEC + minSec : AWAY_SEC
      return (!slot.beat || slot.beat.source === home) && r.sec + slot.sec <= most + 1e-6 && shows(r.view, slot)
    })
    if (i < 0) break
    out[runs[i + 1].from] = runs[i].view
  }
  // Then every shot still too short goes to a neighbour: a cut away back to home, a short home to the longer side.
  // Each pass leaves one run fewer, so it ends.
  for (;;) {
    const runs = runsOf(out, slots)
    if (runs.length < 2) break
    const i = runs.findIndex((r) => r.sec < minSec - 1e-6)
    if (i < 0) break
    const r = runs[i]
    const before = runs[i - 1]
    const after = runs[i + 1]
    let to: View
    if (r.view !== home && (before?.view === home || after?.view === home)) to = home
    else if (before && after) to = before.sec >= after.sec ? before.view : after.view
    else to = (before ?? after).view
    for (let k = r.from; k <= r.to; k++) out[k] = to
  }
  return out
}

/** Every stretch where everyone reacts together shown as a grid of everyone; the rest as they were. */
function withEveryone(slots: Slot[], views: View[], session: PovSession, moments: Moment[]): View[] {
  const least = Math.min(3, 1 + session.others.length)
  const big = bigMoments(moments, least)
  return slots.map((s, i) => {
    if (s.beat && s.beat.source !== session.home.id) return views[i]
    const hit = big.find((b) => overlap(s.srcStart, s.srcEnd, b.startSec, b.endSec) >= Math.min(0.5, (s.srcEnd - s.srcStart) * 0.3))
    return hit ? 'grid' : views[i]
  })
}

/** Whose view each stretch shows, as the mode asks. */
function choose(
  slots: Slot[],
  current: View[],
  session: PovSession,
  sounds: Record<string, AudioMap>,
  moments: Moment[],
  durations: Map<string, number>,
  mode: PovMode,
  wordSpan: Map<string, { startSec: number; endSec: number }>
): View[] {
  const home = session.home.id
  const others = new Map(session.others.map((v) => [v.id, v]))
  const can = (id: string, s: Slot): boolean => {
    const v = others.get(id)
    return !!v && covers(v, durations, s.srcStart, s.srcEnd)
  }
  if (mode === 'mine') return slots.map(() => home)
  if (mode === 'everyone') return withEveryone(slots, current, session, moments)
  // The strongest reaction of someone else's in a stretch, theirs to cut to.
  const reaction = (s: Slot): string | null => {
    // A long line is not given away for a short laugh in it: the cut is for a reaction, not a line.
    if (s.sec > AWAY_SEC) return null
    const hit = moments
      .filter((m) => m.view !== home && can(m.view, s))
      .filter((m) => overlap(s.srcStart, s.srcEnd, m.startSec, m.endSec) >= Math.min(0.3, (m.endSec - m.startSec) * 0.5))
      .sort((a, b) => b.strength - a.strength)[0]
    return hit?.view ?? null
  }
  const chosen = slots.map((s): View => {
    if (s.beat && s.beat.source !== home) return current[slots.indexOf(s)]
    if (mode === 'talking') {
      const said = new Map<string, number>()
      for (const id of s.words) {
        const who = talkerOf(id, sounds)
        const span = wordSpan.get(id)
        if (who && span) said.set(who, (said.get(who) ?? 0) + (span.endSec - span.startSec))
      }
      const top = [...said.entries()].sort((a, b) => b[1] - a[1])[0]
      if (top && top[0] !== home && can(top[0], s)) return top[0]
      if (top && top[0] === home) return home
    }
    return reaction(s) ?? home
  })
  // Back home soon: a cut away for reactions lasts AWAY_SEC at most, unless someone keeps talking.
  if (mode === 'reactions') {
    let away = 0
    for (let i = 0; i < chosen.length; i++) {
      away = chosen[i] !== home && chosen[i] === chosen[i - 1] ? away + slots[i].sec : chosen[i] !== home ? slots[i].sec : 0
      if (away > AWAY_SEC && chosen[i] !== home) {
        chosen[i] = home
        away = 0
      }
    }
  }
  return chosen
}

/** A view as a beat's treatment shows it. */
function treatmentFor(view: View, home: string, grid: Grid | null): { angle?: { source: string; layout: 'full' } | null; grid?: Grid | null } {
  if (view === 'grid') return { angle: null, grid }
  if (view === home) return { angle: null, grid: null }
  return { angle: { source: view, layout: 'full' }, grid: null }
}

/** What view a beat shows now. */
function viewOf(beat: Beat, home: string): View {
  if (beat.treatment.grid) return 'grid'
  return beat.treatment.angle?.layout === 'full' ? beat.treatment.angle.source : home
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const clockOf = (sec: number): string => {
  const t = Math.max(0, Math.round(sec))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

/**
 * The session for the planner, in a few lines: each view by id with its
 * name and line-up, and the reactions heard, whose and when on the edit's
 * recording, so "cut to Sam when he screams" has a place to land.
 */
export function renderPovs(doc: EditDoc): string {
  const session = povSessionOf(doc)
  if (!session) return ''
  const sounds = povSounds(doc, session)
  const moments = momentsOf(
    sounds,
    doc.words.filter((w) => w.source === session.home.id)
  )
  const sign = (n: number): string => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)} s`
  const lines = [
    `${session.home.id} "${session.home.label}": the person's own view, the edit's recording and sound`,
    ...session.others.map((v) => `${v.id} "${v.label}": lined up at ${sign(v.offsetSec)}`)
  ]
  const heard = moments
    .slice()
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 16)
    .sort((a, b) => a.startSec - b.startSec)
    .map((m) => `${m.view} ${m.kind} ${clockOf(m.startSec)}`)
  if (heard.length) lines.push(`reactions: ${heard.join(', ')}`)
  return `<povs>\n${lines.join('\n')}\n</povs>`
}

/** The ops that show each moment of a session through the view the mode picks. */
export function planPovs(doc: EditDoc, ask: PovAsk): PovPlan | { say: string } {
  const session = povSessionOf(doc)
  if (!session)
    return {
      say: 'This edit has one view. Drop the other players’ recordings of the same session with yours and I’ll line them up.'
    }
  const cut = currentCut(doc)
  const home = session.home.id
  const minSec = ask.minSec && ask.minSec > 0 ? Math.min(10, ask.minSec) : MIN_SHOT_SEC
  const sounds = povSounds(doc, session)
  const durations = new Map(doc.sources.map((s) => [s.id, s.durationSec]))
  const homeWords = doc.words.filter((w) => w.source === home)
  const wordSpan = new Map(homeWords.map((w) => [w.id, { startSec: w.startSec, endSec: w.endSec }]))
  const moments = momentsOf(sounds, homeWords)
  // Each reaction its own stretch of the play between lines: from just before it, and long enough to be a shot.
  const edges = moments.flatMap((m) => {
    const from = m.startSec - 0.4
    return [from, Math.max(m.endSec + 0.5, from + minSec + 0.1)]
  })
  const slots = slotsOf(cut, doc, home, !!ask.fill, edges)
  const current = slots.map((s) => (s.beat ? viewOf(s.beat, home) : home))
  const chosen = choose(slots, current, session, sounds, moments, durations, ask.mode, wordSpan)
  const both = ask.everyone && ask.mode !== 'mine' && ask.mode !== 'everyone' ? withEveryone(slots, chosen, session, moments) : chosen
  // A view can hold on only where its recording saw it; a grid wherever two views at least did.
  const others = new Map(session.others.map((v) => [v.id, v]))
  const shows = (view: View, s: Slot): boolean =>
    view === 'grid'
      ? session.others.some((v) => covers(v, durations, s.srcStart, s.srcEnd))
      : !!others.get(view) && covers(others.get(view) as PovView, durations, s.srcStart, s.srcEnd)
  const picked = steady(both, slots, home, minSec, shows)

  // The grid each grid stretch shows: whoever reacted in it first, and only views that saw it all.
  const grids = picked.map((v, i) => {
    if (v !== 'grid') return null
    const s = slots[i]
    const reacted = moments.filter((m) => overlap(s.srcStart, s.srcEnd, m.startSec, m.endSec) > 0).map((m) => m.view)
    return gridFor(session, reacted, durations, s.srcStart, s.srcEnd)
  })
  const final = picked.map((v, i) => (v === 'grid' && !grids[i] ? home : v))

  const ops: Op[] = []
  // Changes to beats already in the cut, grouped by what they change to.
  const changes = new Map<string, { view: View; grid: Grid | null; beats: string[] }>()
  slots.forEach((s, i) => {
    if (!s.beat || s.beat.source !== home) return
    const want = final[i]
    const was = current[i]
    const grid = grids[i]
    if (want === was && (want !== 'grid' || JSON.stringify(s.beat.treatment.grid) === JSON.stringify(grid))) return
    const key = `${want}|${JSON.stringify(grid)}`
    const entry = changes.get(key) ?? { view: want, grid, beats: [] }
    entry.beats.push(s.beat.id)
    changes.set(key, entry)
  })
  for (const { view, grid, beats } of changes.values()) {
    const hasAngle = beats.filter((id) => cut.beats.find((b) => b.id === id)?.treatment.angle)
    const hasGrid = beats.filter((id) => cut.beats.find((b) => b.id === id)?.treatment.grid)
    if (view === 'grid') {
      if (hasAngle.length) ops.push({ op: 'angle', beats: hasAngle, source: null })
      ops.push({ op: 'treat', beats, set: { grid } })
    } else if (view === home) {
      if (hasAngle.length) ops.push({ op: 'angle', beats: hasAngle, source: null })
      if (hasGrid.length) ops.push({ op: 'treat', beats: hasGrid, set: { grid: null } })
    } else {
      if (hasGrid.length) ops.push({ op: 'treat', beats: hasGrid, set: { grid: null } })
      ops.push({ op: 'angle', beats, source: view, layout: 'full' })
    }
  }
  // The play between home's lines, each stretch with its view, added last to first so places hold.
  const gaps = slots.map((s, i) => ({ s, i })).filter(({ s }) => !s.beat)
  for (const { s, i } of [...gaps].reverse()) {
    const treatment = treatmentFor(final[i], home, grids[i])
    ops.push({
      op: 'insert',
      to: s.at,
      beat: {
        source: home,
        from: null,
        to: null,
        inSec: Math.round(s.srcStart * 1000) / 1000,
        outSec: Math.round(s.srcEnd * 1000) / 1000,
        ...(treatment.angle || treatment.grid ? { treatment: { ...(treatment.angle ? { angle: treatment.angle } : {}), ...(treatment.grid ? { grid: treatment.grid } : {}) } } : {})
      }
    })
  }

  const runs = runsOf(final, slots)
  const away = runs.filter((r) => r.view !== home && r.view !== 'grid').length
  const gridRuns = runs.filter((r) => r.view === 'grid').length
  const filled = gaps.length ? ' The play between your lines is in.' : ''
  const together =
    gridRuns === 1
      ? 'Everyone shows at once where you all react together.'
      : `Everyone shows at once ${gridRuns} times, where you all react together.`
  let summary: string
  if (ask.mode === 'mine') summary = 'It is all on your view.'
  else if (ask.mode === 'everyone')
    summary = gridRuns ? together : 'I didn’t hear you all react at once, so nothing shows everyone yet.'
  else if (ask.mode === 'talking')
    summary = away
      ? `It follows whoever is talking: ${count(away, 'cut')} to the others, and back to yours when you talk.`
      : 'It stays on yours: I didn’t hear anyone else talk or react on their own microphone.'
  else
    summary = away
      ? `It stays on yours and cuts to the others for ${count(away, 'reaction')}, back to yours each time.`
      : 'It stays on yours: I didn’t hear anyone else react on their own microphone.'
  if (gridRuns && ask.mode !== 'everyone' && ask.mode !== 'mine') summary += ` ${together}`
  return { ops, summary: summary + filled, away, grids: gridRuns }
}
