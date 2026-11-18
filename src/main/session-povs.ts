import { basename } from 'path'
import { buildAudioMap, type AudioMap } from '../shared/audio/map'
import { shiftFrames } from '../shared/audio/offset'
import type { Envelope } from '../shared/audio/snap'
import { currentCut, throughId, type EditDoc } from '../shared/edit'
import { ownSoundKey, povLabels } from '../shared/pov/choose'
import { lineUpSession, loudestVoice, type SessionRecording } from '../shared/pov/lineup'
import { loudnessEnvelope } from './audio-envelope'
import { listenFrames } from './audio-map'
import { FFMPEG_PATH } from './ffmpeg'
import type { FileFacts, Roles } from './session'

/**
 * Several players' recordings of one gaming session, worked out when they
 * are dropped in together: the talking files are lined up by the voice chat
 * they share, the person's own first (as they said, or the loudest voice),
 * and the rest become their views, lined up with it (shared/pov/lineup).
 * Then each view is heard on the person's own clock (hearViews), so whose
 * voice, laugh or bang each moment is can be told (shared/pov/choose).
 */

/**
 * Words that say the files are several players' views of one session. A
 * session alone is not enough: a talk recorded on a camera and a computer is
 * a session too.
 */
const SESSION_WORDS =
  /\b(povs?|points? of view|perspectives?|each (?:of us|player)|every player|other players?|teammates?|their views?|everyone['’]?s views?|multiplayer|squad|duo|trio|lobby|(?:game|gaming|play) session)\b/i

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']

/** Saying a file is theirs: "mine is", "my pov is", "I'm in", "is me". */
const MINE = /\b(mine|my (?:pov|view|recording|one|footage|screen)|i['’]?m|i am|is me|that['’]?s me)\b/i

/** Saying whose sound to use: "the sound from pov-2", "use pov-3's audio", "Teo's mix". */
const SOUND = /\b(sound|audio|mix)\b/i

/**
 * The recording the person says is theirs: "mine is pov-2", "my pov is the
 * second one", "I'm in pov 3", "pov-1 is me". Matched on the part of each
 * file name that is its own, or on its place among them.
 */
export function saidHome(request: string, files: { path: string; name: string }[]): string | null {
  return saidOf(request, files, (sentence) => MINE.test(sentence) && !SOUND.test(sentence))
}

/**
 * The recording whose sound the person asks for under every view: "use the
 * sound from pov-2", "pov-3's audio". Null when they did not say, and the
 * edit keeps their own recording's: their microphone and their game.
 */
export function saidSound(request: string, files: { path: string; name: string }[]): string | null {
  return saidOf(request, files, (sentence) => SOUND.test(sentence))
}

function saidOf(request: string, files: { path: string; name: string }[], about: (sentence: string) => boolean): string | null {
  if (files.length < 2) return null
  const labels = povLabels(files.map((f) => f.name)).map((l) => l.toLowerCase())
  for (const sentence of request.replace(/\.(mp4|mov|mkv|m4v|webm|avi)\b/gi, '').split(/[.,;!?\n]+/)) {
    if (!about(sentence)) continue
    const said = sentence.toLowerCase()
    const named = labels
      .map((label, i) => ({ i, label, at: label.length >= 2 ? said.indexOf(label) : -1 }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => b.label.length - a.label.length)[0]
    if (named) return files[named.i].path
    const nth = ORDINALS.findIndex((o) => new RegExp(`\\b${o}\\b`).test(said))
    if (nth >= 0 && nth < files.length) return files[nth].path
    const num = /\b(?:pov|number|no\.?|#)\s*(\d)\b/.exec(said)
    if (num) {
      const digit = new RegExp(`(^|\\D)${num[1]}(\\D|$)`)
      const byName = files.findIndex((f) => digit.test(f.name.replace(/\.[^.]+$/, '')))
      if (byName >= 0) return files[byName].path
    }
  }
  return null
}

/** Words that say the files are something else: one talk from several cameras, or takes. */
const NOT_SESSION = /\b(cameras?|cam [a-d]|same take|podcast|interview|not (?:a |one )?(?:game |gaming )?session)\b/i

/** A drift of more than a frame at 30 fps is worth a sentence. */
const DRIFT_SAID_SEC = 0.04

/**
 * The roles with a session found in them, or as they were. When the words or
 * the names say the files are players' views, every recording with picture
 * and sound is one, however it was sorted. Otherwise three or more talking
 * recordings that line up are one, unless the words say they are cameras of
 * one talk; two alone never are, since two cameras of one talk line up just
 * as well (session: separateSameTakes). A file that lines up with none of the
 * others is said plainly and kept as footage to cut to.
 */
export async function findSession(
  roles: Roles,
  files: FileFacts[],
  request: string,
  envelopeOf: (path: string) => Promise<Envelope> = (path) => loudnessEnvelope(FFMPEG_PATH, path, { voice: true })
): Promise<Roles> {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const recorded = (paths: string[]): FileFacts[] =>
    paths.map((p) => byPath.get(p)).filter((f): f is FileFacts => !!f && f.hasVideo && f.hasAudio)
  const all = recorded([...roles.talking, ...roles.broll, ...roles.sound])
  const named = all.length >= 2 && all.every((f) => /\b(pov|perspective|player)\b/i.test(f.name.replace(/[-_.]/g, ' ')))
  const said = SESSION_WORDS.test(request) || named
  const views = said ? all : recorded(roles.talking)
  if (views.length < 2) return roles
  if (!said && (views.length < 3 || NOT_SESSION.test(request))) return roles
  const recordings: SessionRecording[] = []
  for (const f of views) {
    try {
      recordings.push({ path: f.path, env: await envelopeOf(f.path) })
    } catch {
      // Sound that cannot be read cannot be lined up: that file stays as it was.
    }
  }
  if (recordings.length < 2) return roles
  const told = saidHome(request, views)
  const home = told && recordings.some((r) => r.path === told) ? told : (loudestVoice(recordings) ?? recordings[0].path)
  const up = lineUpSession(recordings, home)
  if (up.lined.length === 0) return roles
  const name = (p: string): string => byPath.get(p)?.name ?? basename(p)
  const list = (paths: string[]): string =>
    paths.length <= 1
      ? (paths[0] ? name(paths[0]) : '')
      : `${paths.slice(0, -1).map(name).join(', ')} and ${name(paths[paths.length - 1])}`
  const others = up.lined.map((l) => l.path)
  const reply: string[] = [
    `This is one session from ${up.lined.length + 1} players’ views: I lined ${list(others)} up with yours, ${name(home)}, by the voice chat.`,
    told === home
      ? `${name(home)} is yours, as you said.`
      : `I took ${name(home)} as yours, as its microphone is the loudest; if it isn’t, drop them again and say which one is yours.`
  ]
  for (const l of up.lined)
    if (l.driftSec !== null && Math.abs(l.driftSec) > DRIFT_SAID_SEC)
      reply.push(
        `${name(l.path)}’s clock runs a little apart from yours, ${Math.abs(l.driftSec).toFixed(2)} s over the session, so I lined it up in the middle; near the start and the end it can be up to ${(Math.abs(l.driftSec) / 2).toFixed(2)} s out.`
      )
  for (const p of up.apart)
    reply.push(`${name(p)} doesn’t line up with the others by ear, so it isn’t part of the session; it’s in as footage to cut to.`)
  // The sound under every view is theirs (their microphone and their game) unless they ask for another player's.
  const asked = saidSound(request, views)
  const heard = asked && others.includes(asked) ? asked : null
  if (heard) reply.push(`The sound under every view is ${name(heard)}’s, as you asked.`)
  if (!said) reply.push('If they aren’t one gaming session, drop them again and say what they are.')
  const taken = new Set([home, ...others, ...up.apart])
  const rest = (paths: string[]): string[] => paths.filter((p) => !taken.has(p))
  return {
    ...roles,
    // The person's own view is the edit; any other talking that is not part of the session stays talking.
    talking: [home, ...rest(roles.talking)],
    // Another player's recording asked for as the sound goes under theirs, lined up as a recorder's is.
    sound: heard ? [heard] : rest(roles.sound),
    broll: [...rest(roles.broll), ...up.apart],
    reply: reply.join(' '),
    povs: up.lined
  }
}

/**
 * Each other player's view of a session heard on the person's own clock:
 * its sound laid onto theirs by the line-up and measured against the words
 * of theirs, kept as an audio map under home@view; home's own too, when it
 * never was (a recording that could not be transcribed).
 */
export async function hearViews(
  doc: EditDoc,
  progress: (stage: string, percent: number) => void = () => undefined,
  ffmpeg = FFMPEG_PATH
): Promise<Record<string, AudioMap>> {
  const views = (currentCut(doc).angles ?? []).filter((a) => !doc.audio?.[throughId(a.of, a.source)])
  const maps: Record<string, AudioMap> = {}
  for (const [i, a] of views.entries()) {
    const home = doc.sources.find((s) => s.id === a.of)
    const view = doc.sources.find((s) => s.id === a.source)
    if (!home || !view) continue
    progress(
      `Listening to ${basename(view.path)}${views.length > 1 ? ` (${i + 1} of ${views.length})` : ''}`,
      Math.round((i / views.length) * 100)
    )
    const words = doc.words.filter((w) => w.source === home.id)
    const frames = await listenFrames(ffmpeg, view.path)
    maps[throughId(home.id, view.id)] = buildAudioMap(shiftFrames(frames, a.offsetSec, home.durationSec), words)
    // Theirs as their own recording has it: when the edit's sound is another recording's, its own file is
    // still what tells their voice and their laughs from everyone else's (shared/pov/choose: povSounds).
    const own = ownSoundKey(home)
    if (!doc.audio?.[own] && !maps[own]) maps[own] = buildAudioMap(await listenFrames(ffmpeg, home.path), words)
  }
  // What the credits say once it is done: all of them, not the last one.
  if (views.length > 1) progress('Listening to the other players’ views', 100)
  return maps
}
