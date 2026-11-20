import { creditLine, originFor } from '../../../shared/broll/credit'
import { BROLL_KEYS, wrongBrollKey, type BrollKeyId } from '../../../shared/broll/keys'
import { CC0, OWN, PEXELS, PUBLIC_DOMAIN, FAIR_USE, openverseLicense } from '../../../shared/broll/license'
import { stretchFor } from '../../../shared/broll/policy'
import { rankFor } from '../../../shared/broll/rank'
import { planFor, type MomentResult } from '../../../shared/broll/route'
import { DEFAULT_BROLL, readBrollSettings, type BrollSettings, type LibraryFolder } from '../../../shared/broll/settings'
import { SOURCE_NAMES, type Candidate, type Moment, type SourceId } from '../../../shared/broll/types'
import type { CutalongApi } from './api'

/**
 * B-roll in the browser preview, which reaches no site: made-up finds with
 * generic names, planned and ranked by the same shared code the app uses
 * (shared/broll), so the replies, the reasons and the notes read as they will.
 */

type BrollApi = Pick<
  CutalongApi,
  | 'brollFind'
  | 'brollFetch'
  | 'brollQuote'
  | 'onBrollProgress'
  | 'brollSettings'
  | 'brollSaveSettings'
  | 'brollKeys'
  | 'brollSetKey'
  | 'brollClearKey'
  | 'brollCheckKey'
  | 'brollLibrary'
  | 'brollAddFolder'
  | 'brollRemoveFolder'
  | 'brollScan'
>

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const KEYED: Partial<Record<SourceId, BrollKeyId>> = { pexels: 'pexels', pixabay: 'pixabay', unsplash: 'unsplash', giphy: 'giphy', freesound: 'freesound' }

/** What each source would find for a search, by its words. */
function found(source: SourceId, m: Moment): Candidate[] {
  const title = m.search.replace(/^./, (c) => c.toUpperCase())
  const base = (id: string, over: Partial<Candidate>): Candidate => ({
    id: `${source}-${id}`,
    source,
    kind: 'video',
    title,
    author: 'Example',
    authorUrl: null,
    pageUrl: `https://${source}.example/${id}`,
    mediaUrl: `https://${source}.example/${id}.mp4`,
    previewUrl: null,
    width: 1920,
    height: 1080,
    durationSec: 14,
    bytes: null,
    license: CC0,
    tags: m.search.split(/\s+/),
    ...over
  })
  switch (source) {
    case 'library':
      return [base('1', { title: `${m.search} (your clip)`, author: null, pageUrl: null, mediaUrl: null, license: OWN, durationSec: 6, extra: { path: `/Users/you/Assets/B-Roll/${m.search}.mp4` } })]
    case 'wikimedia':
      return [base('1', { kind: 'image', width: 2560, height: 1440, durationSec: null, license: PUBLIC_DOMAIN })]
    case 'openverse':
      return [
        base('1', { kind: 'image', width: 1024, height: 683, durationSec: null, license: openverseLicense('by', '2.0') }),
        base('2', { kind: 'image', width: 1024, height: 683, durationSec: null, license: openverseLicense('by-nc', '2.0') })
      ]
    case 'pexels':
      return [base('1', { license: PEXELS })]
    case 'nasa':
    case 'archive':
      return [base('1', { license: PUBLIC_DOMAIN, durationSec: 95 })]
    case 'steam':
      return [base('1', { title: `${title}: Launch Trailer`, license: FAIR_USE, durationSec: 62, official: true })]
    case 'bluesky':
      return [base('1', { kind: 'post', title: `A post about ${m.search}`, mediaUrl: null, width: null, height: null, durationSec: null, license: FAIR_USE })]
    default:
      return []
  }
}

export function mockBrollApi(): BrollApi {
  let settings: BrollSettings = { ...DEFAULT_BROLL }
  const keys: Partial<Record<BrollKeyId, string>> = {}
  const folders = new Map<string, LibraryFolder>()
  const progress = new Set<(p: { stage: string; percent: number | null }) => void>()
  const say = (stage: string): void => {
    for (const cb of progress) cb({ stage, percent: null })
  }

  const why = (id: SourceId, paid: boolean): string | null => {
    if (settings.off.includes(id)) return 'you turned it off in Settings'
    const k = KEYED[id]
    if (k && !keys[k]) return 'it needs a free key, added in Settings'
    if (id === 'youtube' || id === 'own-uploads') return 'yt-dlp is not in the browser preview'
    if (id === 'web' && !paid) return 'it costs money and waits for your yes'
    if (id === 'web' && !settings.webSearch) return 'looking on the web is off in Settings'
    if (id === 'giphy' || id === 'generated') return 'the browser preview does not reach it'
    return null
  }

  return {
    brollFind: async ({ moments, paid, perMoment }) => {
      const results: MomentResult[] = []
      for (const m of moments) {
        const plan = planFor(m, { available: { why: (id) => why(id, paid === true) } })
        const asked: MomentResult['asked'] = []
        const all: { candidate: Candidate; place: number; of: number }[] = []
        for (const id of plan.sources) {
          say(id === 'library' ? 'Looking through your library' : `Searching ${SOURCE_NAMES[id]}`)
          await sleep(350)
          const got = found(id, m).filter((c) => c.source !== 'library' || folders.size > 0)
          const kept = got.filter((c) => c.license.monetized !== 'no')
          asked.push({ id, found: got.length, kept: kept.length, ms: 350 })
          kept.forEach((candidate, place) => all.push({ candidate, place, of: kept.length }))
        }
        const left = asked.reduce((n, a) => n + a.found - a.kept, 0)
        const ranked = rankFor(m, all, { order: plan.sources, count: perMoment ?? 3 })
        results.push({
          moment: m,
          plan,
          results: ranked,
          asked,
          notes: [
            ...plan.notes,
            ...(left ? [`${left === 1 ? 'One result had a licence' : `${left} results had licences`} this video cannot use (no commercial use), so I left ${left === 1 ? 'it' : 'them'} out.`] : []),
            ...(ranked.length ? [] : ['Nothing I found fits this moment closely enough.'])
          ]
        })
      }
      return { ok: true as const, results }
    },
    brollFetch: async ({ candidate: c, seconds }) => {
      say('Fetching it')
      await sleep(700)
      const range = stretchFor(c, seconds)
      const credit = creditLine(c, range)
      const length = range ? range.endSec - range.startSec : c.durationSec
      return {
        ok: true as const,
        asset: {
          kind: c.kind === 'video' ? ('video' as const) : ('image' as const),
          path:
            typeof c.extra?.path === 'string' ? c.extra.path : `/Users/you/Movies/Cutalong/Assets/${c.id}.${c.kind === 'video' ? 'mp4' : 'jpg'}`,
          title: c.title,
          durationSec: c.kind === 'video' ? (length ?? 8) : null,
          width: c.width ?? 1920,
          height: c.height ?? 1080,
          origin: { ...originFor(c, range), ...(credit ? { credit } : {}) }
        },
        credit
      }
    },
    brollQuote: async (moments) => {
      const low = moments * 0.034
      const high = moments * 0.12
      const cents = (d: number): string => `${Math.max(1, Math.round(d * 100))} cents`
      return {
        low,
        high,
        searches: moments * 3,
        said: `Looking on the web for ${moments === 1 ? 'this moment' : `${moments} moments`} costs about ${cents(low)} to ${cents(high)} on your Anthropic account, for at most ${moments * 3} web searches.`
      }
    },
    onBrollProgress: (cb) => {
      progress.add(cb)
      return () => progress.delete(cb)
    },
    brollSettings: async () => settings,
    brollSaveSettings: async (patch) => {
      settings = readBrollSettings({ ...settings, ...patch, folders: settings.folders })
      return settings
    },
    brollKeys: async () => Object.fromEntries(BROLL_KEYS.map((k) => [k.id, Boolean(keys[k.id])])) as Record<BrollKeyId, boolean>,
    brollSetKey: async (id, key) => {
      const wrong = wrongBrollKey(id, key)
      if (wrong) return { ok: false as const, message: wrong }
      keys[id] = key.trim()
      return { ok: true as const }
    },
    brollClearKey: async (id) => {
      delete keys[id]
    },
    // The preview reaches no site: a key of 20 characters or more is taken as one the site would accept.
    brollCheckKey: async (id) => {
      await sleep(600)
      const name = BROLL_KEYS.find((k) => k.id === id)?.name ?? id
      const saved = keys[id]
      if (!saved) return { ok: false as const, state: 'none' as const, message: `There is no ${name} key yet.` }
      return saved.length >= 20
        ? { ok: true as const }
        : { ok: false as const, state: 'refused' as const, message: `${name} did not accept that key. Paste it again, or make a new one.` }
    },
    brollLibrary: async () => ({ folders: settings.folders.map((p) => folders.get(p) ?? { path: p, said: 'Not looked through yet.', unsupported: [] }) }),
    brollAddFolder: async () => {
      const path = '/Users/you/Assets'
      say('Looking through /Users/you/Assets: 1,240 files')
      await sleep(900)
      folders.set(path, {
        path,
        said: 'Assets holds 412 videos, 230 pictures, 96 sound effects, 31 music tracks and 18 overlays with transparency. I cannot use 12 .mogrt and 3 .aep files; Settings says why.',
        unsupported: [
          { what: '.mogrt', count: 12, why: 'Premiere motion graphics templates only open in Premiere.' },
          { what: '.aep', count: 3, why: 'After Effects projects only open in After Effects.' }
        ]
      })
      settings = { ...settings, folders: [...settings.folders.filter((f) => f !== path), path] }
      return { ok: true as const, said: [folders.get(path)!.said] }
    },
    brollRemoveFolder: async (path) => {
      folders.delete(path)
      settings = { ...settings, folders: settings.folders.filter((f) => f !== path) }
      return settings
    },
    brollScan: async () => {
      say('Looking through your folders')
      await sleep(600)
      return { said: [...folders.values()].map((f) => f.said) }
    }
  }
}
