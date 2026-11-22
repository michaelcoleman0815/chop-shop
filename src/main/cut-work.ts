import { basename, extname, join } from 'path'
import { suggestProfile } from '../shared/raw/profiles'
import { platform } from './platform'
import { thisComputer } from '../shared/platform'
import { downloadModel, hasModel, transcribe, type WhisperModel } from './transcribe'
import { creditsText } from '../shared/assets'
import { brandOfDoc, readBrand, readBrandById } from './brand-store'
import { stampBrand } from '../shared/brands'
import { saidDetails, toolSaid, type Detail } from '../shared/failure'
import { placeFile } from './export-paths'
import { claudeWriter, writeUploadKit } from './upload-kit'
import { isShort, UPLOAD_SUFFIXES, type UploadKit } from '../shared/upload'
import { renderCut, type ClipSoundOptions, type GraphOptions, type OverlaySpan, type RenderSource } from './cut-render'
import type { CutLayersInput } from './layers-render'
import type { Encoder } from './render/encoder'
import { loudnessEnvelope } from './audio-envelope'
import { snapWords, type Envelope } from '../shared/audio/snap'
import { estimateOffset, shiftEnvelope, shiftFrames, trustworthy, type Offset } from '../shared/audio/offset'
import { assignRoles, factsFor, separateSameTakes, type FileFacts, type Roles } from './session'
import type { LinedRecording } from '../shared/pov/lineup'
import { listenFrames } from './audio-map'
import { buildAudioMap, type AudioMap, type Frames } from '../shared/audio/map'
import { vocabulary } from '../shared/raw/prompt'
import { intakeReply, probeSource, type SourceFacts } from './intake'
import { projectName } from '../shared/project-name'
import { mouthNotice, nicheFrom, type MouthMode, type WatchedClip } from '../shared/vision'
import { subtitlePass, type CutMotionInput } from './motion-scene'
import type { Brand } from '../shared/brand'
import { themeFrom, type MotionScene } from '../shared/motion'
import {
  addSources,
  createDoc,
  currentCut,
  nextSourceId,
  currentVersion,
  EditDocSchema,
  resolveCut,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Resolved,
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
  /**
   * Who says each word (main/speakers), for a recording of a conversation; null where it can't say. Absent,
   * nobody is told apart (a phone, for now).
   */
  speakers?: (path: string, words: Word[]) => Promise<(number | null)[]>
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
  /**
   * The cut's layer tracks for the export (main/layers-render): their pictures as
   * overlay files and the clips that sound. Absent where they are not drawn yet.
   */
  layers?: (input: CutLayersInput) => Promise<{ overlays: OverlaySpan[]; sounds: ClipSoundOptions[] }>
  /**
   * The cut's scene effects for the export, from the cut-outs this computer can
   * make (main/fx-ipc); null when it has none. Absent where they are not drawn.
   */
  fx?: (input: {
    cut: Cut
    resolved: Resolved
    words: Word[]
    sources: Source[]
    quality: 'preview' | 'final'
    workDir: string
    onProgress?: (fraction: number) => void
  }) => Promise<GraphOptions['fx']>
  /**
   * Several players' views of one gaming session found among the files and
   * lined up by ear with the person's own (main/session-povs); the roles as
   * they were when there is none. Absent where other views are not cut in.
   */
  session?: (roles: Roles, facts: FileFacts[], request: string) => Promise<Roles>
  /** How video is encoded: the computer's x264 when absent. */
  encoder?: Encoder
  /** False for an ffmpeg built without its GPL parts, as a phone's is: camera moves are drawn without perspective. */
  perspective?: boolean
  /** The person's Anthropic key, or null: Claude writes an export's titles and description only with it. */
  apiKey(): Promise<string | null>
  /** Settings' switch for Claude writing what an upload needs. */
  claudeWritesUpload(): boolean
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
  input: string | { paths: string[]; soundPaths?: string[]; brand?: string | null },
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
      details?: Detail[]
    }
  | { ok: false; message: string }
> {
  const paths = typeof input === 'string' ? [input] : input.paths
  const soundPaths = typeof input === 'string' ? [] : (input.soundPaths ?? [])
  try {
    if (paths.length === 0) return { ok: false as const, message: 'There is no footage to cut.' }
    // The chat's brand: its kind of video, and the names it listens for.
    const brand = await readBrandById(typeof input === 'string' ? null : input.brand)
    const read = await readFootage(host, paths, soundPaths, progress, 1, { niche: nicheFrom(brand), brand })
    const created = createDoc({
      id: crypto.randomUUID(),
      title: basename(paths[0], extname(paths[0])),
      sources: read.sources,
      words: read.words
    })
    // How each recording sounds, word by word: what takes and the planner read.
    const heard = Object.keys(read.maps).length > 0 ? { ...created, audio: read.maps } : created
    // Made in the chat's brand when it named one, so it stays in it whatever becomes the default.
    const doc = typeof input !== 'string' && input.brand ? stampBrand(heard, brand.id) : heard
    progress('Ready', 100)
    return {
      ok: true as const,
      doc,
      mediaUrl: mediaUrlFor(paths[0]),
      warning: read.notes.length ? read.notes.join(' ') : null,
      lined: read.lined,
      intake: read.intake,
      notice: read.notice,
      ...(read.details.length ? { details: read.details } : {})
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
  | {
      ok: true
      doc: EditDoc
      warning: string | null
      lined: Lined[]
      notice: string | null
      details?: Detail[]
    }
  | { ok: false; message: string }
> {
  try {
    const parsed = EditDocSchema.safeParse(req.doc)
    if (!parsed.success) return { ok: false as const, message: 'The edit could not be read.' }
    let doc = parsed.data
    const soundPaths = req.soundPaths ?? []
    const notes: string[] = []
    const details: Detail[] = []
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
      const brand = await brandOfDoc(doc)
      const read = await readFootage(host, fresh, soundPaths, progress, first, {
        niche: doc.profile || nicheFrom(brand),
        mode: doc.sources.find((s) => s.mouth?.chosen)?.mouth?.mode,
        brand
      })
      notes.push(...read.notes)
      details.push(...read.details)
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
    return {
      ok: true as const,
      doc,
      warning: notes.length ? notes.join(' ') : null,
      lined,
      notice,
      ...(details.length ? { details } : {})
    }
  } catch (err) {
    progress('Failed', 0)
    return { ok: false as const, message: message(err) }
  }
}

/** Another player's view of one session, lined up with the person's own, as the edit takes a camera. */
export type SessionView = LinedRecording & {
  camera: { path: string; durationSec: number; width: number; height: number; fps: number; color?: 'hlg' | 'pq' }
}

/**
 * Which file is which: measured, then read against what the person said. A
 * host that lines up several players' views of one session (WorkHost.session)
 * finds them too, each as a camera of the person's own recording.
 */
export async function sortFootage(
  req: { request: string; paths: string[] },
  apiKey: string | null,
  progress: (stage: string, percent: number | null) => void,
  host?: Pick<WorkHost, 'probe' | 'session'>
): Promise<
  | { ok: true; roles: Omit<Roles, 'povs'> & { povs?: SessionView[] }; facts: FileFacts[] }
  | { ok: false; message: string }
> {
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
    let session = assigned
    let povs: SessionView[] = []
    if (host?.session) {
      // Several players' views of one gaming session are lined up by ear, the person's own first.
      progress('Listening for one session in them', null)
      session = await host.session(assigned, facts, req.request)
      // Each other view as the edit takes a camera: its shape and its frame rate.
      povs = await Promise.all(
        (session.povs ?? []).map(async (p) => {
          const meta = await host.probe(p.path)
          const color = meta.facts?.color
          return {
            ...p,
            camera: {
              path: p.path,
              durationSec: meta.durationSec,
              width: meta.width,
              height: meta.height,
              fps: meta.fps > 0 ? meta.fps : 30,
              ...(color && color !== 'sdr' ? { color } : {})
            }
          }
        })
      )
    }
    // Sorted without reading the request, one take recorded twice would be cut in twice.
    const { povs: _lined, ...roles } = povs.length
      ? session
      : assigned.by === 'measurement'
        ? await separateSameTakes(assigned, facts)
        : assigned
    return { ok: true as const, roles: { ...roles, ...(povs.length ? { povs } : {}) }, facts }
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
  /** What an upload needs, written beside a finished export (main/upload-kit). */
  upload: UploadKit | null
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
): Promise<Rendered | { ok: false; message: string; details?: Detail[] }> {
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
  // What ffmpeg writes, and where the finished file is: an export is made in
  // the work folder and only goes into the export folder whole (placeFile),
  // so a render killed partway, or the app quitting, leaves nothing there.
  let rendering: string | null = null
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
    rendering = final ? join(workDir, 'export.mp4') : join(await previewDir(), `${doc.id}-v${n}-${Date.now()}.mp4`)
    // The brand this version is made in: its graphics, caption colours and logo.
    const brand = await brandOfDoc(doc)
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
    // Scene effects next: their masks, maps and overlays, where this host draws them.
    const fx = host.fx
      ? await host.fx({
          cut,
          resolved,
          words: doc.words,
          sources,
          quality: req.quality,
          workDir: join(workDir, 'fx'),
          onProgress: (f) => progress(share + f * 0.15)
        })
      : null
    const afterFx = share + (fx ? 0.15 : 0)
    // The layer tracks: their pictures drawn the same way, their sounds placed for the mix.
    const hasLayers = (cut.tracks ?? []).some((t) => t.clips.length > 0)
    const layers =
      hasLayers && host.layers
        ? await host.layers({
            cut,
            resolved,
            words: doc.words,
            sources,
            assets: doc.assets,
            quality: req.quality,
            ffmpeg: host.ffmpeg(),
            workDir: join(workDir, 'layers'),
            fontsDir: host.fontsDir(),
            onProgress: (f) => progress(afterFx + f * 0.25)
          })
        : null
    const before = afterFx + (layers ? 0.25 : 0)
    const pass = subtitlePass(cut, resolved, motion.scene)
    // The subtitles leave out what a card holds back; the music and the sounds still follow every word.
    await renderCut(pass.cut, resolved, sources, {
      ffmpeg: host.ffmpeg(),
      outputPath: rendering,
      workDir,
      quality: req.quality,
      fontsDir: host.fontsDir(),
      brand: brand.autoApply ? { colors: brand.colors, logo: brand.logo } : null,
      overlays: motion.overlays,
      layers,
      fx,
      captionWords: pass.resolved.words,
      // A grid's panels show material, on a ground in the brand's look.
      assets: doc.assets,
      theme: themeFrom(brand),
      sfxDir: host.sfxDir(),
      encoder: host.encoder,
      perspective: host.perspective,
      onProgress: (f) => progress(before + f * (1 - before))
    })
    // An export's name is free only when nothing that goes beside it is there either.
    outputPath = final
      ? await placeFile(
          rendering,
          host.outputDir(),
          req.name ? safeName(req.name) : `${safeName(doc.title)} v${n}`,
          '.mp4',
          EXPORT_BESIDE
        )
      : rendering
    // Anything from outside the person's own files is credited beside the video.
    let creditsPath: string | null = null
    const credits = final ? creditsText(doc) : null
    if (credits) {
      creditsPath = outputPath.replace(/\.mp4$/i, '') + ' credits.txt'
      await files.writeText(creditsPath, credits)
    }
    // The file's own size and length, so the chat can frame it before it loads.
    const made = await host.probe(outputPath).catch(() => null)
    const width = made?.width ?? 0
    const height = made?.height ?? 0
    const durationSec = made?.durationSec ?? resolved.durationSec
    // Chapters for the YouTube description, the same ones the video file carries. A Short shows none.
    let chaptersPath: string | null = null
    const chapters = final ? chaptersReply(cut, resolved) : null
    if (chapters?.shows && !isShort(width, height, durationSec)) {
      chaptersPath = outputPath.replace(/\.mp4$/i, '') + ' chapters.txt'
      await files.writeText(chaptersPath, `${chapters.lines}\n`)
    }
    // What an upload needs, beside the video: captions, a description, titles and tags (main/upload-kit).
    let upload: UploadKit | null = null
    if (final) {
      report('Writing the description', 99)
      const key = await host.apiKey()
      const allowed = host.claudeWritesUpload()
      upload = await writeUploadKit({
        doc,
        cut,
        resolved,
        pass,
        scene: motion.scene,
        brand,
        outputPath,
        width,
        height,
        durationSec,
        // Claude only with the person's key and the switch in Settings on; otherwise nothing leaves.
        write: key && allowed ? claudeWriter(key) : null,
        why: !key ? 'no-key' : !allowed ? 'off' : null
      }).catch((err) => {
        console.error('[upload] could not write the upload kit:', message(err))
        return null
      })
    }
    return {
      ok: true as const,
      outputPath,
      mediaUrl: mediaUrlFor(outputPath),
      creditsPath,
      chaptersPath,
      upload,
      width,
      height,
      durationSec
    }
  } catch (err) {
    const said = toolSaid(err)
    console.error('[cut] render failed:', message(err), said ? `\n${said.said}` : '')
    // A preview half-made, or an export placed before what goes beside it failed: neither is left.
    if (outputPath) await files.remove(outputPath).catch(() => undefined)
    if (!final && rendering) await files.remove(rendering).catch(() => undefined)
    // A sentence, and what ffmpeg said behind Details.
    const details = saidDetails(said)
    return { ok: false as const, message: message(err), ...(details.length ? { details } : {}) }
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
  mouth: { niche?: string | null; mode?: MouthMode; brand?: Brand } = {}
): Promise<{
  sources: Source[]
  words: Word[]
  notes: string[]
  lined: Lined[]
  maps: Record<string, AudioMap>
  intake: { sentence: string; facts: string[] } | undefined
  /** What watching the speaker's mouth changed or marked, in a sentence or two. */
  notice: string | null
  /** What whisper printed when it could not transcribe a clip, for Details under the notes. */
  details: Detail[]
}> {
  const sources: Source[] = []
  const words: Word[] = []
  const notes: string[] = []
  const details: Detail[] = []
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
          const heard = await transcriptFor(
            host,
            sp,
            length,
            (stage, pct) => step(`${stage} ${basename(sp, extname(sp))}`, 10 + pct * 0.85),
            { brand: mouth.brand }
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
            notice: (sentence) => notes.push(sentence),
            brand: mouth.brand
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
      // A conversation's voices told apart (shared/speakers), so a cold open can go question to answer and the
      // picture can follow whoever is talking.
      if (host.speakers && clip.length > 0 && (mouth.niche === 'podcast' || suggestProfile(clip)?.profile.id === 'podcast')) {
        step('Telling the voices apart', 99)
        try {
          const who = await host.speakers(path, clip)
          clip = clip.map((w, i) => (who[i] === null || who[i] === undefined ? w : { ...w, speaker: who[i] as number }))
        } catch (err) {
          console.warn('[cut] could not tell the voices apart:', message(err))
        }
      }
      words.push(...clip)
    } catch (err) {
      notes.push(`I couldn't transcribe ${name}, so it is one long beat for now. ${message(err)}`)
      details.push(...saidDetails(toolSaid(err), paths.length > 1 ? name : undefined))
    }
    sources.push(source)
  }
  const intake =
    sentences.length || facts.length ? { sentence: sentences.join(' '), facts: facts.slice(0, 3) } : undefined
  return { sources, words, notes, lined, maps, intake, notice: mouthNotice(watched, paths.length), details }
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
    /** True when the words must be heard on this device, never by another service. */
    localOnly?: boolean
    /** The brand whose names are listened for; the default brand's when absent. */
    brand?: Brand
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
        `The ${whisperModel} transcription model isn't on ${thisComputer} yet. Download it in Settings, then try again.`
      )
    }
    await downloadModel(whisperModel, (p) => progress(`Downloading ${whisperModel}`, Math.round(p * 0.3)))
  }
  const brand = opts.brand ?? (await readBrand())
  const names = vocabulary({ title: basename(path, extname(path)), voice: brand.voice, products: brand.products })
  return transcribe(path, whisperModel, durationSec, (p, stage) => progress(stage, 30 + Math.round(p * 0.7)), 0, {
    names
  })
}

/** An export's name from the edit's title: what a project is named by, short enough for any file system. */
export function safeName(title: string): string {
  return projectName(title)
}

/** Everything an export leaves beside the video, after its name. */
const EXPORT_BESIDE = [' credits.txt', ' chapters.txt', ...Object.values(UPLOAD_SUFFIXES)]

async function previewDir(): Promise<string> {
  const dir = join(platform().paths.temp(), 'cutalong-previews')
  await platform().files.mkdir(dir)
  return dir
}
