import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * A vlog made the way the app makes it (main/vlog), on a planted shoot:
 * every clip watched and cached, only the talking clips heard, a track
 * dropped with the clips put under it, the story told by the rules when
 * there is no key and no model on this Mac, the next clips taken in as one
 * version, and a story asked of told again. Only Electron and the hearing of
 * words are stand-ins, and nothing may leave the Mac.
 */

const fake = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: {
      getPath: (name: string) => (name === 'temp' ? os.tmpdir() : fake.userData),
      isPackaged: false,
      getAppPath: () => fake.userData
    },
    ipcMain: { handle: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./ffmpeg', async () => {
  const { findFfmpeg } = await import('./test-media')
  const { findFfprobe } = await import('./vlog-fixtures')
  return { FFMPEG_PATH: findFfmpeg() ?? 'ffmpeg', FFPROBE_PATH: findFfprobe() ?? 'ffprobe' }
})

import { findFfmpeg } from './test-media'
import { findFfprobe, makeShoot, smallShoot, talkWords, type PlannedClip, type ShootTruth } from './vlog-fixtures'
import { makeVlog, planVlog, type TalkHeard } from './vlog'
import { applyOps } from '../shared/edit/ops'
import { currentCut, currentVersion, resolveCut, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { FIXTURES } from './learn-fixtures'
import { saveSettings } from './store'

const ffmpeg = findFfmpeg()
const ffprobe = findFfprobe()
const dir = mkdtempSync(join(tmpdir(), 'vlog-run-'))
let truth: ShootTruth
let more: ShootTruth
const sent: string[] = []
const heardFiles: string[] = []

/** Hears a talking clip as the talking-head reader would: its planted words, as source s{n}. */
async function readTalking(path: string, n: number): Promise<TalkHeard> {
  heardFiles.push(path)
  const clip = [...truth.clips, ...(more?.clips ?? [])].find((c) => c.path === path)
  const said = (clip && (truth.words.get(clip.name) ?? more?.words.get(clip.name))) || []
  return {
    source: { id: `s${n}`, path, durationSec: clip?.sec ?? 1, width: 384, height: 216, fps: 30, audio: null },
    words: wordsFromTranscript(said, `s${n}`, `s${n}w`),
    notes: []
  }
}
const deps = { readTalking, mediaUrlFor: (p: string) => `media://${p}` }

beforeAll(async () => {
  fake.userData = mkdtempSync(join(tmpdir(), 'vlog-run-data-'))
  delete process.env.ANTHROPIC_API_KEY
  // Anything sent anywhere is seen here; Ollama is not running.
  vi.stubGlobal('fetch', async (url: string) => {
    sent.push(String(url))
    throw new TypeError('fetch failed')
  })
  if (!ffmpeg || !ffprobe) return
  truth = await makeShoot(ffmpeg, dir, smallShoot())
  // A track to cut to, and a voice memo that is not one.
  const bed = join(dir, 'bed.m4a')
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='0.6*sin(2*PI*55*t)*exp(-12*mod(t,0.5))+0.05*sin(2*PI*880*t)':s=48000:d=60",
    '-c:a',
    'aac',
    bed
  ])
  const memo = join(dir, 'memo.m4a')
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-t',
    '20',
    '-i',
    join(FIXTURES, 'talk.m4a'),
    '-c',
    'copy',
    memo
  ])
  writeFileSync(join(dir, 'broken.MOV'), 'not a video')
  const later: PlannedClip[] = [
    { name: 'IMG_0160.MOV', place: 'park', minute: 1500, sec: 5, variant: 3, sound: 'wind', camera: 'iphone' },
    { name: 'IMG_0161.MOV', place: 'park', minute: 1502, sec: 6, variant: 4, sound: 'wind', camera: 'iphone' }
  ]
  const next = join(dir, 'next')
  execFileSync('mkdir', ['-p', next])
  more = await makeShoot(ffmpeg, next, later)
}, 180_000)

afterAll(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
  rmSync(fake.userData, { recursive: true, force: true })
})

const length = (doc: EditDoc): number => resolveCut(currentCut(doc), doc.words, doc.sources).durationSec

describe.skipIf(!ffmpeg || !ffprobe)('a vlog made the way the app makes it', () => {
  let v1: EditDoc

  it('watches every clip, hears only the talking, and tells the day by the rules', async () => {
    const stages: string[] = []
    const paths = [
      ...truth.clips.map((c) => c.path),
      join(dir, 'bed.m4a'),
      join(dir, 'memo.m4a'),
      join(dir, 'broken.MOV')
    ]
    const r = await makeVlog({ paths, request: 'make a vlog' }, deps, (stage) => stages.push(stage))
    if (!r.ok) throw new Error(r.message)
    v1 = r.doc
    expect(stages).toContain(`Watching your clips (${paths.length} of ${paths.length})`)
    expect(stages).toContain('Listening to what you said (2 of 2)')
    expect(stages.at(-1)).toBe('Ready')
    // Only the two talking clips are heard.
    const talking = truth.clips.filter((c) => typeof c.sound === 'object').map((c) => c.path)
    expect(heardFiles.sort()).toEqual(talking.sort())
    expect(v1.profile).toBe('vlog')
    expect(v1.vlog?.clips).toHaveLength(truth.clips.length)
    expect(v1.vlog?.story.by).toBe('rules')
    expect(v1.vlog?.described.by).toBe('measurements')
    expect(currentVersion(v1).n).toBe(1)
    expect(r.reply.text).toMatch(/^v1 is a \d+:\d\d vlog of your day in [56] scenes\. It opens on /)
    // The track is the bed; the memo and the broken file are said, not used.
    expect(currentCut(v1).music?.path).toBe(join(dir, 'bed.m4a'))
    expect(currentCut(v1).music?.beats?.length).toBeGreaterThan(50)
    expect(r.reply.aside).toContain('memo.m4a is a sound recording, not music, so I left it out')
    expect(r.reply.aside).toContain("I couldn't open broken.MOV, so it is not in the story.")
    expect(r.mediaUrl.startsWith('media://')).toBe(true)
    // Each clip's measurements are kept by file, so the next time it is not watched again.
    expect(readdirSync(join(fake.userData, 'vlog')).filter((f) => f.endsWith('.json')).length).toBeGreaterThanOrEqual(
      truth.clips.length
    )
    // Nothing went anywhere but to see whether Ollama is running on this Mac.
    expect(sent.every((u) => u.startsWith('http://127.0.0.1:11434/'))).toBe(true)
  }, 180_000)

  it('takes the next clips in as one new version, keeping the clips and words it had', async () => {
    heardFiles.length = 0
    const stages: string[] = []
    const r = await makeVlog({ paths: more.clips.map((c) => c.path), request: '', doc: v1 }, deps, (stage) =>
      stages.push(stage)
    )
    if (!r.ok) throw new Error(r.message)
    expect(currentVersion(r.doc).n).toBe(2)
    expect(r.doc.versions[0]).toEqual(v1.versions[0])
    expect(r.doc.sources.slice(0, v1.sources.length)).toEqual(v1.sources)
    expect(r.doc.words.filter((w) => v1.words.some((x) => x.id === w.id))).toHaveLength(v1.words.length)
    expect(r.doc.vlog?.clips).toHaveLength(truth.clips.length + 2)
    expect(r.doc.vlog?.told?.map((t) => t.n)).toEqual([1, 2])
    expect(r.reply.lead).toMatch(/^v2 is ready, with your 2 new clips\./)
    // The talking was heard before, and is not heard again.
    expect(heardFiles).toEqual([])
    expect(existsSync(join(fake.userData, 'vlog'))).toBe(true)
  }, 120_000)

  it('tells the story again for a length asked for, as ops for a new version', async () => {
    const r = await planVlog({ doc: v1, request: 'make it 20 seconds' })
    if (!r.ok) throw new Error(r.message)
    const cut = applyOps(currentCut(v1), r.ops, { words: v1.words, sources: v1.sources }).cut
    const len = resolveCut(cut, v1.words, v1.sources).durationSec
    expect(Math.abs(len - 20)).toBeLessThanOrEqual(1)
    expect(r.vlog.story).toMatchObject({ targetSec: 20, lengthAsked: true })
    expect(r.reply.lead).toMatch(new RegExp(`^v2 is ready\\. It runs 0:20 now, down from ${'\\d+:\\d\\d'}\\.$`))
    expect(length(v1)).toBeGreaterThan(20)
    const vertical = await planVlog({ doc: v1, request: 'make it vertical' })
    if (!vertical.ok) throw new Error(vertical.message)
    expect(vertical.ops.at(-1)).toEqual({ op: 'aspect', aspect: 'vertical' })
    expect(vertical.reply.text).toMatch(/^v2 is ready\. It is vertical now, 9:16\. /)
    expect(await planVlog({ doc: { ...v1, vlog: undefined }, request: 'shorter' })).toEqual({
      ok: false,
      message: 'This edit was not cut from a shoot, so it has no story to change.'
    })
  })

  it('says so when there is nothing to watch', async () => {
    const r = await makeVlog({ paths: [join(dir, 'memo.m4a')], request: '' }, deps, () => undefined)
    expect(r).toEqual({ ok: false, message: 'None of those has a picture I could read.' })
    expect(talkWords().length).toBeGreaterThan(0)
  })

  it('says why a track dropped into a vlog with music is not used', async () => {
    const r = await makeVlog({ paths: [join(dir, 'bed.m4a')], request: '', doc: v1 }, deps, () => undefined)
    if (!r.ok) throw new Error(r.message)
    expect(r.reply.aside).toContain('It has music under it already, so bed.m4a is not in it. /music changes the track.')
  }, 60_000)

  it('says whose story it is when the model picked to plan edits is not running', async () => {
    saveSettings({ localPlanner: 'local-8b' })
    try {
      const r = await planVlog({ doc: v1, request: 'make it 20 seconds' })
      if (!r.ok) throw new Error(r.message)
      expect(r.by).toBe('rules')
      expect(r.reply.aside).toContain('local-8b is not running on this Mac, so I told the story by its rules.')
    } finally {
      saveSettings({ localPlanner: null })
    }
  })
})
