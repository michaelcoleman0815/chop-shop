import { promises as fs } from 'fs'
import { basename, extname } from 'path'
import { snapWords } from '../shared/audio/snap'
import { wordsFromTranscript } from '../shared/edit/doc'
import {
  alignPair,
  buildPair,
  findBreaths,
  type FoundBreath,
  type LabelledPair,
  type RecordingInput
} from '../shared/learn'
import type { Transcript } from '../shared/types'
import { listen, type Heard } from './audio-features'

/**
 * Learning from one finished video: listen to it and to the recordings it
 * was cut from, transcribe them all, line them up and label every word.
 * Everything runs on this computer, with the same local transcription and
 * the same listening an edit gets.
 *
 * No Electron here, so the tests can run all of it on files they make.
 */

export interface LearnDeps {
  ffmpeg: string
  /** Transcribes a whole file: the app's own local path, or a stand-in in tests. */
  transcribe: (
    path: string,
    durationSec: number,
    progress: (stage: string, percent: number) => void
  ) => Promise<Transcript>
  onProgress?: (stage: string, percent: number) => void
  id: () => string
  now?: () => Date
  signal?: AbortSignal
}

export type LearnOutcome = { ok: true; pair: LabelledPair } | { ok: false; message: string }

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function stat(path: string): Promise<{ bytes: number | null; modifiedAt: string | null }> {
  try {
    const s = await fs.stat(path)
    return { bytes: s.size, modifiedAt: s.mtime.toISOString() }
  } catch {
    return { bytes: null, modifiedAt: null }
  }
}

export async function learnFromFiles(
  files: { recordings: string[]; finished: string },
  deps: LearnDeps
): Promise<LearnOutcome> {
  const progress = deps.onProgress ?? ((): void => undefined)
  const all = [...files.recordings, files.finished]
  if (files.recordings.length === 0) return { ok: false, message: 'Add the recording the video was cut from.' }
  if (files.recordings.includes(files.finished)) {
    return { ok: false, message: 'The finished video is one of the recordings. Pick the video you made from them.' }
  }
  for (const path of all) {
    try {
      await fs.access(path)
    } catch {
      return { ok: false, message: `I can't find ${basename(path)} any more.` }
    }
  }

  // Each file is heard, then transcribed; transcription is most of the time.
  const share = 92 / all.length
  const heard: { path: string; heard: Heard; transcript: Transcript }[] = []
  for (const [i, path] of all.entries()) {
    const name = basename(path)
    const at = (f: number): number => Math.round(2 + share * (i + f))
    progress(`Listening to ${name}`, at(0))
    let h: Heard
    try {
      h = await listen(deps.ffmpeg, path, deps.signal)
    } catch (err) {
      return { ok: false, message: `I couldn't read ${name}. ${message(err)}` }
    }
    if (h.durationSec <= 0) return { ok: false, message: `${name} has no sound for me to line up.` }
    let transcript: Transcript
    try {
      transcript = await deps.transcribe(path, h.durationSec, (stage, p) =>
        progress(/^Downloading/.test(stage) ? stage : `Transcribing ${name}`, at(0.1 + 0.9 * (p / 100)))
      )
    } catch (err) {
      return { ok: false, message: `I couldn't transcribe ${name}. ${message(err)}` }
    }
    heard.push({ path, heard: h, transcript })
  }

  progress('Lining them up', 95)
  const recs = heard.slice(0, -1)
  const fin = heard[heard.length - 1]
  const breaths: Record<string, FoundBreath[]> = {}
  const recordings: RecordingInput[] = recs.map((r, i) => {
    const id = `s${i + 1}`
    // The same words an edit would have: from the transcript, snapped to the sound.
    const words = snapWords(wordsFromTranscript(r.transcript.words, id, `${id}w`), r.heard.envelope)
    breaths[id] = findBreaths(words, r.heard.envelope, r.heard.features)
    return { id, name: basename(r.path), durationSec: r.heard.durationSec, words, features: r.heard.features }
  })
  const alignment = alignPair(recordings, {
    name: basename(fin.path),
    durationSec: fin.heard.durationSec,
    words: fin.transcript.words,
    features: fin.heard.features
  })
  if (!alignment.ok) return { ok: false, message: alignment.issues[0]?.text ?? 'I could not line these up.' }

  const meta = {
    id: deps.id(),
    title: basename(fin.path, extname(fin.path)),
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    recordings: await Promise.all(
      recs.map(async (r, i) => ({
        id: `s${i + 1}`,
        path: r.path,
        durationSec: r.heard.durationSec,
        ...(await stat(r.path))
      }))
    ),
    finished: { path: fin.path, durationSec: fin.heard.durationSec, ...(await stat(fin.path)) }
  }
  progress('Done', 100)
  return { ok: true, pair: buildPair(meta, recordings, alignment, breaths) }
}
