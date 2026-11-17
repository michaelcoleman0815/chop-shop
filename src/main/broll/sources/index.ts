import type { BrollKeyId } from '../../../shared/broll/keys'
import type { Quotas } from '../../../shared/broll/quota'
import type { BrollSource, SourceId } from '../../../shared/broll/types'
import type { LogoMark } from '../../../shared/motion'
import type { Http } from '../http'
import type { LibraryItem } from '../library'
import { archiveSource } from './archive'
import { blueskySource } from './bluesky'
import { freesoundSource } from './freesound'
import { generatedSource, type GenerationProvider } from './generated'
import { giphySource } from './giphy'
import { librarySource } from './library'
import { logosSource, type LogoData } from './logos'
import { nasaSource } from './nasa'
import { openverseSource } from './openverse'
import { pexelsSource } from './pexels'
import { pixabaySource } from './pixabay'
import { steamSource } from './steam'
import { unsplashSource } from './unsplash'
import { webSource } from './web'
import { wikimediaSource } from './wikimedia'
import { ownUploadsSource, youtubeSource, type YouTubeDeps } from './youtube'

/**
 * Every B-roll source, made from what it needs. No Electron here: the app
 * passes its keychain, folders and capture in (main/broll/app), and the
 * tests pass recorded answers.
 */

export interface AllDeps {
  http: Http
  ffmpeg: string
  quotas?: Quotas
  /** A B-roll site's key from the keychain, read when it is needed. */
  key: (id: BrollKeyId) => string | null
  /** The person's library index. */
  library: () => LibraryItem[] | Promise<LibraryItem[]>
  /** yt-dlp, when this build has it; the person's own channels for their earlier uploads. */
  youtube?: YouTubeDeps & { channels: () => string[] }
  logos?: { index: () => Promise<LogoData[]>; marks: () => Promise<(slug: string) => LogoMark | undefined> }
  fontsDir: string | null
  /** A page as it shows logged out (main/page-capture). */
  capture?: (url: string) => Promise<{ png: Buffer; width: number; height: number; title: string; url: string }>
  anthropicKey?: () => string | null
  generation?: GenerationProvider | null
}

export function createSources(d: AllDeps): Partial<Record<SourceId, BrollSource>> {
  const base = { http: d.http, ffmpeg: d.ffmpeg, quotas: d.quotas }
  const keyed = (id: BrollKeyId) => ({ ...base, key: () => d.key(id) })
  const out: Partial<Record<SourceId, BrollSource>> = {
    library: librarySource({ items: d.library, ffmpeg: d.ffmpeg }),
    openverse: openverseSource(base),
    wikimedia: wikimediaSource(base),
    nasa: nasaSource(base),
    archive: archiveSource(base),
    steam: steamSource(base),
    bluesky: blueskySource({ ...base, fontsDir: d.fontsDir, capture: d.capture }),
    pexels: pexelsSource(keyed('pexels')),
    pixabay: pixabaySource(keyed('pixabay')),
    unsplash: unsplashSource(keyed('unsplash')),
    giphy: giphySource(keyed('giphy')),
    freesound: freesoundSource(keyed('freesound'))
  }
  if (d.youtube) {
    out.youtube = youtubeSource(d.youtube)
    out['own-uploads'] = ownUploadsSource(d.youtube)
  }
  if (d.logos) out.logos = logosSource({ ...d.logos, ffmpeg: d.ffmpeg })
  if (d.anthropicKey) out.web = webSource({ ffmpeg: d.ffmpeg, quotas: d.quotas, apiKey: d.anthropicKey, capture: d.capture })
  if (d.generation) out.generated = generatedSource(d.generation)
  return out
}

/**
 * Why a source cannot be asked: its key is missing, the person turned it
 * off, it is the web search they have not turned on, or their own channels
 * are not set. Null when it can be.
 */
export function unavailable(
  id: SourceId,
  ctx: { hasKey: (id: BrollKeyId) => boolean; off: SourceId[]; webSearch: boolean; channels: string[]; ytdlp: boolean; anthropic: boolean }
): string | null {
  if (ctx.off.includes(id)) return 'you turned it off in Settings'
  const keyed: Partial<Record<SourceId, BrollKeyId>> = { pexels: 'pexels', pixabay: 'pixabay', unsplash: 'unsplash', giphy: 'giphy', freesound: 'freesound' }
  const k = keyed[id]
  if (k && !ctx.hasKey(k)) return 'it needs a free key, added in Settings'
  if ((id === 'youtube' || id === 'own-uploads') && !ctx.ytdlp) return 'yt-dlp is missing from this build'
  if (id === 'own-uploads' && ctx.channels.length === 0) return 'no channel of yours is set in Settings'
  if (id === 'web' && !ctx.webSearch) return 'looking on the web is off in Settings'
  if (id === 'web' && !ctx.anthropic) return 'it needs your Anthropic key'
  return null
}
