import { spawn } from 'child_process'
import { existsSync } from 'fs'
import type { FacesReading } from '../shared/faces-reading'
import type { ScreenBox, ScreenReading } from '../shared/screen'
import { VISION_PATH } from './track'

/**
 * What is on screen in a recording, read on a Mac by the Vision helper (chopshop-vision --screen): its lines of
 * text and where each sits, the window the speaker is kept in and the faces in it, every couple of seconds, so the
 * planner knows a screen recording from a talking head (shared/screen) and graphics keep off faces (shared/faces). Null where there is no helper, nothing could be read,
 * or the picture never holds a page of words: a talking head carries nothing.
 */

interface RawSample {
  t: number
  lines: { text: string; x: number; y: number; w: number; h: number }[]
  faces: { x: number; y: number; w: number; h: number }[]
  windows: { x: number; y: number; w: number; h: number }[]
}

/** Readings far enough apart that a long recording is read in seconds: every 2 s up to 10 minutes, then sparser. */
export function screenEvery(durationSec: number): number {
  return durationSec <= 600 ? 2 : durationSec <= 1800 ? 5 : 10
}

const round = (v: number): number => Math.round(v * 1000) / 1000
const boxOf = (b: { x: number; y: number; w: number; h: number }): ScreenBox => [round(b.x), round(b.y), round(b.w), round(b.h)]

/** The helper's samples as a reading: a page needs a few lines, and the window is the biggest box round a face. */
export function readingOf(raw: RawSample[], everySec: number): ScreenReading | null {
  if (!raw.some((s) => s.lines.length >= 3)) return null
  return {
    everySec,
    samples: raw.slice(0, 3000).map((s) => {
      const window = [...s.windows].sort((a, b) => b.w * b.h - a.w * a.h)[0]
      return {
        t: round(s.t),
        lines: s.lines
          .filter((l) => l.text.trim())
          .slice(0, 60)
          .map((l) => ({ text: l.text.trim().slice(0, 160), box: boxOf(l) })),
        window: window ? boxOf(window) : null
      }
    })
  }
}

/** The faces found in each reading, biggest first; null when none were found at all. */
export function facesOf(raw: RawSample[], everySec: number): FacesReading | null {
  if (!raw.some((s) => s.faces.length > 0)) return null
  return {
    everySec,
    samples: raw.slice(0, 3000).map((s) => ({
      t: round(s.t),
      faces: [...s.faces]
        .sort((a, b) => b.w * b.h - a.w * a.h)
        .slice(0, 12)
        .map(boxOf)
    }))
  }
}

/** What is on screen in a recording and where the faces are, from one reading of its picture. */
export interface PictureReading {
  screen: ScreenReading | null
  faces: FacesReading | null
}

export async function readPicture(path: string, durationSec: number): Promise<PictureReading | null> {
  const bin = VISION_PATH()
  if (process.platform !== 'darwin' || !existsSync(bin) || !(durationSec > 0)) return null
  const everySec = screenEvery(durationSec)
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ['--screen', path, '0', durationSec.toFixed(3), String(1 / everySec)])
    let text = ''
    let err = ''
    child.stdout.on('data', (d) => (text += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(err.trim() || `vision exit ${code}`))))
  })
  const raw = JSON.parse(out) as RawSample[]
  return { screen: readingOf(raw, everySec), faces: facesOf(raw, everySec) }
}
