import { app, dialog, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import type { Envelope } from '../shared/audio/snap'
import {
  CUTTERS,
  learnedVideo,
  learnState,
  type LabelledPair,
  type LearnRunResult,
  type LearnState
} from '../shared/learn'
import type { Transcript } from '../shared/types'
import { loudnessEnvelope } from './audio-envelope'
import { FFMPEG_PATH } from './ffmpeg'
import { learnFromFiles } from './learn-pipeline'
import { readPairs, removePair, savePair } from './learn-store'
import { readBrands } from './brand-store'
import { brandById, FIRST_BRAND_ID } from '../shared/brands'

/**
 * Learning from the creator's own edits, on this computer: a raw recording
 * (or several) and the finished video made from it are lined up, every word
 * is labelled, and the labels join the test set the cutting is checked
 * against. Nothing here touches the network; transcription is the same local
 * path an edit uses.
 */

type Send = (sender: WebContents, channel: string, payload: unknown) => void
type Transcribe = (
  path: string,
  durationSec: number,
  progress: (stage: string, percent: number) => void
) => Promise<Transcript>

const VIDEO = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mts']
const AUDIO = ['wav', 'm4a', 'mp3', 'aac', 'aiff', 'aif', 'flac']

const folder = (): string => join(app.getPath('userData'), 'learn')
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

let running = false

export function registerLearnIpc(deps: { send: Send; transcribe: Transcribe }): void {
  ipcMain.handle('learn:choose', async (_e, kind: 'recordings' | 'finished') => {
    const recordings = kind === 'recordings'
    const res = await dialog.showOpenDialog({
      properties: recordings ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: recordings
        ? [{ name: 'Recordings', extensions: [...VIDEO, ...AUDIO] }]
        : [{ name: 'Finished video', extensions: VIDEO }]
    })
    return res.canceled ? [] : res.filePaths
  })

  // Each brand learns from its own videos only: the state, a check and a run are for one brand.
  ipcMain.handle('learn:state', (_e, brand?: string | null) => currentState(false, brand))
  // Checking again re-runs every cutter on the labels as they stand.
  ipcMain.handle('learn:evaluate', (_e, brand?: string | null) => currentState(true, brand))
  ipcMain.handle('learn:forget', async (_e, id: string, brand?: string | null) => {
    await removePair(folder(), id)
    return currentState(false, brand)
  })

  ipcMain.handle(
    'learn:run',
    async (e, req: { recordings: string[]; finished: string; brand?: string | null }): Promise<LearnRunResult> => {
      const owner = await ownerOf(req?.brand)
      const stateNow = (listening: boolean): Promise<LearnState> => stateFor(listening, owner)
      const strings = (v: unknown): v is string[] =>
        Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0)
      if (!req || !strings(req.recordings) || typeof req.finished !== 'string' || !req.finished) {
        return {
          ok: false,
          message: 'Pick the recording and the finished video made from it.',
          state: await stateNow(false)
        }
      }
      if (running) {
        return {
          ok: false,
          message: "I'm already lining up another video. Give me a moment.",
          state: await stateNow(false)
        }
      }
      running = true
      const progress = (stage: string, percent: number): void => deps.send(e.sender, 'learn:progress', { stage, percent })
      try {
        const outcome = await learnFromFiles(
          { recordings: req.recordings, finished: req.finished },
          { ffmpeg: FFMPEG_PATH, transcribe: deps.transcribe, onProgress: progress, id: randomUUID }
        )
        if (!outcome.ok) return { ok: false, message: outcome.message, state: await stateNow(false) }
        await savePair(folder(), { ...outcome.pair, brand: owner.id })
        return { ok: true, video: learnedVideo(outcome.pair), state: await stateNow(false) }
      } catch (err) {
        return { ok: false, message: message(err), state: await stateNow(false) }
      } finally {
        running = false
      }
    }
  )
}

/** The brand learning is for: the one named, else the default; and which brand owns videos learned before brands had ids. */
async function ownerOf(id: string | null | undefined): Promise<{ id: string; legacy: string }> {
  const list = await readBrands()
  const brand = brandById(list, id)
  const legacy = list.brands.some((b) => b.id === FIRST_BRAND_ID) ? FIRST_BRAND_ID : list.default
  return { id: brand.id, legacy }
}

async function currentState(listening: boolean, brand?: string | null): Promise<LearnState> {
  return stateFor(listening, await ownerOf(brand))
}

async function stateFor(listening: boolean, owner: { id: string; legacy: string }): Promise<LearnState> {
  const pairs = (await readPairs(folder())).filter((p) => (p.brand ?? owner.legacy) === owner.id)
  let envelope: ((pair: LabelledPair, source: string) => Envelope | null) | undefined
  // Only a cutter that listens needs each recording heard again, and only
  // where the recording is still on this computer.
  if (listening && CUTTERS.some((c) => c.listens)) {
    const heard = new Map<string, Envelope | null>()
    for (const pair of pairs) {
      for (const r of pair.recordings) {
        if (heard.has(r.path)) continue
        heard.set(r.path, existsSync(r.path) ? await loudnessEnvelope(FFMPEG_PATH, r.path).catch(() => null) : null)
      }
    }
    envelope = (pair, source) => heard.get(pair.recordings.find((r) => r.id === source)?.path ?? '') ?? null
  }
  return learnState(pairs, { envelope })
}
