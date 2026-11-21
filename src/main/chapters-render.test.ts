import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { chaptersReply } from '../shared/presets'
import { renderCut, type RenderSource } from './cut-render'
import { findFfmpeg, makeBurstClip } from './test-media'

const FFMPEG = findFfmpeg()

/** Four sentences eleven seconds apart, so each can start a chapter YouTube would show. */
const SAID = [0, 1, 2, 3].flatMap((k) =>
  ['Part', `${k + 1}`, 'starts', 'here.'].map((text, i) => ({
    text,
    startSec: 0.5 + k * 11 + i * 0.5,
    endSec: 0.5 + k * 11 + i * 0.5 + 0.4
  }))
)

describe.skipIf(!FFMPEG)('rendering chapters', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let sources: RenderSource[]

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-chapters-'))
    const path = makeBurstClip(ffmpeg, join(dir, 'talk.mp4'), SAID, 46)
    const source = { id: 's1', path, durationSec: 46, width: 320, height: 180, fps: 30 }
    sources = [{ ...source, hasAudio: true }]
    doc = createDoc({ id: 'd', title: 'Parts', source, words: wordsFromTranscript(SAID, 's1') })
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('writes the chapters into the video, at the times the description gives', async () => {
    // Four held shots of eleven seconds each, so every chapter runs long enough for YouTube.
    const ctx = { words: doc.words, sources: doc.sources }
    const shots = applyOps(
      currentCut(doc),
      [
        { op: 'remove', beats: currentCut(doc).beats.map((b) => b.id) },
        ...[0, 1, 2, 3].map((k) => ({
          op: 'insert' as const,
          to: k,
          beat: { source: 's1', inSec: k * 11, outSec: k * 11 + 11 }
        })),
        { op: 'aspect', aspect: 'original' },
        { op: 'loudness', lufs: null }
      ],
      ctx
    )
    expect(shots.rejected).toEqual([])
    const r = applyOps(
      shots.cut,
      [{ op: 'chapters', set: shots.cut.beats.map((b, i) => ({ beat: b.id, title: `Part ${i + 1}` })) }],
      ctx
    )
    expect(r.rejected).toEqual([])
    const resolved = resolveCut(r.cut, doc.words, doc.sources)
    const out = await renderCut(r.cut, resolved, sources, {
      ffmpeg,
      outputPath: join(dir, 'parts.mp4'),
      workDir: join(dir, 'work'),
      quality: 'preview'
    })
    // What a player reads back from the file.
    const meta = spawnSync(ffmpeg, ['-hide_banner', '-i', out, '-f', 'ffmetadata', '-'], { encoding: 'utf8' }).stdout
    const chapters = [...meta.matchAll(/\[CHAPTER\]\nTIMEBASE=1\/1000\nSTART=(\d+)\nEND=(\d+)\ntitle=(.*)/g)].map(
      (m) => ({ start: Number(m[1]) / 1000, end: Number(m[2]) / 1000, title: m[3] })
    )
    const reply = chaptersReply(r.cut, resolved)
    expect(reply.shows).toBe(true)
    const lines = reply.lines.split('\n')
    expect(chapters.map((c) => c.title)).toEqual(['Part 1', 'Part 2', 'Part 3', 'Part 4'])
    expect(chapters[0].start).toBe(0)
    chapters.slice(1).forEach((c, i) => {
      const beat = resolved.beats[i + 1]
      expect(Math.abs(c.start - beat.outStart), c.title).toBeLessThan(0.002)
      // The description's line for it says the same second.
      expect(lines[i + 1]).toBe(`0:${String(Math.floor(beat.outStart)).padStart(2, '0')} ${c.title}`)
    })
    expect(Math.abs(chapters[3].end - resolved.durationSec)).toBeLessThan(0.002)
  })
})
