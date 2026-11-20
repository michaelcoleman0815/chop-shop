import { app, dialog, ipcMain, safeStorage, type WebContents } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { isBrollKeyId, type BrollKeyId } from '../../shared/broll/keys'
import { createQuotas, type Quotas } from '../../shared/broll/quota'
import { makerNames } from '../../shared/broll/route'
import { isSourceId, type BrollSource, type Candidate, type Fetched, type Moment, type SourceId } from '../../shared/broll/types'
import type { KeyCheck } from '../../shared/services'
import { readApiKey } from '../apikey'
import { readBrandById } from '../brand-store'
import { FFMPEG_PATH } from '../ffmpeg'
import { YTDLP_PATH } from '../fetch-video'
import { neverForBrand } from '../memory'
import { loadLogos } from '../motion-icons'
import { trackLoudness } from '../music'
import { FONTS_DIR } from '../resources'
import { getSettings } from '../store'
import { checkBrollKey } from './check'
import { probeFile } from './files'
import { createHttp } from './http'
import { brollKeys, type BrollKeys } from './keys'
import { describeIndex, loadIndex, scanLibrary, type LibraryIndex, type LibraryItem } from './library'
import { fetchPick, findBroll, type FindOptions, type MomentResult } from './router'
import { quotaStore, settingsStore, type BrollSettings } from './settings'
import { createSources, unavailable } from './sources'
import { makerEntries, type LogoData } from './sources/logos'
import { quoteWebSearch } from './sources/web'

/**
 * B-roll from everywhere, wired to the app: keys from the keychain,
 * settings and quota counts in userData, the person's library index, yt-dlp
 * and ffmpeg from the build, pages captured in the app's private window.
 *
 * registerBrollIpc() is called from the main process's start (main/index
 * registerIpc); the chat (Scout), the editor and Settings reach the
 * functions below through it (preload: brollFind, brollFetch and the rest).
 */

type Send = (wc: WebContents, channel: string, payload: unknown) => void

interface State {
  keys: BrollKeys
  settings: ReturnType<typeof settingsStore>
  quotas: Quotas
  libraries: Map<string, LibraryIndex>
  sources: Partial<Record<SourceId, BrollSource>>
  logoIndex: () => Promise<LogoData[]>
}

let state: State | null = null
const userData = (): string => app.getPath('userData')
const brollDir = (): string => join(userData(), 'broll')

/** Where an edit's fetched material is kept: the same folder main/cutalong uses for assets. */
export const assetsDir = (docId: string): string =>
  join(app.getPath('videos'), 'Cutalong', 'Assets', docId.replace(/[^\w-]/g, '') || 'loose')

let logoData: LogoData[] | null = null
const logoIndex = async (): Promise<LogoData[]> => {
  if (!logoData) {
    const mod = (await import('simple-icons/icons.json')) as unknown as { default?: LogoData[] } & LogoData[]
    logoData = (mod.default ?? mod) as LogoData[]
  }
  return logoData
}

function brollState(): State {
  if (state) return state
  const keys = brollKeys({ dir: userData, sealer: () => safeStorage })
  const settings = settingsStore(() => join(brollDir(), 'settings.json'))
  const counts = quotaStore(() => join(brollDir(), 'quota.json'))
  const quotas = createQuotas({ counts: counts.load(), save: counts.save })
  const libraries = new Map<string, LibraryIndex>()
  const http = createHttp()
  const sources = createSources({
    http,
    ffmpeg: FFMPEG_PATH,
    quotas,
    key: (id) => keys.read(id),
    library: () => libraryItems(),
    youtube: {
      tools: (dir) => ({ ffmpeg: FFMPEG_PATH, ytdlp: YTDLP_PATH(), dir, signInFrom: getSettings().videoSignIn ?? null }),
      scratch: join(app.getPath('temp'), 'cutalong-broll'),
      channels: () => settings.get().channels
    },
    logos: { index: logoIndex, marks: loadLogos },
    fontsDir: FONTS_DIR(),
    capture: async (url) => (await import('../page-capture')).capturePage(url),
    anthropicKey: readApiKey,
    // The seam for generated B-roll (sources/generated). It stays empty until the make consent boundary
    // lands (make:start, make:revise, make:go and make:shot need a tapped consent, and typed text never
    // spends); a provider then joins here through that boundary. Empty, the router never asks for
    // generation and nothing is paid for.
    generation: null
  })
  state = { keys, settings, quotas, libraries, sources, logoIndex }
  return state
}

/** Every indexed file of every library folder, loaded from the kept index the first time. */
export async function libraryItems(): Promise<LibraryItem[]> {
  const s = brollState()
  const out: LibraryItem[] = []
  for (const folder of s.settings.get().folders) {
    let index = s.libraries.get(folder) ?? null
    if (!index) {
      index = await loadIndex(brollDir(), folder)
      if (index) s.libraries.set(folder, index)
    }
    if (index) out.push(...index.items)
  }
  return out
}

/** Scans every library folder again (only new and changed files are opened). */
export async function scanLibraries(onProgress?: (stage: string, percent: number | null) => void, signal?: AbortSignal): Promise<string[]> {
  const s = brollState()
  const said: string[] = []
  for (const folder of s.settings.get().folders) {
    if (!existsSync(folder)) {
      said.push(`${folder} is not there any more.`)
      continue
    }
    onProgress?.(`Looking through ${folder}`, null)
    const { index } = await scanLibrary(folder, {
      cacheDir: brollDir(),
      signal,
      deps: { probe: (p, sig) => probeFile(FFMPEG_PATH, p, sig), loudness: (p, sig) => trackLoudness(FFMPEG_PATH, p, sig) },
      onProgress: (p) => onProgress?.(`Looking through ${folder}: ${p.files.toLocaleString('en-US')} files`, null)
    })
    s.libraries.set(folder, index)
    said.push(describeIndex(index))
  }
  return said
}

const why = (id: SourceId): string | null => {
  const s = brollState()
  const set = s.settings.get()
  return unavailable(id, {
    hasKey: (k) => s.keys.has(k),
    off: set.off,
    webSearch: set.webSearch,
    channels: set.channels,
    ytdlp: existsSync(YTDLP_PATH()),
    anthropic: !!readApiKey()
  })
}

const routerDeps = () => {
  const s = brollState()
  return { sources: s.sources, why, makers: async () => makerNames(makerEntries(await s.logoIndex())) }
}

/** What a brand's lists and never list say, read fresh. */
async function brandRules(brandId?: string | null): Promise<{ brand: { prefer: string[]; block: string[] }; never: string[] }> {
  const brand = await readBrandById(brandId ?? null)
  return { brand: brand.broll, never: brandId ? await neverForBrand(brandId) : [] }
}

/**
 * B-roll for moments (shared/broll/moment momentsFor turns the planner's
 * brollWanted into moments). `paid` is the person's yes to the web search's
 * quote, from the app's consent path; without it the web is not asked.
 */
export async function findBrollFor(
  moments: Moment[],
  brandId: string | null,
  opts: Pick<FindOptions, 'paid' | 'perMoment' | 'signal' | 'onProgress' | 'only'> = {}
): Promise<MomentResult[]> {
  const s = brollState()
  const set = s.settings.get()
  const rules = await brandRules(brandId)
  return findBroll(moments, routerDeps(), {
    ...rules,
    policy: { shareAlike: set.shareAlike, fairUse: set.fairUse },
    paid: opts.paid === true && set.webSearch,
    perMoment: opts.perMoment,
    only: opts.only,
    signal: opts.signal,
    onProgress: opts.onProgress
  })
}

/** The picked candidate as a file in the edit's assets folder, with its credit. */
export async function fetchBroll(
  candidate: Candidate,
  docId: string,
  opts: { seconds?: number; output?: { width: number; height: number }; brandId?: string | null; onProgress?: (p: number) => void; signal?: AbortSignal } = {}
): Promise<Fetched> {
  const set = brollState().settings.get()
  // A library file comes from the window by path: only a path the person's own index holds is used.
  if (candidate.source === 'library') {
    const path = candidate.extra?.path
    if (typeof path !== 'string' || !(await libraryItems()).some((i) => i.p === path)) throw new Error('That file is not in your library.')
  }
  const rules = await brandRules(opts.brandId)
  return fetchPick(candidate, assetsDir(docId), routerDeps(), {
    ...rules,
    policy: { shareAlike: set.shareAlike, fairUse: set.fairUse },
    seconds: opts.seconds,
    output: opts.output,
    onProgress: opts.onProgress,
    signal: opts.signal
  })
}

export function brollSettings(): BrollSettings {
  return brollState().settings.get()
}

export function saveBrollSettings(patch: Partial<BrollSettings>): BrollSettings {
  return brollState().settings.save(patch)
}

export function brollKeysStatus(): Record<BrollKeyId, boolean> {
  return brollState().keys.all()
}

export function checkKey(id: BrollKeyId): Promise<KeyCheck> {
  const s = brollState()
  return checkBrollKey(id, { http: createHttp(), read: (k) => s.keys.read(k) })
}

/** What the library holds, a sentence per folder, and what it cannot use and why. */
export async function librarySummary(): Promise<{ folders: { path: string; said: string; unsupported: { what: string; count: number; why: string }[] }[] }> {
  const s = brollState()
  await libraryItems()
  return {
    folders: s.settings.get().folders.map((path) => {
      const index = s.libraries.get(path)
      return {
        path,
        said: index ? describeIndex(index) : 'Not looked through yet.',
        unsupported: (index?.unsupported ?? []).map((g) => ({ what: g.what, count: g.count, why: g.why }))
      }
    })
  }
}

const asKey = (id: unknown): BrollKeyId => {
  if (!isBrollKeyId(id)) throw new Error('That is not a B-roll site Cutalong knows.')
  return id
}

/** The handlers Settings, the chat and the editor call. Registered once, from the main process's start. */
export function registerBrollIpc(send: Send): void {
  ipcMain.handle('broll:keys', () => brollKeysStatus())
  ipcMain.handle('broll:setKey', (_e, id: unknown, key: unknown) => brollState().keys.set(asKey(id), typeof key === 'string' ? key : ''))
  ipcMain.handle('broll:clearKey', (_e, id: unknown) => brollState().keys.clear(asKey(id)))
  ipcMain.handle('broll:checkKey', (_e, id: unknown) => checkKey(asKey(id)))
  ipcMain.handle('broll:settings', () => brollSettings())
  ipcMain.handle('broll:saveSettings', (_e, patch: unknown) => {
    // Folders come only from the folder picker (broll:addFolder): the window cannot point the library anywhere it likes.
    const rest = { ...(patch && typeof patch === 'object' ? patch : {}) } as Partial<BrollSettings>
    delete rest.folders
    return saveBrollSettings(rest)
  })
  ipcMain.handle('broll:quote', (_e, moments: unknown) => quoteWebSearch(Math.max(1, Math.min(10, Number(moments) || 1))))
  ipcMain.handle('broll:library', () => librarySummary())
  ipcMain.handle('broll:addFolder', async (e) => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Choose your assets folder' })
    if (r.canceled || !r.filePaths[0]) return { ok: false as const }
    const folders = [...brollSettings().folders.filter((f) => f !== r.filePaths[0]), r.filePaths[0]]
    saveBrollSettings({ folders })
    const said = await scanLibraries((stage, percent) => send(e.sender, 'broll:progress', { stage, percent }))
    return { ok: true as const, said }
  })
  ipcMain.handle('broll:removeFolder', (_e, path: unknown) => {
    brollState().libraries.delete(String(path))
    return saveBrollSettings({ folders: brollSettings().folders.filter((f) => f !== path) })
  })
  ipcMain.handle('broll:scan', async (e) => {
    const said = await scanLibraries((stage, percent) => send(e.sender, 'broll:progress', { stage, percent }))
    return { said }
  })
  ipcMain.handle('broll:find', async (e, req: { moments?: Moment[]; brandId?: string | null; paid?: boolean; perMoment?: number; only?: unknown }) => {
    try {
      const perMoment = Math.max(1, Math.min(6, Math.round(Number(req?.perMoment) || 3)))
      const results = await findBrollFor(Array.isArray(req?.moments) ? req.moments.slice(0, 6) : [], req?.brandId ?? null, {
        // A paid search runs only for a yes tapped on its price; the window sends it from that button alone.
        paid: req?.paid === true,
        perMoment,
        only: Array.isArray(req?.only) ? req.only.filter(isSourceId) : undefined,
        onProgress: (p) => send(e.sender, 'broll:progress', { stage: p.stage, percent: p.percent })
      })
      return { ok: true as const, results }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(
    'broll:fetch',
    async (e, req: { candidate: Candidate; docId: string; seconds?: number; output?: { width: number; height: number }; brandId?: string | null }) => {
      try {
        const got = await fetchBroll(req.candidate, req.docId, {
          seconds: req.seconds,
          output: req.output,
          brandId: req.brandId,
          onProgress: (p) => send(e.sender, 'broll:progress', { stage: 'Fetching it', percent: p })
        })
        return { ok: true as const, ...got }
      } catch (err) {
        return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
