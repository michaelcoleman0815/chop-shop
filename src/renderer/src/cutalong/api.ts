import { COMPUTER, type Device } from './device'
import { fileUrl } from './format'
import { createMockApi } from './mock'

type ChopApi = Window['chop']

/**
 * What Cutalong uses of the main process. Narrower than the whole preload API
 * on purpose: it documents the surface, and it is what the browser mock has
 * to stand in for when the UI runs outside Electron.
 */
export type CutalongApi = Pick<
  ChopApi,
  | 'getVersion'
  | 'pathForFile'
  | 'openVideo'
  | 'prepareCut'
  | 'planSession'
  | 'makeVlog'
  | 'planVlog'
  | 'renderCut'
  | 'openPremiere'
  | 'lineUpCamera'
  | 'chooseCamera'
  | 'findSpeaker'
  | 'findFocus'
  | 'analyzeMusic'
  | 'findMusic'
  | 'chooseAudio'
  | 'listLuts'
  | 'chooseLut'
  | 'sfxFiles'
  | 'findSounds'
  | 'readSound'
  | 'onCutProgress'
  | 'findClips'
  | 'onClipsProgress'
  | 'clipPoster'
  | 'planEdit'
  | 'triage'
  | 'studyInspiration'
  | 'onInspirationProgress'
  | 'listPresets'
  | 'savePreset'
  | 'removePreset'
  | 'recentProjects'
  | 'createProject'
  | 'openProject'
  | 'saveProject'
  | 'mediaPreviews'
  | 'mediaPoster'
  | 'openMedia'
  | 'extendCut'
  | 'reveal'
  | 'hasApiKey'
  | 'addAsset'
  | 'onAssetProgress'
  | 'searchVideos'
  | 'saveImageAsset'
  | 'capturePage'
  | 'setVideoSignIn'
  | 'getBrand'
  | 'saveBrand'
  | 'getBrands'
  | 'saveBrands'
  | 'learnBrand'
  | 'onBrandProgress'
  | 'learnChoose'
  | 'learnRun'
  | 'learnState'
  | 'learnEvaluate'
  | 'learnForget'
  | 'onLearnProgress'
  | 'memoryView'
  | 'rememberSignal'
  | 'updateMemory'
  | 'chooseMedia'
  | 'checkKey'
  | 'serviceKeys'
  | 'setServiceKey'
  | 'clearServiceKey'
  | 'checkServiceKey'
  | 'setOtherServices'
  | 'localPlanners'
  | 'setApiKey'
  | 'clearApiKey'
  | 'provider'
  | 'getSettings'
  | 'setSettings'
  | 'chooseOutputDir'
  | 'hasModel'
  | 'modelSizeMb'
  | 'downloadModel'
  | 'onAiProgress'
  | 'mapStatus'
  | 'mapData'
  | 'downloadMaps'
  | 'onMapProgress'
  | 'updateState'
  | 'checkForUpdates'
  | 'onUpdateState'
  | 'downloadUpdate'
  | 'installUpdate'
>

/**
 * A host other than Electron: the phone app (mobile/src/main.tsx) answers
 * the API with the same work on the phone, and installs itself as
 * window.cutalongHost before the app loads.
 */
export interface CutalongHost {
  api: CutalongApi
  /** A file in the app's storage as the player can load it. */
  mediaUrlFor: (path: string) => string
  device: Device
}

const hosted = typeof window !== 'undefined' ? (window as { cutalongHost?: CutalongHost }).cutalongHost : undefined
const bridge = typeof window !== 'undefined' && !hosted ? (window as { chop?: ChopApi }).chop : undefined

/** True in a plain browser, where a mock stands in for the main process. */
export const isMock = !bridge && !hosted

/** The device the app runs on: the computer, or the phone that hosts it. */
export const device: Device = hosted?.device ?? COMPUTER

/**
 * The real bridge inside Electron; the phone's host on a phone; a mock in a
 * plain browser, so the screens can be built and checked without the app around them.
 */
export const api: CutalongApi = hosted?.api ?? bridge ?? createMockApi()

/** A local file as the player can load it, from the main process's media server. */
export function mediaUrlFor(path: string): string {
  if (path.startsWith('data:')) return path
  if (hosted) return hosted.mediaUrlFor(path)
  if (isMock || !bridge) return '/sample.mp4'
  // Without the server (it could not start), the packaged page plays files by path.
  if (!bridge.mediaBase) return fileUrl(path)
  return `${bridge.mediaBase}/${encodeURIComponent(path)}`
}
