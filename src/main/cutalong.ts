import { app, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { FFMPEG_PATH, probe } from './ffmpeg'
import { FONTS_DIR } from './resources'
import { getSettings } from './store'
import { downloadModel, hasModel, transcribe } from './transcribe'
import { readAnalysis } from './analysis-cache'
import { fetchVideo } from './fetch-video'
import { measureVideo, probeMedia } from './inspiration/measure'
import { renderCut } from './cut-render'
import { removePreset, savedPresets, savePreset } from './preset-store'
import { planEdit } from './planner'
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
      await renderCut(cut, resolved, sources, {
        ffmpeg: FFMPEG_PATH,
        outputPath,
        workDir,
        quality: req.quality,
        fontsDir: FONTS_DIR(),
        onProgress: (f) => deps.send(e.sender, 'cut:progress', { stage, percent: Math.round(f * 100) })
      })
      return { ok: true as const, outputPath, mediaUrl: deps.mediaUrlFor(outputPath) }
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
        const fetched = await fetchVideo(input.url, (p) => progress('Fetching the video', Math.round(p * 0.4)))
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

  ipcMain.handle('cut:plan', (_e, req: { doc: unknown; request: string; notes: Note[] }) => planEdit(req))

  ipcMain.handle('presets:list', () => savedPresets())
  ipcMain.handle('presets:save', (_e, preset: unknown) => savePreset(preset))
  ipcMain.handle('presets:remove', (_e, command: string) => removePreset(command))
}

/**
 * The transcript for a whole file: the clip finder's cached one when it
 * covers the same recording, otherwise a fresh run, fetching the model first
 * if it is missing rather than sending anyone to Settings.
 */
async function transcriptFor(
  path: string,
  durationSec: number,
  progress: (stage: string, percent: number) => void
): Promise<Transcript> {
  const cached = await readAnalysis(path).catch(() => null)
  const whole =
    cached &&
    cached.transcript.words.length > 0 &&
    (cached.options?.startSec ?? 0) < 0.5 &&
    Math.abs((cached.options?.endSec ?? durationSec) - durationSec) < 0.5
  if (whole) return cached.transcript

  const { whisperModel } = getSettings()
  if (!hasModel(whisperModel)) {
    await downloadModel(whisperModel, (p) => progress(`Downloading ${whisperModel}`, Math.round(p * 0.3)))
  }
  return transcribe(path, whisperModel, durationSec, (p, stage) => progress(stage, 30 + Math.round(p * 0.7)))
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
