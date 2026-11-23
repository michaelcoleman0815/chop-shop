import antonUrl from '../../../../resources/fonts/Anton-Regular.ttf?url'
import archivoUrl from '../../../../resources/fonts/ArchivoBlack-Regular.ttf?url'
import soraUrl from '../../../../resources/fonts/Sora.ttf?url'
import cinzelUrl from '../../../../resources/fonts/Cinzel.ttf?url'
import fellUrl from '../../../../resources/fonts/IMFellEnglish-Regular.ttf?url'
import serifUrl from '../../../../resources/fonts/DMSerifDisplay-Regular.ttf?url'
import interUrl from '../../../../resources/fonts/Inter-SemiBold.ttf?url'
import interHeavyUrl from '../../../../resources/fonts/Inter-ExtraBold.ttf?url'
import bebasUrl from '../../../../resources/fonts/BebasNeue-Regular.ttf?url'
import instrumentSerifUrl from '../../../../resources/fonts/InstrumentSerif-Regular.ttf?url'
import instrumentItalicUrl from '../../../../resources/fonts/InstrumentSerif-Italic.ttf?url'
import instrumentSansUrl from '../../../../resources/fonts/InstrumentSans-Bold.ttf?url'
import archivoWideUrl from '../../../../resources/fonts/ArchivoExpanded-Black.ttf?url'
import {
  forgetMeasures,
  logoLookup,
  marksFrom,
  MOTION_FONTS,
  type IconNode,
  type LogoEntry,
  type LogoMark
} from '../../../shared/motion'
import { MEDIA_CORS } from './api'

/**
 * What the editor's motion canvas needs from the page: the faces graphics
 * are set in, loaded from the very files the export registers with Skia (so
 * both measure and draw the same glyphs), Lucide's icon shapes, and images.
 * Everything is bundled with the app; nothing is fetched from the web.
 */

const URLS: Record<string, string> = {
  'Anton-Regular.ttf': antonUrl,
  'ArchivoBlack-Regular.ttf': archivoUrl,
  'Sora.ttf': soraUrl,
  'Cinzel.ttf': cinzelUrl,
  'IMFellEnglish-Regular.ttf': fellUrl,
  'DMSerifDisplay-Regular.ttf': serifUrl,
  'Inter-SemiBold.ttf': interUrl,
  'Inter-ExtraBold.ttf': interHeavyUrl,
  'BebasNeue-Regular.ttf': bebasUrl,
  'InstrumentSerif-Regular.ttf': instrumentSerifUrl,
  'InstrumentSerif-Italic.ttf': instrumentItalicUrl,
  'InstrumentSans-Bold.ttf': instrumentSansUrl,
  'ArchivoExpanded-Black.ttf': archivoWideUrl
}

let fonts: Promise<void> | null = null

/**
 * Loads the motion faces once. Resolves even if one fails, so the canvas still draws, and only once the measures
 * taken before the faces were in are forgotten, so the redraw that follows lays the words out in them.
 */
export function loadMotionFonts(): Promise<void> {
  if (fonts) return fonts
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return Promise.resolve()
  fonts = Promise.all(
    MOTION_FONTS.map(async (f) => {
      const url = URLS[f.file]
      if (!url) return
      const [lo, hi] = f.weights
      const face = new FontFace(f.family, `url(${url})`, { weight: lo === hi ? String(lo) : `${lo} ${hi}` })
      try {
        await face.load()
        document.fonts.add(face)
      } catch (err) {
        console.warn(`[motion] could not load ${f.family}:`, err)
      }
    })
  ).then(() => {
    // Anything drawn while they loaded was measured in the fallback face: measure again in these.
    forgetMeasures()
  })
  return fonts
}

let icons: Promise<(name: string) => IconNode[] | undefined> | null = null

/** Lucide's shapes, loaded the first time a graphic has an icon. */
export function loadIconNodes(): Promise<(name: string) => IconNode[] | undefined> {
  icons ??= import('lucide-static/icon-nodes.json').then((m) => {
    const nodes = m.default as unknown as Record<string, IconNode[]>
    return (name: string) => nodes[name]
  })
  return icons
}

let logos: Promise<(slug: string) => LogoMark | undefined> | null = null

/** Brand marks from Simple Icons (CC0), loaded the first time a graphic has a logo. */
export function loadLogoMarks(): Promise<(slug: string) => LogoMark | undefined> {
  logos ??= Promise.all([import('simple-icons'), import('simple-icons/icons.json')]).then(([marks, index]) =>
    logoLookup(
      ((index as { default?: unknown }).default ?? index) as LogoEntry[],
      marksFrom(marks as unknown as Record<string, unknown>)
    )
  )
  return logos
}

const images = new Map<string, Promise<HTMLImageElement | null>>()

/** An image decoded for drawing, or null when it cannot be read. */
export function loadPicture(url: string): Promise<HTMLImageElement | null> {
  let hit = images.get(url)
  if (!hit) {
    hit = new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      // Read with leave, as the decks read theirs, so a canvas that draws it can still be read (an adjustment clip over it).
      if (MEDIA_CORS && !url.startsWith('data:') && !url.startsWith('blob:')) img.crossOrigin = MEDIA_CORS
      img.src = url
    })
    images.set(url, hit)
  }
  return hit
}
