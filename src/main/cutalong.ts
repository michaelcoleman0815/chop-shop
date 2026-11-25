import { app, clipboard, dialog, ipcMain, type WebContents } from 'electron'
import { measureScopes } from './scopes'
import { readPicture } from './screen-read'
import { downloadSpeakerModel, findSpeakers } from './speakers'
import { anthropicKeyIn } from '../shared/keys'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { FFMPEG_PATH, FFPROBE_PATH, probe } from './ffmpeg'
import { FONTS_DIR, helperScript } from './resources'
import { signInBrowsers } from '../shared/platform'
import { getSettings, saveSettings } from './store'
import { hasModel, transcribe } from './transcribe'
import { fetchVideo, YTDLP_PATH } from './fetch-video'
import { fetchExcerpt, fetchImage, importFile, saveImage, searchVideos, type AssetTools, type NewAsset } from './assets'
import { isImageUrl, type Range } from '../shared/assets'
import { existsSync } from 'fs'
import { measureVideo } from './inspiration/measure'
import { freePath } from './export-paths'
import { readApiKey } from './apikey'
import { findFocus } from './focus'
import { analyzeTrack, findTracks } from './music'
import { lately, remember } from './lately'
import { ownSounds } from './own-sounds'
import { soundsLines, type OwnSound } from '../shared/sounds'
import type { PlanQuality } from '../shared/plan-quality'
import { planQuote, type QuoteInput } from './plan-quote'
import { findSounds, makeAllSfx, readSound } from './sfx'
import { findPremiere, openInPremiere, writePremiere } from './premiere-cut'
import { importPremiere, returnName, writePremiereReturn } from './premiere-import'
import { renderCutMotion } from './motion-render'
import { renderCutLayers } from './layers-render'
import { matteCutoutsFor, renderEditFx } from './fx-ipc'
import { captureLink } from './page-shot'
import { loadIcons, loadLogos } from './motion-icons'
import { loudnessEnvelope } from './audio-envelope'
import { estimateOffset, trustworthy, type Offset } from '../shared/audio/offset'
import { findSession, hearViews } from './session-povs'
import { watchClip } from './mouth'
import { detectFaces, hasFaceFinder } from './track'
import {
  extendCut,
  prepareCut,
  readFootage,
  renderEdit,
  safeName,
  sortFootage,
  transcriptFor,
  type WorkHost
} from './cut-work'
import { removePreset, savedPresets, savePreset } from './preset-store'
import { checkKey, keepOffList, keyDeps, planEdit } from './planner'
import type { CommandLine, RequestExtra } from './planner-prompt'
import { triage } from './triage'
import { planEditLocally } from './planner-local'
import { findServer, localModels } from './local-llm'
import { localHost } from './local-server'
import { brandOfDoc, readBrand, readBrandById, readBrands, saveBrand, saveBrands } from './brand-store'
import { hearInCloud, registerServicesIpc } from './providers'
import { registerLearnIpc } from './learn'
import { neverForBrand, preferencesForPlanner, registerMemoryIpc } from './memory'
import { neverForPlanner } from '../shared/never'
import { brandInSentence } from '../shared/brands'
import { registerClippingIpc } from './clipping'
import { accountStatus, requestCode, signOut, startAccountSync, syncAccount, verifyCode } from './account'
import { registerVlogIpc } from './vlog'
import { registerMakeIpc } from './make'
import { registerShowcaseIpc } from './showcase'
import { currentVersion, subjectFrom, type Subject, EditDocSchema, type Note } from '../shared/edit'
import {
  BUILT_IN_PRESETS,
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
import { saidDetails, toolSaid, type Detail } from '../shared/failure'
import { ENDING_SEC, habitLines, measureRun, OPENING_SEC, type VideoRun } from '../shared/channel-habits'
import { isFiller } from '../shared/fillers'
import { isLink, linkName, readLink } from './link-learn'
import { vocabulary } from '../shared/raw/prompt'

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

/** Where what the last edits looked like is kept. */
const latelyPath = (): string => join(app.getPath('userData'), 'lately.json')

/** Their own sounds, read and chosen among once for all who ask at the same time (main/own-sounds). */
let readingSounds: Promise<OwnSound[]> | null = null
function readSounds(): Promise<OwnSound[]> {
  readingSounds ??= ownSounds(FFMPEG_PATH, soundFolders(), join(app.getPath('userData'), 'sounds-index.json'))
    .catch(() => [])
    .finally(() => (readingSounds = null))
  return readingSounds
}
/** What the app asks a plan for: the edit, the words or notes, and what the person said yes to first (main/plan-quote). */
type PlanRequest = {
  doc: unknown
  request: string
  notes: Note[]
  voice?: string
  commands?: CommandLine[]
  agreed?: { quality: PlanQuality; most: number }
} & RequestExtra

/** The same, for a plan to use: none when a big library, read for the first time, is not ready in time. */
function soundsInTime(): Promise<OwnSound[]> {
  return Promise.race([readSounds(), new Promise<OwnSound[]>((resolve) => setTimeout(() => resolve([]), 15000).unref?.())])
}

/**
 * The Mac as the shared work sees it (cut-work.ts): its ffmpeg, settings in
 * userData, other AI services, the face finder, drawing motion graphics and
 * the person's key. Each is read when it is used.
 */
export const macWork: WorkHost = {
  ffmpeg: () => FFMPEG_PATH,
  ffprobe: () => FFPROBE_PATH,
  probe: (path) => probe(path),
  whisperModel: () => getSettings().whisperModel,
  outputDir: () => getSettings().outputDir,
  sfxDir: () => sfxDir(),
  fontsDir: () => FONTS_DIR(),
  hearInCloud: (path, durationSec, progress) => hearInCloud(path, durationSec, progress),
  watch: (input) => watchClip(input, detectFaces, FFMPEG_PATH),
  // What each recording's picture measures, for Claude to grade by (main/scopes).
  scopes: (path, durationSec) => measureScopes(FFMPEG_PATH, path, durationSec),
  // What is on screen in each recording and where the faces are, for the planner and the graphics (main/screen-read).
  picture: (path, durationSec) => readPicture(path, durationSec),
  speakers: async (path, words) => {
    await downloadSpeakerModel()
    return (await findSpeakers(FFMPEG_PATH, path, words)).words
  },
  // Graphics drawn behind the person, and clips cut to the person or an object, take the cut-outs Vision makes (main/matte-cutouts).
  motion: async (input) => renderCutMotion({ ...input, icons: loadIcons, logos: loadLogos, cutouts: await matteCutoutsFor(input) }),
  // The layer tracks, drawn by the same compositor (main/layers-render).
  layers: async (input) => renderCutLayers({ ...input, cutouts: await matteCutoutsFor(input) }),
  // Scene effects, from the cut-outs this Mac makes with Vision (main/fx-ipc).
  fx: (input) => renderEditFx(input),
  // Several players' views of one gaming session, lined up by ear (main/session-povs).
  session: (roles, facts, request) => findSession(roles, facts, request),
  apiKey: async () => readApiKey(),
  claudeWritesUpload: () => getSettings().claudeWritesUpload !== false
}

export function registerCutalongIpc(deps: { send: Send; mediaUrlFor: (path: string) => string }): void {
  /**
   * Turns footage into an edit. Several talking clips become one edit in the
   * order they were shot. When a separate recording has the better sound,
   * each clip is lined up with it by ear, and the words, the preview and the
   * export all use that sound.
   */
  ipcMain.handle(
    'cut:prepare',
    (e, input: string | { paths: string[]; soundPaths?: string[]; brand?: string | null }) => {
      // Their sounds are read while the footage is, so the first plan has them.
      void readSounds()
      return prepareCut(
        macWork,
        input,
        (stage, percent) => deps.send(e.sender, 'cut:progress', { stage, percent }),
        deps.mediaUrlFor
      )
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
  ipcMain.handle('cut:extend', (e, req: { doc: unknown; paths: string[]; soundPaths?: string[] }) =>
    extendCut(macWork, req, (stage, percent) => deps.send(e.sender, 'cut:progress', { stage, percent }))
  )

  /**
   * Which file is which: measured, then read against what the person said, with
   * several players' views of one gaming session lined up by ear (macWork.session).
   */
  ipcMain.handle('cut:session', (e, req: { request: string; paths: string[] }) =>
    sortFootage(req, readApiKey(), (stage, percent) => deps.send(e.sender, 'cut:progress', { stage, percent }), macWork)
  )

  /**
   * A Premiere sequence, exported from Premiere as xmeml, into a new edit:
   * a copy of its picture and sound to play here, heard as any footage is,
   * with every second of it in the cut (main/premiere-import).
   */
  ipcMain.handle('premiere:import', (e, req: { path: string; brand?: string | null }) =>
    importPremiere(
      macWork,
      req,
      (stage, percent) => deps.send(e.sender, 'cut:progress', { stage, percent }),
      deps.mediaUrlFor,
      join(app.getPath('userData'), 'premiere')
    )
  )

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
      // An edit of a Premiere sequence goes back onto that sequence, its cuts as they were.
      const name = doc.premiere ? returnName(doc) : `${safeName(doc.title)} v${n}`
      xmlPath = await freePath(getSettings().outputDir, name, '.xml', [' captions.srt'])
      const written = doc.premiere
        ? await writePremiereReturn(doc, { ffmpeg: FFMPEG_PATH, xmlPath, sfxDir: sfxDir() })
        : await writePremiere(doc, { ffmpeg: FFMPEG_PATH, xmlPath, sfxDir: sfxDir() })
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

  /**
   * Each other player's view of a session, heard on the person's own clock
   * (session-povs: hearViews), so whose voice, laugh or bang each moment is
   * can be told (shared/pov/choose).
   */
  ipcMain.handle('pov:listen', async (e, req: { doc: unknown }) => {
    const parsed = EditDocSchema.safeParse(req.doc)
    if (!parsed.success) return { ok: false as const, message: 'The edit could not be read.' }
    try {
      const maps = await hearViews(parsed.data, (stage, percent) => deps.send(e.sender, 'cut:progress', { stage, percent }))
      return { ok: true as const, maps }
    } catch (err) {
      return { ok: false as const, message: message(err) }
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
  ipcMain.handle('cut:render', (e, req: { doc: unknown; quality: 'preview' | 'final'; name?: string }) =>
    renderEdit(
      macWork,
      req,
      (stage, percent) => deps.send(e.sender, 'cut:progress', { stage, percent }),
      deps.mediaUrlFor
    )
  )

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
      if (measures.hasAudio && (await hasModel(settings.whisperModel))) {
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
      e,
      req: PlanRequest
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
      // Their own sound effects, so the edit reaches for those before the made ones.
      const sounds = await soundsInTime()
      // What the last edits looked like, so this one is not the same again.
      const before = parsed.success ? await lately(latelyPath(), parsed.data.id).catch(() => []) : []
      const local = getSettings().localPlanner
      const result = local
        ? await planEditLocally(
            { ...req, preferences, logos, never: said, habits },
            { host: await localHost(), model: local }
          )
        : await planEdit(
            { ...req, preferences, logos, never: said, habits, sounds, lately: before },
            { progress: (stage) => deps.send(e.sender, 'cut:progress', { stage, percent: null }) }
          )
      if (!parsed.success) return result
      const offered = keepOffList(result, parsed.data, never, brandInSentence(brand))
      if (offered.ok) await remember(latelyPath(), parsed.data, offered.ops).catch(() => undefined)
      return offered
    }
  )

  // What an edit will cost, before it starts: worked out here from what it would send, with nothing asked of Claude.
  // Null where it costs nothing (a local AI) or cannot run (no key).
  ipcMain.handle('cut:quote', async (_e, req: Omit<QuoteInput, 'more'>) => {
    if (getSettings().localPlanner || !(await keyDeps().read())) return null
    const sounds = await soundsInTime()
    return planQuote({ ...req, more: soundsLines(sounds).join('\n').length + 1200 }, getSettings())
  })

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
        chat?: { role: 'user' | 'assistant'; text: string }[]
        made?: string[]
      }
    ) => {
      const files = await Promise.all(
        req.files.map(async (f) => {
          const p = await probe(f.path).catch(() => null)
          return { name: f.name, durationSec: p ? p.durationSec : null, video: !!p && p.width > 0, audio: !!p?.facts.audio }
        })
      )
      // With no key, the model on this computer chosen in Claude's place reads it (main/local-llm).
      return triage(
        {
          request: req.request,
          files,
          link: req.link,
          hasEdit: req.hasEdit,
          commands: req.commands,
          chat: req.chat,
          made: req.made
        },
        {
          key: () => keyDeps().read(),
          local: async () => {
            const model = getSettings().localPlanner
            return model ? { host: await localHost(), model } : null
          }
        }
      )
    }
  )

  // The local AI server on this computer, which kind it is, and its models: for planning edits,
  // seeing pictures and finding clips without Claude (main/local-llm).
  ipcMain.handle('planner:local', async () => {
    const server = await findServer(getSettings().localServer)
    if (!server) return { up: false, models: [], kind: null, host: null }
    return { up: true, kind: server.kind, host: server.host, models: await localModels(server.host).catch(() => []) }
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
        } else if (!(await hasModel(settings.whisperModel))) {
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
    const allowed = signInBrowsers()
    return saveSettings({ videoSignIn: browser && allowed.includes(browser) ? browser : null }).videoSignIn ?? null
  })

  ipcMain.handle('claude:check', (_e, opts?: { quick?: boolean }) => checkKey(keyDeps(), opts ?? {}))
  // A key copied in the Console, picked up when the person comes back: only text shaped like an
  // Anthropic key ever leaves the clipboard, and nothing of it is kept here (shared/keys).
  ipcMain.handle('claude:keyOnClipboard', async () => anthropicKeyIn(await clipboard.readText()))

  // Other AI services: keys, the switch, and key checks (providers/index.ts).
  registerServicesIpc()

  // The account: sign in with an emailed code, and keys, settings, brands and presets sync (main/account).
  ipcMain.handle('account:status', () => accountStatus())
  ipcMain.handle('account:code', (_e, email: string) => requestCode(String(email ?? '')))
  ipcMain.handle('account:verify', (_e, email: string, code: string) => verifyCode(String(email ?? ''), String(code ?? '')))
  ipcMain.handle('account:signOut', () => signOut())
  ipcMain.handle('account:sync', () => syncAccount())
  startAccountSync()

  ipcMain.handle('presets:list', () => savedPresets())
  ipcMain.handle('presets:save', (_e, preset: unknown) => savePreset(preset))
  ipcMain.handle('presets:remove', (_e, command: string) => removePreset(command))

  // Learning from the creator's own edits, transcribed the same local way,
  // and without fetching a model: nothing in it leaves this computer.
  registerLearnIpc({
    send: deps.send,
    transcribe: (path, durationSec, progress) =>
      transcriptFor(macWork, path, durationSec, progress, { download: false, localOnly: true })
  })
  // And from how they edit here: small signals in, plain statements out, on this computer.
  registerMemoryIpc()
  // /clipping: many short clips from long recordings (main/clipping).
  registerClippingIpc({ send: deps.send })

  // Videos made from nothing (main/make): a narration read or recorded is heard on this Mac only.
  registerMakeIpc({
    send: deps.send,
    mediaUrlFor: deps.mediaUrlFor,
    transcribe: (path, durationSec, progress) =>
      transcriptFor(macWork, path, durationSec, progress, { localOnly: true })
  })

  // Video cards read from links, and grids of several videos at once (main/showcase).
  registerShowcaseIpc({ mediaUrlFor: deps.mediaUrlFor })

  // Vlogs: a shoot watched and told as a story (main/vlog), its talking heard as footage is here.
  registerVlogIpc({
    send: deps.send,
    mediaUrlFor: deps.mediaUrlFor,
    // In the chat's brand: the names it listens for.
    readTalking: async (path, n, progress, brand) => {
      const read = await readFootage(macWork, [path], [], progress, n, {
        niche: 'vlog',
        brand: await readBrandById(brand)
      })
      const source = read.sources[0]
      return { source, words: read.words, map: read.maps[source.id], notes: read.notes }
    }
  })
}
