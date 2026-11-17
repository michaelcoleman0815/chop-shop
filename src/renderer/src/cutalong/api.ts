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
  | 'makeStart'
  | 'makeGo'
  | 'makeRevise'
  | 'makeScript'
  | 'makeChange'
  | 'makeShot'
  | 'makeCancel'
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
  | 'fxCan'
  | 'fxCutouts'
  | 'downloadMaps'
  | 'onMapProgress'
  | 'updateState'
  | 'checkForUpdates'
  | 'onUpdateState'
  | 'downloadUpdate'
  | 'installUpdate'
>

const bridge = typeof window !== 'undefined' ? (window as { chop?: ChopApi }).chop : undefined

/** True in a plain browser, where a mock stands in for the main process. */
export const isMock = !bridge

/**
 * The real bridge inside Electron; a mock in a plain browser, so the screens
 * can be built and checked without the app around them.
 */
export const api: CutalongApi = bridge ?? createMockApi()

/**
 * How a picture the scene effects read is loaded: with leave to read it, from
 * the media server, which gives it (main/media-server); a file loaded by path
 * cannot ask, and the effects then draw over the picture without reading it.
 */
export const MEDIA_CORS: 'anonymous' | undefined = bridge && !bridge.mediaBase ? undefined : 'anonymous'

/** A local file as the player can load it, from the main process's media server. */
export function mediaUrlFor(path: string): string {
  if (path.startsWith('data:')) return path
  if (isMock || !bridge) return '/sample.mp4'
  // Without the server (it could not start), the packaged page plays files by path.
  if (!bridge.mediaBase) return fileUrl(path)
  return `${bridge.mediaBase}/${encodeURIComponent(path)}`
}
