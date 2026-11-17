import { createHash } from 'crypto'
import { basename, extname } from 'path'
import type { LibraryKind } from '../../../shared/broll/files'
import { OWN } from '../../../shared/broll/license'
import type { BrollKind, BrollSource, Candidate, Fetched } from '../../../shared/broll/types'
import { fileIn, normalized, runFfmpeg } from '../files'
import { searchLibrary, type LibraryItem } from '../library'

/**
 * The person's own folder of assets, through its index (main/broll/library):
 * searched first, always, and used where the file is, like footage. Nothing
 * from it is ever sent anywhere: its candidates carry no link, and its words
 * never leave this computer. An image sequence becomes one clip when picked.
 */

const KINDS_FOR: Record<BrollKind, LibraryKind[]> = {
  video: ['video', 'overlay', 'sequence'],
  image: ['image', 'overlay'],
  gif: ['video'],
  logo: ['overlay', 'image'],
  page: [],
  post: [],
  audio: ['sfx', 'music']
}

const idOf = (path: string): string => createHash('sha1').update(path).digest('hex').slice(0, 16)

export function candidateOf(item: LibraryItem): Candidate {
  const audio = item.k === 'sfx' || item.k === 'music'
  const moving = !audio && (item.d !== undefined || item.k === 'sequence' || item.k === 'video')
  return {
    id: idOf(item.p),
    source: 'library',
    kind: audio ? 'audio' : moving ? 'video' : 'image',
    title: item.k === 'sequence' || /%0\dd/.test(item.p) ? item.n : basename(item.n, extname(item.n)),
    author: null,
    authorUrl: null,
    pageUrl: null,
    mediaUrl: null,
    previewUrl: null,
    width: item.w ?? null,
    height: item.h ?? null,
    durationSec: item.d ?? null,
    bytes: item.s,
    license: OWN,
    tags: item.t ? item.t.split(' ') : [],
    ...(item.a ? { alpha: true } : {}),
    extra: {
      path: item.p,
      libraryKind: item.k,
      audio: item.k === 'sfx' ? 'sfx' : item.k === 'music' ? 'music' : null,
      loudness: item.l ?? null,
      frames: item.f ?? null
    }
  }
}

export function librarySource(deps: { items: () => LibraryItem[] | Promise<LibraryItem[]>; ffmpeg: string }): BrollSource {
  return {
    id: 'library',
    name: 'Your library',
    kinds: ['video', 'image', 'gif', 'logo', 'audio'],
    async search(query, opts = {}) {
      const items = await deps.items()
      const wanted = new Set((opts.kinds ?? ['video', 'image', 'audio']).flatMap((k) => KINDS_FOR[k]))
      const found = searchLibrary(items, query, { kinds: [...wanted], count: opts.count ?? 12 })
      // A logo from the library is one filed under "logo".
      const logoOnly = opts.kinds?.length === 1 && opts.kinds[0] === 'logo'
      return found.map((f) => candidateOf(f.item)).filter((c) => !logoOnly || c.tags.includes('logo'))
    },
    async fetch(c, dir, opts = {}): Promise<Fetched> {
      const path = typeof c.extra?.path === 'string' ? c.extra.path : null
      if (!path) throw new Error('That file is no longer in your library.')
      if (c.extra?.libraryKind === 'sequence' || /%0\dd\.\w+$/.test(path)) {
        // A sequence plays as one clip: WebM keeps its transparency, which the preview shows as it is.
        const alpha = c.alpha === true
        const out = await fileIn(dir, c.title, alpha ? 'webm' : 'mp4')
        await runFfmpeg(
          deps.ffmpeg,
          [
            '-loglevel',
            'error',
            '-y',
            '-framerate',
            '30',
            '-i',
            path,
            ...(alpha
              ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '24', '-row-mt', '1']
              : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']),
            '-vf',
            'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            out
          ],
          opts.signal
        )
        return normalized(out, c, null, deps.ffmpeg)
      }
      return normalized(path, c, null, deps.ffmpeg)
    }
  }
}
