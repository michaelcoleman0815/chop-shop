import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { findBeats, readMono, SAMPLE_RATE } from './beats'

/**
 * A music track made ready to be a bed: how long it runs, how loud it was
 * mastered, its tempo and every beat. And the person's own music, searched
 * by name. Nothing leaves the machine.
 */

export interface TrackFacts {
  durationSec: number
  lufs: number | null
  bpm: number | null
  beats: number[]
}

const AUDIO = /\.(mp3|m4a|aac|wav|aiff?|flac|ogg|opus)$/i

/** Integrated loudness of a file, from ffmpeg's EBU R128 meter; null when it cannot say. */
export function trackLoudness(ffmpeg: string, path: string, signal?: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostats', '-i', path, '-vn', '-af', 'ebur128', '-f', 'null', '-'], {
      signal
    })
    let log = ''
    child.stderr.on('data', (d) => (log = (log + d.toString()).slice(-6000)))
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const m = /I:\s+(-?\d+(?:\.\d+)?) LUFS/.exec(log.slice(log.lastIndexOf('Summary:')))
      resolve(m ? Number(m[1]) : null)
    })
  })
}

/** Everything a bed needs to know about a track. */
export async function analyzeTrack(ffmpeg: string, path: string, signal?: AbortSignal): Promise<TrackFacts> {
  const [samples, lufs] = await Promise.all([readMono(ffmpeg, path, 900, signal), trackLoudness(ffmpeg, path, signal)])
  if (samples.length === 0) throw new Error(`${basename(path)} has no sound to use.`)
  const grid = findBeats(samples)
  return {
    durationSec: samples.length / SAMPLE_RATE,
    lufs: lufs !== null && Number.isFinite(lufs) && lufs > -70 ? lufs : null,
    bpm: grid.bpm > 0 ? grid.bpm : null,
    beats: grid.beats.map((b) => Number(b.toFixed(4)))
  }
}

/**
 * Tracks in the music folders whose names hold every word asked for, best
 * matches first: a name that starts with the words, then the shortest. Looks
 * two folders deep and stops after a few thousand files.
 */
export async function findTracks(query: string, roots: string[], limit = 8): Promise<{ path: string; name: string }[]> {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const found: { path: string; name: string }[] = []
  let seen = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2 || seen > 5000) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const path = join(dir, e.name)
      if (e.isDirectory()) await walk(path, depth + 1)
      else if (AUDIO.test(e.name)) {
        seen++
        const name = basename(e.name, extname(e.name))
        const lower = name.toLowerCase()
        if (words.every((w) => lower.includes(w))) found.push({ path, name })
      }
    }
  }
  for (const root of roots) await walk(root, 0)
  const first = words[0] ?? ''
  return found
    .sort((a, b) => {
      const sa = a.name.toLowerCase().startsWith(first) ? 0 : 1
      const sb = b.name.toLowerCase().startsWith(first) ? 0 : 1
      return sa - sb || a.name.length - b.name.length
    })
    .slice(0, limit)
}
