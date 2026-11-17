import { app, dialog, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { FFMPEG_PATH, FFPROBE_PATH, probe } from './ffmpeg'
import { FONTS_DIR, helperScript } from './resources'
import { getSettings, saveSettings } from './store'
import { downloadModel, hasModel, transcribe } from './transcribe'
import { fetchVideo, YTDLP_PATH } from './fetch-video'
import { fetchExcerpt, fetchImage, importFile, saveImage, searchVideos, type AssetTools, type NewAsset } from './assets'
import { creditsText, isImageUrl, type Range } from '../shared/assets'
import { existsSync } from 'fs'
import { measureVideo } from './inspiration/measure'
import { renderCut } from './cut-render'
import { freePath, placeFile } from './export-paths'
import { claudeWriter, writeUploadKit } from './upload-kit'
import { readApiKey } from './apikey'
import { isShort, UPLOAD_SUFFIXES, type UploadKit } from '../shared/upload'
import { findFocus } from './focus'
import { analyzeTrack, findTracks } from './music'
import { findSounds, makeAllSfx, readSound } from './sfx'
import { findPremiere, openInPremiere, writePremiere } from './premiere-cut'
import { renderCutMotion, subtitlePass } from './motion-render'
import { renderEditFx } from './fx-ipc'
import { captureLink } from './page-shot'
import { loadIcons, loadLogos } from './motion-icons'
import { loudnessEnvelope } from './audio-envelope'
import { snapWords, type Envelope } from '../shared/audio/snap'
import { estimateOffset, shiftEnvelope, shiftFrames, trustworthy, type Offset } from '../shared/audio/offset'
import { assignRoles, factsFor, separateSameTakes, type FileFacts } from './session'
import { listenFrames } from './audio-map'
import { buildAudioMap, type AudioMap, type Frames } from '../shared/audio/map'
import { vocabulary } from '../shared/raw/prompt'
import { intakeReply, probeSource } from './intake'
import { projectName } from '../shared/project-name'
import { watchClip } from './mouth'
import { detectFaces, hasFaceFinder } from './track'
import { thisComputer } from '../shared/platform'
import { mouthNotice, nicheFrom, type MouthMode, type WatchedClip } from '../shared/vision'
import { removePreset, savedPresets, savePreset } from './preset-store'
import { checkKey, keepOffList, keyDeps, planEdit } from './planner'
import type { CommandLine, RequestExtra } from './planner-prompt'
import { triage } from './triage'
import { planEditLocally } from './planner-local'
import { isLocalUp, localModels } from './local-llm'
import { OLLAMA_HOST } from './clips'
import { brandOfDoc, readBrand, readBrandById, readBrands, saveBrand, saveBrands } from './brand-store'
import { hearInCloud, registerServicesIpc } from './providers'
import { registerLearnIpc } from './learn'
import { neverForBrand, preferencesForPlanner, registerMemoryIpc } from './memory'
import { neverForPlanner } from '../shared/never'
import { brandInSentence, stampBrand } from '../shared/brands'
import { registerClippingIpc } from './clipping'
import { registerVlogIpc } from './vlog'
import { registerMakeIpc } from './make'
import { registerShowcaseIpc } from './showcase'
import { themeFrom } from '../shared/motion'
import {
  addSources,
  createDoc,
  currentCut,
  nextSourceId,
  currentVersion,
  subjectFrom,
  type Subject,
  EditDocSchema,
  resolveCut,
  wordsFromTranscript,
  type Note,
  type Source,
  type Word
} from '../shared/edit'
import {
  BUILT_IN_PRESETS,
  chaptersReply,
  describeStyle,
  CAPTION_STYLE_PRESETS,
  SKILL_PRESETS,
  suggestCommandName
} from '../shared/presets'
import {
  aspectOf,
  factDetails,
  factsReply,
  measureSpeech,
  styleFromFacts,
  summarize,
  type InspirationStudy,
  type SpeechMeasures
} from '../shared/inspiration'
import type { Transcript } from '../shared/types'
import type { Brand } from '../shared/brand'
import { saidDetails, toolSaid, type Detail } from '../shared/failure'
import { ENDING_SEC, habitLines, measureRun, OPENING_SEC, type VideoRun } from '../shared/channel-habits'
import { isFiller } from '../shared/fillers'
import { isLink, linkName, readLink } from './link-learn'

/**
 * The main-process side of Cutalong: turning footage into an edit document,
 * rendering a document, studying a video someone likes, and keeping saved
 * slash commands. Everything here is glue; the decisions live in shared/ and
 * in the tested modules it calls.
 */

type Send = (sender: WebContents, channel: string, payload: unknown) => void

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** How much of a reference video is transcribed for speech pacing. */
const SPEECH_SAMPLE_SEC = 180

/** Where the built-in sound effects are kept once made. */
const sfxDir = (): string => join(app.getPath('userData'), 'sfx')

/** The folders a person's own sound effects are usually in. */
const soundFolders = (): string[] => [
  join(app.getPath('music'), 'Sound Effects'),
  join(app.getPath('music'), 'Sounds'),
  join(app.getPath('music'), 'SFX'),
  join(app.getPath('userData'), 'sounds')
]

export function registerCutalongIpc(deps: { send: Send; mediaUrlFor: (path: string) => string }): void {
  /**
   * Turns footage into an edit. Several talking clips become one edit in the
   * order they were shot. When a separate recording has the better sound,
   * each clip is lined up with it by ear, and the words, the preview and the
   * export all use that sound.
   */
  ipcMain.handle(
    'cut:prepare',
    async (e, input: string | { paths: string[]; soundPaths?: string[]; brand?: string | null }) => {
      const paths = typeof input === 'string' ? [input] : input.paths
      const soundPaths = typeof input === 'string' ? [] : (input.soundPaths ?? [])
      const progress = (stage: string, percent: number): void => deps.send(e.sender, 'cut:progress', { stage, percent })
      try {
        if (paths.length === 0) return { ok: false as const, message: 'There is no footage to cut.' }
        // The chat's brand: its kind of video, and the names it listens for.
        const brand = await readBrandById(typeof input === 'string' ? null : input.brand)
        const read = await readFootage(paths, soundPaths, progress, 1, { niche: nicheFrom(brand), brand })
        const created = createDoc({
          id: randomUUID(),
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
          mediaUrl: deps.mediaUrlFor(paths[0]),
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
  )

  // Where a screen recording changes, stretch by stretch, for a camera to follow.
  ipcMain.handle(
    'focus:find',
    async (_e, req: { path: string; ranges: { startSec: number; durationSec: number }[] }) => {
      try {
        const regions = []
        for (const r of req.ranges.slice(0, 64)) {
          regions.push(await findFocus(FFMPEG_PATH, req.path, r.startSec, Math.min(r.durationSec, 600)))
        }
        return { ok: true as const, regions }
      } catch (err) {
        console.error('[focus] failed:', message(err))
        return { ok: false as const, message: `I couldn't read ${basename(req.path)} to see what changes in it.` }
      }
    }
  )

  // A track made ready to be a bed: its length, loudness, tempo and beats.
  ipcMain.handle('music:analyze', async (_e, path: string) => {
    try {
      return { ok: true as const, facts: await analyzeTrack(FFMPEG_PATH, path) }
    } catch (err) {
      console.error('[music] analysis failed:', message(err))
      return { ok: false as const, message: `I couldn't read ${basename(path)} as music.` }
    }
  })

  // The person's own music, by name, from their Music folder.
  ipcMain.handle('music:find', async (_e, query: string) => findTracks(query, [app.getPath('music')]))

  // The built-in sound effects, made once and kept, so the preview plays the files the export uses.
  ipcMain.handle('sfx:built', async () => {
    try {
      return { ok: true as const, files: await makeAllSfx(FFMPEG_PATH, sfxDir()) }
    } catch (err) {
      console.error('[sfx] making the sounds failed:', message(err))
      return { ok: false as const, message: "I couldn't make the sound effects." }
    }
  })
  // The person's own sounds, by name, from the folders sounds are usually kept in.
  ipcMain.handle('sfx:find', async (_e, query: string) => findSounds(query, soundFolders()))
  // What one of their sounds needs to land on its moment at a known level.
  ipcMain.handle('sfx:read', async (_e, path: string) => {
    try {
      return { ok: true as const, ...(await readSound(FFMPEG_PATH, path)) }
    } catch (err) {
      console.error('[sfx] reading a sound failed:', message(err))
      return { ok: false as const, message: `I couldn't read ${basename(path)} as a sound.` }
    }
  })
  /**
   * More footage for an edit already under way: new talking clips go on the
   * end of the cut as a new version, and a new recording with better sound is
   * lined up under every clip that does not have one yet.
   */
  ipcMain.handle('cut:extend', async (e, req: { doc: unknown; paths: string[]; soundPaths?: string[] }) => {
    const progress = (stage: string, percent: number): void => deps.send(e.sender, 'cut:progress', { stage, percent })
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
        const found = await lineUp(lonely, soundPaths, progress)
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
        const read = await readFootage(fresh, soundPaths, progress, first, {
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
  })

  /** Which file is which: measured, then read against what the person said. */
  ipcMain.handle('cut:session', async (e, req: { request: string; paths: string[] }) => {
    const progress = (stage: string, percent: number): void => deps.send(e.sender, 'cut:progress', { stage, percent })
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
      deps.send(e.sender, 'cut:progress', { stage: 'Working out which file is which', percent: null })
      const assigned = await assignRoles(req.request, facts)
      // Sorted without reading the request, one take recorded twice would be cut in twice.
      const roles = assigned.by === 'measurement' ? await separateSameTakes(assigned, facts) : assigned
      return { ok: true as const, roles, facts }
    } catch (err) {
      return { ok: false as const, message: message(err) }
    }
  })

  /**
   * The current version as a Premiere project beside the exports, cut on the
   * person's own files, with the captions beside it as SRT; Premiere opens it
   * when it is on this computer.
   */
  ipcMain.handle('cut:premiere', async (_e, req: { doc: unknown }) => {
    const parsed = EditDocSchema.safeParse(req.doc)
    if (!parsed.success) return { ok: false as const, message: 'The edit could not be read.' }
    const doc = parsed.data
    let xmlPath: string | null = null
    try {
      const n = currentVersion(doc).n
      // Its captions go beside it as "<name> captions.srt", so that name has to be free too.
      xmlPath = await freePath(getSettings().outputDir, `${safeName(doc.title)} v${n}`, '.xml', [' captions.srt'])
      const written = await writePremiere(doc, { ffmpeg: FFMPEG_PATH, xmlPath, sfxDir: sfxDir() })
      const premiere = await findPremiere()
      if (premiere) openInPremiere(premiere, xmlPath)
      return {
        ok: true as const,
        ...written,
        opened: premiere ? basename(premiere).replace(/\.(app|exe)$/i, '') : null
      }
    } catch (err) {
      console.error('[premiere] failed:', message(err))
      if (xmlPath) await fs.rm(xmlPath, { force: true }).catch(() => undefined)
      return { ok: false as const, message: message(err) }
    }
  })

  /**
   * Another camera of a recording: its shape, and where it sits against the
   * recording, found by ear as the better sound is. Unsure, it starts with no
   * offset and the reply says so, for /angle sync to move.
   */
  /**
   * Where the speaker is through each recording, for following them into a
   * narrower frame: the faces the face finder sees (the Mac's Vision helper,
   * YuNet on Windows), twice a second. Without one, the reply says so and
   * framing by hand still works.
   */
  ipcMain.handle('reframe:find', async (_e, req: { sources: { id: string; path: string; durationSec: number }[] }) => {
    const subjects: Record<string, Subject> = {}
    try {
      for (const s of req.sources) {
        const samples = await detectFaces(s.path, 0, s.durationSec, 2)
        subjects[s.id] = subjectFrom(samples, s.durationSec, 2)
      }
      return { ok: true as const, subjects }
    } catch (err) {
      return { ok: false as const, finder: hasFaceFinder(), message: message(err) }
    }
  })

  ipcMain.handle('angle:choose', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose the other camera’s recording',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mov', 'mp4', 'm4v', 'mkv', 'mts', 'avi', 'webm'] }]
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.handle('angle:line', async (_e, req: { path: string; of: string }) => {
    try {
      const meta = await probe(req.path)
      const color = meta.facts?.color
      let offset: Offset | null = null
      if (meta.facts?.audio) {
        const mine = await loudnessEnvelope(FFMPEG_PATH, req.of)
        offset = estimateOffset(mine, await loudnessEnvelope(FFMPEG_PATH, req.path))
      }
      const sure = offset !== null && trustworthy(offset)
      return {
        ok: true as const,
        camera: {
          path: req.path,
          durationSec: meta.durationSec,
          width: meta.width,
          height: meta.height,
          fps: meta.fps > 0 ? meta.fps : 30,
          ...(color && color !== 'sdr' ? { color } : {})
        },
        offsetSec: sure && offset ? offset.offsetSec : 0,
        sure,
        hasSound: !!meta.facts?.audio
      }
    } catch (err) {
      return { ok: false as const, message: message(err) }
    }
  })

  // A clip from /clipping exports under its own title (name), with no version number on it.
  ipcMain.handle('cut:render', async (e, req: { doc: unknown; quality: 'preview' | 'final'; name?: string }) => {
    const parsed = EditDocSchema.safeParse(req.doc)
    if (!parsed.success) return { ok: false as const, message: 'The edit could not be read.' }
    const doc = parsed.data
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    if (resolved.pieces.length === 0)
      return { ok: false as const, message: 'There is nothing left in the cut to render.' }

    const final = req.quality === 'final'
    const stage = final ? 'Exporting' : 'Rendering a preview'
    const workDir = await fs.mkdtemp(join(app.getPath('temp'), 'cutalong-render-'))
    // What ffmpeg writes, and where the finished file is: an export is made in
    // the work folder and only goes into the export folder whole (placeFile),
    // so a render killed partway, or the app quitting, leaves nothing there.
    let rendering: string | null = null
    let outputPath: string | null = null
    try {
      // What each recording has now. One the cut no longer uses may be gone
      // from the disk; nothing reads it, and one the cut does use is named in
      // a sentence before anything renders. A podcast has sound and no picture.
      const sources = await Promise.all(
        doc.sources.map(async (s) => {
          const facts = await probeSource(FFPROBE_PATH, s.path).catch(() => null)
          if (!facts) return { ...s, hasAudio: false }
          return { ...s, hasAudio: facts.audio !== null, hasVideo: facts.width > 0 && facts.height > 0 }
        })
      )
      const n = currentVersion(doc).n
      rendering = final ? join(workDir, 'export.mp4') : join(await previewDir(), `${doc.id}-v${n}-${Date.now()}.mp4`)
      // The brand this version is made in: its graphics, caption colours and logo.
      const brand = await brandOfDoc(doc)
      const report = (f: number): void => deps.send(e.sender, 'cut:progress', { stage, percent: Math.round(f * 100) })
      // Graphics first: drawn frame by frame, then laid over the picture in the final pass.
      const motion = await renderCutMotion({
        cut,
        resolved,
        words: doc.words,
        sources,
        assets: doc.assets,
        brand,
        quality: req.quality,
        ffmpeg: FFMPEG_PATH,
        workDir: join(workDir, 'motion'),
        fontsDir: FONTS_DIR(),
        icons: loadIcons,
        logos: loadLogos,
        onProgress: (f) => report(f * 0.25)
      })
      const share = motion.overlays.length > 0 ? 0.25 : 0
      // Scene effects next: their masks, maps and overlays, from the cut-outs this computer can make (main/fx-ipc).
      const fx = await renderEditFx({
        cut,
        resolved,
        words: doc.words,
        sources,
        quality: req.quality,
        workDir: join(workDir, 'fx'),
        onProgress: (f) => report(share + f * 0.15)
      })
      const before = share + (fx ? 0.15 : 0)
      const pass = subtitlePass(cut, resolved, motion.scene)
      // The subtitles leave out what a card holds back; the music and the sounds still follow every word.
      await renderCut(pass.cut, resolved, sources, {
        ffmpeg: FFMPEG_PATH,
        outputPath: rendering,
        workDir,
        quality: req.quality,
        fontsDir: FONTS_DIR(),
        brand: brand.autoApply ? { colors: brand.colors, logo: brand.logo } : null,
        overlays: motion.overlays,
        fx,
        captionWords: pass.resolved.words,
        // A grid's panels show material, on a ground in the brand's look.
        assets: doc.assets,
        theme: themeFrom(brand),
        sfxDir: sfxDir(),
        onProgress: (f) => report(before + f * (1 - before))
      })
      // An export's name is free only when nothing that goes beside it is there either.
      outputPath = final
        ? await placeFile(
            rendering,
            getSettings().outputDir,
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
        await fs.writeFile(creditsPath, credits)
      }
      // The file's own size and length, so the chat can frame it before it loads.
      const made = await probe(outputPath).catch(() => null)
      const width = made?.width ?? 0
      const height = made?.height ?? 0
      const durationSec = made?.durationSec ?? resolved.durationSec
      // Chapters for the YouTube description, the same ones the video file carries. A Short shows none.
      let chaptersPath: string | null = null
      const chapters = final ? chaptersReply(cut, resolved) : null
      if (chapters?.shows && !isShort(width, height, durationSec)) {
        chaptersPath = outputPath.replace(/\.mp4$/i, '') + ' chapters.txt'
        await fs.writeFile(chaptersPath, `${chapters.lines}\n`)
      }
      // What an upload needs, beside the video: captions, a description, titles and tags (main/upload-kit).
      let upload: UploadKit | null = null
      if (final) {
        deps.send(e.sender, 'cut:progress', { stage: 'Writing the description', percent: 99 })
        const key = readApiKey()
        const allowed = getSettings().claudeWritesUpload !== false
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
        mediaUrl: deps.mediaUrlFor(outputPath),
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
      if (outputPath) await fs.rm(outputPath, { force: true }).catch(() => undefined)
      if (!final && rendering) await fs.rm(rendering, { force: true }).catch(() => undefined)
      // A sentence, and what ffmpeg said behind Details.
      const details = saidDetails(said)
      return { ok: false as const, message: message(err), ...(details.length ? { details } : {}) }
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  ipcMain.handle('inspiration:study', async (e, input: { url?: string; path?: string }) => {
    const progress = (stage: string, percent: number): void =>
      deps.send(e.sender, 'inspiration:progress', { stage, percent })
    try {
      let path = input.path ?? null
      let title: string | null = null
      let channel: string | null = null
      if (input.url) {
        progress('Fetching the video', 2)
        const fetched = await fetchVideo(
          input.url,
          (p) => progress('Fetching the video', Math.round(p * 0.4)),
          undefined,
          getSettings().videoSignIn ?? null
        )
        path = fetched.path
        title = fetched.title
        channel = fetched.channel
      }
      if (!path) return { ok: false as const, message: 'Paste a link or drop a video to learn from.' }
      title ??= basename(path, extname(path))

      progress('Measuring the cuts', 42)
      const measures = await measureVideo(path, { ffmpeg: FFMPEG_PATH, maxSec: 600 })

      // Speech pacing needs a transcript. The model is not downloaded just
      // for this: the picture alone answers most of the question.
      let speech: SpeechMeasures | null = null
      let note: string | null = null
      let said: Detail[] = []
      const settings = getSettings()
      if (measures.hasAudio && hasModel(settings.whisperModel)) {
        try {
          progress('Listening to the pacing', 70)
          const span = Math.min(measures.measuredSec, SPEECH_SAMPLE_SEC)
          const transcript = await transcribe(path, settings.whisperModel, span, (p) =>
            progress('Listening to the pacing', 70 + Math.round(p * 0.28))
          )
          speech = measureSpeech(transcript.words)
        } catch (err) {
          note = `I measured the picture but couldn't listen to the speech. ${message(err)}`
          said = saidDetails(toolSaid(err))
        }
      } else if (measures.hasAudio) {
        note = 'Speech pacing needs the transcription model, which is not downloaded yet.'
      }

      const facts = summarize(measures, speech)
      const style = styleFromFacts(facts)
      const taken = [...BUILT_IN_PRESETS, ...CAPTION_STYLE_PRESETS, ...SKILL_PRESETS, ...(await savedPresets())]
      const study: InspirationStudy = {
        source: { url: input.url ?? null, path, title, durationSec: measures.durationSec },
        facts,
        style,
        reply: factsReply(facts),
        chips: describeStyle(style).slice(0, 3),
        details: [...factDetails(facts), ...said],
        command: suggestCommandName(channel ?? title, taken),
        note
      }
      progress('Done', 100)
      return { ok: true as const, study }
    } catch (err) {
      progress('Failed', 0)
      return { ok: false as const, message: message(err) }
    }
  })

  // What has been learned about how the creator edits goes with each request,
  // read fresh here so a statement they deleted never reaches the planner, and
  // the brand's own logos by name, so a logo pop can show them, and how the
  // brand's videos usually run (shared/channel-habits).
  // Claude plans unless the person picked a model on this Mac in Settings.
  // The edit's own brand gives the logos and the never list, which the plan is checked against too.
  ipcMain.handle(
    'cut:plan',
    async (
      _e,
      req: { doc: unknown; request: string; notes: Note[]; voice?: string; commands?: CommandLine[] } & RequestExtra
    ) => {
      const parsed = EditDocSchema.safeParse(req.doc)
      const brand = parsed.success ? await brandOfDoc(parsed.data) : await readBrand()
      // What this brand has learned from its own chats.
      const preferences = await preferencesForPlanner(brand.id).catch(() => [])
      const logos = brand.logos.map((l) => l.name)
      const never = await neverForBrand(brand.id).catch(() => [])
      const said = neverForPlanner(never)
      // How the brand's own videos run, when any were learned: a Short asked for aims at their usual length.
      const habits = habitLines(brand.videos)
      const local = getSettings().localPlanner
      const result = local
        ? await planEditLocally(
            { ...req, preferences, logos, never: said, habits },
            { host: OLLAMA_HOST, model: local }
          )
        : await planEdit({ ...req, preferences, logos, never: said, habits })
      return parsed.success ? keepOffList(result, parsed.data, never, brandInSentence(brand)) : result
    }
  )

  // Claude reads a message before any footage is read: one edit, a vlog,
  // clips from a long recording, words kept for footage still to come, or a
  // question to answer; and what a link with it is for. Each file goes as
  // its name, its length and whether it has a picture, never what is in it.
  ipcMain.handle(
    'cut:triage',
    async (
      _e,
      req: {
        request: string
        files: { path: string; name: string }[]
        link: string | null
        hasEdit: boolean
        commands?: CommandLine[]
      }
    ) => {
      const files = await Promise.all(
        req.files.map(async (f) => {
          const p = await probe(f.path).catch(() => null)
          return { name: f.name, durationSec: p ? p.durationSec : null, video: !!p && p.width > 0, audio: !!p?.facts.audio }
        })
      )
      return triage({ request: req.request, files, link: req.link, hasEdit: req.hasEdit, commands: req.commands })
    }
  )

  // The models Ollama has on this Mac, for planning edits without Claude.
  ipcMain.handle('planner:local', async () => {
    if (!(await isLocalUp(OLLAMA_HOST))) return { up: false, models: [] }
    return { up: true, models: await localModels(OLLAMA_HOST).catch(() => []) }
  })

  // The brand: kept in userData, learned from the person's own videos, all
  // measured here on this computer.
  ipcMain.handle('brand:get', () => readBrand())
  ipcMain.handle('brand:save', (_e, brand: unknown) => saveBrand(brand))
  // A brand per channel: the list, and which one new chats use (shared/brands).
  ipcMain.handle('brands:get', () => readBrands())
  ipcMain.handle('brands:save', (_e, brands: unknown) => saveBrands(brands))
  // A file gives its picture, its sound and its words, heard word for word
  // at its start and its end so the fillers left in show; a link gives its
  // length and its captions (main/link-learn). Both give how the channel's
  // videos run (shared/channel-habits).
  ipcMain.handle('brand:learn', async (e, paths: string[]) => {
    const learned: {
      path: string
      title: string
      facts: ReturnType<typeof summarize> | null
      run: VideoRun
    }[] = []
    const failed: string[] = []
    const details: Detail[] = []
    const settings = getSettings()
    for (const [i, path] of paths.entries()) {
      const at = (f: number): number => Math.round(((i + f) / paths.length) * 100)
      const name = isLink(path) ? linkName(path) : basename(path)
      try {
        if (isLink(path)) {
          needsYtdlp()
          deps.send(e.sender, 'brand:progress', { stage: `Fetching the captions of ${name}`, percent: at(0) })
          const dir = await fs.mkdtemp(join(app.getPath('temp'), 'cutalong-link-'))
          try {
            const read = await readLink(path, {
              ytdlp: YTDLP_PATH(),
              dir,
              signInFrom: settings.videoSignIn ?? null,
              signal: AbortSignal.timeout(180_000)
            })
            const run = measureRun({
              from: 'link',
              durationSec: read.durationSec,
              aspect: read.aspect,
              heard: read.captions ? { by: 'captions', stretches: [read.captions.words] } : { unheard: 'no-captions' }
            })
            learned.push({ path, title: read.title, facts: null, run })
          } finally {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
          }
          continue
        }
        deps.send(e.sender, 'brand:progress', { stage: `Watching ${name}`, percent: at(0) })
        const measures = await measureVideo(path, { ffmpeg: FFMPEG_PATH, maxSec: 600 })
        const aspect = aspectOf(measures.width, measures.height)
        let speech: SpeechMeasures | null = null
        let run: VideoRun
        if (!measures.hasAudio) {
          run = measureRun({ from: 'file', durationSec: measures.durationSec, aspect, heard: { unheard: 'no-sound' } })
        } else if (!hasModel(settings.whisperModel)) {
          run = measureRun({ from: 'file', durationSec: measures.durationSec, aspect, heard: { unheard: 'no-model' } })
        } else {
          deps.send(e.sender, 'brand:progress', { stage: `Listening to ${name}`, percent: at(0.4) })
          const verbatim = {
            names: vocabulary({ title: basename(path, extname(path)), voice: '', products: [] }),
            again: false
          }
          const opening = Math.min(measures.durationSec, OPENING_SEC)
          const start = await transcribe(path, settings.whisperModel, opening, () => undefined, 0, verbatim)
          const stretches = [start.words]
          // A longer video's end too: whether it closes on a call to action.
          if (measures.durationSec > opening + 5) {
            deps.send(e.sender, 'brand:progress', { stage: `Listening to the end of ${name}`, percent: at(0.7) })
            const from = Math.max(opening, measures.durationSec - ENDING_SEC)
            const tail = measures.durationSec - from
            const end = await transcribe(path, settings.whisperModel, tail, () => undefined, from, verbatim)
            stretches.push(end.words)
          }
          // The look's pace and pauses as before, from the opening without its fillers.
          speech = measureSpeech(start.words.filter((w) => !isFiller(w.text)))
          const heard = { by: 'whisper' as const, stretches }
          run = measureRun({ from: 'file', durationSec: measures.durationSec, aspect, heard })
        }
        learned.push({ path, title: basename(path, extname(path)), facts: summarize(measures, speech), run })
      } catch (err) {
        failed.push(`${name}: ${message(err)}`)
        details.push(...saidDetails(toolSaid(err), paths.length > 1 ? name : undefined))
      }
    }
    deps.send(e.sender, 'brand:progress', { stage: 'Done', percent: 100 })
    return { learned, failed, ...(details.length ? { details } : {}) }
  })

  // Material for an edit: files, image links, excerpts of videos at links,
  // search results to pick B-roll from, and icons the renderer drew. All of it
  // is kept on this computer, in the edit's own assets folder.
  const tools = (docId: string): AssetTools => ({
    ffmpeg: FFMPEG_PATH,
    ytdlp: YTDLP_PATH(),
    dir: join(app.getPath('videos'), 'Cutalong', 'Assets', docId.replace(/[^\w-]/g, '') || 'loose'),
    signInFrom: getSettings().videoSignIn ?? null
  })
  const needsYtdlp = (): void => {
    if (!existsSync(YTDLP_PATH()))
      throw new Error(`yt-dlp is missing from this build. Run ${helperScript('fetch-ytdlp')}.`)
  }

  ipcMain.handle('assets:add', async (e, req: { docId: string; path?: string; url?: string; range?: Range | null }) => {
    try {
      let asset: NewAsset
      if (req.path) asset = await importFile(req.path, tools(req.docId))
      else if (req.url && isImageUrl(req.url)) asset = await fetchImage(req.url, tools(req.docId))
      else if (req.url) {
        needsYtdlp()
        asset = await fetchExcerpt(req.url, req.range ?? null, tools(req.docId), (p) =>
          deps.send(e.sender, 'assets:progress', { stage: 'Fetching the clip', percent: p })
        )
      } else return { ok: false as const, message: 'There was nothing to add.', signIn: false }
      return { ok: true as const, asset }
    } catch (err) {
      const text = message(err)
      return { ok: false as const, message: text, signIn: /signed-in browser/.test(text) }
    }
  })

  // The brand's B-roll sources: channels and sites to look in first, and ones never to use.
  ipcMain.handle('assets:search', async (_e, query: string, sources?: { prefer?: unknown; block?: unknown }) => {
    const lines = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 30) : []
    try {
      needsYtdlp()
      const found = await searchVideos(query, tools('search'), 5, {
        prefer: lines(sources?.prefer),
        block: lines(sources?.block)
      })
      return { ok: true as const, ...found }
    } catch (err) {
      return { ok: false as const, message: message(err) }
    }
  })

  ipcMain.handle(
    'assets:saveImage',
    async (_e, req: { docId: string; base64: string; name: string; origin: NewAsset['origin'] }) => {
      try {
        const asset = await saveImage(Buffer.from(req.base64, 'base64'), req.name, req.origin, tools(req.docId))
        return { ok: true as const, asset }
      } catch (err) {
        return { ok: false as const, message: message(err) }
      }
    }
  )

  // A page at a link the person gave, captured here as one tall picture, as it
  // shows to someone logged out, and kept with the link it came from.
  ipcMain.handle('assets:capturePage', async (_e, req: { docId: string; url: string }) => {
    const link = captureLink(req.url)
    if (!link)
      return { ok: false as const, message: 'That is not a link I can open. It needs to start with http or https.' }
    try {
      const { capturePage } = await import('./page-capture')
      const shot = await capturePage(link.href)
      const host = new URL(shot.url || link.href).hostname.replace(/^www\./, '')
      const origin = { type: 'link' as const, url: link.href, author: host, license: null, range: null }
      const asset = await saveImage(shot.png, shot.title || host, origin, tools(req.docId))
      return { ok: true as const, asset }
    } catch (err) {
      return { ok: false as const, message: message(err) }
    }
  })

  ipcMain.handle('settings:videoSignIn', (_e, browser: string | null) => {
    const allowed = ['chrome', 'safari', 'firefox', 'edge', 'brave', 'chromium', 'opera', 'vivaldi']
    return saveSettings({ videoSignIn: browser && allowed.includes(browser) ? browser : null }).videoSignIn ?? null
  })

  ipcMain.handle('claude:check', (_e, opts?: { quick?: boolean }) => checkKey(keyDeps(), opts ?? {}))

  // Other AI services: keys, the switch, and key checks (providers/index.ts).
  registerServicesIpc()

  ipcMain.handle('presets:list', () => savedPresets())
  ipcMain.handle('presets:save', (_e, preset: unknown) => savePreset(preset))
  ipcMain.handle('presets:remove', (_e, command: string) => removePreset(command))

  // Learning from the creator's own edits, transcribed the same local way,
  // and without fetching a model: nothing in it leaves this computer.
  registerLearnIpc({
    send: deps.send,
    transcribe: (path, durationSec, progress) =>
      transcriptFor(path, durationSec, progress, { download: false, localOnly: true })
  })
  // And from how they edit here: small signals in, plain statements out, on this computer.
  registerMemoryIpc()
  // /clipping: many short clips from long recordings (main/clipping).
  registerClippingIpc({ send: deps.send })

  // Videos made from nothing (main/make): a narration read or recorded is heard on this Mac only.
  registerMakeIpc({
    send: deps.send,
    mediaUrlFor: deps.mediaUrlFor,
    transcribe: (path, durationSec, progress) => transcriptFor(path, durationSec, progress, { localOnly: true })
  })

  // Video cards read from links, and grids of several videos at once (main/showcase).
  registerShowcaseIpc({ mediaUrlFor: deps.mediaUrlFor })

  // Vlogs: a shoot watched and told as a story (main/vlog), its talking heard as footage is here.
  registerVlogIpc({
    send: deps.send,
    mediaUrlFor: deps.mediaUrlFor,
    // In the chat's brand: the names it listens for.
    readTalking: async (path, n, progress, brand) => {
      const read = await readFootage([path], [], progress, n, { niche: 'vlog', brand: await readBrandById(brand) })
      const source = read.sources[0]
      return { source, words: read.words, map: read.maps[source.id], notes: read.notes }
    }
  })
}

interface Lined {
  name: string
  sound: string
  offsetSec: number
}

type ProgressFn = (stage: string, percent: number) => void

/**
 * Finds where each clip sits in the recordings with the better sound, by
 * matching their loudness. A clip keeps its own sound when no match is sure.
 */
async function lineUp(
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
      const mine = await loudnessEnvelope(FFMPEG_PATH, source.path)
      own.set(source.id, mine)
      let best: { path: string; offset: Offset } | null = null
      for (const sp of soundPaths) {
        if (!envelopes.has(sp)) envelopes.set(sp, await loudnessEnvelope(FFMPEG_PATH, sp))
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
async function readFootage(
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
    const meta = await probe(path)
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
      const found = await lineUp([source], soundPaths, (stage) => step(stage, 5), soundEnv)
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
          const length = (await probe(sp)).durationSec
          const heard = await transcriptFor(
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
            if (!soundFrames.has(sp)) soundFrames.set(sp, await listenFrames(FFMPEG_PATH, sp))
            maps[source.id] = buildAudioMap(shiftFrames(soundFrames.get(sp) as Frames, at, source.durationSec), clip)
          } catch (err) {
            console.warn('[cut] could not map the sound:', message(err))
          }
        }
      } else {
        const transcript = await transcriptFor(path, source.durationSec, (stage, pct) => step(stage, 10 + pct * 0.85), {
          notice: (sentence) => notes.push(sentence),
          brand: mouth.brand
        })
        clip = wordsFromTranscript(transcript.words, source.id, prefix)
        // Listen to the recording so every word's edges sit on its sound,
        // which is what lets cuts land tight without clipping a consonant.
        // The same listen measures pitch and what kind of sound each stretch
        // is, for the audio map that takes and the planner read.
        if (clip.length > 0) {
          step('Listening for the cuts', 97)
          try {
            const frames = await listenFrames(FFMPEG_PATH, path)
            heard = { hopSec: frames.hopSec, db: frames.db }
            clip = snapWords(clip, heard)
            maps[source.id] = buildAudioMap(frames, clip)
          } catch (err) {
            try {
              heard = own ?? (await loudnessEnvelope(FFMPEG_PATH, path))
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
      // compare it with, sound timing stays.
      if (clip.length > 0 && heard) {
        step('Watching the speaker', 98)
        const w = await watchClip(
          { source, words: clip, envelope: heard, map: maps[source.id], ...mouth },
          detectFaces,
          FFMPEG_PATH
        )
        ;({ source, words: clip } = w)
        if (w.map) maps[source.id] = w.map
        if (w.seen) watched.push({ name: basename(path), source, words: clip })
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
async function transcriptFor(
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
    /** The brand whose names are listened for; the default brand's when absent. */
    brand?: Brand
  } = {}
): Promise<Transcript> {
  // Another AI service hears the words when the person has added one. If it
  // cannot, this computer does, and the one sentence saying why goes back.
  if (!opts.localOnly) {
    const cloud = await hearInCloud(path, durationSec, progress)
    if (cloud.service) return cloud.transcript
    if (cloud.note) opts.notice?.(cloud.note)
  }

  const { whisperModel } = getSettings()
  if (!hasModel(whisperModel)) {
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
function safeName(title: string): string {
  return projectName(title)
}

/** Everything an export leaves beside the video, after its name. */
const EXPORT_BESIDE = [' credits.txt', ' chapters.txt', ...Object.values(UPLOAD_SUFFIXES)]

async function previewDir(): Promise<string> {
  const dir = join(app.getPath('temp'), 'cutalong-previews')
  await fs.mkdir(dir, { recursive: true })
  return dir
}
