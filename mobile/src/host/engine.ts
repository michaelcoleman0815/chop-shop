import { registerPlugin } from '@capacitor/core'
import type { EnginePlugin } from 'cutalong-engine'

/**
 * ffmpeg, ffprobe and whisper.cpp inside the app (mobile/engine). On a phone
 * the native plugin answers; in a browser, the web fallback hands the same
 * calls to the dev bridge (mobile/dev/engine-bridge.mjs), which runs the real
 * tools on the computer, so the whole phone app can be driven there.
 */
export const Engine = registerPlugin<EnginePlugin>('CutalongEngine', {
  web: () => import('./engine-web').then((m) => new m.EngineWeb())
})
