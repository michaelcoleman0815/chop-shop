import { app, ipcMain, type WebContents } from 'electron'
import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { FFMPEG_PATH, probe } from './ffmpeg'
import { getSettings } from './store'
import { downloadModel, hasModel, transcribe } from './transcribe'
import type { WhisperModel } from './whisper-args'
import { listenFrames } from './audio-map'
import { loudnessEnvelope } from './audio-envelope'
import { readAnalysis } from './analysis-cache'
import { readBrand, readBrandById } from './brand-store'
import { brandInSentence, stampMade } from '../shared/brands'
import { neverFinishNote, stripDoc, type NeverItem } from '../shared/never'
import { neverForBrand } from './memory'
import { readApiKey } from './apikey'
import { suggestClips } from './clips'
import { localHost } from './local-server'
import { isLocalUp, localModels } from './local-llm'
import { claudeErrorText, MODEL } from './planner'
import { detectFaces, hasFaceFinder, type VisionSample } from './track'
import { downloadSpeakerModel, findSpeakers } from './speakers'
import { displaySize, measureMouth } from './mouth'
import { linkFaces, planCrops } from '../shared/vision/faces'
import { seatsOfSpeakers, subjectOfSpeakers, type MouthFrames } from '../shared/speakers/seats'
import { NO_FACE_FINDER, thisComputer } from '../shared/platform'
import { detectShots } from './shots'
import { buildAudioMap, type Frames } from '../shared/audio/map'
import { snapWords, type Envelope } from '../shared/audio/snap'
import { brandStyle, type Brand } from '../shared/brand'
import { commit, crowdShare, currentCut, subjectFrom, type Source, type Subject, type Word } from '../shared/edit'
import {
  clipDoc,
  clipsReply,
  measureRecording,
  MIN_RECORDING_SEC,
  planRecording,
  readClipAsk,
  recordingNames,
  shapePicks,
  startsClause,
  strongOpening,
  wordsToRead,
  type ClipAsk,
  type ClipProfile,
  type ClipsFound,
  type ClipsReply,
  type FoundClip,
  type FoundRecording,
  type Picker,
  type RecordingFacts,
  type RecordingPlan,
  type SoundStretch
} from '../shared/clipping'
import { CLOSE_PROMPT, cutsOnPauses, heardClosely } from '../shared/clipping/restarts'
import type { SuggestedClip, Transcript, TranscriptWord } from '../shared/types'
import { saidDetails, toolSaid, type Detail } from '../shared/failure'
import { withoutSoundNotes } from './whisper-parse'
import { sermonPad, type BedMood } from './pads'
import { keyWordsFor } from './key-words'
import { presetById } from '../shared/caption-presets'
import type { CaptionSpec } from '../shared/edit/schema'

/**
 * /clipping, the main process's half: many short clips from long
 * recordings. For each recording it hears every word (once, then kept),
 * listens to what it sounds like, looks for a frozen picture, and works out
 * what is left out (shared/clipping/plan). Then the moments are picked:
 * Claude through the clip finder's prompt when there is a key, a model on
 * this Mac through Ollama when one runs, and measuring when there is
 * neither. Each moment becomes its own edit, vertical and captioned.
 *
 * Everything but Claude's read of the words happens on this computer.
 */

type Send = (sender: WebContents, channel: string, payload: unknown) => void

export interface ClipFindRequest {
  paths: string[]
  /** What was typed with the command. */
  ask: string
  /** What Claude read in the words of a request that was not /clipping: how many, how long, what about. */
  asked?: ClipAsk
  /** Words already heard, by recording, from the edit they are in. */
  known?: Record<string, TranscriptWord[]>
  /** Clips the set already has: a new run finds others. */
  avoid?: { path: string; startSec: number; endSec: number }[]
  /** The chat's brand, by id (shared/brands): its kind of video and caption look. The default when absent. */
  brand?: string | null
  /**
   * Shorter than this, a recording counts as short and nothing is heard: a recording dropped in with no
   * words is clipped only when it is long, and anything shorter is edited as it always was.
   */
  minSec?: number
}

export type ClipFindResult =
  | ({ ok: true; reply: ClipsReply } & ClipsFound)
  | { ok: false; message: string; details?: Detail[] }

export interface ClipProgress {
  stage: string
  percent: number | null
}

/** What a recording is measured with. Tests hand in their own. */
export interface ClippingTools {
  probe: (path: string) => Promise<{
    durationSec: number
    width: number
    height: number
    fps: number
    hasAudio: boolean
    color?: Source['color']
  }>
  /** Every word, with progress as a share of the recording heard. */
  transcribe: (path: string, durationSec: number, progress: (fraction: number) => void) => Promise<TranscriptWord[]>
  /** What it sounds like, stretch by stretch, and its loudness every half second. */
  listen: (
    path: string,
    words: TranscriptWord[]
  ) => Promise<{ sounds: SoundStretch[]; loudness: { hopSec: number; db: number[] } }>
  /**
   * A stretch heard again closely, with what was broken off written so (shared/clipping/restarts
   * CLOSE_PROMPT), on the recording's clock; on the model the recording was heard with for its clips, so the
   * words read as they did. Absent, a clip keeps the words first heard.
   */
  hear?: (path: string, startSec: number, durationSec: number, recordingSec: number) => Promise<TranscriptWord[]>
  /** Where the picture holds still for at least `minSec`. */
  frozen: (path: string, durationSec: number) => Promise<{ startSec: number; endSec: number }[]>
  envelope: (path: string, startSec: number, durationSec: number) => Promise<Envelope>
  /** The face finder, on a Mac; null where there is none. */
  faces: ((path: string, startSec: number, durationSec: number) => Promise<VisionSample[]>) | null
  /**
   * Who says each word, 0, 1, 2... (main/speakers), for a recording of more than one voice; null where it
   * can't say. Absent, nobody is told apart.
   */
  speakers?: (path: string, words: TranscriptWord[], progress: (fraction: number) => void) => Promise<(number | null)[]>
  /**
   * Each face's mouth, frame by frame, over a stretch (main/mouth), from face samples timed from `startSec`.
   * Absent or null, a clip follows the largest face rather than whoever is talking.
   */
  mouth?: (path: string, samples: VisionSample[], startSec: number, durationSec: number) => Promise<MouthFrames | null>
  shots: (path: string, startSec: number, durationSec: number) => Promise<number[]>
  /** Who picks the moments. */
  engine: () => Promise<{ by: Picker; model: string | null }>
  suggest: typeof suggestClips
  brand: () => Promise<Brand>
  /** Where what was heard and measured is kept, by file. */
  cacheDir: string
  /** The nth clip's bed, for a kind of clip that has one (main/pads); absent lays none. */
  pad?: (n: number, mood?: BedMood) => Promise<{ path: string; durationSec: number; lufs: number | null } | null>
  /**
   * The words each clip's speaker leans on, by index, for captions that pick them out, and each clip's hook,
   * for looks that put one on screen (main/key-words).
   */
  keyWords?: (clips: string[][]) => Promise<{ keys: number[][]; hooks: string[]; opens?: number[]; moods?: BedMood[] }>
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** From this long, a recording is heard for its clips on the small model, whatever Settings choose for edits. */
export const FAST_HEARING_SEC = 10 * 60

/**
 * The model a recording is heard with for its clips. Always one guess at each step (main/whisper-args
 * greedy). On an hour's service the medium model's search took about as long as the service itself; the
 * small model with one guess took an eighth of that and wrote the same words on a sermon (measured on the
 * owner's own Sunday service), so a long recording takes it when it is there. A smaller choice stays.
 */
export function clippingModel(chosen: WhisperModel, durationSec: number, haveSmall: boolean): WhisperModel {
  const large = chosen === 'medium.en' || chosen === 'large-v3-turbo'
  return large && durationSec >= FAST_HEARING_SEC && haveSmall ? 'small.en' : chosen
}

// ---------- Kept from before ----------

/** Bumped when what is kept changes shape, so an old file is measured again. */
const CACHE_VERSION = 2

interface Kept {
  v: number
  durationSec: number
  words: TranscriptWord[] | null
  sounds: SoundStretch[] | null
  loudness: { hopSec: number; db: number[] } | null
  frozen: { startSec: number; endSec: number }[] | null
}

async function keyFor(path: string): Promise<string> {
  const stat = await fs.stat(path)
  return createHash('sha1').update(`${path} ${stat.mtimeMs} ${stat.size}`).digest('hex').slice(0, 16)
}

async function readKept(dir: string, path: string): Promise<Kept | null> {
  try {
    const kept = JSON.parse(await fs.readFile(join(dir, `${await keyFor(path)}.json`), 'utf8')) as Kept
    return kept.v === CACHE_VERSION ? kept : null
  } catch {
    return null
  }
}

async function writeKept(dir: string, path: string, kept: Kept): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, `${await keyFor(path)}.json`)
    // Written whole, then renamed: a kill mid-write never leaves half a transcript to trust.
    await fs.writeFile(`${file}.tmp`, JSON.stringify(kept))
    await fs.rename(`${file}.tmp`, file)
  } catch {
    // Keeping it is a saving of time; failing to keep it must not fail the clips.
  }
}

// ---------- Measuring ----------

/** The audio map's stretches and a loudness every half second, from one listen. */
export function soundsOf(
  frames: Frames,
  words: TranscriptWord[]
): { sounds: SoundStretch[]; loudness: { hopSec: number; db: number[] } } {
  const map = buildAudioMap(
    frames,
    words.map((w, i) => ({ id: `w${i + 1}`, startSec: w.startSec, endSec: w.endSec }))
  )
  const hop = 0.5
  const per = Math.max(1, Math.round(hop / frames.hopSec))
  const db: number[] = []
  for (let i = 0; i < frames.db.length; i += per) {
    let sum = 0
    let n = 0
    for (let k = i; k < Math.min(frames.db.length, i + per); k++) {
      // Power, not decibels, is what averages.
      sum += Math.pow(10, frames.db[k] / 10)
      n++
    }
    db.push(Math.round(10 * Math.log10(sum / Math.max(1, n) + 1e-12) * 10) / 10)
  }
  return { sounds: map.segments, loudness: { hopSec: hop, db } }
}

/**
 * Where the picture holds still for half a minute or more, read from the
 * keyframes alone: decoding a two-hour stream's every frame to find its BRB
 * screen would take longer than the rest of clipping together. Works the same
 * on ffmpeg 6.0, 6.1 and 7.0.
 */
export function frozenStretches(
  ffmpeg: string,
  path: string,
  durationSec: number,
  minSec = 30
): Promise<{ startSec: number; endSec: number }[]> {
  const args = [
    '-hide_banner',
    '-nostats',
    '-skip_frame',
    'nokey',
    '-i',
    path,
    '-an',
    '-sn',
    '-vf',
    `scale=96:-2,freezedetect=n=0.003:d=${Math.max(2, minSec)},metadata=print:file=-`,
    '-f',
    'null',
    '-'
  ]
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args)
    let text = ''
    child.stdout.on('data', (d) => (text += d.toString()))
    child.stderr.on('data', () => undefined)
    child.on('error', () => resolve([]))
    child.on('close', () => {
      const out: { startSec: number; endSec: number }[] = []
      let start: number | null = null
      for (const m of text.matchAll(/lavfi\.freezedetect\.freeze_(start|end)=([\d.]+)/g)) {
        const t = Number(m[2])
        if (m[1] === 'start') start = t
        else if (start !== null) {
          out.push({ startSec: start, endSec: t })
          start = null
        }
      }
      // Still frozen when the recording ends.
      if (start !== null) out.push({ startSec: start, endSec: durationSec })
      resolve(out)
    })
  })
}

/** The tools of this computer: ffmpeg, whisper, the Mac's face finder, and whoever picks. */
export function defaultTools(): ClippingTools {
  return {
    probe: async (path) => {
      const meta = await probe(path)
      const color = meta.facts?.color
      return {
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        fps: meta.fps > 0 ? meta.fps : 30,
        hasAudio: meta.facts ? meta.facts.audio !== null : true,
        ...(color && color !== 'sdr' ? { color } : {})
      }
    },
    transcribe: async (path, durationSec, progress) => {
      const { whisperModel } = getSettings()
      const model = clippingModel(whisperModel, durationSec, await hasModel('small.en'))
      if (!(await hasModel(model))) await downloadModel(model, () => undefined)
      const heard: Transcript = await transcribe(
        path,
        model,
        durationSec,
        (p, stage) => {
          if (stage === 'Transcribing') progress(Math.max(0, Math.min(1, (p - 12) / 86)))
        },
        0,
        undefined,
        { greedy: true, align: true }
      )
      return heard.words
    },
    listen: async (path, words) => soundsOf(await listenFrames(FFMPEG_PATH, path), words),
    hear: async (path, startSec, durationSec, recordingSec) => {
      const model = clippingModel(getSettings().whisperModel, recordingSec, await hasModel('small.en'))
      if (!(await hasModel(model))) return []
      const verbatim = { names: [], again: false, prompt: CLOSE_PROMPT }
      return (await transcribe(path, model, durationSec, () => undefined, startSec, verbatim)).words
    },
    frozen: (path, durationSec) => frozenStretches(FFMPEG_PATH, path, durationSec),
    envelope: (path, startSec, durationSec) => loudnessEnvelope(FFMPEG_PATH, path, { startSec, durationSec }),
    faces: hasFaceFinder()
      ? (path, startSec, durationSec) => detectFaces(path, startSec, durationSec, FACE_HZ)
      : null,
    shots: (path, startSec, durationSec) => detectShots(path, startSec, durationSec).catch(() => []),
    speakers: async (path, words, progress) => {
      await downloadSpeakerModel()
      return (await findSpeakers(FFMPEG_PATH, path, words, { onProgress: progress })).words
    },
    mouth: async (path, samples, startSec, durationSec) => {
      const meta = await probe(path)
      const frame = await displaySize(FFMPEG_PATH, path, { width: meta.width, height: meta.height })
      const fps = meta.fps > 0 ? meta.fps : 30
      const plan = planCrops(linkFaces(samples.map((s) => ({ t: s.t + startSec, faces: s.faces }))), { ...frame, fps })
      if (plan.slots.length < 2) return null
      const raw = await measureMouth(FFMPEG_PATH, path, plan, { fps, startSec, durationSec })
      return { times: raw.times, slots: raw.slots }
    },
    engine: chooseEngine,
    suggest: suggestClips,
    brand: readBrand,
    cacheDir: join(app.getPath('userData'), 'clipping'),
    pad: (n, mood) => sermonPad(join(app.getPath('userData'), 'pads'), n, FFMPEG_PATH, mood),
    keyWords: keyWordsFor
  }
}

/**
 * Who picks: a model on this Mac when the person chose one for planning, then
 * Claude when there is a key, then whatever Ollama has pulled, then measuring.
 */
export async function chooseEngine(): Promise<{ by: Picker; model: string | null }> {
  const settings = getSettings()
  const chosen =
    settings.localPlanner ?? (settings.clipModel?.startsWith('ollama:') ? settings.clipModel.slice(7) : null)
  const host = await localHost()
  if (chosen && (await isLocalUp(host))) return { by: 'local', model: chosen }
  if (readApiKey()) return { by: 'claude', model: MODEL }
  if (await isLocalUp(host)) {
    const models = await localModels(host).catch(() => [])
    // The biggest that fits a laptop's memory; a 70B model takes minutes a transcript.
    const fits = models.filter((m) => m.sizeBytes <= 20e9).sort((a, b) => b.sizeBytes - a.sizeBytes)
    const pick = fits[0] ?? [...models].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]
    if (pick) return { by: 'local', model: pick.name }
  }
  return { by: 'measured', model: null }
}

// ---------- Picking ----------

/** Words per request: Claude reads a long service whole; a local model's window is 32k tokens. */
const CHUNK_WORDS = { claude: 30000, local: 9000 }

/** The moments a model picks, read in parts small enough for it, then held to the rules. */
async function pickWithModel(
  tools: ClippingTools,
  engine: { by: 'claude' | 'local'; model: string | null },
  facts: RecordingFacts,
  plan: RecordingPlan,
  ask: ClipAsk,
  avoid: { startSec: number; endSec: number }[]
): Promise<{ startSec: number; endSec: number; title: string; hook: string; reason: string; score: number }[]> {
  const words = wordsToRead(facts.words, plan.regions)
  const size = CHUNK_WORDS[engine.by]
  // A couple more than are wanted, so a moment filmed through the crowd can give way to one filmed from the front.
  const want = plan.count + SPARE_PICKS
  const parts: TranscriptWord[][] = []
  for (let i = 0; i < words.length; i += size) parts.push(words.slice(i, i + size))
  const model = engine.by === 'local' ? `ollama:${engine.model}` : (engine.model ?? MODEL)
  const music = plan.regions
    .filter((r) => r.kind === 'worship')
    .map((r) => ({ startSec: r.startSec, endSec: r.endSec }))
  // Asked for more than were found already: the model is told what is taken.
  const steer = [
    ask.said,
    avoid.length
      ? `Leave out the moments already clipped: ${avoid.map((a) => `${Math.round(a.startSec)} to ${Math.round(a.endSec)} s`).join(', ')}.`
      : ''
  ]
    .filter(Boolean)
    .join('\n')
  const picked: SuggestedClip[] = []
  for (const part of parts) {
    const share = part.length / Math.max(1, words.length)
    const maxClips = Math.max(1, Math.round(want * share + 0.49))
    const transcript: Transcript = { words: part, text: part.map((w) => w.text).join(' '), language: 'en' }
    picked.push(
      ...(await tools.suggest(
        transcript,
        facts.durationSec,
        maxClips,
        model,
        { minSec: plan.bounds.minSec, maxSec: plan.bounds.maxSec },
        steer || undefined,
        plan.profile.genre,
        music
      ))
    )
  }
  return shapePicks(picked, {
    words: facts.words,
    sentences: plan.sentences,
    regions: plan.regions,
    bounds: plan.bounds,
    avoid
  }).slice(0, want)
}

/**
 * How often the face finder looks, a second: often enough to keep up with a service's camera operator
 * panning after a preacher who walks, in a clip's close vertical window.
 */
export const FACE_HZ = 4

/** Moments picked beyond the count, to choose between on what the picture shows. */
const SPARE_PICKS = 4

/** A clip filmed through the crowd for this share of it or more is one the popular clips would not post. */
export const CROWD_SHARE = 0.3

/** Clips filmed through the crowd make up a set this small (the five a sermon should give), and no larger. */
const FEWEST_CLIPS = 5

// ---------- Clips as edits ----------

/** Whether a clip's captions pick out the words leant on: the brand's look when it has one, else the profile's. */
export function keyedCaptions(profile: ClipProfile, brandCaptions: Partial<CaptionSpec>): boolean {
  const preset = (Object.keys(brandCaptions).length > 0 ? brandCaptions : (profile.captions ?? {})).preset
  return !!preset && !!presetById(preset).style.keyColor
}

/**
 * A clip's words, moved onto their sound, so tightening cuts land a hair before each onset; and where its kind of
 * clip cuts restarts, the cut after each one moved into the pause before the word kept, and the clip opened in the
 * breath before its first word (shared/clipping/restarts cutsOnPauses).
 */
async function snapped(
  tools: ClippingTools,
  path: string,
  words: TranscriptWord[],
  restarts = false
): Promise<TranscriptWord[]> {
  if (words.length === 0) return words
  const from = Math.max(0, words[0].startSec - 1)
  const to = words[words.length - 1].endSec + 1
  try {
    const env = await tools.envelope(path, from, to - from)
    const local: Word[] = words.map((w, i) => ({
      id: `w${i + 1}`,
      source: 's1',
      text: w.text,
      startSec: Math.max(0, w.startSec - from),
      endSec: Math.max(0, w.endSec - from)
    }))
    const onSound = snapWords(local, env)
    // Everything else a word knows (who says it, whether it is leaned on) stays with it.
    return (restarts ? cutsOnPauses(onSound, env) : onSound).map((w, i) => ({
      ...words[i],
      text: w.text,
      startSec: w.startSec + from,
      endSec: w.endSec + from
    }))
  } catch {
    return words
  }
}

/**
 * A clip's words heard again closely, where its kind of clip cuts the lines broken off and begun again
 * (ClipProfile.restarts): a long recording is heard fast for its moments, and that hearing smooths "religion
 * never- religion never points" into one line, so the restart is in the sound but not in the words. The words
 * first heard stay where the close hearing fails or disagrees with them.
 */
async function closely(tools: ClippingTools, path: string, recordingSec: number, words: TranscriptWord[]): Promise<TranscriptWord[]> {
  if (!tools.hear || words.length === 0) return words
  const from = Math.max(0, words[0].startSec - 0.5)
  const to = words[words.length - 1].endSec + 0.5
  try {
    const close = withoutSoundNotes(await tools.hear(path, from, to - from, recordingSec))
    const heard = heardClosely(words, close)
    if (!heard) console.warn('[clipping] the close hearing disagreed with the first; keeping the first')
    // Words heard again are whoever said the word first heard under them.
    const said = (t: number): number | undefined =>
      words.find((w) => t >= w.startSec - 0.05 && t <= w.endSec + 0.05)?.speaker
    return heard
      ? heard.map((w) => {
          const speaker = w.speaker ?? said((w.startSec + w.endSec) / 2)
          return speaker === undefined ? w : { ...w, speaker }
        })
      : words
  } catch (err) {
    console.warn('[clipping] could not hear a clip again:', message(err))
    return words
  }
}

/**
 * Where the speaker is through a clip, for following them into the vertical
 * frame: the Mac's face finder, twice a second, over the clip alone. A
 * switched feed's camera cuts go with it, so the frame cuts with the camera.
 */
async function speakerIn(
  tools: ClippingTools,
  path: string,
  startSec: number,
  endSec: number,
  words: TranscriptWord[] = []
): Promise<{ subject: Subject | null; crowd: number }> {
  if (!tools.faces) return { subject: null, crowd: 0 }
  const from = Math.max(0, startSec - 0.5)
  const length = endSec - from + 0.5
  try {
    const samples = await tools.faces(path, from, length)
    const crowd = crowdShare(samples)
    if (!samples.some((s) => s.faces.length > 0)) return { subject: null, crowd }
    const cuts = (await tools.shots(path, from, length)).map((t) => Math.round((from + t) * 1000) / 1000)
    const subject = (await followTalk(tools, path, samples, from, length, words)) ?? subjectFrom(samples, length, FACE_HZ, from)
    const all = [...new Set([...(subject.cuts ?? []), ...cuts])].sort((a, b) => a - b)
    // The camera's cuts kept apart from the turns to another speaker, which only move a crop.
    const shots = cuts.length > 0 ? { shots: cuts } : {}
    return { subject: all.length > 0 ? { ...subject, cuts: all, ...shots } : subject, crowd }
  } catch {
    return { subject: null, crowd: 0 }
  }
}

/** Two or more people in one shot this share of the time is a wide shot of them, as a podcast filmed wide is. */
const TOGETHER_SHARE = 0.4
/** Each of two speakers heard for at least this long in a clip, or it isn't a conversation worth following. */
const LEAST_TALK_SEC = 3

/**
 * The frame on whoever is talking, for a clip of two or more people filmed in one shot whose words say who
 * speaks (shared/speakers/seats): which face is whose from their mouths, then the frame on the speaker's,
 * cutting as the floor changes hands. Null where that can't be done, and the clip follows the largest face.
 */
async function followTalk(
  tools: ClippingTools,
  path: string,
  samples: VisionSample[],
  from: number,
  length: number,
  words: TranscriptWord[]
): Promise<Subject | null> {
  if (!tools.mouth) return null
  const said = words.filter((w) => w.speaker !== undefined && w.endSec > from && w.startSec < from + length)
  const talk = new Map<number, number>()
  for (const w of said) talk.set(w.speaker as number, (talk.get(w.speaker as number) ?? 0) + w.endSec - w.startSec)
  if ([...talk.values()].filter((sec) => sec >= LEAST_TALK_SEC).length < 2) return null
  if (samples.filter((s) => s.faces.length >= 2).length < TOGETHER_SHARE * samples.length) return null
  try {
    const frames = await tools.mouth(path, samples, from, length)
    if (!frames) return null
    const seats = seatsOfSpeakers(frames, said)
    const subject = subjectOfSpeakers(samples, said, seats, length, FACE_HZ, from)
    // Kept, so an edit can cut to the one listening.
    const sat = [...seats.entries()].map(([speaker, seat]) => ({ speaker, x: seat.x })).sort((a, b) => a.speaker - b.speaker)
    return subject && sat.length > 0 ? { ...subject, seats: sat } : subject
  } catch (err) {
    console.warn('[clipping] could not tell whose face is whose', message(err))
    return null
  }
}

// ---------- The whole run ----------

export async function findClips(
  req: ClipFindRequest,
  tools: ClippingTools,
  progress: (p: ClipProgress) => void
): Promise<ClipFindResult> {
  const paths = [...new Set(req.paths)]
  if (paths.length === 0)
    return { ok: false, message: 'Drop a long recording with /clipping, and I will find the clips in it.' }
  // Claude's reading of words said in a chat; /clipping's own arguments otherwise.
  const ask = req.asked ? { ...req.asked, said: req.asked.said || req.ask } : readClipAsk(req.ask)
  // Two recordings with one file name are told apart by their folders.
  const names = recordingNames(paths)
  const nameOf = (path: string): string => names.get(path) ?? basename(path)
  const timings = new Map<string, number>()
  const time = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
    const t0 = performance.now()
    try {
      return await work()
    } finally {
      timings.set(step, (timings.get(step) ?? 0) + performance.now() - t0)
    }
  }
  const notes: string[] = []
  const brand = await tools.brand()
  const niche = brand.niche || null

  // Each recording's share of the bar, by its length.
  const metas = await Promise.all(paths.map((p) => tools.probe(p).catch(() => null)))
  const unreadable = paths.filter((_, i) => !metas[i])
  if (unreadable.length === paths.length) {
    return { ok: false, message: `I couldn't read ${unreadable.map(nameOf).join(' or ')} as a recording.` }
  }
  if (unreadable.length)
    notes.push(`I couldn't read ${unreadable.map(nameOf).join(' or ')} as a recording.`)
  const total = metas.reduce((n, m) => n + (m?.durationSec ?? 0), 0) || 1
  let before = 0

  const read: {
    facts: RecordingFacts
    plan: RecordingPlan
    meta: NonNullable<(typeof metas)[number]>
    cached: boolean
  }[] = []
  for (const [i, path] of paths.entries()) {
    const meta = metas[i]
    if (!meta) continue
    const name = nameOf(path)
    const of = paths.length > 1 ? ` (${i + 1} of ${paths.length})` : ''
    const share = meta.durationSec / total
    const at = (f: number): number => Math.round((before + share * f) * 0.95 * 100)
    const kept = await readKept(tools.cacheDir, path)
    let cached = false

    // A recording that is a short already, or under the bar this request set: nothing to hear, and the reply says why.
    if (meta.durationSec < Math.max(MIN_RECORDING_SEC, req.minSec ?? 0)) {
      const facts: RecordingFacts = { path, durationSec: meta.durationSec, words: [] }
      const plan = planRecording(facts, ask, niche)
      read.push({ facts, plan: { ...plan, none: 'short' }, meta, cached })
      before += share
      continue
    }

    // Every word: from the edit it is already in, kept from before, or heard now.
    let words = req.known?.[path] ?? kept?.words ?? null
    if (words) cached = true
    else {
      const classic = await readAnalysis(path).catch(() => null)
      const whole =
        classic &&
        (classic.options?.startSec ?? 0) < 0.5 &&
        Math.abs((classic.options?.endSec ?? meta.durationSec) - meta.durationSec) < 0.5
      if (whole && classic.transcript.words.length > 0) {
        words = classic.transcript.words
        cached = true
      }
    }
    if (!words) {
      const minutes = Math.max(1, Math.round(meta.durationSec / 60))
      progress({ stage: `Transcribing ${name}${of}: 0 of ${minutes} minutes`, percent: at(0) })
      words = await time('transcribing', () =>
        tools.transcribe(path, meta.durationSec, (f) =>
          progress({
            stage: `Transcribing ${name}${of}: ${Math.min(minutes, Math.floor(f * minutes))} of ${minutes} minutes`,
            percent: at(f * 0.8)
          })
        )
      )
    }
    words = [...words].filter((w) => w.text.trim()).sort((a, b) => a.startSec - b.startSec)

    // What it sounds like, and whether the picture stops: kept with the words.
    let sounds = kept?.sounds ?? null
    let loudness = kept?.loudness ?? null
    if (!sounds && meta.hasAudio && words.length > 0) {
      progress({ stage: `Listening to ${name}${of}`, percent: at(0.82) })
      try {
        const heard = await time('listening', () => tools.listen(path, words as TranscriptWord[]))
        sounds = heard.sounds
        loudness = heard.loudness
      } catch (err) {
        console.warn('[clipping] could not listen to', name, message(err))
      }
    }
    let frozen = kept?.frozen ?? null
    if (!frozen && meta.width > 0) {
      progress({ stage: `Watching the picture in ${name}${of}`, percent: at(0.92) })
      frozen = await time('watching', () => tools.frozen(path, meta.durationSec))
    }
    await writeKept(tools.cacheDir, path, {
      v: CACHE_VERSION,
      durationSec: meta.durationSec,
      words,
      sounds,
      loudness,
      frozen
    })

    const facts: RecordingFacts = {
      path,
      durationSec: meta.durationSec,
      // Heard before sound notes were taken out, a kept transcript has them still.
      words: withoutSoundNotes(words),
      ...(sounds ? { sounds } : {}),
      ...(frozen ? { frozen } : {}),
      ...(loudness ? { loudness } : {})
    }
    let plan = await time('finding', async () => planRecording(facts, ask, niche))
    // A podcast's voices told apart, so its clips can follow whoever is talking; kept with the words.
    if (plan.profile.id === 'podcast' && tools.speakers && !words.some((w) => w.speaker !== undefined)) {
      progress({ stage: `Telling the voices apart in ${name}${of}`, percent: at(0.95) })
      try {
        const heard = words
        const who = await time('telling voices apart', () => (tools.speakers as NonNullable<ClippingTools['speakers']>)(path, heard, () => undefined))
        words = heard.map((w, i) => (who[i] === null || who[i] === undefined ? w : { ...w, speaker: who[i] as number }))
        await writeKept(tools.cacheDir, path, { v: CACHE_VERSION, durationSec: meta.durationSec, words, sounds, loudness, frozen })
        facts.words = withoutSoundNotes(words)
        plan = planRecording(facts, ask, niche)
      } catch (err) {
        console.warn('[clipping] could not tell the voices apart in', name, message(err))
      }
    }
    read.push({ facts, plan, meta, cached })
    before += share
  }

  // The moments, by whoever picks them. With nothing long enough to clip,
  // nobody is asked, and nothing shows as under way.
  const live = read.some((r) => !r.plan.none)
  let engine: { by: Picker; model: string | null } = live ? await tools.engine() : { by: 'measured', model: null }
  let fellBack = false
  if (live)
    progress({
      stage:
        engine.by === 'claude'
          ? 'Claude is reading the transcript'
          : engine.by === 'local'
            ? `${engine.model} is reading the transcript`
            : 'Finding the moments',
      percent: engine.by === 'measured' ? 95 : null
    })
  type Pick = {
    path: string
    startSec: number
    endSec: number
    title: string
    hook: string
    reason: string
    score: number
    /** The clip's first and last words in the recording's words, where the fitting said (shared/clipping/shape). */
    fromWord?: number
    toWord?: number
  }
  const picks: Pick[] = []
  for (const r of read) {
    if (r.plan.none) continue
    const avoid = (req.avoid ?? []).filter((a) => a.path === r.facts.path)
    let found: Omit<Pick, 'path'>[] = []
    if (engine.by !== 'measured') {
      try {
        found = await time('picking', () =>
          pickWithModel(tools, engine as { by: 'claude' | 'local'; model: string | null }, r.facts, r.plan, ask, avoid)
        )
      } catch (err) {
        const who = engine.by === 'claude' ? 'Claude' : (engine.model ?? `The model on ${thisComputer}`)
        const why = engine.by === 'claude' ? claudeErrorText(err) : message(err).replace(/\.$/, '')
        notes.push(`${who} couldn't pick them (${why}), so I sorted them by measuring.`)
        engine = { by: 'measured', model: null }
        fellBack = true
      }
    }
    if (engine.by === 'measured')
      found = await time('finding', async () => measureRecording(r.facts, r.plan, ask, avoid))
    if (ask.funny && found.length === 0 && !(r.facts.sounds ?? []).some((s) => s.kind === 'laughter'))
      notes.push(`I heard no laughter in ${nameOf(r.facts.path)}.`)
    if (ask.topic && found.length === 0) notes.push(`Nothing in ${nameOf(r.facts.path)} is about ${ask.topic}.`)
    picks.push(...found.map((f) => ({ ...f, path: r.facts.path })))
  }
  picks.sort((a, b) => b.score - a.score || a.startSec - b.startSec)

  // Where the speaker is in each, and how much of it is filmed through the crowd: the count each recording
  // wants, from the front first, best first; a moment filmed through the crowd only where there are not enough.
  const looked: { pick: Pick; subject: Subject | null; crowd: number }[] = []
  if (picks.length > 0 && tools.faces) progress({ stage: 'Looking at each moment', percent: 95 })
  const wordsOf = new Map(read.map((r) => [r.facts.path, r.facts.words]))
  for (const p of picks)
    looked.push({
      pick: p,
      ...(await time('watching', () => speakerIn(tools, p.path, p.startSec, p.endSec, wordsOf.get(p.path) ?? [])))
    })
  const chosen: typeof looked = []
  let throughCrowd = 0
  for (const r of read) {
    const own = looked.filter((l) => l.pick.path === r.facts.path)
    const front = own.filter((l) => l.crowd < CROWD_SHARE)
    // Where they fill the set, the least crowded first: a moment the crowd blocks now and then over one it hides.
    const crowded = own.filter((l) => l.crowd >= CROWD_SHARE).sort((a, b) => a.crowd - b.crowd || b.pick.score - a.pick.score)
    // Filmed through the crowd only to make up a handful, never to make up the count.
    const enough = Math.min(r.plan.count, Math.max(front.length, FEWEST_CLIPS))
    const taken = [...front, ...crowded].slice(0, enough)
    // Counted only where the moment would have made the set on its words alone.
    const top = own.slice(0, r.plan.count)
    throughCrowd += crowded.filter((l) => top.includes(l) && !taken.includes(l)).length
    chosen.push(...taken)
  }
  chosen.sort((a, b) => b.pick.score - a.pick.score || a.pick.startSec - b.pick.startSec)
  picks.splice(0, picks.length, ...chosen.map((c) => c.pick))
  if (throughCrowd > 0)
    notes.push(
      `I left out ${throughCrowd === 1 ? 'a moment' : `${throughCrowd} moments`} filmed mostly from behind the congregation.`
    )

  // Each moment as its own edit.
  const captions = brand.autoApply ? (brandStyle(brand).captions ?? {}) : {}
  const brandCaptions = brand.autoApply && Object.keys(captions).length > 0
  const clips: FoundClip[] = []
  let followed = 0
  // Each clip's words, moved onto their sound.
  const said: { inside: TranscriptWord[]; words: TranscriptWord[] }[] = []
  for (const [k, p] of picks.entries()) {
    const r = read.find((x) => x.facts.path === p.path)!
    // By word where the fitting said which: Whisper can squeeze a sentence's last words onto one instant,
    // and a word starting where the clip ends would be let in by its time.
    const first =
      p.fromWord !== undefined && p.toWord !== undefined
        ? r.facts.words.slice(p.fromWord, p.toWord + 1)
        : r.facts.words.filter((w) => w.startSec >= p.startSec - 0.01 && w.endSec <= p.endSec + 0.01)
    // Heard again closely where its restarts are cut, so they are in its words to cut.
    let inside = first
    if (r.plan.profile.restarts && tools.hear) {
      progress({ stage: `Listening closely to each moment (${k + 1} of ${picks.length})`, percent: 95 })
      inside = await time('making clips', () => closely(tools, p.path, r.meta.durationSec, first))
    }
    const restarts = !!r.plan.profile.restarts
    said.push({ inside, words: await time('making clips', () => snapped(tools, p.path, inside, restarts)) })
  }
  // The words each preacher leans on, for captions that set them in the accent, and each clip's hook, for
  // looks that put one on screen: one ask for the set.
  const profileOf = (p: Pick): ClipProfile => read.find((x) => x.facts.path === p.path)!.plan.profile
  const asking = picks.some(
    (p) => keyedCaptions(profileOf(p), captions) || (profileOf(p).looks ?? []).some((l) => l.hook)
  )
  const marks =
    asking && tools.keyWords && engine.by === 'claude'
      ? await time('making clips', () => tools.keyWords!(said.map((c) => c.words.map((w) => w.text)))).catch(
          () => null
        )
      : null
  const keys = marks?.keys ?? []
  for (const [k, p] of picks.entries()) {
    progress({
      stage: `Making the clips (${k + 1} of ${picks.length})`,
      percent: 96 + Math.round((k / Math.max(1, picks.length)) * 4)
    })
    const r = read.find((x) => x.facts.path === p.path)!
    // Opening on the line itself, not the run-up or the filler before it ("And, but if…"), so long as what
    // is left is still a clip.
    const all = said[k].words
    const asked = marks?.opens?.[k] ?? 0
    let from = strongOpening(all, asked > 0 && startsClause(all, asked) ? asked : 0)
    const left = (i: number): number => (all.length ? all[all.length - 1].endSec - (all[i]?.startSec ?? 0) : 0)
    if (from > 0 && left(from) < Math.min(r.plan.bounds.minSec, 0.8 * left(0))) from = strongOpening(all, 0)
    if (from > 0 && left(from) < Math.min(r.plan.bounds.minSec, 0.8 * left(0))) from = 0
    const inside = said[k].inside.slice(from)
    const marked = new Set((keys[k] ?? []).map((i) => i - from).filter((i) => i >= 0))
    // Opened mid-sentence, the first word takes the capital a sentence would give it.
    const capital = (t: string): string => t.replace(/\p{Ll}/u, (c) => c.toUpperCase())
    const words = all
      .slice(from)
      .map((w, i) => (i === 0 && from > 0 ? { ...w, text: capital(w.text) } : w))
      .map((w, i) => (marked.has(i) ? { ...w, key: true } : w))
    const subject = chosen[k].subject
    if (subject) followed++
    const source: Omit<Source, 'id'> = {
      path: p.path,
      durationSec: r.meta.durationSec,
      width: r.meta.width,
      height: r.meta.height,
      fps: r.meta.fps,
      audio: null,
      ...(r.meta.color ? { color: r.meta.color } : {}),
      ...(subject ? { subject } : {})
    }
    const laughter = (r.facts.sounds ?? []).filter((s) => s.kind === 'laughter')
    // The bed in the mood the clip's words call for (main/key-words), curious where nobody was asked.
    const mood = marks?.moods?.[k] ?? 'curious'
    const made = r.plan.profile.bed && tools.pad ? await tools.pad(k, mood).catch(() => null) : null
    const music = made ? { ...made, mood } : null
    const doc = clipDoc({
      id: randomUUID(),
      title: p.title || basename(p.path, extname(p.path)),
      source,
      words,
      profile: r.plan.profile,
      laughter,
      captions,
      reframe: !!subject,
      ...(music ? { music } : {}),
      // Its turn among the looks, and its hook: Claude's, or its title where there was no Claude to ask.
      variant: k,
      hook: marks?.hooks[k] || p.title,
      tailSec: Math.max(0, p.endSec - (inside[inside.length - 1]?.endSec ?? p.endSec))
    })
    clips.push({
      source: p.path,
      startSec: from > 0 && inside[0] ? inside[0].startSec : p.startSec,
      endSec: p.endSec,
      title: doc.title,
      hook: p.hook,
      reason: p.reason,
      score: p.score,
      doc
    })
  }
  const wide = read.some((r) => r.meta.width > r.meta.height)
  if (clips.length > 0 && wide && followed < clips.length) {
    notes.push(
      tools.faces
        ? `I couldn't find a face in ${clips.length - followed === 1 ? 'one clip' : `${clips.length - followed} clips`}, so ${clips.length - followed === 1 ? 'it keeps' : 'they keep'} the middle of the picture.`
        : `The clips keep the middle of the picture: ${NO_FACE_FINDER}.`
    )
  }

  const recordings: FoundRecording[] = read.map((r) => ({
    path: r.facts.path,
    durationSec: r.facts.durationSec,
    profile: r.plan.profile.id,
    left: r.plan.regions,
    words: r.facts.words.length,
    none: r.plan.none ?? (clips.some((c) => c.source === r.facts.path) ? null : 'nothing'),
    cached: r.cached
  }))
  const steps = ['transcribing', 'listening', 'watching', 'finding', 'picking', 'making clips']
  const found: ClipsFound = {
    by: engine.by,
    model: engine.model,
    recordings,
    clips,
    notes,
    timings: steps.filter((s) => timings.has(s)).map((s) => ({ step: s, ms: Math.round(timings.get(s) as number) })),
    had: (req.avoid ?? []).filter((a) => paths.includes(a.path)).length,
    ...(fellBack ? { fellBack } : {})
  }
  for (const t of found.timings) console.log(`[clipping] ${t.step}: ${(t.ms / 1000).toFixed(2)} s`)
  if (live) progress({ stage: 'Done', percent: 100 })
  return { ok: true, ...found, reply: clipsReply(found, brandCaptions) }
}

/**
 * The clips a run found, made in the chat's brand: every version names it,
 * and what its never list rules out (shared/never) comes off as one more
 * version, which says so.
 */
export function clipsInBrand(clips: FoundClip[], brand: Brand, never: NeverItem[]): FoundClip[] {
  return clips.map((c) => inBrand(c, brand, never).clip)
}

function inBrand(c: FoundClip, brand: Brand, never: NeverItem[]): { clip: FoundClip; left: NeverItem[] } {
  const doc = stampMade(c.doc, brand.id)
  const strip = stripDoc(doc, never)
  if (strip.ops.length === 0) return { clip: { ...c, doc }, left: [] }
  return {
    clip: { ...c, doc: commit(doc, strip.ops, neverFinishNote(brandInSentence(brand), strip.items)).doc },
    left: strip.items
  }
}

/**
 * What /clipping sends back: the clips made in the chat's brand (clipsInBrand)
 * and the reply as they are, said again from them. Captions the never list
 * took off are not called on, and the reply says what was left out and why.
 */
export function sentInBrand<T extends ClipsFound & { reply: ClipsReply }>(found: T, brand: Brand, never: NeverItem[]): T {
  const made = found.clips.map((c) => inBrand(c, brand, never))
  const clips = made.map((m) => m.clip)
  const left = [...new Set(made.flatMap((m) => m.left))]
  const styled = brand.autoApply && Object.keys(brandStyle(brand).captions ?? {}).length > 0
  const reply = clipsReply({ ...found, clips }, styled)
  const captionsOff = clips.length > 0 && clips.every((c) => !currentCut(c.doc).captions.on)
  const chips = captionsOff ? reply.chips.filter((c) => !/^Captions\b/.test(c)) : reply.chips
  const aside = [reply.aside, neverFinishNote(brandInSentence(brand), left)].filter(Boolean).join(' ') || null
  return { ...found, clips, reply: { ...reply, chips, aside } }
}

export function registerClippingIpc(deps: { send: Send }, tools: () => ClippingTools = defaultTools): void {
  ipcMain.handle('clips:find', async (e, req: ClipFindRequest): Promise<ClipFindResult> => {
    try {
      const own = tools()
      // The chat's brand, when it named one, over whatever brand the tools read; each clip is made in it.
      const brand = req.brand ? await readBrandById(req.brand) : null
      const picked = brand ? { ...own, brand: async () => brand } : own
      const found = await findClips(req, picked, (p) => deps.send(e.sender, 'clips:progress', p))
      if (!found.ok || !brand) return found
      const never = await neverForBrand(brand.id).catch(() => [])
      return sentInBrand(found, brand, never)
    } catch (err) {
      console.error('[clipping] failed:', message(err))
      deps.send(e.sender, 'clips:progress', { stage: 'Failed', percent: 0 })
      // A sentence; what whisper printed, when it stopped, behind Details.
      const details = saidDetails(toolSaid(err))
      return { ok: false, message: message(err), ...(details.length ? { details } : {}) }
    }
  })
}
