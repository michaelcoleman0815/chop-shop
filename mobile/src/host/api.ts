import type { EngineInfo, EnginePlugin } from 'cutalong-engine'
import type { CutalongApi } from '../../../src/renderer/src/cutalong/api'
import { platform } from '../../../src/main/platform'
import { probeFile } from '../../../src/main/intake'
import { extendCut, prepareCut, renderEdit, sortFootage, type WorkHost } from '../../../src/main/cut-work'
import { checkKey, keyDeps, planEdit } from '../../../src/main/planner'
import { planQuote } from '../../../src/main/plan-quote'
import { triage } from '../../../src/main/triage'
import { downloadModel, hasModel, modelSizeMb, type WhisperModel } from '../../../src/main/transcribe'
import { analyzeTrack } from '../../../src/main/music'
import { makeAllSfx, readSound } from '../../../src/main/sfx'
import { findFocus } from '../../../src/main/focus'
import { importFile } from '../../../src/main/asset-file'
import { brandOfDoc, readBrand, readBrands, saveBrand, saveBrands } from '../../../src/main/brand-store'
import { removePreset, savedPresets, savePreset } from '../../../src/main/preset-store'
import { accountStatus, requestCode, signOut, syncAccount, verifyCode } from '../../../src/main/account'
import { createProject, openProject, recentProjects, saveProject } from './projects'
import { sceneForCut } from '../../../src/main/motion-scene'
import { clipSounds, drawsOverPicture } from '../../../src/main/layer-sounds'
import { phoneEncoder } from '../../../src/main/render/encoder'
import { detectProvider } from '../../../src/shared/keys'
import { isServiceId, type ServiceId } from '../../../src/shared/services'
import { EMPTY_MEMORY, memoryView } from '../../../src/shared/memory'
import { EditDocSchema } from '../../../src/shared/edit'
import type { MapStatus } from '../../../src/shared/maps'
import { learnState } from '../../../src/shared/learn'
import { effectsOf } from '../../../src/shared/fx'
import { filmLayers } from '../../../src/shared/edit/film'
import { habitLines } from '../../../src/shared/channel-habits'
import { BROLL_KEYS, type BrollKeyId } from '../../../src/shared/broll/keys'
import { DEFAULT_BROLL } from '../../../src/shared/broll/settings'
import { ON_THE_MAC } from './limits'
import type { PhoneServices } from './services'
import type { PhoneSettings } from './settings'

/**
 * The API the app uses (renderer api.ts), answered on the phone by the same
 * work the Mac's main process does (src/main), on the phone's platform.
 * What is on the Mac for now answers with one sentence saying so.
 */

/** Maps are drawn on the Mac's canvas for now, like the other graphics: nothing of them is kept here. */
const NO_MAPS: MapStatus = { level: 0, plates: false, complete: false, downloadMb: 0 }

type Progress = { stage: string; percent: number | null }
type Listener = (p: Progress) => void

export interface PhoneApiParts {
  engine: EnginePlugin
  info: EngineInfo
  settings: PhoneSettings
  /** Other AI services, behind the switch and their keys (services.ts). */
  services: PhoneServices
  mediaUrlFor: (path: string) => string
  version: string
  /** Keeps the screen on while an export runs; the person is told so. */
  awake: { keep(): Promise<void>; allow(): Promise<void> }
}

/** The shared work's view of the phone (src/main/cut-work.ts). */
export function phoneWork(parts: Pick<PhoneApiParts, 'info' | 'settings' | 'services'>): WorkHost {
  const encoder = phoneEncoder(parts.info.encoders)
  return {
    ffmpeg: () => 'ffmpeg',
    ffprobe: () => 'ffprobe',
    probe: (path) => probeFile('ffprobe', path),
    whisperModel: () => parts.settings.current().whisperModel,
    outputDir: () => platform().paths.exports(),
    sfxDir: () => `${platform().paths.userData()}/sfx`,
    fontsDir: () => platform().paths.fonts(),
    hearInCloud: (path, durationSec, progress) => parts.services.hearInCloud(path, durationSec, progress),
    // Graphics, scene effects, a grid's ground and film's dust, leaks and flicker are drawn on the Mac's
    // canvas for now: a cut with none of them renders here.
    motion: async (input) => {
      if (effectsOf(input.cut).length > 0) throw new Error(ON_THE_MAC.effects)
      if (input.cut.beats.some((b) => b.treatment.grid)) throw new Error(ON_THE_MAC.grid)
      const film = filmLayers(input.cut.look)
      if (film.fine || film.soft) throw new Error(ON_THE_MAC.film)
      const scene = sceneForCut(input)
      if (scene.layers.length > 0) throw new Error(ON_THE_MAC.graphics)
      return { overlays: [], scene }
    },
    // The layer tracks' sounds mix here; their pictures are drawn on the Mac's canvas for now.
    layers: async (input) => {
      if (drawsOverPicture(input)) throw new Error(ON_THE_MAC.layers)
      const sounds = await clipSounds(input, async (path) => (await probeFile('ffprobe', path)).facts.audio !== null)
      return { overlays: [], sounds }
    },
    encoder: encoder ?? undefined,
    perspective: false,
    apiKey: () => platform().secrets.get('anthropic'),
    claudeWritesUpload: () => parts.settings.current().claudeWritesUpload !== false
  }
}

/**
 * The person's Anthropic key, locked in the Keychain or the Keystore. The
 * key calls below (hasApiKey, checkKey, setApiKey, clearApiKey, provider)
 * are the ones the Mac answers, so a gate in the shared app that asks for a
 * working key before anything runs works on a phone as it is.
 */
const key = (): Promise<string | null> => platform().secrets.get('anthropic')

function asService(id: unknown): ServiceId {
  if (!isServiceId(id)) throw new Error('That is not a service Cutalong knows.')
  return id
}

function fanOut(): { listeners: Set<Listener>; emit: Listener; on: (cb: Listener) => () => void } {
  const listeners = new Set<Listener>()
  return {
    listeners,
    emit: (p) => listeners.forEach((cb) => cb(p)),
    on: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}

export function createPhoneApi(parts: PhoneApiParts): CutalongApi {
  const work = phoneWork(parts)
  const cut = fanOut()
  const ai = fanOut()
  const quiet = (): (() => void) => () => undefined
  const pick = async (
    kinds: Array<'video' | 'audio' | 'image'>,
    multiple: boolean
  ): Promise<{ path: string; name: string }[]> =>
    (await parts.engine.pick({ multiple, kinds })).files.map((f) => ({ path: f.path, name: f.name }))
  const progress = (stage: string, percent: number | null): void => cut.emit({ stage, percent })

  // Stills for files, once each: the frame a tenth of the way in.
  const posters = new Map<string, Promise<string | null>>()
  const poster = (path: string): Promise<string | null> => {
    let job = posters.get(path)
    if (!job) {
      job = (async () => {
        const host = platform()
        const facts = await probeFile('ffprobe', path)
        if (facts.width <= 0) return null
        const dir = `${host.paths.temp()}/posters`
        await host.files.mkdir(dir)
        const out = `${dir}/${encodeURIComponent(path).replace(/%/g, '_').slice(-120)}.jpg`
        if (!(await host.files.stat(out))) {
          const r = await host.run('ffmpeg', [
            '-hide_banner',
            '-y',
            ...['-ss', (Math.max(0, facts.durationSec) * 0.1).toFixed(3), '-i', path],
            ...['-frames:v', '1', '-vf', 'scale=-2:360', '-an', out]
          ])
          if (r.code !== 0) return null
        }
        return parts.mediaUrlFor(out)
      })().catch(() => null)
      posters.set(path, job)
      void job.then((url) => {
        if (!url) posters.delete(path)
      })
    }
    return job
  }

  return {
    getVersion: async () => parts.version,
    // Phones have no drag and drop: files come in through + (openMedia).
    pathForFile: () => '',
    openVideo: async () => null,
    prepareCut: (input) => prepareCut(work, input, progress, parts.mediaUrlFor),
    extendCut: (req) => extendCut(work, req, progress),
    // Several players' views of one session are not looked for here (no WorkHost.session): they are cut on the Mac.
    planSession: async (req) => {
      const r = await sortFootage(req, await key(), progress)
      return r.ok ? { ok: true as const, roles: r.roles } : r
    },
    makeVlog: async () => ({ ok: false as const, message: ON_THE_MAC.vlog }),
    planVlog: async () => ({ ok: false as const, message: ON_THE_MAC.vlog }),
    // Videos made from nothing are on the Mac for now: nothing is written, quoted, made or spent here, tap or no tap.
    makeStart: async () => ({ ok: false as const, message: ON_THE_MAC.make }),
    makeGo: async () => ({ ok: false as const, message: ON_THE_MAC.make }),
    makeRevise: async () => ({ ok: false as const, message: ON_THE_MAC.make }),
    makeScript: async () => ({ ok: false as const, message: ON_THE_MAC.make }),
    makeChange: async () => ({ ok: false as const, message: ON_THE_MAC.make }),
    makeShot: async () => ({ ok: false as const, message: ON_THE_MAC.make }),
    makeCancel: async () => false,
    /**
     * Rendered by the renderer of record with the phone's encoder. An export
     * keeps the screen on while it runs, then goes to Photos as well.
     */
    renderCut: async (req) => {
      const final = req.quality === 'final'
      if (final) await parts.awake.keep().catch(() => undefined)
      try {
        const r = await renderEdit(work, req, (stage, percent) => cut.emit({ stage, percent }), parts.mediaUrlFor)
        if (!r.ok || !final) return r
        const photos = await parts.engine
          .saveToPhotos({ path: r.outputPath })
          .catch((err: unknown) => ({ saved: false, message: err instanceof Error ? err.message : String(err) }))
        return { ...r, photos }
      } finally {
        if (final) await parts.awake.allow().catch(() => undefined)
      }
    },
    openPremiere: async () => ({ ok: false as const, message: ON_THE_MAC.premiere }),
    importPremiere: async () => ({ ok: false as const, message: ON_THE_MAC.premiere }),
    lineUpCamera: async () => ({ ok: false as const, message: ON_THE_MAC.angle }),
    listenPovs: async () => ({ ok: false as const, message: ON_THE_MAC.povs }),
    chooseCamera: async () => null,
    findSpeaker: async () => ({ ok: false as const, finder: false, message: ON_THE_MAC.reframe }),
    findFocus: async (req) => {
      try {
        const regions = []
        for (const r of req.ranges.slice(0, 64))
          regions.push(await findFocus('ffmpeg', req.path, r.startSec, Math.min(r.durationSec, 600)))
        return { ok: true as const, regions }
      } catch {
        return {
          ok: false as const,
          message: `I couldn't read ${req.path.split('/').pop()} to see what changes in it.`
        }
      }
    },
    analyzeMusic: async (path) => {
      try {
        return { ok: true as const, facts: await analyzeTrack('ffmpeg', path) }
      } catch {
        return { ok: false as const, message: `I couldn't read ${path.split('/').pop()} as music.` }
      }
    },
    // No music folder on a phone: a track is picked with chooseAudio.
    findMusic: async () => [],
    chooseAudio: async () => (await pick(['audio'], false))[0]?.path ?? null,
    listLuts: async () => [],
    chooseLut: async () => null,
    sfxFiles: async () => {
      try {
        return { ok: true as const, files: await makeAllSfx('ffmpeg', work.sfxDir()) }
      } catch {
        return { ok: false as const, message: "I couldn't make the sound effects." }
      }
    },
    findSounds: async () => [],
    readSound: async (path) => {
      try {
        return { ok: true as const, ...(await readSound('ffmpeg', path)) }
      } catch {
        return { ok: false as const, message: `I couldn't read ${path.split('/').pop()} as a sound.` }
      }
    },
    onCutProgress: cut.on,
    findClips: async () => ({ ok: false as const, message: ON_THE_MAC.clipping }),
    onClipsProgress: quiet,
    clipPoster: async () => '',
    // In the edit's own brand, as on the Mac, with how its videos run when any were learned. What a
    // brand learns from chats, and its never list, are kept on the Mac for now, so a phone's plans
    // have neither. A map asked for in words goes to Claude as on the Mac; /map, which a plan may
    // run, says it is on the Mac.
    planEdit: async (req) => {
      const parsed = EditDocSchema.safeParse(req.doc)
      const brand = parsed.success ? await brandOfDoc(parsed.data) : await readBrand()
      return planEdit({
        ...req,
        preferences: [],
        logos: brand.logos.map((l) => l.name),
        habits: habitLines(brand.videos)
      })
    },
    // Priced here before it starts; a phone sends no frames, so an edit is planned once.
    planQuote: async (req) =>
      (await keyDeps().read()) ? planQuote({ ...req, more: 600 }, { ...(await parts.settings.current()), claudeSeesFrames: false }) : null,
    // What a message asks for, read by Claude before any footage is: each file goes as its name,
    // its length and whether it has a picture and sound, never what is in it.
    triage: async (req) => {
      const files = await Promise.all(
        req.files.map(async (f) => {
          const p = await probeFile('ffprobe', f.path).catch(() => null)
          return { name: f.name, durationSec: p ? p.durationSec : null, video: !!p && p.width > 0, audio: !!p?.facts.audio }
        })
      )
      return triage({ request: req.request, files, link: req.link, hasEdit: req.hasEdit, commands: req.commands })
    },
    studyInspiration: async () => ({ ok: false as const, message: ON_THE_MAC.study }),
    onInspirationProgress: quiet,
    listPresets: () => savedPresets(),
    savePreset: (preset) => savePreset(preset),
    removePreset: (command) => removePreset(command),
    recentProjects: () => recentProjects(),
    createProject: (name, mode) => createProject(name, mode),
    // No browsing for project files: the phone's projects are in its list.
    openProject: async (path) => (path ? openProject(path) : null),
    saveProject: (project) => saveProject(project),
    // Only a made video's result is kept in another chat, and a phone makes none.
    keepInChat: async () => null,
    mediaPreviews: async (path) => {
      const url = await poster(path)
      if (!url) throw new Error('There is no picture to show.')
      const facts = await probeFile('ffprobe', path)
      return {
        filmstripUrl: url,
        posterUrl: url,
        waveformUrl: null,
        durationSec: facts.durationSec,
        width: facts.width,
        height: facts.height,
        frames: 1
      }
    },
    mediaPoster: (path) => poster(path),
    openMedia: () => pick(['video', 'audio', 'image'], true),
    // Nowhere to show a file on a phone: an export goes to Photos instead.
    reveal: async () => undefined,
    hasApiKey: async () => (await key()) !== null,
    addAsset: async (req) => {
      if (!req.path) return { ok: false as const, message: ON_THE_MAC.link, signIn: false }
      try {
        return { ok: true as const, asset: await importFile(req.path, { ffmpeg: 'ffmpeg' }) }
      } catch (err) {
        return { ok: false as const, message: err instanceof Error ? err.message : String(err), signIn: false }
      }
    },
    onAssetProgress: quiet,
    // B-roll is found, fetched and credited on the Mac for now: its folders, free libraries, keys and the web.
    brollFind: async () => ({ ok: false as const, message: ON_THE_MAC.broll }),
    brollFetch: async () => ({ ok: false as const, message: ON_THE_MAC.broll }),
    brollQuote: async () => ({ low: 0, high: 0, searches: 0, said: ON_THE_MAC.broll }),
    onBrollProgress: quiet,
    brollSettings: async () => DEFAULT_BROLL,
    brollSaveSettings: async () => DEFAULT_BROLL,
    brollKeys: async () => Object.fromEntries(BROLL_KEYS.map((k) => [k.id, false])) as Record<BrollKeyId, boolean>,
    brollSetKey: async () => ({ ok: false as const, message: ON_THE_MAC.broll }),
    brollClearKey: async () => undefined,
    brollCheckKey: async () => ({ ok: false as const, state: 'none' as const, message: ON_THE_MAC.broll }),
    brollLibrary: async () => ({ folders: [] }),
    brollAddFolder: async () => ({ ok: false as const }),
    brollRemoveFolder: async () => DEFAULT_BROLL,
    brollScan: async () => ({ said: [] }),
    saveImageAsset: async () => ({ ok: false as const, message: ON_THE_MAC.icon }),
    capturePage: async () => ({ ok: false as const, message: ON_THE_MAC.link }),
    // A video's card is read from its page by yt-dlp, and a grid's ground is drawn on the Mac's canvas.
    videoCard: async () => ({ ok: false as const, message: ON_THE_MAC.link }),
    makeGrid: async () => ({ ok: false as const, message: ON_THE_MAC.grid }),
    // Nothing is cut out of a picture here: that is the Mac's Vision.
    fxCan: async () => ({ person: false, objects: false }),
    fxCutouts: async () => ({ tracks: [], missing: [] }),
    // Following needs the Mac's Vision.
    followClips: async () => ({ ops: [], said: 'Following something in the picture needs Cutalong on a Mac, so it stays where it is put.' }),
    setVideoSignIn: async () => null,
    getBrand: () => readBrand(),
    saveBrand: (brand) => saveBrand(brand),
    // Brands are kept on the phone as on the Mac; learning a look from videos is on the Mac for now.
    getBrands: () => readBrands(),
    saveBrands: (brands) => saveBrands(brands),
    learnBrand: async (paths) => ({
      learned: [],
      failed: paths.map((p) => `${p.split('/').pop()}: ${ON_THE_MAC.brand}`)
    }),
    onBrandProgress: quiet,
    learnChoose: async () => [],
    learnRun: async () => ({ ok: false as const, message: ON_THE_MAC.learn, state: learnState([]) }),
    learnState: async () => learnState([]),
    learnEvaluate: async () => learnState([]),
    learnForget: async () => learnState([]),
    onLearnProgress: quiet,
    // Learning from chats is part of the brand study, on the Mac for now: nothing is kept here.
    memoryView: async () => memoryView(EMPTY_MEMORY),
    rememberSignal: async () => undefined,
    updateMemory: async () => memoryView(EMPTY_MEMORY),
    chooseMedia: async () => {
      const [file] = await pick(['image'], false)
      return file ? { path: file.path, kind: 'image' as const, durationSec: 0 } : null
    },
    // The desktop's rules: a key Anthropic accepted before passes while it is busy, down or out of reach.
    checkKey: (opts) => checkKey(keyDeps(), opts ?? {}),
    // A phone asks before an app reads what was copied, so the key is pasted there instead.
    anthropicKeyOnClipboard: async () => null,
    // The app learns whether each service has a key, never what it is.
    serviceKeys: async () => parts.services.keys(),
    setServiceKey: (id, next) => parts.services.setKey(asService(id), typeof next === 'string' ? next : ''),
    clearServiceKey: (id) => parts.services.clearKey(asService(id)),
    checkServiceKey: (id) => parts.services.check(asService(id)),
    setOtherServices: (on) => parts.services.setOn(on === true),
    localPlanners: async () => ({ up: false, kind: null, host: null, models: [] }),
    setApiKey: async (next) => {
      const trimmed = next.trim()
      if (trimmed) await platform().secrets.set('anthropic', trimmed)
      else await platform().secrets.remove('anthropic')
    },
    clearApiKey: () => platform().secrets.remove('anthropic'),
    // The account, the same work as on the Mac (src/main/account), over the phone's own network and Keychain.
    accountStatus: () => accountStatus(),
    accountRequestCode: (email) => requestCode(email),
    accountVerify: (email, code) => verifyCode(email, code),
    accountSignOut: () => signOut(),
    accountSync: () => syncAccount(),
    provider: async () => detectProvider(await key()),
    getSettings: async () => parts.settings.current(),
    setSettings: (patch) => parts.settings.set(patch),
    chooseOutputDir: async () => null,
    mapStatus: async () => NO_MAPS,
    mapData: async () => ({ status: NO_MAPS, tilesDir: null, plates: null }),
    downloadMaps: async () => ({ ok: false as const, message: ON_THE_MAC.maps, status: NO_MAPS }),
    onMapProgress: quiet,
    hasModel: (model) => hasModel(model as WhisperModel),
    modelSizeMb: async (model) => modelSizeMb(model as WhisperModel),
    downloadModel: async (model) => {
      await downloadModel(model as WhisperModel, (percent) => ai.emit({ stage: 'Downloading model', percent }))
      return true
    },
    onAiProgress: (cb) => ai.on(cb as Listener),
    // Updates come from the App Store and Google Play.
    updateState: async () => ({ status: 'idle' as const }),
    checkForUpdates: async () => ({ status: 'idle' as const }),
    onUpdateState: () => () => undefined,
    downloadUpdate: async () => undefined,
    installUpdate: async () => undefined
  }
}
