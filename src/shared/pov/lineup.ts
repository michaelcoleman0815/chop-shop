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

/** Sure enough to cut between two players' views on it: the voice chat lines up clearly. */
export function sameSession(o: Offset | null): o is Offset {
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
 * alike at the very ends never beat the real line-up.
 */
const SHARED_SEC = 60
/** How long the stretches checked on their own are, and how far either side of the whole's line-up they look. */
const STRETCH_SEC = 90
const STRETCH_REACH_SEC = 2
/** Recordings sharing this much or more are checked in stretches, and for drift. */
const STRETCHES_FROM_SEC = 600

const round3 = (v: number): number => Math.round(v * 1000) / 1000

/** How two recordings of one session line up. */
export interface Pairing extends Offset {
  /** How far the line-up moves from near the start of what they share to near its end, when that was long enough to measure. */
  driftSec: number | null
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
 * Where another recording of the session sits against home: matched over
 * all they share first, which finds it give or take a fraction of a second;
 * then, when they share ten minutes or more, matched again in three
 * stretches (near the start, the middle and the end) each on its own. Two
 * recorders' clocks never run at exactly the same rate, so over an hour the
 * line-up can move by a few frames; matched over the whole, that blurs the
 * match, while each stretch stays sharp. The line-up taken is the middle
 * one, so neither end is out by more than half the drift, and the drift is
 * the move from the first stretch to the last.
 */
export function pairUp(homeLoudness: Envelope, otherLoudness: Envelope): Pairing | null {
  const home = chatActivity(homeLoudness)
  const other = chatActivity(otherLoudness)
  const homeSec = home.db.length * home.hopSec
  const otherSec = other.db.length * other.hopSec
  const whole = estimateOffset(home, other, { minOverlapSec: SHARED_SEC })
  if (!whole) return null
  const start = Math.max(0, -whole.offsetSec)
  const end = Math.min(homeSec, otherSec - whole.offsetSec)
  if (end - start < STRETCHES_FROM_SEC) return { ...whole, driftSec: null }
  const len = Math.min(STRETCH_SEC, (end - start) / 4)
  const reach = STRETCH_REACH_SEC + 1
  const [early, middle, late] = [start + reach, (start + end - len) / 2, end - len - reach].map((at) =>
    stretch(home, other, at, len, whole.offsetSec)
  )
  const heard = [early, middle, late].filter((o): o is Offset => o !== null)
  // Fewer than two stretches heard clearly: the whole is all there is to go on.
  if (heard.length < 2) return { ...whole, driftSec: null }
  const confidences = heard.map((o) => o.confidence).sort((a, b) => a - b)
  return {
    offsetSec: middle?.offsetSec ?? round3(((early as Offset).offsetSec + (late as Offset).offsetSec) / 2),
    confidence: confidences[Math.floor(confidences.length / 2)],
    margin: whole.margin,
    overlapSec: whole.overlapSec,
    driftSec: early && late ? round3(late.offsetSec - early.offsetSec) : null
  }
}

/** Lines every recording up with home, directly or through one that already is. */
export function lineUpSession(recordings: SessionRecording[], home: string): SessionLineUp {
  const own = recordings.find((r) => r.path === home)
  if (!own) throw new Error('The home recording is not one of them.')
  const lined: LinedRecording[] = []
  const waiting = recordings.filter((r) => r.path !== home)
  const line = (r: SessionRecording, o: Pairing, via: LinedRecording | null): LinedRecording => ({
    path: r.path,
    offsetSec: round3((via?.offsetSec ?? 0) + o.offsetSec),
    confidence: o.confidence,
    overlapSec: o.overlapSec,
    via: via?.path ?? null,
    driftSec: via ? null : o.driftSec
  })
  // Home first; then, round by round, through whatever has lined up so far.
  for (const r of [...waiting]) {
    const o = pairUp(own.env, r.env)
    if (o && sameSession(o)) {
      lined.push(line(r, o, null))
      waiting.splice(waiting.indexOf(r), 1)
    }
  }
  let found = true
  while (found && waiting.length > 0) {
    found = false
    for (const r of [...waiting]) {
      for (const through of lined) {
        const mid = recordings.find((x) => x.path === through.path) as SessionRecording
        const o = pairUp(mid.env, r.env)
        if (!o || !sameSession(o)) continue
        lined.push(line(r, o, through))
        waiting.splice(waiting.indexOf(r), 1)
        found = true
        break
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
