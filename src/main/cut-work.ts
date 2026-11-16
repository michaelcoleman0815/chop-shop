import { basename, extname, join } from 'path'
import { platform } from './platform'
import { downloadModel, hasModel, transcribe, type WhisperModel } from './transcribe'
import { creditsText } from '../shared/assets'
import { renderCut, type OverlaySpan, type RenderSource } from './cut-render'
import type { Encoder } from './render/encoder'
import { loudnessEnvelope } from './audio-envelope'
import { snapWords, type Envelope } from '../shared/audio/snap'
import { estimateOffset, shiftEnvelope, shiftFrames, trustworthy, type Offset } from '../shared/audio/offset'
import { assignRoles, factsFor, separateSameTakes, type FileFacts, type Roles } from './session'
import { listenFrames } from './audio-map'
import { buildAudioMap, type AudioMap, type Frames } from '../shared/audio/map'
import { vocabulary } from '../shared/raw/prompt'
import { intakeReply, probeSource, type SourceFacts } from './intake'
import { projectName } from '../shared/project-name'
import { mouthNotice, nicheFrom, type MouthMode, type WatchedClip } from '../shared/vision'
import { subtitlePass, type CutMotionInput } from './motion-scene'
import type { Brand } from '../shared/brand'
import type { MotionScene } from '../shared/motion'
import {
  addSources,
  createDoc,
  currentCut,
  nextSourceId,
  currentVersion,
  EditDocSchema,
  resolveCut,
  wordsFromTranscript,
  type EditDoc,
  type Source,
  type Word
} from '../shared/edit'
import { chaptersReply } from '../shared/presets'
import type { Transcript } from '../shared/types'

/**
 * The work behind turning footage into an edit and an edit into video:
 * reading and sorting recordings, hearing the words, lining up better sound,
 * making v1, and rendering an export. The Mac's IPC handlers (cutalong.ts)
 * and the phone's host (mobile/src/host) both call these, so an edit made on
 * either is made by the same code. What differs between them comes in as a
 * WorkHost: where the tools are, the brand and settings, and the parts only
 * a Mac has (other AI services hearing the words, the face finder, drawing
 * motion graphics).
 */

export interface ProbeResult {
  durationSec: number
  width: number
  height: number
  fps: number
  facts: SourceFacts | null
}

/** What watching the mouth returns for a clip (main/mouth.ts). */
export interface Watched {
  source: Source
  words: Word[]
  map?: AudioMap
  /** What was seen of the mouth, or nothing when no face was watched. */
  seen: unknown
}

export interface WorkHost {
  ffmpeg(): string
  ffprobe(): string
  probe(path: string): Promise<ProbeResult>
  readBrand(): Promise<Brand>
  whisperModel(): WhisperModel
  /** Where exports go. */
  outputDir(): string
  /** Where the built-in sound effects are kept once made. */
  sfxDir(): string
  fontsDir(): string | null
  /**
   * Another AI service hearing the words, when the person has added one and
   * left them on. A phone hears them itself.
   */
  hearInCloud?: (
    path: string,
    durationSec: number,
    progress: (stage: string, percent: number) => void
  ) => Promise<{ service: string; transcript: Transcript } | { service: null; note: string | null }>
  /** Watching the speaker's mouth, with the Mac's face finder. */
  watch?: (input: {
    source: Source
    words: Word[]
    envelope: Envelope
    map?: AudioMap
    niche?: string | null
    mode?: MouthMode
  }) => Promise<Watched>
  /** Draws the cut's motion graphics to overlay files; empty overlays when it has none. */
  motion(input: CutMotionInput): Promise<{ overlays: OverlaySpan[]; scene: MotionScene }>
  /** How video is encoded: the computer's x264 when absent. */
  encoder?: Encoder
  /** False for an ffmpeg built without its GPL parts, as a phone's is: camera moves are drawn without perspective. */
  perspective?: boolean
}

export type ProgressFn = (stage: string, percent: number) => void

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export interface Lined {
  name: string
  sound: string
  offsetSec: number
}

/**
 * Turns footage into an edit. Several talking clips become one edit in the
 * order they were shot. When a separate recording has the better sound,
 * each clip is lined up with it by ear, and the words, the preview and the
 * export all use that sound.
 */
export async function prepareCut(
  host: WorkHost,
  input: string | { paths: string[]; soundPaths?: string[] },
  progress: ProgressFn,
  mediaUrlFor: (path: string) => string
): Promise<
  | {
      ok: true
      doc: EditDoc
      mediaUrl: string
      warning: string | null
      lined: Lined[]
      intake: { sentence: string; facts: string[] } | undefined
      notice: string | null
    }
  | { ok: false; message: string }
> {
  const paths = typeof input === 'string' ? [input] : input.paths
  const soundPaths = typeof input === 'string' ? [] : (input.soundPaths ?? [])
  try {
    if (paths.length === 0) return { ok: false as const, message: 'There is no footage to cut.' }
    const read = await readFootage(host, paths, soundPaths, progress, 1, { niche: nicheFrom(await host.readBrand()) })
    const created = createDoc({
      id: crypto.randomUUID(),
      title: basename(paths[0], extname(paths[0])),
      sources: read.sources,
      words: read.words
    })
    // How each recording sounds, word by word: what takes and the planner read.
    const doc = Object.keys(read.maps).length > 0 ? { ...created, audio: read.maps } : created
    progress('Ready', 100)
    return {
      ok: true as const,
      doc,
      mediaUrl: mediaUrlFor(paths[0]),
      warning: read.notes.length ? read.notes.join(' ') : null,
      lined: read.lined,
      intake: read.intake,
      notice: read.notice
    }
  } catch (err) {
    progress('Failed', 0)
    return { ok: false as const, message: message(err) }
  }
}

/**
 * More footage for an edit already under way: new talking clips go on the
 * end of the cut as a new version, and a new recording with better sound is
 * lined up under every clip that does not have one yet.
 */
export async function extendCut(
  host: WorkHost,
  req: { doc: unknown; paths: string[]; soundPaths?: string[] },
  progress: ProgressFn
): Promise<
  | { ok: true; doc: EditDoc; warning: string | null; lined: Lined[]; notice: string | null }
  | { ok: false; message: string }
> {
  try {
    const parsed = EditDocSchema.safeParse(req.doc)
    if (!parsed.success) return { ok: false as const, message: 'The edit could not be read.' }
    let doc = parsed.data
    const soundPaths = req.soundPaths ?? []
    const notes: string[] = []
    const lined: Lined[] = []
    let notice: string | null = null
    if (soundPaths.length > 0) {
      const lonely = doc.sources.filter((s) => !s.audio)
      const found = await lineUp(host, lonely, soundPaths, progress)
      notes.push(...found.notes)
      lined.push(...found.lined)
      doc = { ...doc, sources: doc.sources.map((s) => found.audio.get(s.id) ?? s) }
    }
    const fresh = req.paths.filter((p) => !doc.sources.some((s) => s.path === p))
    if (fresh.length > 0) {
      const first = Number(nextSourceId(doc).slice(1))
      // New clips are watched the way this edit already is: its profile, and
      // a mode a sentence chose for its mouth watching.
      const read = await readFootage(host, fresh, soundPaths, progress, first, {
        niche: doc.profile || nicheFrom(await host.readBrand()),
        mode: doc.sources.find((s) => s.mouth?.chosen)?.mouth?.mode
      })
      notes.push(...read.notes)
      lined.push(...read.lined)
      notice = read.notice
      const names = fresh.map((p) => basename(p))
      if (Object.keys(read.maps).length > 0) doc = { ...doc, audio: { ...(doc.audio ?? {}), ...read.maps } }
      doc = addSources(
        doc,
        read.sources,
        read.words,
        names.length === 1 ? `${names[0]} is on the end.` : `${names.length} more clips are on the end.`
      )
    }
    progress('Ready', 100)
    return { ok: true as const, doc, warning: notes.length ? notes.join(' ') : null, lined, notice }
  } catch (err) {
    progress('Failed', 0)
    return { ok: false as const, message: message(err) }
  }
}

/** Which file is which: measured, then read against what the person said. */
export async function sortFootage(
  req: { request: string; paths: string[] },
  apiKey: string | null,
  progress: (stage: string, percent: number | null) => void
): Promise<{ ok: true; roles: Roles; facts: FileFacts[] } | { ok: false; message: string }> {
  try {
    const facts: FileFacts[] = new Array(req.paths.length)
    let done = 0
    // A few at a time: a shoot can be dozens of files.
    const queue = req.paths.map((p, i) => ({ p, i }))
    const worker = async (): Promise<void> => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        facts[job.i] = await factsFor(job.p)
        done++
        progress(
          `Looking through your footage (${done} of ${req.paths.length})`,
          Math.round((done / req.paths.length) * 90)
        )
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, req.paths.length) }, worker))
    // Claude reading the request has no percent to give, so the bar sweeps.
    progress('Working out which file is which', null)
    const assigned = await assignRoles(req.request, facts, apiKey)
    // Sorted without reading the request, one take recorded twice would be cut in twice.
    const roles = assigned.by === 'measurement' ? await separateSameTakes(assigned, facts) : assigned
    return { ok: true as const, roles, facts }
  } catch (err) {
    return { ok: false as const, message: message(err) }
  }
}

export interface Rendered {
  ok: true
  outputPath: string
  mediaUrl: string
  creditsPath: string | null
  chaptersPath: string | null
  /** The exported file's own size and length. */
  width: number
  height: number
  durationSec: number
}

/**
 * Renders the current version with the renderer of record. A clip from
 * /clipping exports under its own title (name), with no version number on it.
 */
export async function renderEdit(
  host: WorkHost,
  req: { doc: unknown; quality: 'preview' | 'final'; name?: string },
  report: (stage: string, percent: number) => void,
  mediaUrlFor: (path: string) => string
): Promise<Rendered | { ok: false; message: string }> {
  const parsed = EditDocSchema.safeParse(req.doc)
  if (!parsed.success) return { ok: false as const, message: 'The edit could not be read.' }
  const doc = parsed.data
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  if (resolved.pieces.length === 0)
    return { ok: false as const, message: 'There is nothing left in the cut to render.' }

  const files = platform().files
  const final = req.quality === 'final'
  const stage = final ? 'Exporting' : 'Rendering a preview'
  const workDir = await files.tempDir('cutalong-render-')
  let outputPath: string | null = null
  try {
    // What each recording has now. One the cut no longer uses may be gone
    // from the disk; nothing reads it, and one the cut does use is named in
    // a sentence before anything renders. A podcast has sound and no picture.
    const sources: RenderSource[] = await Promise.all(
      doc.sources.map(async (s) => {
        const facts = await probeSource(host.ffprobe(), s.path).catch(() => null)
        if (!facts) return { ...s, hasAudio: false }
        return { ...s, hasAudio: facts.audio !== null, hasVideo: facts.width > 0 && facts.height > 0 }
      })
    )
    const n = currentVersion(doc).n
    outputPath = final
      ? await freePath(host.outputDir(), req.name ? safeName(req.name) : `${safeName(doc.title)} v${n}`, '.mp4')
      : join(await previewDir(), `${doc.id}-v${n}-${Date.now()}.mp4`)
    const brand = await host.readBrand()
    const progress = (f: number): void => report(stage, Math.round(f * 100))
    // Graphics first: drawn frame by frame, then laid over the picture in the final pass.
    const motion = await host.motion({
      cut,
      resolved,
      words: doc.words,
      sources,
      assets: doc.assets,
      brand,
      quality: req.quality,
      ffmpeg: host.ffmpeg(),
      workDir: join(workDir, 'motion'),
      fontsDir: host.fontsDir(),
      onProgress: (f) => progress(f * 0.25)
    })
    const share = motion.overlays.length > 0 ? 0.25 : 0
    const pass = subtitlePass(cut, resolved, motion.scene)
    // The subtitles leave out what a card holds back; the music and the sounds still follow every word.
    await renderCut(pass.cut, resolved, sources, {
      ffmpeg: host.ffmpeg(),
      outputPath,
      workDir,
      quality: req.quality,
      fontsDir: host.fontsDir(),
      brand: brand.autoApply ? { colors: brand.colors, logo: brand.logo } : null,
      overlays: motion.overlays,
      captionWords: pass.resolved.words,
      sfxDir: host.sfxDir(),
      encoder: host.encoder,
      perspective: host.perspective,
      onProgress: (f) => progress(share + f * (1 - share))
    })
    // Anything from outside the person's own files is credited beside the video.
    let creditsPath: string | null = null
    const credits = final ? creditsText(doc) : null
    if (credits) {
      creditsPath = outputPath.replace(/\.mp4$/i, '') + ' credits.txt'
      await files.writeText(creditsPath, credits)
    }
    // Chapters for the YouTube description, the same ones the video file carries.
    let chaptersPath: string | null = null
    const chapters = final ? chaptersReply(cut, resolved) : null
    if (chapters?.shows) {
      chaptersPath = outputPath.replace(/\.mp4$/i, '') + ' chapters.txt'
      await files.writeText(chaptersPath, `${chapters.lines}\n`)
    }
    // The file's own size and length, so the chat can frame it before it loads.
    const made = await host.probe(outputPath).catch(() => null)
    return {
      ok: true as const,
      outputPath,
      mediaUrl: mediaUrlFor(outputPath),
      creditsPath,
      chaptersPath,
      width: made?.width ?? 0,
      height: made?.height ?? 0,
      durationSec: made?.durationSec ?? resolved.durationSec
    }
  } catch (err) {
    console.error('[cut] render failed:', message(err))
    // Nothing half-made, and no empty file holding the name, is left in the export folder.
    if (outputPath) await files.remove(outputPath).catch(() => undefined)
    return { ok: false as const, message: message(err) }
  } finally {
    await files.remove(workDir).catch(() => undefined)
  }
}

/**
 * Finds where each clip sits in the recordings with the better sound, by
 * matching their loudness. A clip keeps its own sound when no match is sure.
 */
export async function lineUp(
  host: WorkHost,
  sources: Source[],
  soundPaths: string[],
  progress: ProgressFn,
  envelopes = new Map<string, Envelope>()
): Promise<{ audio: Map<string, Source>; lined: Lined[]; notes: string[]; own: Map<string, Envelope> }> {
  const audio = new Map<string, Source>()
  const lined: Lined[] = []
  const notes: string[] = []
  const own = new Map<string, Envelope>()
  for (const [i, source] of sources.entries()) {
    const name = basename(source.path, extname(source.path))
    progress(
      `Lining up ${name} with your audio${sources.length > 1 ? ` (${i + 1} of ${sources.length})` : ''}`,
      Math.round((i / Math.max(1, sources.length)) * 100)
    )
    try {
      const mine = await loudnessEnvelope(host.ffmpeg(), source.path)
      own.set(source.id, mine)
      let best: { path: string; offset: Offset } | null = null
      for (const sp of soundPaths) {
        if (!envelopes.has(sp)) envelopes.set(sp, await loudnessEnvelope(host.ffmpeg(), sp))
        const offset = estimateOffset(mine, envelopes.get(sp) as Envelope)
        if (trustworthy(offset) && (!best || offset.confidence > best.offset.confidence)) best = { path: sp, offset }
      }
      if (best) {
        audio.set(source.id, { ...source, audio: { path: best.path, offsetSec: best.offset.offsetSec } })
        lined.push({ name: basename(source.path), sound: basename(best.path), offsetSec: best.offset.offsetSec })
      } else notes.push(`I couldn't line ${name} up with your audio, so it keeps its own sound.`)
    } catch (err) {
      notes.push(`I couldn't listen to ${name}, so it keeps its own sound. ${message(err)}`)
    }
  }
  return { audio, lined, notes, own }
}

/**
 * Reads talking clips into recordings and words. With a better recording of
 * the sound, each clip is lined up with it first, and the words are heard
 * from that recording, once for every clip it covers.
 */
export async function readFootage(
  host: WorkHost,
  paths: string[],
  soundPaths: string[],
  progress: ProgressFn,
  firstIndex: number,
  mouth: { niche?: string | null; mode?: MouthMode } = {}
): Promise<{
  sources: Source[]
  words: Word[]
  notes: string[]
  lined: Lined[]
  maps: Record<string, AudioMap>
  intake: { sentence: string; facts: string[] } | undefined
  /** What watching the speaker's mouth changed or marked, in a sentence or two. */
  notice: string | null
}> {
  const sources: Source[] = []
  const words: Word[] = []
  const notes: string[] = []
  const lined: Lined[] = []
  const maps: Record<string, AudioMap> = {}
  const sentences: string[] = []
  const facts: string[] = []
  const soundEnv = new Map<string, Envelope>()
  const soundWords = new Map<string, Transcript['words']>()
  const soundFrames = new Map<string, Frames>()
  const watched: WatchedClip[] = []

  for (const [i, path] of paths.entries()) {
    const name = basename(path, extname(path))
    const of = paths.length > 1 ? ` (${i + 1} of ${paths.length})` : ''
    // Each clip's share of the bar.
    const step = (stage: string, within: number): void =>
      progress(`${stage}${of}`, Math.min(99, Math.round(((i + within / 100) / paths.length) * 100)))
    step(`Reading ${name}`, 1)
    const meta = await host.probe(path)
    const color = meta.facts?.color
    let source: Source = {
      id: `s${firstIndex + i}`,
      path,
      durationSec: meta.durationSec,
      width: meta.width,
      height: meta.height,
      fps: meta.fps > 0 ? meta.fps : 30,
      audio: null,
      ...(color && color !== 'sdr' ? { color } : {})
    }
    // What intake noticed and fixed about this recording, said once for the drop.
    if (meta.facts) {
      const said = intakeReply(basename(path), meta.facts)
      if (said.sentence) sentences.push(said.sentence)
      for (const f of said.facts) if (!facts.includes(f)) facts.push(f)
    }
    let own: Envelope | null = null
    if (soundPaths.length > 0) {
      const found = await lineUp(host, [source], soundPaths, (stage) => step(stage, 5), soundEnv)
      source = found.audio.get(source.id) ?? source
      own = found.own.get(source.id) ?? null
      notes.push(...found.notes)
      lined.push(...found.lined)
    }

    // The first recording's words are w1, w2, ...; later ones carry their id.
    const prefix = firstIndex + i === 1 ? 'w' : `${source.id}w`
    // The loudness the words are snapped to, on this clip's clock: watching the mouth reads it too.
    let heard: Envelope | null = null
    let clip: Word[] = []
    try {
      if (source.audio) {
        const sp = source.audio.path
        if (!soundWords.has(sp)) {
          const length = (await host.probe(sp)).durationSec
          const heard = await transcriptFor(host, sp, length, (stage, pct) =>
            step(`${stage} ${basename(sp, extname(sp))}`, 10 + pct * 0.85)
          )
          soundWords.set(sp, heard.words)
        }
        const at = source.audio.offsetSec
        const mine = (soundWords.get(sp) as Transcript['words'])
          .filter((w) => w.startSec >= at - 0.05 && w.endSec <= at + source.durationSec + 0.05)
          .map((w) => ({ ...w, startSec: w.startSec - at, endSec: w.endSec - at }))
        clip = wordsFromTranscript(mine, source.id, prefix)
        if (clip.length > 0) {
          step('Listening for the cuts', 97)
          heard = shiftEnvelope(soundEnv.get(sp) as Envelope, at, source.durationSec)
          clip = snapWords(clip, heard)
          // The pitch and kind of each sound come from the recording that is heard.
          try {
            if (!soundFrames.has(sp)) soundFrames.set(sp, await listenFrames(host.ffmpeg(), sp))
            maps[source.id] = buildAudioMap(shiftFrames(soundFrames.get(sp) as Frames, at, source.durationSec), clip)
          } catch (err) {
            console.warn('[cut] could not map the sound:', message(err))
          }
        }
      } else {
        const transcript = await transcriptFor(
          host,
          path,
          source.durationSec,
          (stage, pct) => step(stage, 10 + pct * 0.85),
          {
            notice: (sentence) => notes.push(sentence)
          }
        )
        clip = wordsFromTranscript(transcript.words, source.id, prefix)
        // Listen to the recording so every word's edges sit on its sound,
        // which is what lets cuts land tight without clipping a consonant.
        // The same listen measures pitch and what kind of sound each stretch
        // is, for the audio map that takes and the planner read.
        if (clip.length > 0) {
          step('Listening for the cuts', 97)
          try {
            const frames = await listenFrames(host.ffmpeg(), path)
            heard = { hopSec: frames.hopSec, db: frames.db }
            clip = snapWords(clip, heard)
            maps[source.id] = buildAudioMap(frames, clip)
          } catch (err) {
            try {
              heard = own ?? (await loudnessEnvelope(host.ffmpeg(), path))
              clip = snapWords(clip, heard)
            } catch {
              console.warn('[cut] could not listen to the audio, keeping recogniser timing:', message(err))
            }
          }
        }
      }
      // Watch the speaker's mouth (main/mouth): the sound lined up with it,
      // cuts timed to it and voices from off camera marked, all on this
      // clip's own picture clock. Without a face, or without the sound to
      // compare it with, sound timing stays. A phone does not watch yet.
      if (clip.length > 0 && heard && host.watch) {
        step('Watching the speaker', 98)
        const w = await host.watch({ source, words: clip, envelope: heard, map: maps[source.id], ...mouth })
        ;({ source, words: clip } = w)
        if (w.map) maps[source.id] = w.map
        if (w.seen) watched.push({ name: basename(path), source, words: clip })
      }
      words.push(...clip)
    } catch (err) {
      notes.push(`I couldn't transcribe ${name}, so it is one long beat for now. ${message(err)}`)
    }
    sources.push(source)
  }
  const intake =
    sentences.length || facts.length ? { sentence: sentences.join(' '), facts: facts.slice(0, 3) } : undefined
  return { sources, words, notes, lined, maps, intake, notice: mouthNotice(watched, paths.length) }
}

/**
 * The transcript for a whole file, written verbatim: every filler, false
 * start and retake, the names from the brand and the title listened for,
 * and a second listen where words went missing. The model is fetched first
 * if it is missing rather than sending anyone to Settings.
 *
 * The clip finder's cached transcript is not reused: it is written the tidy
 * way, which smooths retakes away, and finding retakes is the point here.
 */
export async function transcriptFor(
  host: WorkHost,
  path: string,
  durationSec: number,
  progress: (stage: string, percent: number) => void,
  opts: {
    /** Says, in one sentence, why another AI service could not hear it. */
    notice?: (sentence: string) => void
    /** False when nothing may be downloaded, not even the model: learning from edits. */
    download?: boolean
    /** True when the words must be heard on this Mac, never by another service. */
    localOnly?: boolean
  } = {}
): Promise<Transcript> {
  // Another AI service hears the words when the person has added one. If it
  // cannot, this computer does, and the one sentence saying why goes back.
  if (!opts.localOnly && host.hearInCloud) {
    const cloud = await host.hearInCloud(path, durationSec, progress)
    if (cloud.service !== null) return cloud.transcript
    if (cloud.note) opts.notice?.(cloud.note)
  }

  const whisperModel = host.whisperModel()
  if (!(await hasModel(whisperModel))) {
    // Learning from edits never reaches the network, not even for the model.
    if (opts.download === false) {
      throw new Error(
        `The ${whisperModel} transcription model isn't on this Mac yet. Download it in Settings, then try again.`
      )
    }
    await downloadModel(whisperModel, (p) => progress(`Downloading ${whisperModel}`, Math.round(p * 0.3)))
  }
  const brand = await host.readBrand()
  const names = vocabulary({ title: basename(path, extname(path)), voice: brand.voice, products: brand.products })
  return transcribe(path, whisperModel, durationSec, (p, stage) => progress(stage, 30 + Math.round(p * 0.7)), 0, {
    names
  })
}

/** An export's name from the edit's title: what a project is named by, short enough for any file system. */
export function safeName(title: string): string {
  return projectName(title)
}

/**
 * A name in `dir` no other file has, taken by making the file empty there and
 * then: two exports started together, or two edits with the same title, each
 * get their own file instead of writing over one another.
 */
export async function freePath(dir: string, name: string, ext: string): Promise<string> {
  const files = platform().files
  await files.mkdir(dir)
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? `${name}${ext}` : `${name} (${n})${ext}`)
    if (await files.claim(candidate)) return candidate
  }
}

async function previewDir(): Promise<string> {
  const dir = join(platform().paths.temp(), 'cutalong-previews')
  await platform().files.mkdir(dir)
  return dir
}
