import { basename, extname } from 'path'
import { isImagePath } from '../shared/assets'
import type { Asset } from '../shared/edit'
import { probeMedia } from './inspiration/measure'

/**
 * Material that is a file already there: footage, a picture or a sound the
 * person brought in. On its own so a phone, which fetches nothing from
 * links, brings files in the same way (assets.ts has the rest).
 */

export type NewAsset = Omit<Asset, 'id'>

const AUDIO = /\.(mp3|m4a|aac|wav|aiff|flac|ogg)$/i

const own = (): NewAsset['origin'] => ({ type: 'file', url: null, author: null, license: null, range: null })

/** A file already on disk. It is used where it is, like footage. */
export async function importFile(path: string, tools: { ffmpeg: string }): Promise<NewAsset> {
  const title = basename(path, extname(path))
  if (AUDIO.test(path)) {
    return { kind: 'audio', path, title, durationSec: null, width: null, height: null, origin: own() }
  }
  const info = await probeMedia(tools.ffmpeg, path)
  const image = isImagePath(path)
  return {
    kind: image ? 'image' : 'video',
    path,
    title,
    durationSec: image ? null : info.durationSec,
    width: info.width,
    height: info.height,
    origin: own()
  }
}
