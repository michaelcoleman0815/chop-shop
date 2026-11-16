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

  ipcMain.handle('learn:state', () => currentState(false))
  // Checking again re-runs every cutter on the labels as they stand.
  ipcMain.handle('learn:evaluate', () => currentState(true))
  ipcMain.handle('learn:forget', async (_e, id: string) => {
    await removePair(folder(), id)
    return currentState(false)
  })

  ipcMain.handle('learn:run', async (e, req: { recordings: string[]; finished: string }): Promise<LearnRunResult> => {
    const strings = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0)
    if (!req || !strings(req.recordings) || typeof req.finished !== 'string' || !req.finished) {
      return {
        ok: false,
        message: 'Pick the recording and the finished video made from it.',
        state: await currentState(false)
      }
    }
    if (running) {
      return {
        ok: false,
        message: "I'm already lining up another video. Give me a moment.",
        state: await currentState(false)
      }
    }
    running = true
    const progress = (stage: string, percent: number): void => deps.send(e.sender, 'learn:progress', { stage, percent })
    try {
      const outcome = await learnFromFiles(
        { recordings: req.recordings, finished: req.finished },
        { ffmpeg: FFMPEG_PATH, transcribe: deps.transcribe, onProgress: progress, id: randomUUID }
      )
      if (!outcome.ok) return { ok: false, message: outcome.message, state: await currentState(false) }
      await savePair(folder(), outcome.pair)
      return { ok: true, video: learnedVideo(outcome.pair), state: await currentState(false) }
    } catch (err) {
      return { ok: false, message: message(err), state: await currentState(false) }
    } finally {
      running = false
    }
  })
}

async function currentState(listening: boolean): Promise<LearnState> {
  const pairs = await readPairs(folder())
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
