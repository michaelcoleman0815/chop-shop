import type { License } from './types'

/**
 * Every licence a source can say, read into one shape: its name as a credit
 * says it, a link to its text, whether it needs a credit, whether it may go
 * in a video YouTube pays for, and whether it may be changed.
 *
 * The readers take what each API writes (Openverse's "by-nc", Wikimedia's
 * "CC BY-SA 4.0" or "pd", Freesound's licence links, the SPDX ids Simple
 * Icons gives some marks) and anything they cannot read becomes unknown,
 * which the policy leaves out.
 */

const CC = 'https://creativecommons.org'

export const OWN: License = { id: 'own', name: 'Your own', url: null, credit: false, monetized: 'yes', modify: true }

export const UNKNOWN: License = {
  id: 'unknown',
  name: 'Licence unknown',
  url: null,
  credit: true,
  monetized: 'no',
  modify: false,
  note: 'Its licence could not be read, so it is left out.'
}

/** Other people's clips, pages and posts: kept short, credited, and the person's own call. */
export const FAIR_USE: License = {
  id: 'fair-use',
  name: 'Fair use is your call',
  url: null,
  credit: true,
  monetized: 'your-call',
  modify: true,
  note: 'Someone else’s work: kept short and credited, and whether this use is fair is your call.'
}

export const PEXELS: License = {
  id: 'pexels',
  name: 'Pexels License',
  url: 'https://www.pexels.com/license/',
  credit: false,
  monetized: 'yes',
  modify: true
}

export const PIXABAY: License = {
  id: 'pixabay',
  name: 'Pixabay Content License',
  url: 'https://pixabay.com/service/license-summary/',
  credit: false,
  monetized: 'yes',
  modify: true
}

export const UNSPLASH: License = {
  id: 'unsplash',
  name: 'Unsplash License',
  url: 'https://unsplash.com/license',
  credit: false,
  monetized: 'yes',
  modify: true
}

/**
 * NASA's media: not copyrighted in the United States, credited to NASA, and
 * never used to suggest NASA endorses the video. Items NASA hosts but credits
 * to someone else are read as unknown by the NASA source instead.
 */
export const NASA: License = {
  id: 'public-domain',
  name: 'Public domain (NASA)',
  url: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
  credit: true,
  monetized: 'yes',
  modify: true,
  note: 'Credit NASA, and never suggest NASA endorses the video.'
}

/** A brand's mark, used only to name the brand. */
export const TRADEMARK: License = {
  id: 'trademark',
  name: 'Trademark of its owner',
  url: null,
  credit: true,
  monetized: 'yes',
  modify: false,
  note: 'Logos are trademarks: shown as they are, only to name the brand, never to suggest it endorses the video.'
}

/** A Creative Commons licence by its parts, with its version. */
function cc(parts: string, version: string | null): License {
  const v = version && /^\d(\.\d)?$/.test(version) ? version : '4.0'
  const nc = parts.includes('nc')
  const nd = parts.includes('nd')
  const sa = parts.includes('sa')
  return {
    id: `cc-${parts}` as License['id'],
    name: `CC ${parts.toUpperCase()} ${v}`,
    url: `${CC}/licenses/${parts}/${v}/`,
    credit: true,
    monetized: nc ? 'no' : 'yes',
    modify: !nd,
    ...(nc
      ? { note: 'Non-commercial only, so never in a video YouTube pays for.' }
      : sa
        ? { note: 'Share-alike: a video that uses it may have to carry the same licence.' }
        : nd
          ? { note: 'No derivatives: it may only be shown exactly as it is.' }
          : {})
  }
}

export const CC0: License = {
  id: 'cc0',
  name: 'CC0 1.0',
  url: `${CC}/publicdomain/zero/1.0/`,
  credit: false,
  monetized: 'yes',
  modify: true
}

export const PDM: License = {
  id: 'pdm',
  name: 'Public Domain Mark 1.0',
  url: `${CC}/publicdomain/mark/1.0/`,
  credit: false,
  monetized: 'yes',
  modify: true
}

export const PUBLIC_DOMAIN: License = {
  id: 'public-domain',
  name: 'Public domain',
  url: null,
  credit: false,
  monetized: 'yes',
  modify: true
}

const PARTS = ['by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd'] as const

/** Openverse's licence codes ("cc0", "pdm", "by-nc-sa") and version. */
export function openverseLicense(code: string, version?: string | null): License {
  const c = code.trim().toLowerCase()
  if (c === 'cc0') return CC0
  if (c === 'pdm') return PDM
  if ((PARTS as readonly string[]).includes(c)) return cc(c, version ?? null)
  // Sampling+ and NC-Sampling+ are retired licences that allow less than CC BY.
  return UNKNOWN
}

/** A licence from a link to its text: Creative Commons, mostly, as Freesound and the Internet Archive write them. */
export function licenseFromUrl(url: string | null | undefined): License {
  if (!url) return UNKNOWN
  const u = url.trim().toLowerCase().replace(/^http:/, 'https:')
  if (/creativecommons\.org\/publicdomain\/zero\//.test(u)) return CC0
  if (/creativecommons\.org\/publicdomain\/mark\//.test(u)) return PDM
  // The Internet Archive's long-standing "public domain" link.
  if (/creativecommons\.org\/licenses\/publicdomain\/?$/.test(u)) return PUBLIC_DOMAIN
  const m = /creativecommons\.org\/licenses\/(by(?:-nc)?(?:-sa|-nd)?)\/(\d(?:\.\d)?)/.exec(u)
  if (m && (PARTS as readonly string[]).includes(m[1])) return cc(m[1], m[2])
  return UNKNOWN
}

/**
 * Wikimedia Commons' licence, from its short name ("CC BY-SA 4.0", "Public
 * domain", "CC0") or its template code ("cc-by-4.0", "pd", "cc-zero").
 */
export function wikimediaLicense(shortName: string | null | undefined, code?: string | null): License {
  const name = (shortName ?? '').trim()
  const c = (code ?? '').trim().toLowerCase()
  if (/^cc0\b|^cc-zero$/i.test(name) || c === 'cc0' || c === 'cc-zero') return CC0
  if (/^public domain\b|^pd\b/i.test(name) || c === 'pd' || c.startsWith('pd-')) return PUBLIC_DOMAIN
  const fromName = /^cc[- ](by(?:[- ]nc)?(?:[- ](?:sa|nd))?)[- ]?(\d(?:\.\d)?)?/i.exec(name)
  if (fromName) {
    const parts = fromName[1].toLowerCase().replace(/ /g, '-')
    if ((PARTS as readonly string[]).includes(parts)) return cc(parts, fromName[2] ?? null)
  }
  const fromCode = /^cc-(by(?:-nc)?(?:-sa|-nd)?)-(\d(?:\.\d)?)/.exec(c)
  if (fromCode && (PARTS as readonly string[]).includes(fromCode[1])) return cc(fromCode[1], fromCode[2])
  return UNKNOWN
}

/**
 * The licence a Simple Icons mark's drawing carries, from the SPDX id or
 * "custom" the package gives some marks. A mark with none is the package's
 * own CC0 drawing. Either way the mark itself is a trademark.
 */
export function logoLicense(spdx: string | null | undefined, guidelines?: string | null): License {
  const base = { ...TRADEMARK, ...(guidelines ? { url: guidelines } : {}) }
  if (!spdx) return base
  const id = spdx.trim()
  if (/^(CC0-1\.0|Unlicense)$/i.test(id)) return base
  const ccm = /^CC-(BY(?:-NC)?(?:-SA|-ND)?)-(\d\.\d)$/i.exec(id)
  if (ccm) {
    const drawn = cc(ccm[1].toLowerCase(), ccm[2])
    return {
      ...base,
      name: `Trademark of its owner, drawing ${drawn.name}`,
      credit: true,
      monetized: drawn.monetized,
      // A logo is never changed anyway; share-alike is kept so the policy can see it.
      id: drawn.id === 'cc-by' ? 'trademark' : drawn.id,
      note: drawn.note ?? base.note
    }
  }
  if (/^(MIT|BSD-\d-Clause|Apache-2\.0|ISC|Zlib)$/i.test(id)) return { ...base, name: `Trademark of its owner, drawing ${id}` }
  if (/^(L?GPL|AGPL|MPL|EPL|CDDL)/i.test(id)) {
    return {
      ...base,
      id: 'copyleft',
      name: `Trademark of its owner, drawing ${id}`,
      note: 'Its drawing is under a copyleft licence, so it is left out.'
    }
  }
  // "custom": the brand has terms of its own, which the person reads.
  return {
    ...base,
    monetized: 'your-call',
    note: 'The brand has its own terms for its logo; read them before using it.'
  }
}

/** Freesound's licence links, which name CC0, CC BY and CC BY-NC, and the retired Sampling+. */
export function freesoundLicense(url: string | null | undefined): License {
  return licenseFromUrl(url)
}

/** The licence written as the credit line ends: "CC BY 4.0 https://…", or just the name when it has no link. */
export function licenseText(l: License): string {
  return l.url ? `${l.name} ${l.url}` : l.name
}
