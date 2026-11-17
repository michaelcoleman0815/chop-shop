import type { Range } from '../assets'
import { clock } from '../presets'
import { licenseText } from './license'
import type { Candidate, NewAsset } from './types'

/**
 * The credit for each thing fetched, in the form its source asks for
 * ("Photo by … on Unsplash", "Powered by GIPHY"), and the origin the asset
 * keeps, which the upload kit's credits are written from (shared/assets
 * creditLines: title, author, link, stretch, licence). The person's own
 * material needs none.
 */

const UTM = 'utm_source=cutalong&utm_medium=referral'

/** Unsplash asks for links back with the app named as the referrer. */
export function unsplashLink(url: string): string {
  return url.includes('?') ? `${url}&${UTM}` : `${url}?${UTM}`
}

/** The line that credits a candidate in the upload kit, or null for the person's own. */
export function creditLine(c: Candidate, range?: Range | null): string | null {
  if (c.source === 'library' || c.source === 'own-uploads' || c.license.id === 'own') return null
  const by = c.author ? ` by ${c.author}` : ''
  const link = c.pageUrl ? ` ${c.pageUrl}` : ''
  const stretch = range ? ` ${clock(range.startSec)}-${clock(range.endSec)}` : ''
  const license = c.license.monetized === 'your-call' ? '' : `, ${licenseText(c.license)}`
  switch (c.source) {
    case 'pexels':
      return `${c.kind === 'video' ? 'Video' : 'Photo'}${by} from Pexels${link}`
    case 'pixabay':
      return `${c.kind === 'video' ? 'Video' : 'Image'}${by} from Pixabay${link}`
    case 'unsplash':
      return `Photo${by} on Unsplash${c.pageUrl ? ` ${unsplashLink(c.pageUrl)}` : ''}`
    case 'giphy':
      return `“${c.title}”${by}, Powered by GIPHY${link}`
    case 'nasa':
      return `“${c.title}”, ${c.author ?? 'NASA'}${link}${stretch}, ${c.license.name}`
    case 'bluesky':
      return `Post${by} on Bluesky${link}`
    case 'steam':
      return `“${c.title}”${by}, from Steam${link}${stretch}`
    case 'logos':
      return `${c.title} logo, a trademark of its owner, drawn by Simple Icons (CC0)`
    case 'web':
      return `“${c.title}”${c.author ? `, ${c.author}` : ''}${link}`
    case 'youtube':
      return `“${c.title}”${by}${link}${stretch}`
    default:
      // Openverse, Wikimedia Commons, the Internet Archive, Freesound: title, author, source, licence.
      return `“${c.title}”${by}${link}${stretch}${license}`
  }
}

/**
 * Where an asset came from, as the edit keeps it. The person's own material
 * is a file of theirs, so the never list's "B-roll from outside" does not
 * cover it and the credits leave it out. Someone else's clip keeps no
 * licence, as excerpts never have: using it is the editor's own call.
 */
export function originFor(c: Candidate, range: Range | null): NewAsset['origin'] {
  const own = c.source === 'library' || c.source === 'own-uploads'
  if (own) return { type: 'file', url: c.pageUrl, author: c.author, license: null, range }
  const author =
    c.source === 'giphy'
      ? `${c.author ? `${c.author}, ` : ''}Powered by GIPHY`
      : c.source === 'unsplash' && c.author
        ? `${c.author} on Unsplash`
        : c.author
  const license = c.license.monetized === 'your-call' ? null : licenseText(c.license)
  const type = c.kind === 'logo' ? 'icon' : c.kind === 'video' || c.kind === 'gif' ? 'video' : 'link'
  const url = c.source === 'unsplash' && c.pageUrl ? unsplashLink(c.pageUrl) : c.pageUrl
  return { type, url, author, license, range }
}
