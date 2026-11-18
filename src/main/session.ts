import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { execFile } from 'child_process'
import { basename } from 'path'
import { promisify } from 'util'
import { z } from 'zod'
import { estimateOffset, trustworthy } from '../shared/audio/offset'
import type { LinedRecording } from '../shared/pov/lineup'
import { levels, type Envelope } from '../shared/audio/snap'
import { readApiKey } from './apikey'
import { loudnessEnvelope } from './audio-envelope'
import { FFMPEG_PATH, FFPROBE_PATH } from './ffmpeg'
import { PROBE_ARGS, readDuration, readProbe } from './intake'
import { MODEL } from './planner'

const run = promisify(execFile)

/**
 * A shoot is rarely one file. A creator drops in the camera clips they talk
 * in, a screen or recorder file with the better microphone, and B-roll, in any
 * order and any number. This works out which is which: first by measuring
 * every file, then by reading what the person said about them.
 */

export interface FileFacts {
  path: string
  name: string
  durationSec: number
  hasVideo: boolean
  hasAudio: boolean
  width: number
  height: number
  /** When the camera says it was recorded, if it says. */
  createdAt: string | null
  /**
   * How much of the first three minutes sounds like someone talking, 0 to 1:
   * loud enough, and rising and falling the way syllables do. Wind and room
   * tone are loud but steady, so they score low.
   */
  speech: number
}

export interface Roles {
  /** The recordings the edit is cut from, in the order they were shot. */
  talking: string[]
  /** Recordings whose sound goes under the talking footage instead of its own. */
  sound: string[]
  /** Footage to cut to. */
  broll: string[]
  ignored: string[]
  /** One or two plain sentences for the person, naming files by name. */
  reply: string
  /**
   * The other players' views of one gaming session, each lined up by ear
   * with the first talking recording, the person's own (shared/pov/lineup).
   */
  povs?: LinedRecording[]
  /** Whether Claude read the request, or the files were sorted by measurement alone. */
  by: 'claude' | 'measurement'
}

const SPEECH_WINDOW_SEC = 180

/** What a file is, measured: streams, length, and how much of it is talking. */
export async function factsFor(path: string): Promise<FileFacts> {
  // Whole streams, as intake reads them: the entries a narrower call names
  // differ between ffprobe versions, and the disposition that marks cover art
  // is only shown whole.
  const { stdout } = await run(FFPROBE_PATH, [...PROBE_ARGS, path])
  const json = JSON.parse(stdout) as { format?: { tags?: { creation_time?: string } } }
  // Cover art is a video stream too; readProbe leaves it out, as it is not footage.
  const facts = readProbe(JSON.parse(stdout))
  const durationSec = facts.durationSec > 0 ? facts.durationSec : await readDuration(FFPROBE_PATH, path)
  const hasVideo = facts.width > 0 && facts.height > 0
  const hasAudio = facts.audio !== null
  let speech = 0
  if (hasAudio) {
    try {
      const env = await loudnessEnvelope(FFMPEG_PATH, path, { durationSec: SPEECH_WINDOW_SEC })
      speech = speechShare(env.db, env.hopSec, levels(env).threshold)
    } catch {
      // Unreadable sound counts as no talking.
    }
  }
  return {
    path,
    name: basename(path),
    durationSec,
    hasVideo,
    hasAudio,
    width: facts.width,
    height: facts.height,
    createdAt: json.format?.tags?.creation_time ?? null,
    speech
  }
}

/** Share of one-second windows that are loud and fluctuate like syllables. */
export function speechShare(db: ArrayLike<number>, hopSec: number, threshold: number): number {
  const per = Math.max(1, Math.round(1 / hopSec))
  const windows = Math.floor(db.length / per)
  if (windows === 0) return 0
  let talking = 0
  for (let w = 0; w < windows; w++) {
    let above = 0
    let sum = 0
    let sq = 0
    for (let i = w * per; i < (w + 1) * per; i++) {
      const v = Math.max(-80, db[i])
      if (v > threshold) above++
      sum += v
      sq += v * v
    }
    const mean = sum / per
    const sd = Math.sqrt(Math.max(0, sq / per - mean * mean))
    if (above / per > 0.3 && sd > 4) talking++
  }
  return talking / windows
}

const shot = (f: FileFacts): string => `${f.createdAt ?? ''}|${f.name}`

/** Names screen and audio recorders give their files: OBS's date and time, QuickTime's, a recorder's. */
const RECORDER_NAME =
  /^\d{4}-\d{2}-\d{2}[ _]\d{2}[-.]\d{2}[-.]\d{2}|screen ?recording|recording|obs|zoom|riverside|audio|mic|^ZOOM\d|^TASCAM|^DR-?\d/i

/** Whether the person said the sound should come from another recording. */
const ASKS_FOR_OTHER_SOUND = /\b(computer|screen|obs|recorder|mic(rophone)?|lav|audio|sound)\b/i

/**
 * Sorting by measurement alone, for when Claude is not available. A clip is
 * talking when much of it sounds like speech: a short clip has to be clearly
 * talking, since B-roll with people in the background scores a little too.
 */
export function guessRoles(files: FileFacts[], request = ''): Roles {
  const videos = files.filter((f) => f.hasVideo)
  const soundOnly = files.filter((f) => !f.hasVideo && f.hasAudio)
  const talkingScore = (f: FileFacts): number => f.speech * f.durationSec
  let talking = videos.filter((f) => f.durationSec >= 2 && f.speech >= 0.25 && (f.durationSec >= 20 || f.speech >= 0.5))
  if (talking.length === 0 && videos.length > 0)
    talking = [videos.reduce((a, b) => (talkingScore(b) > talkingScore(a) ? b : a))]

  // A screen or recorder file the person says is "the audio" is sound, not picture.
  const sound = [...soundOnly]
  if (ASKS_FOR_OTHER_SOUND.test(request) && talking.length > 1) {
    const recorders = talking.filter((f) => RECORDER_NAME.test(f.name))
    if (recorders.length > 0 && recorders.length < talking.length) {
      talking = talking.filter((f) => !recorders.includes(f))
      sound.push(...recorders)
    }
  }
  talking.sort((a, b) => shot(a).localeCompare(shot(b)))
  const used = new Set([...talking, ...sound].map((f) => f.path))
  const broll = videos.filter((f) => !used.has(f.path))
  return {
    talking: talking.map((f) => f.path),
    sound: sound.map((f) => f.path),
    broll: broll.map((f) => f.path),
    ignored: [],
    reply: describeRoles(talking, sound, broll),
    by: 'measurement'
  }
}

/** Names in a sentence: "a.mp4", "a.mp4 and b.mp4", "a.mp4, b.mp4 and c.mp4". */
function names(list: { name: string }[]): string {
  if (list.length <= 1) return list[0]?.name ?? ''
  return `${list
    .slice(0, -1)
    .map((f) => f.name)
    .join(', ')} and ${list[list.length - 1].name}`
}

/** Which file is which, in plain sentences. */
function describeRoles(talking: FileFacts[], sound: FileFacts[], broll: FileFacts[]): string {
  return [
    talking.length ? `${names(talking)} ${talking.length === 1 ? 'is' : 'are'} the talking.` : '',
    sound.length ? `The sound comes from ${names(sound)}.` : '',
    broll.length ? `${names(broll)} ${broll.length === 1 ? 'is' : 'are'} B-roll.` : ''
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The same take recorded twice: a camera and a screen or computer recording
 * of one talk, or two cameras. Sorted by measurement alone, both are talking,
 * and the edit says everything twice. Two talking files whose sound lines up
 * by ear, over nearly all of the shorter one and closely, are one take: a
 * recorder file becomes the sound under the camera's picture, and a second
 * camera is left out, with a sentence saying /angle adds it. Different takes
 * of the same lines never line up that closely, as their timing differs.
 */
export async function separateSameTakes(
  roles: Roles,
  files: FileFacts[],
  envelopeOf: (path: string) => Promise<Envelope> = (path) => loudnessEnvelope(FFMPEG_PATH, path)
): Promise<Roles> {
  if (roles.talking.length < 2) return roles
  const byPath = new Map(files.map((f) => [f.path, f]))
  const fact = (path: string): FileFacts | undefined => byPath.get(path)
  const recorder = (path: string): boolean => RECORDER_NAME.test(fact(path)?.name ?? '')
  const envelopes = new Map<string, Promise<Envelope | null>>()
  const envelope = (path: string): Promise<Envelope | null> => {
    let e = envelopes.get(path)
    if (!e) {
      e = envelopeOf(path).catch(() => null)
      envelopes.set(path, e)
    }
    return e
  }
  const sameTake = async (a: string, b: string): Promise<boolean> => {
    const [ea, eb] = await Promise.all([envelope(a), envelope(b)])
    if (!ea || !eb) return false
    const o = estimateOffset(ea, eb)
    const shorter = Math.min(ea.db.length * ea.hopSec, eb.db.length * eb.hopSec)
    return trustworthy(o) && o.confidence >= 0.7 && o.overlapSec >= 0.8 * shorter
  }
  // Cameras first, so a recorder file is matched with the picture it goes under.
  const order = [...roles.talking].sort((a, b) => Number(recorder(a)) - Number(recorder(b)))
  const kept: string[] = []
  const sound = [...roles.sound]
  const repeats: { path: string; of: string }[] = []
  for (const path of order) {
    let twin: string | null = null
    for (const k of kept) {
      if (await sameTake(k, path)) {
        twin = k
        break
      }
    }
    if (twin === null) kept.push(path)
    else if (recorder(path)) sound.push(path)
    else repeats.push({ path, of: twin })
  }
  if (kept.length === roles.talking.length) return roles
  const talking = roles.talking.filter((p) => kept.includes(p))
  const list = (paths: string[]): FileFacts[] => paths.map(fact).filter((f): f is FileFacts => !!f)
  const reply = [
    describeRoles(list(talking), list(sound), list(roles.broll)),
    ...repeats.map(
      (r) =>
        `${fact(r.path)?.name} is the same take as ${fact(r.of)?.name} from another camera, so I left it out; /angle adds it as a second camera.`
    )
  ].join(' ')
  return { ...roles, talking, sound, reply }
}

const RoleSchema = z.object({
  talking: z
    .array(z.number().int())
    .describe('Numbers of the recordings the edit is cut from: someone talking to camera or in conversation.'),
  sound: z
    .array(z.number().int())
    .describe(
      "Numbers of recordings whose sound should replace the talking footage's own: the person asked for it, or it is plainly the better microphone recording of the same talking."
    ),
  broll: z.array(z.number().int()).describe('Numbers of recordings to cut to: footage that shows something.'),
  ignore: z.array(z.number().int()).describe('Numbers of recordings the person said not to use at all.'),
  reply: z
    .string()
    .describe(
      'One or two plain sentences telling the person which file is which, by file name. First person, no exclamation marks.'
    )
})

const ROLES_SYSTEM = `You sort a video creator's footage before an edit. They dropped several files and said something about them. Decide each file's role:
- talking: what the edit is cut from, a person talking. Usually camera files with a lot of speech. Several files can be talking clips of one shoot.
- sound: a recording whose sound goes under the talking footage instead of the camera's own, such as a computer, screen or recorder file that captured the same talking on a better microphone. Only when the person asked for it, or a file is clearly that.
- broll: footage to cut to, usually short and with little or no talking.
- ignore: files the person said not to use.
Every file gets exactly one role. Follow what the person said over the measurements; use the measurements when they said nothing. Never invent files.`

/** Reads what the person said about their files, with the measurements, and sorts them. */
export async function assignRoles(request: string, files: FileFacts[]): Promise<Roles> {
  const guess = guessRoles(files, request)
  const apiKey = readApiKey()
  if (!apiKey || files.length === 0) return guess
  const table = files
    .map(
      (f, i) =>
        `${i + 1}. ${f.name}: ${Math.round(f.durationSec)} s, ${f.hasVideo ? `${f.width}x${f.height} video` : 'sound only'}${
          f.hasAudio ? `, talking in ${Math.round(f.speech * 100)}% of the first 3 minutes` : ', no sound'
        }${f.createdAt ? `, recorded ${f.createdAt}` : ''}`
    )
    .join('\n')
  try {
    const client = new Anthropic({ apiKey })
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      system: ROLES_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `What they said:\n<request>${request || '(nothing)'}</request>\n\nThe files, with what was measured:\n${table}`
        }
      ],
      output_config: { effort: 'low', format: betaZodOutputFormat(RoleSchema) }
    })
    const r = response.parsed_output
    if (!r) return guess
    const pick = (list: number[]): FileFacts[] =>
      [...new Set(list)].filter((n) => n >= 1 && n <= files.length).map((n) => files[n - 1])
    const talking = pick(r.talking)
    const taken = new Set(talking.map((f) => f.path))
    const sound = pick(r.sound).filter((f) => !taken.has(f.path) && f.hasAudio)
    sound.forEach((f) => taken.add(f.path))
    const ignored = pick(r.ignore).filter((f) => !taken.has(f.path))
    ignored.forEach((f) => taken.add(f.path))
    // Anything left over is footage to cut to, so nothing dropped in is lost.
    const broll = files.filter((f) => f.hasVideo && !taken.has(f.path))
    if (talking.length === 0) return guess
    talking.sort((a, b) => shot(a).localeCompare(shot(b)))
    return {
      talking: talking.map((f) => f.path),
      sound: sound.map((f) => f.path),
      broll: broll.map((f) => f.path),
      ignored: ignored.map((f) => f.path),
      reply: r.reply.trim() || guess.reply,
      by: 'claude'
    }
  } catch {
    return guess
  }
}
