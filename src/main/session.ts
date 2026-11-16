import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { execFile } from 'child_process'
import { basename } from 'path'
import { promisify } from 'util'
import { z } from 'zod'
import { levels } from '../shared/audio/snap'
import { readApiKey } from './apikey'
import { loudnessEnvelope } from './audio-envelope'
import { FFMPEG_PATH, FFPROBE_PATH } from './ffmpeg'
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
  /** Whether Claude read the request, or the files were sorted by measurement alone. */
  by: 'claude' | 'measurement'
}

const SPEECH_WINDOW_SEC = 180

/** What a file is, measured: streams, length, and how much of it is talking. */
export async function factsFor(path: string): Promise<FileFacts> {
  const { stdout } = await run(FFPROBE_PATH, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_entries',
    'format=duration:format_tags=creation_time:stream=codec_type,width,height,disposition',
    path
  ])
  const json = JSON.parse(stdout) as {
    format?: { duration?: string; tags?: { creation_time?: string } }
    streams?: { codec_type?: string; width?: number; height?: number; disposition?: { attached_pic?: number } }[]
  }
  const streams = json.streams ?? []
  // Cover art is a video stream too; it is not footage.
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const hasAudio = streams.some((s) => s.codec_type === 'audio')
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
    durationSec: Number(json.format?.duration ?? 0),
    hasVideo: !!video,
    hasAudio,
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
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

/** Sorting by measurement alone, for when Claude is not available. */
export function guessRoles(files: FileFacts[], request = ''): Roles {
  const videos = files.filter((f) => f.hasVideo)
  const soundOnly = files.filter((f) => !f.hasVideo && f.hasAudio)
  const talkingScore = (f: FileFacts): number => f.speech * f.durationSec
  let talking = videos.filter((f) => f.speech >= 0.25 && f.durationSec >= 20)
  if (talking.length === 0 && videos.length > 0)
    talking = [videos.reduce((a, b) => (talkingScore(b) > talkingScore(a) ? b : a))]
  if (talking.length === 0 && soundOnly.length > 0) talking = []

  // A screen or recorder file the person says is "the audio" is sound, not picture.
  const sound = [...soundOnly]
  const asksForOtherSound = /\b(computer|screen|obs|recorder|mic(rophone)?|lav|audio)\b/i.test(request)
  if (asksForOtherSound && talking.length > 1) {
    const longest = Math.max(...talking.map((f) => f.durationSec))
    const screen = talking.find(
      (f) => /^\d{4}-\d{2}-\d{2}[ _]\d{2}-\d{2}-\d{2}|screen|recording|obs/i.test(f.name) && f.durationSec >= longest * 0.5
    )
    if (screen) {
      talking = talking.filter((f) => f !== screen)
      sound.push(screen)
    }
  }
  talking.sort((a, b) => shot(a).localeCompare(shot(b)))
  const used = new Set([...talking, ...sound].map((f) => f.path))
  const broll = videos.filter((f) => !used.has(f.path))
  const names = (list: FileFacts[]): string => list.map((f) => f.name).join(', ')
  const reply = [
    talking.length ? `${names(talking)} ${talking.length === 1 ? 'is' : 'are'} the talking.` : '',
    sound.length ? `The sound comes from ${names(sound)}.` : '',
    broll.length ? `${names(broll)} ${broll.length === 1 ? 'is' : 'are'} B-roll.` : ''
  ]
    .filter(Boolean)
    .join(' ')
  return {
    talking: talking.map((f) => f.path),
    sound: sound.map((f) => f.path),
    broll: broll.map((f) => f.path),
    ignored: [],
    reply,
    by: 'measurement'
  }
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
