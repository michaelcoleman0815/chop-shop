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
  | 'renderCut'
  | 'onCutProgress'
  | 'planEdit'
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
  | 'reveal'
  | 'hasApiKey'
  | 'addAsset'
  | 'onAssetProgress'
  | 'searchVideos'
  | 'saveImageAsset'
  | 'setVideoSignIn'
>

const bridge = typeof window !== 'undefined' ? (window as { chop?: ChopApi }).chop : undefined

/** True in a plain browser, where a mock stands in for the main process. */
export const isMock = !bridge

/**
 * The real bridge inside Electron; a mock in a plain browser, so the screens
 * can be built and checked without the app around them.
 */
export const api: CutalongApi = bridge ?? createMockApi()

/** A local file as the player can load it (the main process serves media://). */
export function mediaUrlFor(path: string): string {
  if (path.startsWith('data:')) return path
  return isMock ? '/sample.mp4' : `media://local/${encodeURIComponent(path)}`
}
