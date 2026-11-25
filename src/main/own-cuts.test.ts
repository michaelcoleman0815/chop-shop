import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return { app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() }, ipcMain: { handle: () => undefined } }
})

import { createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc, type Source } from '../shared/edit'
import { FFMPEG_PATH } from './ffmpeg'
import { cutsNear, onItsOwnCuts } from './own-cuts'

/** A real little video: blue to 4.1 s, red to 8.15 s, then blue again: an edit with a cutaway in it. */
function filmed(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cutalong-own-')), 'edited.mp4')
  const clip = (color: string, sec: number): string[] => ['-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=${sec}`]
  execFileSync(FFMPEG_PATH, ['-v', 'error', '-y', ...clip('blue', 4.1), ...clip('red', 4.05), ...clip('blue', 4), '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-pix_fmt', 'yuv420p', path])
  return path
}
/** Three sentences over it, each starting a little before its shot does, the speaker on screen in the first and last. */
function edited(path: string, faces = true): EditDoc {
  const said: [string, number, number][] = [
    ['One two three four.', 0.4, 3.9],
    ['Five six seven eight.', 4.4, 7.9],
    ['Nine ten eleven twelve.', 8.5, 11.6]
  ]
  const words = said.flatMap(([text, from, to]) => text.split(' ').map((w, i, all) => ({ text: w, startSec: from + ((to - from) * i) / all.length, endSec: from + ((to - from) * (i + 1)) / all.length - 0.02 })))
  const source = {
    id: 's1', path, durationSec: 12.1, width: 320, height: 180, fps: 30,
    ...(faces ? { faces: { everySec: 1, samples: Array.from({ length: 12 }, (_, t) => ({ t, faces: t < 4 || t > 8 ? [[0.4, 0.2, 0.2, 0.4]] : [] })) } } : {})
  } as unknown as Source
  return createDoc({ id: 'd', title: 'Edited', source, words: wordsFromTranscript(words, 's1') })
}
const pieces = (doc: EditDoc) => resolveCut(currentCut(doc), doc.words, doc.sources).pieces

describe('footage that was edited already', () => {
  it('has its own cuts found where they are', async () => {
    const path = filmed()
    const [cut] = await cutsNear(FFMPEG_PATH, path, 4.2, 0.6)
    expect(cut).toBeCloseTo(4.1, 1)
    expect(await cutsNear(FFMPEG_PATH, path, 2, 0.6)).toEqual([])
  })

  it('has its beats set on those cuts, and plays straight through', async () => {
    const path = filmed()
    const before = edited(path)
    const after = await onItsOwnCuts(FFMPEG_PATH, before)
    const [a, b, c] = pieces(after)
    // Each beat starts on the cut, to the frame, and nothing between them is left out.
    expect(b.srcStart).toBeCloseTo(4.1, 1)
    expect(c.srcStart).toBeCloseTo(8.15, 1)
    expect(Math.abs(b.srcStart - a.srcEnd)).toBeLessThan(0.02)
    expect(Math.abs(c.srcStart - b.srcEnd)).toBeLessThan(0.02)
    // Still the first version, with nothing done to it yet.
    expect(after.versions).toHaveLength(1)
    expect(pieces(before)[1].srcStart).not.toBeCloseTo(4.1, 1)
  })

  it('leaves plain talk, and footage no faces were read in, as it was', async () => {
    const path = filmed()
    const blind = edited(path, false)
    expect(await onItsOwnCuts(FFMPEG_PATH, blind)).toBe(blind)
    const talk = edited(path)
    const always = { ...talk, sources: [{ ...talk.sources[0], faces: { everySec: 1, samples: Array.from({ length: 12 }, (_, t) => ({ t, faces: [[0.4, 0.2, 0.2, 0.4]] })) } }] } as unknown as EditDoc
    expect(await onItsOwnCuts(FFMPEG_PATH, always)).toBe(always)
  })
})
