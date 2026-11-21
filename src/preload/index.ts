import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { MapDownloadResult, MapStatus, PlatesFile } from '../shared/maps'
import type { CutoutKind, CutoutTrack } from '../shared/fx/masks'
import type {
  AnalysisOptions,
  CachedAnalysis,
  AnalysisResult,
  AspectPreset,
  CaptureSource,
  ClipRequest,
  ExportProgress,
  MediaPreviews,
  Project,
  ProjectMode,
  ProjectSummary,
  Settings,
  SuggestedClip,
  Timeline,
  TranscriptWord,
  UpdateState,
  VideoMeta,
  ZoomKeyframe
} from '../shared/types'
import type { Asset, EditDoc, Note, Op, Region, Source, Subject } from '../shared/edit'
import type { InspirationFacts, InspirationStudy } from '../shared/inspiration'
import type { Brand } from '../shared/brand'
import type { AudioMap } from '../shared/audio/map'
import type { VideoRun } from '../shared/channel-habits'
import type { Brands } from '../shared/brands'
import type { UploadKit } from '../shared/upload'
import type { LearnRunResult, LearnState } from '../shared/learn/state'
import type { MemoryChange, MemoryView, Signal } from '../shared/memory'
import type { PremiereFacts, Preset } from '../shared/presets'
import type { KeyCheck, ServiceId } from '../shared/services'
import type { BrollKeyId } from '../shared/broll/keys'
import type { MomentResult as BrollMomentResult } from '../shared/broll/route'
import type { BrollSettings, LibraryFolder, WebQuote } from '../shared/broll/settings'
import type {
  Candidate as BrollCandidate,
  Fetched as BrollFetched,
  Moment as BrollMoment,
  SourceId as BrollSourceId
} from '../shared/broll/types'
import type { ClipAsk, ClipsFound, ClipsReply } from '../shared/clipping'
import type { ClaudeKeyState } from '../shared/setup'
import type { PlanQuestion, PlanStep } from '../shared/plan/commands'
import type { Vlog } from '../shared/vlog/schema'
import type { VlogReply } from '../shared/vlog/reply'
import type { Change, Consent, Draft, Reply as MakeReply, ShotChange } from '../shared/make/draft'
import type { MakeQuestion } from '../shared/make/questions'
import type { Make } from '../shared/make/schema'
import type { Kept } from '../shared/make/kept'

type Progress = { stage: string; percent: number | null }

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/** Where the main process serves local files from, asked once as the page loads. */
const mediaBase: string = (() => {
  try {
    return String(ipcRenderer.sendSync('media:base'))
  } catch {
    return ''
  }
})()

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  /** http://127.0.0.1:port/token: a file's address is this, a slash, and its encoded path. */
  mediaBase,

  // Cutalong: footage into an edit document, documents into video, videos
  // someone likes into a style, and the saved slash commands.
  prepareCut: (
    /** With `brand`, the chat's brand by id: its kind of video and the names it listens for. */
    input: string | { paths: string[]; soundPaths?: string[]; brand?: string | null }
  ): Promise<
    | {
        ok: true
        doc: EditDoc
        mediaUrl: string
        warning: string | null
        lined?: { name: string; sound: string; offsetSec: number }[]
        /** What intake noticed and fixed: one sentence, at most three facts. */
        intake?: { sentence: string; facts: string[] }
        /** What watching the speaker's mouth changed or marked, in a sentence or two. */
        notice?: string | null
        /** What whisper printed when it could not transcribe a clip, for Details. */
        details?: { label: string; value: string }[]
      }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('cut:prepare', input),
  /**
   * A Premiere sequence, exported as Final Cut Pro XML, into a new edit: a
   * copy of its picture and sound to play here, every second of it in the
   * cut, so what is asked for goes back onto it (main: premiere:import).
   */
  importPremiere: (req: {
    path: string
    brand?: string | null
  }): Promise<
    | {
        ok: true
        doc: EditDoc
        mediaUrl: string
        warning: string | null
        notice?: string | null
        details?: { label: string; value: string }[]
        /** What was read from the sequence. */
        read: { name: string; durationSec: number; clips: number; files: number; missing: string[]; drawn: number }
      }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('premiere:import', req),
  /** More footage for an edit under way: talking clips on the end, better sound under every clip. */
  extendCut: (req: {
    doc: EditDoc
    paths: string[]
    soundPaths?: string[]
  }): Promise<
    | {
        ok: true
        doc: EditDoc
        warning: string | null
        lined: { name: string; sound: string; offsetSec: number }[]
        notice?: string | null
        details?: { label: string; value: string }[]
      }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('cut:extend', req),
  /** Which dropped file is the talking, which has the better sound, and which is B-roll. */
  planSession: (req: {
    request: string
    paths: string[]
  }): Promise<
    | {
        ok: true
        roles: {
          talking: string[]
          sound: string[]
          broll: string[]
          ignored: string[]
          reply: string
          by: 'claude' | 'measurement'
          /** The other players' views of one gaming session, lined up with the first talking file (main/session-povs). */
          povs?: {
            path: string
            offsetSec: number
            confidence: number
            overlapSec: number
            via: string | null
            driftSec: number | null
            /** Whether stretches of their own confirmed the line-up; unsure, it is in but not cut to until checked. */
            sure: boolean
            stretches: { checked: number; agreed: number } | null
            camera: { path: string; durationSec: number; width: number; height: number; fps: number; color?: 'hlg' | 'pq' }
          }[]
        }
      }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('cut:session', req),
  analyzeMusic: (
    path: string
  ): Promise<
    | { ok: true; facts: { durationSec: number; lufs: number | null; bpm: number | null; beats: number[] } }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('music:analyze', path),
  findMusic: (query: string): Promise<{ path: string; name: string }[]> => ipcRenderer.invoke('music:find', query),
  sfxFiles: (): Promise<{ ok: true; files: Record<string, string> } | { ok: false; message: string }> =>
    ipcRenderer.invoke('sfx:built'),
  findSounds: (query: string): Promise<{ path: string; name: string }[]> => ipcRenderer.invoke('sfx:find', query),
  readSound: (
    path: string
  ): Promise<{ ok: true; leadSec: number; peakDb: number; durationSec: number } | { ok: false; message: string }> =>
    ipcRenderer.invoke('sfx:read', path),
  findFocus: (req: {
    path: string
    ranges: { startSec: number; durationSec: number }[]
  }): Promise<{ ok: true; regions: Region[][] } | { ok: false; message: string }> =>
    ipcRenderer.invoke('focus:find', req),
  chooseCamera: (): Promise<string | null> => ipcRenderer.invoke('angle:choose'),
  findSpeaker: (req: {
    sources: { id: string; path: string; durationSec: number }[]
  }): Promise<{ ok: true; subjects: Record<string, Subject> } | { ok: false; finder: boolean; message: string }> =>
    ipcRenderer.invoke('reframe:find', req),
  lineUpCamera: (req: {
    path: string
    of: string
  }): Promise<
    | {
        ok: true
        camera: Omit<Source, 'id'>
        offsetSec: number
        sure: boolean
        hasSound: boolean
      }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('angle:line', req),
  /** Each other player's view of a session, heard on the person's own clock (main: pov:listen), as audio maps under home@view. */
  listenPovs: (req: {
    doc: EditDoc
  }): Promise<{ ok: true; maps: Record<string, AudioMap> } | { ok: false; message: string }> =>
    ipcRenderer.invoke('pov:listen', req),
  openPremiere: (req: {
    doc: EditDoc
  }): Promise<
    | {
        ok: true
        xmlPath: string
        srtPath: string | null
        opened: string | null
        facts: PremiereFacts
        /** Set when the edit went back onto the Premiere sequence it was made from: its name. */
        sequence?: string
      }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('cut:premiere', req),
  renderCut: (req: {
    doc: EditDoc
    quality: 'preview' | 'final'
    /** The file's name in the export folder, when it is not the edit's title and version: a clip's title. */
    name?: string
  }): Promise<
    | {
        ok: true
        outputPath: string
        mediaUrl: string
        creditsPath?: string | null
        chaptersPath?: string | null
        /** What an upload needs, written beside the export (shared/upload). */
        upload?: UploadKit | null
        /** The exported file's own size and length. */
        width?: number
        height?: number
        durationSec?: number
        /** On a phone, whether the export went to Photos too, and why not when it did not. */
        photos?: { saved: boolean; message?: string }
      }
    /** A sentence, and what ffmpeg said behind Details when it was ffmpeg that stopped. */
    | { ok: false; message: string; details?: { label: string; value: string }[] }
  > => ipcRenderer.invoke('cut:render', req),
  addAsset: (req: {
    docId: string
    path?: string
    url?: string
    range?: { startSec: number; endSec: number } | null
  }): Promise<{ ok: true; asset: Omit<Asset, 'id'> } | { ok: false; message: string; signIn: boolean }> =>
    ipcRenderer.invoke('assets:add', req),
  onAssetProgress: (cb: (p: Progress) => void): (() => void) => listen('assets:progress', cb),
  /** B-roll to choose from; `sources` are the brand's channels and sites to look in first and to leave out. */
  searchVideos: (
    query: string,
    sources?: { prefer: string[]; block: string[] }
  ): Promise<
    | {
        ok: true
        results: {
          url: string
          title: string
          author: string | null
          durationSec: number | null
          preferred?: boolean
        }[]
        /** Results left out because their channel or site is blocked. */
        blocked?: number
        /** Preferred channels looked in first: those that answered, of `tried` asked. */
        looked?: number
        tried?: number
      }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('assets:search', query, sources),
  saveImageAsset: (req: {
    docId: string
    base64: string
    name: string
    origin: Asset['origin']
  }): Promise<{ ok: true; asset: Omit<Asset, 'id'> } | { ok: false; message: string }> =>
    ipcRenderer.invoke('assets:saveImage', req),
  // B-roll from everywhere (main/broll/app): the person's folders first, then the free libraries and sites.
  /** B-roll for moments of the edit: the best few for each, with a reason. `paid` only from a tapped yes to the price. */
  brollFind: (req: {
    moments: BrollMoment[]
    brandId?: string | null
    paid?: boolean
    perMoment?: number
    /** Ask only these sources: the web alone, once its price is agreed to. */
    only?: BrollSourceId[]
  }): Promise<{ ok: true; results: BrollMomentResult[] } | { ok: false; message: string }> =>
    ipcRenderer.invoke('broll:find', req),
  /** The picked B-roll as a file in the edit's material, normalized, with its credit on it. */
  brollFetch: (req: {
    candidate: BrollCandidate
    docId: string
    seconds?: number
    output?: { width: number; height: number }
    brandId?: string | null
  }): Promise<({ ok: true } & BrollFetched) | { ok: false; message: string }> => ipcRenderer.invoke('broll:fetch', req),
  /** What looking on the web for `moments` moments may cost, before anything is spent. */
  brollQuote: (moments: number): Promise<WebQuote> => ipcRenderer.invoke('broll:quote', moments),
  onBrollProgress: (cb: (p: Progress) => void): (() => void) => listen('broll:progress', cb),
  brollSettings: (): Promise<BrollSettings> => ipcRenderer.invoke('broll:settings'),
  /** Folders are not changed here: only the folder picker adds one (brollAddFolder). */
  brollSaveSettings: (patch: Partial<Omit<BrollSettings, 'folders'>>): Promise<BrollSettings> =>
    ipcRenderer.invoke('broll:saveSettings', patch),
  /** Which B-roll sites have a key saved; the keys never come back to the window. */
  brollKeys: (): Promise<Record<BrollKeyId, boolean>> => ipcRenderer.invoke('broll:keys'),
  brollSetKey: (id: BrollKeyId, key: string): Promise<{ ok: true } | { ok: false; message: string }> =>
    ipcRenderer.invoke('broll:setKey', id, key),
  brollClearKey: (id: BrollKeyId): Promise<void> => ipcRenderer.invoke('broll:clearKey', id),
  brollCheckKey: (id: BrollKeyId): Promise<KeyCheck> => ipcRenderer.invoke('broll:checkKey', id),
  /** The person's asset folders: a sentence each of what it holds, and what it cannot use and why. */
  brollLibrary: (): Promise<{ folders: LibraryFolder[] }> => ipcRenderer.invoke('broll:library'),
  /** Opens the folder picker; a folder picked is looked through at once (progress on onBrollProgress). */
  brollAddFolder: (): Promise<{ ok: false } | { ok: true; said: string[] }> => ipcRenderer.invoke('broll:addFolder'),
  brollRemoveFolder: (path: string): Promise<BrollSettings> => ipcRenderer.invoke('broll:removeFolder', path),
  /** Looks through every folder again, opening only what changed. */
  brollScan: (): Promise<{ said: string[] }> => ipcRenderer.invoke('broll:scan'),
  /** A page at a link, captured on this computer as it shows logged out, saved into the edit's material. */
  capturePage: (req: {
    docId: string
    url: string
  }): Promise<{ ok: true; asset: Omit<Asset, 'id'> } | { ok: false; message: string }> =>
    ipcRenderer.invoke('assets:capturePage', req),
  /** A video's card from its link: title, views and age, and its thumbnail as material. The video is never fetched. */
  videoCard: (req: {
    docId: string
    url: string
  }): Promise<
    | {
        ok: true
        card: { url: string; title: string; channel: string | null; views: number | null; uploaded: string | null }
        asset: Omit<Asset, 'id'> | null
      }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('assets:videoCard', req),
  /** Two to four finished videos as one edit, playing at once in a grid. */
  makeGrid: (req: {
    paths: string[]
    labels?: string[]
    sound?: number | 'none'
  }): Promise<{ ok: true; doc: EditDoc; mediaUrl: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke('cut:grid', req),
  setVideoSignIn: (browser: string | null): Promise<string | null> =>
    ipcRenderer.invoke('settings:videoSignIn', browser),
  getBrand: (): Promise<Brand> => ipcRenderer.invoke('brand:get'),
  saveBrand: (brand: Brand): Promise<{ ok: true; brand: Brand } | { ok: false; message: string }> =>
    ipcRenderer.invoke('brand:save', brand),
  /** A brand per channel, and which one new chats use (shared/brands). */
  getBrands: (): Promise<Brands> => ipcRenderer.invoke('brands:get'),
  saveBrands: (brands: Brands): Promise<{ ok: true; brands: Brands } | { ok: false; message: string }> =>
    ipcRenderer.invoke('brands:save', brands),
  /** Files and links to the person's own videos: a link gives its length and captions, and no look (shared/channel-habits). */
  learnBrand: (
    paths: string[]
  ): Promise<{
    learned: { path: string; title: string; facts: InspirationFacts | null; run: VideoRun }[]
    failed: string[]
    /** What whisper printed when it could not hear a video, for Details. */
    details?: { label: string; value: string }[]
  }> => ipcRenderer.invoke('brand:learn', paths),
  onBrandProgress: (cb: (p: Progress) => void): (() => void) => listen('brand:progress', cb),
  // Learning from your edits: recordings and the video made from them, lined up on this computer.
  learnChoose: (kind: 'recordings' | 'finished'): Promise<string[]> => ipcRenderer.invoke('learn:choose', kind),
  // Each brand learns from its own videos: `brand` is its id, the default brand's when absent.
  learnRun: (req: { recordings: string[]; finished: string; brand?: string | null }): Promise<LearnRunResult> =>
    ipcRenderer.invoke('learn:run', req),
  learnState: (brand?: string | null): Promise<LearnState> => ipcRenderer.invoke('learn:state', brand),
  learnEvaluate: (brand?: string | null): Promise<LearnState> => ipcRenderer.invoke('learn:evaluate', brand),
  learnForget: (id: string, brand?: string | null): Promise<LearnState> =>
    ipcRenderer.invoke('learn:forget', id, brand),
  onLearnProgress: (cb: (p: Progress) => void): (() => void) => listen('learn:progress', cb),
  // What has been learned about how you edit, kept on this computer.
  memoryView: (): Promise<MemoryView> => ipcRenderer.invoke('memory:get'),
  rememberSignal: (signal: Signal): Promise<void> => ipcRenderer.invoke('memory:record', signal),
  updateMemory: (change: MemoryChange): Promise<MemoryView> => ipcRenderer.invoke('memory:update', change),
  onCutProgress: (cb: (p: Progress) => void): (() => void) => listen('cut:progress', cb),
  /** /clipping: the moments in long recordings that stand on their own, each as its own edit. */
  findClips: (req: {
    paths: string[]
    ask: string
    /** What Claude read in words that were not /clipping. */
    asked?: ClipAsk
    known?: Record<string, TranscriptWord[]>
    avoid?: { path: string; startSec: number; endSec: number }[]
    /** The chat's brand, by id. */
    brand?: string | null
  }): Promise<
    | ({ ok: true; reply: ClipsReply } & ClipsFound)
    | { ok: false; message: string; details?: { label: string; value: string }[] }
  > => ipcRenderer.invoke('clips:find', req),
  onClipsProgress: (cb: (p: Progress) => void): (() => void) => listen('clips:progress', cb),
  /**
   * A vlog from a shoot: every clip watched, the talking heard, the moments
   * described, the day told as a story. With `doc`, the clips join that edit's
   * story as a new version. Progress comes on cut:progress.
   */
  makeVlog: (req: {
    paths: string[]
    request: string
    doc?: EditDoc | null
    /** The chat's brand, by id: the names the talking is listened for with. */
    brand?: string | null
  }): Promise<{ ok: true; doc: EditDoc; mediaUrl: string; reply: VlogReply } | { ok: false; message: string }> =>
    ipcRenderer.invoke('vlog:make', req),
  /**
   * A video made from nothing (main/make): the prompt read, its script
   * written and the whole of it quoted. Under "Go ahead without asking" in
   * Settings it is made straight away. Progress comes on cut:progress.
   */
  makeStart: (req: {
    text: string
    recording?: string | null
    /** The chat's brand, by id: its voice writes the script. The default brand's when absent. */
    brand?: string | null
    /** The questions were answered (or answered by typing): ask nothing again. */
    answered?: boolean
    /** Answered by typing: show the quote, whatever Settings says about going ahead without asking. */
    quoteFirst?: boolean
    /**
     * Typed answers confirmed on their read-back: the words the brief is read from (the ask with only
     * its style and length answers), as it was read back. `text`, with what it should say, is what Claude reads.
     */
    reading?: string
    /**
     * Why it may be written: a tap (a read-back's Yes, the questions' options) or a new video asked for with
     * nothing else waiting. Without it, main asks the questions, and writes nothing.
     */
    consent?: Consent
  }): Promise<
    | { ok: true; kind: 'ask'; questions: MakeQuestion[] }
    | { ok: true; kind: 'quote'; draft: Draft; reply: MakeReply }
    | { ok: true; kind: 'made'; auto: true; doc: EditDoc; mediaUrl: string; reply: MakeReply; spent: number; into: Draft['into'] | null }
    | { ok: false; message: string; draft?: Draft; reply?: MakeReply }
  > => ipcRenderer.invoke('make:start', req),
  /**
   * A quote confirmed at `confirmed` dollars, the price its button showed:
   * made, unless the price is now higher, another service would make it, or
   * the draft is not the one the button showed (its fingerprint). Stopped, it
   * answers with what was spent and a quote for the rest.
   */
  makeGo: (req: {
    draft: Draft
    confirmed: number
    /** shared/make/fingerprint of the draft, as its quote was shown. */
    fingerprint: string
    /** The quote's button, tapped: nothing is made without it. */
    consent: 'tap'
  }): Promise<
    | { ok: true; doc: EditDoc; mediaUrl: string; reply: MakeReply; spent: number; into: Draft['into'] | null }
    | { ok: false; message: string; draft?: Draft; reply?: MakeReply }
  > => ipcRenderer.invoke('make:go', req),
  /**
   * Changes said about a quote, read back and confirmed: each in turn, the last winning, the brief
   * changed and quoted again; draft null when, in the end, nothing changed.
   */
  makeRevise: (req: {
    draft: Draft
    steps: string[]
    /** Yes on the read-back, tapped: no quote is changed without it. */
    consent: 'tap'
  }): Promise<
    | { ok: true; draft: Draft; reply: MakeReply; changed: string[] }
    | { ok: true; draft: null }
    /** Stopped or failed: why, and, when writing the script again may have cost something, the quote with that counted. */
    | { ok: false; message: string; draft?: Draft; reply?: MakeReply }
  > => ipcRenderer.invoke('make:revise', req),
  /** The script edited before anything is made, quoted again. */
  makeScript: (req: {
    draft: Draft
    script: string
  }): Promise<{ ok: true; draft: Draft; reply: MakeReply } | { ok: false; message: string }> =>
    ipcRenderer.invoke('make:script', req),
  /** An ask of a made video: what making it again costs, before anything is made. Null when it is an ordinary edit. */
  makeChange: (req: {
    doc: EditDoc
    text: string
    onScreen?: string | null
    /** The person's own voice-over, dropped for a made video that asked for one. */
    recording?: string | null
    brand?: string | null
  }): Promise<{ ok: true; change: Change | null } | { ok: false; message: string }> =>
    ipcRenderer.invoke('make:change', req),
  /** One shot made again for its confirmed quote: the op for a new version, the record and the asset. */
  makeShot: (req: {
    doc: EditDoc
    change: ShotChange
    confirmed: number
    /** The quote's button, tapped: nothing is made without it. */
    consent: 'tap'
  }): Promise<
    | { ok: true; ops: Op[]; make: Make; asset: Omit<Asset, 'id'>; summary: string; reply: MakeReply; spent: number }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('make:shot', req),
  /** Stops whatever is being made: nothing more is asked for or spent. */
  makeCancel: (): Promise<boolean> => ipcRenderer.invoke('make:cancel'),
  /** A vlog's story told again for what was asked, as ops for a new version and the shoot with its new story. */
  planVlog: (req: {
    doc: EditDoc
    request: string
  }): Promise<
    | { ok: true; ops: Op[]; vlog: Vlog; reply: VlogReply; by: 'claude' | 'local' | 'rules' }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('vlog:plan', req),
  planEdit: (req: {
    doc: EditDoc
    request: string
    notes: Note[]
    voice?: string
    /** The slash commands there are, the person's own among them: a plan may run any of them. */
    commands?: { command: string; summary: string }[]
    /** Cuts offered and not yet answered, in plain words. */
    offers?: string[]
    /** The last turns of the chat, oldest first. */
    chat?: { role: 'user' | 'assistant'; text: string }[]
    /** The person's brands by name, and whether this chat is in each. */
    brands?: { name: string; current: boolean }[]
  }): Promise<
    | {
        ok: true
        ops: Op[]
        /** The plan in order: runs of edit ops, and Cutalong's commands between them. */
        steps: PlanStep[]
        /** A question Claude asked instead of guessing, or null. */
        question: PlanQuestion | null
        summary: string
        reply: string
        notesHandled: string[]
        needs: string[]
        rejected: string[]
        brollWanted?: { beat: string; search: string }[]
      }
    | { ok: false; message: string; needsKey?: boolean; keyState?: ClaudeKeyState }
  > => ipcRenderer.invoke('cut:plan', req),
  /**
   * What a message asks Cutalong to make, read by Claude before any footage
   * is: an edit, a vlog, clips from a long recording, words to wait for
   * footage with, or a question answered; and what a link with it is for.
   */
  triage: (req: {
    request: string
    files: { path: string; name: string }[]
    link: string | null
    hasEdit: boolean
    commands?: { command: string; summary: string }[]
  }): Promise<
    | {
        ok: true
        route: 'edit' | 'vlog' | 'clipping' | 'grid' | 'wait' | 'answer'
        reply: string
        link: 'study' | 'material' | 'page' | 'cards' | 'none'
        clip: ClipAsk
        question: PlanQuestion | null
      }
    | { ok: false; message: string; keyState?: ClaudeKeyState }
  > => ipcRenderer.invoke('cut:triage', req),
  /** `quick` takes a key Anthropic accepted before as working, without asking again: for launch. */
  checkKey: (opts?: {
    quick?: boolean
  }): Promise<
    | { ok: true; state: 'ok'; confirmed: true }
    | { ok: false; state: ClaudeKeyState; message: string; confirmed: boolean; needsKey: boolean }
  > => ipcRenderer.invoke('claude:check', opts),
  /** An Anthropic key the person copied, if that is what is on the clipboard now, else null: nothing else is read back. */
  anthropicKeyOnClipboard: (): Promise<string | null> => ipcRenderer.invoke('claude:keyOnClipboard'),
  // Other AI services: whether each key exists (never what it is), saving and
  // checking a key, and the one switch that lets anything go to them.
  serviceKeys: (): Promise<Record<ServiceId, boolean>> => ipcRenderer.invoke('services:keys'),
  setServiceKey: (id: ServiceId, key: string): Promise<{ ok: true } | { ok: false; message: string }> =>
    ipcRenderer.invoke('services:setKey', id, key),
  clearServiceKey: (id: ServiceId): Promise<void> => ipcRenderer.invoke('services:clearKey', id),
  checkServiceKey: (id: ServiceId): Promise<KeyCheck> => ipcRenderer.invoke('services:check', id),
  setOtherServices: (on: boolean): Promise<boolean> => ipcRenderer.invoke('services:setOn', on),
  /** The local AI server on this computer (Ollama, or another with the /v1 chat API), where it is, and its models. */
  localPlanners: (): Promise<{
    up: boolean
    kind: 'ollama' | 'v1' | null
    host: string | null
    models: { name: string; sizeBytes: number }[]
  }> => ipcRenderer.invoke('planner:local'),
  studyInspiration: (input: {
    url?: string
    path?: string
  }): Promise<{ ok: true; study: InspirationStudy } | { ok: false; message: string }> =>
    ipcRenderer.invoke('inspiration:study', input),
  onInspirationProgress: (cb: (p: Progress) => void): (() => void) => listen('inspiration:progress', cb),
  listPresets: (): Promise<Preset[]> => ipcRenderer.invoke('presets:list'),
  savePreset: (preset: Preset): Promise<{ ok: true; presets: Preset[] } | { ok: false; message: string }> =>
    ipcRenderer.invoke('presets:save', preset),
  removePreset: (command: string): Promise<Preset[]> => ipcRenderer.invoke('presets:remove', command),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
  chooseOutputDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseOutputDir'),

  openVideo: (): Promise<VideoMeta | null> => ipcRenderer.invoke('dialog:openVideo'),
  // Dropped files only carry a path via webUtils from Electron 32 onward.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  describeVideo: (path: string): Promise<VideoMeta> => ipcRenderer.invoke('video:describe', path),

  exportClip: (
    req: ClipRequest & { jobId: string }
  ): Promise<{ ok: true; outputPath: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke('clip:export', req),

  listCaptureSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke('capture:sources'),
  screenPermission: (): Promise<string> => ipcRenderer.invoke('capture:permission'),
  openPermissionSettings: (): Promise<void> => ipcRenderer.invoke('capture:openPermissionSettings'),

  grabBuffer: (payload: {
    jobId: string
    segments: ArrayBuffer[]
    tailSec: number
    aspect: AspectPreset
    name: string
  }): Promise<{ ok: true; outputPath: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke('buffer:grab', payload),

  hasApiKey: (): Promise<boolean> => ipcRenderer.invoke('ai:hasKey'),
  setApiKey: (key: string): Promise<void> => ipcRenderer.invoke('ai:setKey', key),
  clearApiKey: (): Promise<void> => ipcRenderer.invoke('ai:clearKey'),

  provider: (): Promise<string> => ipcRenderer.invoke('ai:provider'),
  listModels: (): Promise<{ ok: true; models: { id: string; name: string }[] } | { ok: false; message: string }> =>
    ipcRenderer.invoke('ai:models'),

  hasModel: (model: string): Promise<boolean> => ipcRenderer.invoke('stt:hasModel', model),
  modelSizeMb: (model: string): Promise<number> => ipcRenderer.invoke('stt:modelSize', model),
  downloadModel: (model: string): Promise<boolean> => ipcRenderer.invoke('stt:downloadModel', model),

  // Maps: what data is here, what the preview draws from, and the first-use download.
  mapStatus: (): Promise<MapStatus> => ipcRenderer.invoke('maps:status'),
  mapData: (): Promise<{ status: MapStatus; tilesDir: string | null; plates: PlatesFile | null }> =>
    ipcRenderer.invoke('maps:data'),
  downloadMaps: (): Promise<MapDownloadResult> => ipcRenderer.invoke('maps:download'),
  onMapProgress: (cb: (p: { percent: number }) => void): (() => void) => {
    const handler = (_e: unknown, p: { percent: number }): void => cb(p)
    ipcRenderer.on('maps:progress', handler)
    return () => ipcRenderer.removeListener('maps:progress', handler)
  },

  // Scene effects: what this computer can cut out, and the cut-outs the preview draws an edit's effects from.
  fxCan: (): Promise<{ person: boolean; objects: boolean }> => ipcRenderer.invoke('fx:can'),
  fxCutouts: (doc: unknown): Promise<{ tracks: CutoutTrack[]; missing: CutoutKind[] }> =>
    ipcRenderer.invoke('fx:cutouts', { doc }),

  analyze: (
    videoPath: string,
    force?: boolean,
    options?: AnalysisOptions
  ): Promise<{ ok: true; result: AnalysisResult } | { ok: false; message: string }> =>
    ipcRenderer.invoke('ai:analyze', videoPath, force, options),
  hasArtlist: (): Promise<boolean> => ipcRenderer.invoke('artlist:has'),
  setArtlist: (clientId: string, clientSecret: string): Promise<boolean> =>
    ipcRenderer.invoke('artlist:set', clientId, clientSecret),
  searchArtlist: (
    query: string
  ): Promise<
    | {
        ok: true
        songs: { id: string; name: string; artist: string; durationSec: number; bpm: number | null; url: string }[]
      }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('artlist:search', query),
  fetchArtlistSong: (song: {
    id: string
    name: string
    artist: string
    durationSec: number
    bpm: number | null
    url: string
  }): Promise<{ ok: true; path: string } | { ok: false; message: string }> => ipcRenderer.invoke('artlist:fetch', song),
  listMusic: (): Promise<{ name: string; path: string }[]> => ipcRenderer.invoke('music:list'),
  chooseMusicDir: (): Promise<string | null> => ipcRenderer.invoke('music:choose'),
  renderClipPreview: (
    req: ClipRequest & { jobId: string }
  ): Promise<{ ok: true; mediaUrl: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke('clip:renderPreview', req),
  captionSample: (presetId: string, motion = false): Promise<string> =>
    ipcRenderer.invoke('captions:sample', presetId, motion),
  clipPoster: (path: string, atSec: number, aspect: string): Promise<string> =>
    ipcRenderer.invoke('media:clipPoster', path, atSec, aspect),
  fetchVideo: (
    url: string,
    range?: { startSec: number; endSec: number }
  ): Promise<{ ok: true; meta: VideoMeta } | { ok: false; message: string }> =>
    ipcRenderer.invoke('video:fromUrl', url, range),
  onFetchProgress: (cb: (p: { percent: number; stage: string; message?: string }) => void): (() => void) => {
    const handler = (_e: unknown, p: { percent: number; stage: string; message?: string }): void => cb(p)
    ipcRenderer.on('video:fetchProgress', handler)
    return () => ipcRenderer.removeListener('video:fetchProgress', handler)
  },
  cachedAnalysis: (videoPath: string): Promise<CachedAnalysis | null> => ipcRenderer.invoke('ai:cached', videoPath),

  onAiProgress: (cb: (p: { stage: string; percent: number; message?: string }) => void): (() => void) => {
    const handler = (_e: unknown, p: { stage: string; percent: number; message?: string }): void => cb(p)
    ipcRenderer.on('ai:progress', handler)
    return () => ipcRenderer.removeListener('ai:progress', handler)
  },

  previewRange: (
    sourcePath: string,
    startSec: number
  ): Promise<{ mediaUrl: string; startSec: number; windowSec: number }> =>
    ipcRenderer.invoke('preview:range', sourcePath, startSec),

  exportPremiere: (req: {
    sourcePath: string
    clips: SuggestedClip[]
    words: TranscriptWord[]
    tighten: boolean
  }): Promise<{ ok: true; xmlPath: string; srtPath: string | null } | { ok: false; message: string }> =>
    ipcRenderer.invoke('premiere:export', req),

  previewClip: (
    req: ClipRequest & { jobId: string }
  ): Promise<{ ok: true; mediaUrl: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke('clip:preview', req),

  planClip: (req: {
    words: TranscriptWord[]
    durationSec: number
  }): Promise<{ segments: { start: number; end: number }[]; zooms: ZoomKeyframe[] }> =>
    ipcRenderer.invoke('clip:plan', req),

  chooseMedia: (): Promise<{
    path: string
    kind: 'image' | 'video'
    durationSec: number
  } | null> => ipcRenderer.invoke('dialog:chooseMedia'),
  chooseAudio: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseAudio'),

  listLuts: (): Promise<{ name: string; path: string }[]> => ipcRenderer.invoke('lut:list'),
  chooseLut: (): Promise<string | null> => ipcRenderer.invoke('lut:choose'),
  importEpr: (): Promise<
    | {
        ok: true
        preset: {
          name: string
          width: number | null
          height: number | null
          videoBitrate: number | null
          audioBitrate: number | null
          fps: number | null
        }
      }
    | { ok: false; message: string }
    | null
  > => ipcRenderer.invoke('preset:importEpr'),

  probeMedia: (
    path: string
  ): Promise<{ path: string; durationSec: number; width: number; height: number; fps: number }> =>
    ipcRenderer.invoke('timeline:probe', path),

  mediaPreviews: (path: string): Promise<MediaPreviews> => ipcRenderer.invoke('media:previews', path),
  /** One still for a thumbnail, or null when the file has no picture. */
  mediaPoster: (path: string): Promise<string | null> => ipcRenderer.invoke('media:poster', path),
  /** Footage, sound and images, as many as the person picks. */
  openMedia: (): Promise<{ path: string; name: string }[]> => ipcRenderer.invoke('dialog:openMedia'),
  renderTimeline: (req: {
    jobId: string
    timeline: Timeline
    name: string
    preview: boolean
  }): Promise<{ ok: true; outputPath: string; mediaUrl: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke('timeline:render', req),

  recentProjects: (): Promise<ProjectSummary[]> => ipcRenderer.invoke('project:recent'),
  createProject: (name: string, mode: ProjectMode): Promise<Project> =>
    ipcRenderer.invoke('project:create', name, mode),
  openProject: (path?: string): Promise<Project | null> => ipcRenderer.invoke('project:open', path),
  saveProject: (project: Project): Promise<void> => ipcRenderer.invoke('project:save', project),
  /**
   * A paid result kept in its own chat's file while another chat is open: read, merged and written in that file's
   * turn. A new made video never replaces an edit; it goes in a new chat then, as with no file to keep it in.
   * Where it was kept, or null.
   */
  keepInChat: (req: { path: string | null; name: string; kept: Kept }): Promise<{ path: string; name: string; aside?: boolean } | null> =>
    ipcRenderer.invoke('project:keep', req),
  forgetProject: (path: string): Promise<void> => ipcRenderer.invoke('project:forget', path),

  reveal: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal', path),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openPath', path),

  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  updateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('update:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  openReleasesPage: (): Promise<void> => ipcRenderer.invoke('update:openPage'),

  onExportProgress: (cb: (p: ExportProgress) => void): (() => void) => {
    const handler = (_e: unknown, p: ExportProgress): void => cb(p)
    ipcRenderer.on('clip:progress', handler)
    return () => ipcRenderer.removeListener('clip:progress', handler)
  },
  onUpdateState: (cb: (s: UpdateState) => void): (() => void) => {
    const handler = (_e: unknown, s: UpdateState): void => cb(s)
    ipcRenderer.on('update:state', handler)
    return () => ipcRenderer.removeListener('update:state', handler)
  },
  onGrabRequested: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('buffer:grab-requested', handler)
    return () => ipcRenderer.removeListener('buffer:grab-requested', handler)
  }
}

export type ChopApi = typeof api

contextBridge.exposeInMainWorld('chop', api)
