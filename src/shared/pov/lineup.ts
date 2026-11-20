import { estimateOffset, trustworthy, type Offset } from '../audio/offset'
import type { Envelope } from '../audio/snap'

/**
 * One gaming session recorded by several players: each player's recording
 * of their own view, started and stopped whenever they liked. What they all
 * share is the voice chat, heard in every recording whatever the game sounds
 * like, so they line up by ear the way a second camera does (audio/offset),
 * each against the person's own recording, the home view.
 *
 * A recording that does not line up with home may still line up with one
 * that does (two players who started late together), and goes in through
 * it. One that lines up with none is not of this session, and says so.
 * Long sessions are checked in stretches and for drift (pairUp).
 *
 * Pure: the envelopes arrive measured (main/audio-envelope), so the tests
 * line up synthetic sessions with known answers.
 */

export interface SessionRecording {
  path: string
  env: Envelope
}

export interface LinedRecording {
  path: string
  /** The moment at home's time t is at t + offsetSec in this recording. */
  offsetSec: number
  confidence: number
  /** Seconds of the session both heard. */
  overlapSec: number
  /** The recording it was lined up through, when it did not line up with home directly. */
  via: string | null
  /** How far the line-up moves between the start and the end of the overlap, when it was measured. */
  driftSec: number | null
  /**
   * Whether the line-up is sure enough to cut on: stretches of their own
   * agree with it (pairUp), and so does whatever it was lined up through.
   * Unsure, it matched over the whole session but nothing confirmed it.
   */
  sure: boolean
  /** The stretches checked on their own, and how many agreed; null when they share too little to check. */
  stretches: { checked: number; agreed: number } | null
}

export interface SessionLineUp {
  home: string
  /** Every other recording that lined up, with its offset from home. */
  lined: LinedRecording[]
  /** Recordings that line up with none of the others: not this session, or too little heard. */
  apart: string[]
}

/** How far over its background a moment has to be to count at all, and to count fully. */
const ACTIVE_FROM_DB = 6
const ACTIVE_FULL_DB = 18

const activities = new WeakMap<Envelope, Envelope>()

/**
 * A recording's loudness as how far above its own background each moment
 * is: nothing within 6 dB of it, all at 18 dB or more over it. The
 * background is the quiet between sounds over the few seconds around. A
 * player's own voice is loud in their recording and everyone else's comes in
 * quieter through the chat, while each game's sound sets a background of its
 * own; over their backgrounds, the chat is on in every recording at the same
 * moments, whoever is talking, so it is what lines them up.
 */
export function chatActivity(env: Envelope): Envelope {
  const known = activities.get(env)
  if (known) return known
  const n = env.db.length
  const block = Math.max(1, Math.round(1 / env.hopSec))
  const blocks = Math.ceil(n / block)
  const floors = new Float32Array(blocks)
  for (let b = 0; b < blocks; b++) {
    const around: number[] = []
    for (let i = Math.max(0, (b - 2) * block); i < Math.min(n, (b + 2) * block); i++)
      if (Number.isFinite(env.db[i])) around.push(env.db[i])
    around.sort((x, y) => x - y)
    floors[b] = around.length ? around[Math.floor(0.2 * (around.length - 1))] : -90
  }
  const db = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const above = env.db[i] - floors[Math.min(blocks - 1, Math.floor(i / block))]
    db[i] = Number.isFinite(above) ? Math.max(0, Math.min(1, (above - ACTIVE_FROM_DB) / (ACTIVE_FULL_DB - ACTIVE_FROM_DB))) : 0
  }
  const out = { hopSec: env.hopSec, db }
  activities.set(env, out)
  return out
}

/**
 * Two recordings of one session: stretches of their own agree on the
 * line-up (pairUp), or, where nothing confirmed it, the voice chat lines up
 * clearly over all they share.
 */
export function sameSession(o: Offset | Pairing | null): o is Offset {
  if (o && 'sure' in o && o.sure) return true
  return trustworthy(o) && o.confidence >= 0.55 && o.overlapSec >= 20
}

/** A stretch of an envelope: from startSec, lenSec long, clipped to what there is. */
export function sliceEnvelope(env: Envelope, startSec: number, lenSec: number): Envelope {
  const a = Math.max(0, Math.round(startSec / env.hopSec))
  const b = Math.min(env.db.length, Math.round((startSec + lenSec) / env.hopSec))
  const db = new Float32Array(Math.max(0, b - a))
  for (let i = 0; i < db.length; i++) db[i] = env.db[a + i]
  return { hopSec: env.hopSec, db }
}

/**
 * Seconds two recordings must share before a match over all of them counts:
 * a minute (or half the shorter one), so a few seconds that happen to look
 * alike at the very ends never beat the real line-up; for long recordings, a
 * quarter of the shorter one, up to ten minutes, since in a long session with
 * little said, a minute or two at the ends can look alike by chance more
 * than the whole of it does.
 */
const SHARED_SEC = 60
const SHARED_SHARE = 0.25
const SHARED_MOST_SEC = 600
/** How long the stretches checked on their own are, and how far either side of the whole's line-up they look. */
const STRETCH_SEC = 60
const STRETCH_REACH_SEC = 2
/** What is shared is checked in sixths, at the two stretches in each where both recordings talk most. */
const STRETCH_PARTS = 6
const STRETCHES_PER_PART = 2
/** Recordings sharing this much or more are checked in stretches, and for drift. */
const STRETCHES_FROM_SEC = 600
/** Stretches agree when each is this close to one line through them: a frame and a half at 30 fps. */
const AGREE_SEC = 0.05
/** It takes this many stretches that agree to be sure. */
const AGREE_LEAST = 3
/** Stretches this far apart, or more, measure the drift. */
const DRIFT_SPAN_SEC = 600
/** The fastest two recorders' clocks drift apart: 1.8 s an hour. A steeper line is chance, not drift. */
const MOST_DRIFT = 5e-4

const round3 = (v: number): number => Math.round(v * 1000) / 1000

/** How two recordings of one session line up. */
export interface Pairing extends Offset {
  /** How far the line-up moves from the start of what they share to its end, when that was measured. */
  driftSec: number | null
  /** Whether stretches of their own confirmed it, or for recordings that share less than ten minutes, the whole did. */
  sure: boolean
  /** The stretches checked on their own, and how many agreed; null when they share too little to check. */
  stretches: { checked: number; agreed: number } | null
}

/**
 * The line-up in one stretch of home: home from `at` for `len` seconds
 * against the other recording around where the whole says it is, searched
 * only a little way either side.
 */
function stretch(home: Envelope, other: Envelope, at: number, len: number, offsetSec: number): Offset | null {
  const a = sliceEnvelope(home, at, len)
  const from = at + offsetSec - STRETCH_REACH_SEC
  if (from < 0) return null
  const b = sliceEnvelope(other, from, len + 2 * STRETCH_REACH_SEC)
  const o = estimateOffset(a, b, { maxLagSec: STRETCH_REACH_SEC * 2 })
  // Home's at + t is the slice's t, and the other's from + t + o.
  return o && trustworthy(o) ? { ...o, offsetSec: round3(from - at + o.offsetSec) } : null
}

/**
 * Where both recordings talk most, at a line-up: the stretches of home to
 * check on their own, two in each sixth of what they share, so they reach
 * across all of it. A minute where both are active together is a minute of
 * the voice chat; in a session with little said, a stretch anywhere else is
 * mostly game, which no two recordings share.
 */
export function talkiestStretches(home: Envelope, other: Envelope, offsetSec: number, startSec: number, endSec: number, len = STRETCH_SEC): number[] {
  // How active both are together, summed up to each of home's moments.
  const shift = Math.round(offsetSec / home.hopSec)
  const sum = new Float64Array(home.db.length + 1)
  for (let i = 0; i < home.db.length; i++) {
    const j = i + shift
    sum[i + 1] = sum[i] + (j >= 0 && j < other.db.length ? Math.min(home.db[i], other.db[j]) : 0)
  }
  const at = (sec: number): number => Math.max(0, Math.min(home.db.length, Math.round(sec / home.hopSec)))
  const out: number[] = []
  const from = startSec + STRETCH_REACH_SEC + 1
  const to = endSec - STRETCH_REACH_SEC - 1
  const part = (to - from) / STRETCH_PARTS
  if (part <= 0) return out
  for (let k = 0; k < STRETCH_PARTS; k++) {
    const options: { at: number; talk: number }[] = []
    for (let t = from + k * part; t + len <= Math.min(to, from + (k + 1) * part + len / 2); t += len / 4)
      options.push({ at: t, talk: sum[at(t + len)] - sum[at(t)] })
    options.sort((a, b) => b.talk - a.talk)
    const mine: number[] = []
    for (const o of options) {
      if (mine.length >= STRETCHES_PER_PART || o.talk <= 0) break
      if (mine.every((t) => Math.abs(t - o.at) >= len)) mine.push(o.at)
    }
    out.push(...mine)
  }
  return out.sort((a, b) => a - b)
}

/**
 * One line through the stretches' line-ups, as clocks that drift apart at a
 * steady rate make: its slope the median of the slopes between stretches far
 * enough apart to say, so a stretch that matched the wrong moment does not
 * tilt it, then fitted again through those that agree with it.
 */
export function agreeingLine<P extends { t: number; offsetSec: number }>(points: P[]): { slope: number; at: (t: number) => number; agree: P[] } {
  const slopes: number[] = []
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      if (Math.abs(points[j].t - points[i].t) >= DRIFT_SPAN_SEC / 2)
        slopes.push((points[j].offsetSec - points[i].offsetSec) / (points[j].t - points[i].t))
  const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)] ?? 0
  const rough = median(slopes)
  const slope0 = Math.abs(rough) <= MOST_DRIFT ? rough : 0
  const icpt0 = median(points.map((p) => p.offsetSec - slope0 * p.t))
  const agree = points.filter((p) => Math.abs(p.offsetSec - (icpt0 + slope0 * p.t)) <= AGREE_SEC)
  // Fitted again through those that agree: least squares, flat when they sit too close together to say.
  const n = agree.length
  const mt = agree.reduce((s, p) => s + p.t, 0) / Math.max(1, n)
  const mo = agree.reduce((s, p) => s + p.offsetSec, 0) / Math.max(1, n)
  let num = 0
  let den = 0
  for (const p of agree) {
    num += (p.t - mt) * (p.offsetSec - mo)
    den += (p.t - mt) ** 2
  }
  const span = n ? Math.max(...agree.map((p) => p.t)) - Math.min(...agree.map((p) => p.t)) : 0
  const fitted = n >= 2 && span >= DRIFT_SPAN_SEC / 2 && den > 0 ? num / den : 0
  const slope = Math.abs(fitted) <= MOST_DRIFT ? fitted : 0
  return { slope, at: (t) => mo + slope * (t - mt), agree }
}

/**
 * Where another recording of the session sits against home: matched over
 * all they share first, which finds it give or take a fraction of a second;
 * then, when they share ten minutes or more, matched again in stretches of a
 * minute each on its own, where both talk most (talkiestStretches). The
 * line-up is sure when three or more of them agree on one line: two
 * recorders' clocks never run at exactly the same rate, so over an hour it
 * can move by a few frames, and the line through them says how far (the
 * drift) and where it sits in the middle of what they share, so neither end
 * is out by more than half the drift. Matched over a whole long session,
 * game sound nobody shares can drown the chat; a minute of talk cannot be.
 * Nothing confirmed, the whole is all there is to go on, and it is unsure.
 */
export function pairUp(homeLoudness: Envelope, otherLoudness: Envelope): Pairing | null {
  const home = chatActivity(homeLoudness)
  const other = chatActivity(otherLoudness)
  const homeSec = home.db.length * home.hopSec
  const otherSec = other.db.length * other.hopSec
  const shared = Math.min(SHARED_MOST_SEC, Math.max(SHARED_SEC, SHARED_SHARE * Math.min(homeSec, otherSec)))
  const whole = estimateOffset(home, other, { minOverlapSec: shared })
  if (!whole) return null
  const start = Math.max(0, -whole.offsetSec)
  const end = Math.min(homeSec, otherSec - whole.offsetSec)
  // Too short to check in stretches, and too short to drift: the whole says it.
  if (end - start < STRETCHES_FROM_SEC) return { ...whole, driftSec: null, sure: sameSession(whole), stretches: null }
  const checked = talkiestStretches(home, other, whole.offsetSec, start, end)
  const heard: (Offset & { t: number })[] = []
  for (const at of checked) {
    const o = stretch(home, other, at, STRETCH_SEC, whole.offsetSec)
    if (o) heard.push({ ...o, t: at + STRETCH_SEC / 2 })
  }
  const line = agreeingLine(heard)
  const stretches = { checked: checked.length, agreed: line.agree.length }
  if (line.agree.length < AGREE_LEAST) return { ...whole, driftSec: null, sure: false, stretches }
  const ts = line.agree.map((p) => p.t)
  const confidences = line.agree.map((p) => p.confidence).sort((a, b) => a - b)
  return {
    offsetSec: round3(line.at((start + end) / 2)),
    confidence: confidences[Math.floor(confidences.length / 2)],
    margin: whole.margin,
    overlapSec: whole.overlapSec,
    driftSec: Math.max(...ts) - Math.min(...ts) >= DRIFT_SPAN_SEC ? round3(line.slope * (end - start)) : null,
    sure: true,
    stretches
  }
}

/**
 * Lines every recording up with home: sure line-ups first, straight to home
 * or through one already surely lined up; then any recording that is of the
 * session at all, unsure, the same way.
 */
export function lineUpSession(recordings: SessionRecording[], home: string): SessionLineUp {
  const own = recordings.find((r) => r.path === home)
  if (!own) throw new Error('The home recording is not one of them.')
  const lined: LinedRecording[] = []
  const waiting = recordings.filter((r) => r.path !== home)
  const known = new Map<string, Pairing | null>()
  const pair = (a: SessionRecording, b: SessionRecording): Pairing | null => {
    const key = `${a.path}\n${b.path}`
    if (!known.has(key)) known.set(key, pairUp(a.env, b.env))
    return known.get(key) ?? null
  }
  const line = (r: SessionRecording, o: Pairing, via: LinedRecording | null): LinedRecording => ({
    path: r.path,
    offsetSec: round3((via?.offsetSec ?? 0) + o.offsetSec),
    confidence: o.confidence,
    overlapSec: o.overlapSec,
    via: via?.path ?? null,
    driftSec: via ? null : o.driftSec,
    sure: o.sure && (via?.sure ?? true),
    stretches: o.stretches
  })
  for (const sureOnly of [true, false]) {
    // Home first; then, round by round, through whatever has lined up so far.
    let found = true
    while (found && waiting.length > 0) {
      found = false
      for (const r of [...waiting]) {
        const through = [null, ...lined.filter((l) => l.sure || !sureOnly)]
        for (const via of through) {
          const from = via ? (recordings.find((x) => x.path === via.path) as SessionRecording) : own
          const o = pair(from, r)
          if (!o || !(sureOnly ? o.sure : sameSession(o))) continue
          lined.push(line(r, o, via))
          waiting.splice(waiting.indexOf(r), 1)
          found = true
          break
        }
      }
    }
  }
  const order = new Map(recordings.map((r, i) => [r.path, i]))
  lined.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0))
  return { home, lined, apart: waiting.map((r) => r.path) }
}

/**
 * Which recording is the person's own, by ear: the one whose voice is
 * loudest in it, as a player's own microphone is in their own recording and
 * the others only reach it through the voice chat. The level is the middle
 * of the loud moments, so one shout does not decide it.
 */
export function loudestVoice(recordings: SessionRecording[]): string | null {
  let best: { path: string; level: number } | null = null
  for (const r of recordings) {
    const loud = Array.from(r.env.db)
      .filter((v) => Number.isFinite(v) && v > -60)
      .sort((a, b) => b - a)
    if (loud.length === 0) continue
    // The middle of the loudest tenth: speech peaks, not a single bang.
    const top = loud.slice(0, Math.max(1, Math.floor(loud.length / 10)))
    const level = top[Math.floor(top.length / 2)]
    if (!best || level > best.level) best = { path: r.path, level }
  }
  return best?.path ?? null
}
