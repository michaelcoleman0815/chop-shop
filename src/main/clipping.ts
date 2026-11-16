import { app, ipcMain, type WebContents } from 'electron'
import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { FFMPEG_PATH, probe } from './ffmpeg'
import { getSettings } from './store'
import { downloadModel, hasModel, transcribe } from './transcribe'
import { listenFrames } from './audio-map'
import { loudnessEnvelope } from './audio-envelope'
import { readAnalysis } from './analysis-cache'
import { readBrand } from './brand-store'
import { readApiKey } from './apikey'
import { suggestClips, OLLAMA_HOST } from './clips'
import { isLocalUp, localModels } from './local-llm'
import { MODEL } from './planner'
import { detectFaces, VISION_PATH, type VisionSample } from './track'
import { detectShots } from './shots'
import { buildAudioMap, type Frames } from '../shared/audio/map'
import { snapWords, type Envelope } from '../shared/audio/snap'
import { brandStyle, type Brand } from '../shared/brand'
import { subjectFrom, type Source, type Subject, type Word } from '../shared/edit'
import {
  clipDoc,
  clipsReply,
  measureRecording,
  planRecording,
  readClipAsk,
  shapePicks,
  wordsToRead,
  type ClipAsk,
  type ClipsFound,
  type ClipsReply,
  type FoundClip,
  type FoundRecording,
  type Picker,
  type RecordingFacts,
  type RecordingPlan,
  type SoundStretch
} from '../shared/clipping'
import type { SuggestedClip, Transcript, TranscriptWord } from '../shared/types'

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
  /** Words already heard, by recording, from the edit they are in. */
  known?: Record<string, TranscriptWord[]>
  /** Clips the set already has: a new run finds others. */
  avoid?: { path: string; startSec: number; endSec: number }[]
}

export type ClipFindResult = ({ ok: true; reply: ClipsReply } & ClipsFound) | { ok: false; message: string }

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
  /** Where the picture holds still for at least `minSec`. */
  frozen: (path: string, durationSec: number) => Promise<{ startSec: number; endSec: number }[]>
  envelope: (path: string, startSec: number, durationSec: number) => Promise<Envelope>
  /** The face finder, on a Mac; null where there is none. */
  faces: ((path: string, startSec: number, durationSec: number) => Promise<VisionSample[]>) | null
  shots: (path: string, startSec: number, durationSec: number) => Promise<number[]>
  /** Who picks the moments. */
  engine: () => Promise<{ by: Picker; model: string | null }>
  suggest: typeof suggestClips
  brand: () => Promise<Brand>
  /** Where what was heard and measured is kept, by file. */
  cacheDir: string
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ---------- Kept from before ----------

/** Bumped when what is kept changes shape, so an old file is measured again. */
const CACHE_VERSION = 1

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
      if (!hasModel(whisperModel)) await downloadModel(whisperModel, () => undefined)
      const heard: Transcript = await transcribe(path, whisperModel, durationSec, (p, stage) => {
        if (stage === 'Transcribing') progress(Math.max(0, Math.min(1, (p - 12) / 86)))
      })
      return heard.words
    },
    listen: async (path, words) => soundsOf(await listenFrames(FFMPEG_PATH, path), words),
    frozen: (path, durationSec) => frozenStretches(FFMPEG_PATH, path, durationSec),
    envelope: (path, startSec, durationSec) => loudnessEnvelope(FFMPEG_PATH, path, { startSec, durationSec }),
    faces: existsSync(VISION_PATH())
      ? (path, startSec, durationSec) => detectFaces(path, startSec, durationSec, 2)
      : null,
    shots: (path, startSec, durationSec) => detectShots(path, startSec, durationSec).catch(() => []),
    engine: chooseEngine,
    suggest: suggestClips,
    brand: readBrand,
    cacheDir: join(app.getPath('userData'), 'clipping')
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
  if (chosen && (await isLocalUp(OLLAMA_HOST))) return { by: 'local', model: chosen }
  if (readApiKey()) return { by: 'claude', model: MODEL }
  if (await isLocalUp(OLLAMA_HOST)) {
    const models = await localModels(OLLAMA_HOST).catch(() => [])
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
    const maxClips = Math.max(1, Math.round(plan.count * share + 0.49))
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
  }).slice(0, plan.count)
}

// ---------- Clips as edits ----------

/** A clip's words, moved onto their sound, so tightening cuts land a hair before each onset. */
async function snapped(tools: ClippingTools, path: string, words: TranscriptWord[]): Promise<TranscriptWord[]> {
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
    return snapWords(local, env).map((w) => ({ text: w.text, startSec: w.startSec + from, endSec: w.endSec + from }))
  } catch {
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
  endSec: number
): Promise<Subject | null> {
  if (!tools.faces) return null
  const from = Math.max(0, startSec - 0.5)
  const length = endSec - from + 0.5
  try {
    const samples = await tools.faces(path, from, length)
    if (!samples.some((s) => s.faces.length > 0)) return null
    const subject = subjectFrom(samples, length, 2, from)
    const cuts = (await tools.shots(path, from, length)).map((t) => Math.round((from + t) * 1000) / 1000)
    return cuts.length > 0 ? { ...subject, cuts } : subject
  } catch {
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
  const ask = readClipAsk(req.ask)
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
    return { ok: false, message: `I couldn't read ${unreadable.map((p) => basename(p)).join(' or ')} as a recording.` }
  }
  if (unreadable.length)
    notes.push(`I couldn't read ${unreadable.map((p) => basename(p)).join(' or ')} as a recording.`)
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
    const name = basename(path)
    const of = paths.length > 1 ? ` (${i + 1} of ${paths.length})` : ''
    const share = meta.durationSec / total
    const at = (f: number): number => Math.round((before + share * f) * 0.95 * 100)
    const kept = await readKept(tools.cacheDir, path)
    let cached = false

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
      words,
      ...(sounds ? { sounds } : {}),
      ...(frozen ? { frozen } : {}),
      ...(loudness ? { loudness } : {})
    }
    const plan = await time('finding', async () => planRecording(facts, ask, niche))
    read.push({ facts, plan, meta, cached })
    before += share
  }

  // The moments, by whoever picks them.
  let engine = await tools.engine()
  let fellBack = false
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
        const who = engine.by === 'claude' ? 'Claude' : (engine.model ?? 'The model on this Mac')
        notes.push(`${who} couldn't pick them (${message(err).replace(/\.$/, '')}), so I sorted them by measuring.`)
        engine = { by: 'measured', model: null }
        fellBack = true
      }
    }
    if (engine.by === 'measured')
      found = await time('finding', async () => measureRecording(r.facts, r.plan, ask, avoid))
    if (ask.funny && found.length === 0 && !(r.facts.sounds ?? []).some((s) => s.kind === 'laughter'))
      notes.push(`I heard no laughter in ${basename(r.facts.path)}.`)
    if (ask.topic && found.length === 0) notes.push(`Nothing in ${basename(r.facts.path)} is about ${ask.topic}.`)
    picks.push(...found.map((f) => ({ ...f, path: r.facts.path })))
  }
  picks.sort((a, b) => b.score - a.score || a.startSec - b.startSec)

  // Each moment as its own edit.
  const captions = brand.autoApply ? (brandStyle(brand).captions ?? {}) : {}
  const brandCaptions = brand.autoApply && Object.keys(captions).length > 0
  const clips: FoundClip[] = []
  let followed = 0
  for (const [k, p] of picks.entries()) {
    progress({
      stage: `Making the clips (${k + 1} of ${picks.length})`,
      percent: 96 + Math.round((k / Math.max(1, picks.length)) * 4)
    })
    const r = read.find((x) => x.facts.path === p.path)!
    const inside = r.facts.words.filter((w) => w.startSec >= p.startSec - 0.01 && w.endSec <= p.endSec + 0.01)
    const words = await time('making clips', () => snapped(tools, p.path, inside))
    const subject = await time('making clips', () => speakerIn(tools, p.path, p.startSec, p.endSec))
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
    const doc = clipDoc({
      id: randomUUID(),
      title: p.title || basename(p.path, extname(p.path)),
      source,
      words,
      profile: r.plan.profile,
      laughter,
      captions,
      reframe: !!subject,
      tailSec: Math.max(0, p.endSec - (inside[inside.length - 1]?.endSec ?? p.endSec))
    })
    clips.push({
      source: p.path,
      startSec: p.startSec,
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
        : 'The clips keep the middle of the picture: following the speaker needs the face finder Cutalong has on a Mac.'
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
  progress({ stage: 'Done', percent: 100 })
  return { ok: true, ...found, reply: clipsReply(found, brandCaptions) }
}

export function registerClippingIpc(deps: { send: Send }, tools: () => ClippingTools = defaultTools): void {
  ipcMain.handle('clips:find', async (e, req: ClipFindRequest): Promise<ClipFindResult> => {
    try {
      return await findClips(req, tools(), (p) => deps.send(e.sender, 'clips:progress', p))
    } catch (err) {
      console.error('[clipping] failed:', message(err))
      deps.send(e.sender, 'clips:progress', { stage: 'Failed', percent: 0 })
      return { ok: false, message: message(err) }
    }
  })
}
