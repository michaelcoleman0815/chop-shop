import type { EngineInfo, EnginePlugin } from 'cutalong-engine'
import type { CutalongApi } from '../../../src/renderer/src/cutalong/api'
import { platform } from '../../../src/main/platform'
import { probeFile } from '../../../src/main/intake'
import { extendCut, prepareCut, renderEdit, sortFootage, type WorkHost } from '../../../src/main/cut-work'
import { checkKey, planEdit } from '../../../src/main/planner'
import { downloadModel, hasModel, modelSizeMb, type WhisperModel } from '../../../src/main/transcribe'
import { analyzeTrack } from '../../../src/main/music'
import { makeAllSfx, readSound } from '../../../src/main/sfx'
import { findFocus } from '../../../src/main/focus'
import { importFile } from '../../../src/main/asset-file'
import { readBrand, saveBrand } from '../../../src/main/brand-store'
import { removePreset, savedPresets, savePreset } from '../../../src/main/preset-store'
import { createProject, openProject, recentProjects, saveProject } from '../../../src/main/projects'
import { sceneForCut } from '../../../src/main/motion-scene'
import { phoneEncoder } from '../../../src/main/render/encoder'
import { detectProvider } from '../../../src/shared/keys'
import { isServiceId, type ServiceId } from '../../../src/shared/services'
import { EMPTY_MEMORY, memoryView } from '../../../src/shared/memory'
import { learnState } from '../../../src/shared/learn'
import { ON_THE_MAC } from './limits'
import type { PhoneServices } from './services'
import type { PhoneSettings } from './settings'

/**
 * The API the app uses (renderer api.ts), answered on the phone by the same
 * work the Mac's main process does (src/main), on the phone's platform.
 * What is on the Mac for now answers with one sentence saying so.
 */

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
    readBrand: () => readBrand(),
    whisperModel: () => parts.settings.current().whisperModel,
    outputDir: () => platform().paths.exports(),
    sfxDir: () => `${platform().paths.userData()}/sfx`,
    fontsDir: () => platform().paths.fonts(),
    hearInCloud: (path, durationSec, progress) => parts.services.hearInCloud(path, durationSec, progress),
    // Graphics are drawn on the Mac's canvas for now: a cut with none renders here.
    motion: async (input) => {
      const scene = sceneForCut(input)
      if (scene.layers.length > 0) throw new Error(ON_THE_MAC.graphics)
      return { overlays: [], scene }
    },
    encoder: encoder ?? undefined,
    perspective: false
  }
}

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
    planSession: async (req) => {
      const r = await sortFootage(req, await key(), progress)
      return r.ok ? { ok: true as const, roles: r.roles } : r
    },
    makeVlog: async () => ({ ok: false as const, message: ON_THE_MAC.vlog }),
    planVlog: async () => ({ ok: false as const, message: ON_THE_MAC.vlog }),
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
    lineUpCamera: async () => ({ ok: false as const, message: ON_THE_MAC.angle }),
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
    planEdit: async (req) =>
      planEdit({ ...req, preferences: [], logos: (await readBrand()).logos.map((l) => l.name), apiKey: await key() }),
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
    searchVideos: async () => ({ ok: false as const, message: ON_THE_MAC.broll }),
    saveImageAsset: async () => ({ ok: false as const, message: ON_THE_MAC.icon }),
    capturePage: async () => ({ ok: false as const, message: ON_THE_MAC.link }),
    setVideoSignIn: async () => null,
    getBrand: () => readBrand(),
    saveBrand: (brand) => saveBrand(brand),
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
    checkKey: async () => checkKey(await key()),
    // The app learns whether each service has a key, never what it is.
    serviceKeys: async () => parts.services.keys(),
    setServiceKey: (id, next) => parts.services.setKey(asService(id), typeof next === 'string' ? next : ''),
    clearServiceKey: (id) => parts.services.clearKey(asService(id)),
    checkServiceKey: (id) => parts.services.check(asService(id)),
    setOtherServices: (on) => parts.services.setOn(on === true),
    localPlanners: async () => ({ up: false, models: [] }),
    setApiKey: async (next) => {
      const trimmed = next.trim()
      if (trimmed) await platform().secrets.set('anthropic', trimmed)
      else await platform().secrets.remove('anthropic')
    },
    clearApiKey: () => platform().secrets.remove('anthropic'),
    provider: async () => detectProvider(await key()),
    getSettings: async () => parts.settings.current(),
    setSettings: (patch) => parts.settings.set(patch),
    chooseOutputDir: async () => null,
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
