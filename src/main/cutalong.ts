import { app, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { FFMPEG_PATH, probe } from './ffmpeg'
import { FONTS_DIR } from './resources'
import { getSettings, saveSettings } from './store'
import { downloadModel, hasModel, transcribe } from './transcribe'
import { fetchVideo, YTDLP_PATH } from './fetch-video'
import { fetchExcerpt, fetchImage, importFile, saveImage, searchVideos, type AssetTools, type NewAsset } from './assets'
import { creditsText, isImageUrl, type Range } from '../shared/assets'
import { existsSync } from 'fs'
import { measureVideo, probeMedia } from './inspiration/measure'
import { renderCut } from './cut-render'
import { loudnessEnvelope } from './audio-envelope'
import { snapWords } from '../shared/audio/snap'
import { vocabulary } from '../shared/raw/prompt'
import { removePreset, savedPresets, savePreset } from './preset-store'
import { checkKey, planEdit } from './planner'
import { readBrand, saveBrand } from './brand-store'
import {
  createDoc,
  currentCut,
  currentVersion,
  EditDocSchema,
  resolveCut,
  wordsFromTranscript,
  type Note,
  type Word
} from '../shared/edit'
import { BUILT_IN_PRESETS, describeStyle, suggestCommandName } from '../shared/presets'
import {
  factDetails,
  factsReply,
  measureSpeech,
  styleFromFacts,
  summarize,
  type InspirationStudy,
  type SpeechMeasures
} from '../shared/inspiration'
import type { Transcript } from '../shared/types'

/**
 * The main-process side of Cutalong: turning footage into an edit document,
 * rendering a document, studying a video someone likes, and keeping saved
 * slash commands. Everything here is glue; the decisions live in shared/ and
 * in the tested modules it calls.
 */

type Send = (sender: WebContents, channel: string, payload: unknown) => void

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** How much of a reference video is transcribed for speech pacing. */
const SPEECH_SAMPLE_SEC = 180

export function registerCutalongIpc(deps: { send: Send; mediaUrlFor: (path: string) => string }): void {
  ipcMain.handle('cut:prepare', async (e, path: string) => {
    const progress = (stage: string, percent: number): void => deps.send(e.sender, 'cut:progress', { stage, percent })
    try {
      progress('Reading the footage', 1)
      const meta = await probe(path)
      const source = {
        id: 's1',
        path,
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        fps: meta.fps > 0 ? meta.fps : 30
      }
      let words: Word[] = []
      let warning: string | null = null
      try {
        const transcript = await transcriptFor(path, meta.durationSec, progress)
        words = wordsFromTranscript(transcript.words, source.id)
        // Listen to the recording so every word's edges sit on its sound,
        // which is what lets cuts land tight without clipping a consonant.
        if (words.length > 0) {
          progress('Listening for the cuts', 97)
          try {
            words = snapWords(words, await loudnessEnvelope(FFMPEG_PATH, path))
          } catch (err) {
            console.warn('[cut] could not listen to the audio, keeping recogniser timing:', message(err))
          }
        }
      } catch (err) {
        warning = `I couldn't transcribe it, so it is one long beat for now. ${message(err)}`
      }
      const doc = createDoc({ id: randomUUID(), title: basename(path, extname(path)), source, words })
      progress('Ready', 100)
      return { ok: true as const, doc, mediaUrl: deps.mediaUrlFor(path), warning }
    } catch (err) {
      progress('Failed', 0)
      return { ok: false as const, message: message(err) }
    }
  })

  ipcMain.handle('cut:render', async (e, req: { doc: unknown; quality: 'preview' | 'final' }) => {
    const parsed = EditDocSchema.safeParse(req.doc)
    if (!parsed.success) return { ok: false as const, message: 'The edit could not be read.' }
    const doc = parsed.data
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    if (resolved.pieces.length === 0)
      return { ok: false as const, message: 'There is nothing left in the cut to render.' }

    const final = req.quality === 'final'
    const stage = final ? 'Exporting' : 'Rendering a preview'
    const workDir = await fs.mkdtemp(join(app.getPath('temp'), 'cutalong-render-'))
    try {
      const sources = await Promise.all(
        doc.sources.map(async (s) => ({ ...s, hasAudio: (await probeMedia(FFMPEG_PATH, s.path)).hasAudio }))
      )
      const n = currentVersion(doc).n
      const outputPath = final
        ? await freePath(getSettings().outputDir, `${safeName(doc.title)} v${n}`, '.mp4')
        : join(await previewDir(), `${doc.id}-v${n}-${Date.now()}.mp4`)
      const brand = await readBrand()
      await renderCut(cut, resolved, sources, {
        ffmpeg: FFMPEG_PATH,
        outputPath,
        workDir,
        quality: req.quality,
        fontsDir: FONTS_DIR(),
        brand: brand.autoApply ? { colors: brand.colors, logo: brand.logo } : null,
        onProgress: (f) => deps.send(e.sender, 'cut:progress', { stage, percent: Math.round(f * 100) })
      })
      // Anything from outside the person's own files is credited beside the video.
      let creditsPath: string | null = null
      const credits = final ? creditsText(doc) : null
      if (credits) {
        creditsPath = outputPath.replace(/\.mp4$/i, '') + ' credits.txt'
        await fs.writeFile(creditsPath, credits)
      }
      return { ok: true as const, outputPath, mediaUrl: deps.mediaUrlFor(outputPath), creditsPath }
    } catch (err) {
      console.error('[cut] render failed:', message(err))
      return { ok: false as const, message: message(err) }
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  ipcMain.handle('inspiration:study', async (e, input: { url?: string; path?: string }) => {
    const progress = (stage: string, percent: number): void =>
      deps.send(e.sender, 'inspiration:progress', { stage, percent })
    try {
      let path = input.path ?? null
      let title: string | null = null
      let channel: string | null = null
      if (input.url) {
        progress('Fetching the video', 2)
        const fetched = await fetchVideo(
          input.url,
          (p) => progress('Fetching the video', Math.round(p * 0.4)),
          undefined,
          getSettings().videoSignIn ?? null
        )
        path = fetched.path
        title = fetched.title
        channel = fetched.channel
      }
      if (!path) return { ok: false as const, message: 'Paste a link or drop a video to learn from.' }
      title ??= basename(path, extname(path))

      progress('Measuring the cuts', 42)
      const measures = await measureVideo(path, { ffmpeg: FFMPEG_PATH, maxSec: 600 })

      // Speech pacing needs a transcript. The model is not downloaded just
      // for this: the picture alone answers most of the question.
      let speech: SpeechMeasures | null = null
      let note: string | null = null
      const settings = getSettings()
      if (measures.hasAudio && hasModel(settings.whisperModel)) {
        try {
          progress('Listening to the pacing', 70)
          const span = Math.min(measures.measuredSec, SPEECH_SAMPLE_SEC)
          const transcript = await transcribe(path, settings.whisperModel, span, (p) =>
            progress('Listening to the pacing', 70 + Math.round(p * 0.28))
          )
          speech = measureSpeech(transcript.words)
        } catch (err) {
          note = `I measured the picture but couldn't listen to the speech. ${message(err)}`
        }
      } else if (measures.hasAudio) {
        note = 'Speech pacing needs the transcription model, which is not downloaded yet.'
      }

      const facts = summarize(measures, speech)
      const style = styleFromFacts(facts)
      const taken = [...BUILT_IN_PRESETS, ...(await savedPresets())]
      const study: InspirationStudy = {
        source: { url: input.url ?? null, path, title, durationSec: measures.durationSec },
        facts,
        style,
        reply: factsReply(facts),
        chips: describeStyle(style).slice(0, 3),
        details: factDetails(facts),
        command: suggestCommandName(channel ?? title, taken),
        note
      }
      progress('Done', 100)
      return { ok: true as const, study }
    } catch (err) {
      progress('Failed', 0)
      return { ok: false as const, message: message(err) }
    }
  })

  ipcMain.handle('cut:plan', (_e, req: { doc: unknown; request: string; notes: Note[]; voice?: string }) =>
    planEdit(req)
  )

  // The brand: kept in userData, learned from the person's own videos, all
  // measured here on this computer.
  ipcMain.handle('brand:get', () => readBrand())
  ipcMain.handle('brand:save', (_e, brand: unknown) => saveBrand(brand))
  ipcMain.handle('brand:learn', async (e, paths: string[]) => {
    const learned: { path: string; title: string; facts: ReturnType<typeof summarize> }[] = []
    const failed: string[] = []
    const settings = getSettings()
    for (const [i, path] of paths.entries()) {
      const at = (f: number): number => Math.round(((i + f) / paths.length) * 100)
      deps.send(e.sender, 'brand:progress', { stage: `Watching ${basename(path)}`, percent: at(0) })
      try {
        const measures = await measureVideo(path, { ffmpeg: FFMPEG_PATH, maxSec: 600 })
        let speech: SpeechMeasures | null = null
        if (measures.hasAudio && hasModel(settings.whisperModel)) {
          deps.send(e.sender, 'brand:progress', { stage: `Listening to ${basename(path)}`, percent: at(0.5) })
          const t = await transcribe(path, settings.whisperModel, Math.min(measures.measuredSec, 120), () => undefined)
          speech = measureSpeech(t.words)
        }
        learned.push({ path, title: basename(path, extname(path)), facts: summarize(measures, speech) })
      } catch (err) {
        failed.push(`${basename(path)}: ${message(err)}`)
      }
    }
    deps.send(e.sender, 'brand:progress', { stage: 'Done', percent: 100 })
    return { learned, failed }
  })

  // Material for an edit: files, image links, excerpts of videos at links,
  // search results to pick B-roll from, and icons the renderer drew. All of it
  // is kept on this computer, in the edit's own assets folder.
  const tools = (docId: string): AssetTools => ({
    ffmpeg: FFMPEG_PATH,
    ytdlp: YTDLP_PATH(),
    dir: join(app.getPath('videos'), 'Chop Shop', 'Assets', docId.replace(/[^\w-]/g, '') || 'loose'),
    signInFrom: getSettings().videoSignIn ?? null
  })
  const needsYtdlp = (): void => {
    if (!existsSync(YTDLP_PATH())) throw new Error('yt-dlp is missing from this build. Run scripts/fetch-ytdlp.sh.')
  }

  ipcMain.handle('assets:add', async (e, req: { docId: string; path?: string; url?: string; range?: Range | null }) => {
    try {
      let asset: NewAsset
      if (req.path) asset = await importFile(req.path, tools(req.docId))
      else if (req.url && isImageUrl(req.url)) asset = await fetchImage(req.url, tools(req.docId))
      else if (req.url) {
        needsYtdlp()
        asset = await fetchExcerpt(req.url, req.range ?? null, tools(req.docId), (p) =>
          deps.send(e.sender, 'assets:progress', { stage: 'Fetching the clip', percent: p })
        )
      } else return { ok: false as const, message: 'There was nothing to add.', signIn: false }
      return { ok: true as const, asset }
    } catch (err) {
      const text = message(err)
      return { ok: false as const, message: text, signIn: /signed-in browser/.test(text) }
    }
  })

  ipcMain.handle('assets:search', async (_e, query: string) => {
    try {
      needsYtdlp()
      return { ok: true as const, results: await searchVideos(query, tools('search')) }
    } catch (err) {
      return { ok: false as const, message: message(err) }
    }
  })

  ipcMain.handle(
    'assets:saveImage',
    async (_e, req: { docId: string; base64: string; name: string; origin: NewAsset['origin'] }) => {
      try {
        const asset = await saveImage(Buffer.from(req.base64, 'base64'), req.name, req.origin, tools(req.docId))
        return { ok: true as const, asset }
      } catch (err) {
        return { ok: false as const, message: message(err) }
      }
    }
  )

  ipcMain.handle('settings:videoSignIn', (_e, browser: string | null) => {
    const allowed = ['chrome', 'safari', 'firefox', 'edge', 'brave', 'chromium', 'opera', 'vivaldi']
    return saveSettings({ videoSignIn: browser && allowed.includes(browser) ? browser : null }).videoSignIn ?? null
  })

  ipcMain.handle('claude:check', () => checkKey())

  ipcMain.handle('presets:list', () => savedPresets())
  ipcMain.handle('presets:save', (_e, preset: unknown) => savePreset(preset))
  ipcMain.handle('presets:remove', (_e, command: string) => removePreset(command))
}

/**
 * The transcript for a whole file, written verbatim: every filler, false
 * start and retake, the names from the brand and the title listened for,
 * and a second listen where words went missing. The model is fetched first
 * if it is missing rather than sending anyone to Settings.
 *
 * The clip finder's cached transcript is not reused: it is written the tidy
 * way, which smooths retakes away, and finding retakes is the point here.
 */
async function transcriptFor(
  path: string,
  durationSec: number,
  progress: (stage: string, percent: number) => void
): Promise<Transcript> {
  const { whisperModel } = getSettings()
  if (!hasModel(whisperModel)) {
    await downloadModel(whisperModel, (p) => progress(`Downloading ${whisperModel}`, Math.round(p * 0.3)))
  }
  const brand = await readBrand()
  const names = vocabulary({ title: basename(path, extname(path)), voice: brand.voice, products: brand.products })
  return transcribe(path, whisperModel, durationSec, (p, stage) => progress(stage, 30 + Math.round(p * 0.7)), 0, {
    names
  })
}

function safeName(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, '-').trim() || 'Untitled'
}

async function freePath(dir: string, name: string, ext: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? `${name}${ext}` : `${name} (${n})${ext}`)
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
  }
}

async function previewDir(): Promise<string> {
  const dir = join(app.getPath('temp'), 'cutalong-previews')
  await fs.mkdir(dir, { recursive: true })
  return dir
}
