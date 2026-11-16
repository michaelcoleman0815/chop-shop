import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What an export leaves beside it for an upload, through the app's own
 * export handler with only Electron faked: the captions checked against the
 * pages the render burns in, the description from the brand's template,
 * names that never collide, a Short with no chapters, and nothing sent
 * anywhere without a key and Settings' switch.
 */

type Handler = (...args: unknown[]) => unknown

const fake = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, Handler>(),
  key: null as string | null
}))

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: {
      getPath: (name: string) => (name === 'temp' ? os.tmpdir() : path.join(fake.root, name)),
      isPackaged: false,
      getAppPath: () => process.cwd()
    },
    ipcMain: { handle: (channel: string, fn: Handler) => fake.handlers.set(channel, fn) },
    dialog: {},
    net: {
      fetch: async () => {
        throw new Error('No network in this test.')
      }
    },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
// The real probe: whether an export is a Short depends on its real shape.
vi.mock('./ffmpeg', async () => {
  const { findFfmpeg, findFfprobe } = await import('./test-media')
  const { PROBE_ARGS, readProbe } = await import('./intake')
  const cp = await import('child_process')
  const ffprobe = findFfprobe() ?? 'ffprobe'
  return {
    FFMPEG_PATH: findFfmpeg() ?? 'ffmpeg',
    FFPROBE_PATH: ffprobe,
    probe: async (p: string) => {
      const r = readProbe(JSON.parse(cp.execFileSync(ffprobe, [...PROBE_ARGS, p]).toString()))
      return { durationSec: r.durationSec, width: r.width, height: r.height, fps: r.fps, facts: r }
    }
  }
})
vi.mock('./transcribe', () => ({ hasModel: () => true, downloadModel: async () => '/m', transcribe: async () => ({ words: [] }) }))
vi.mock('./analysis-cache', () => ({ readAnalysis: async () => null }))
// The Anthropic key as the keychain would give it: none, unless a test sets one.
vi.mock('./apikey', () => ({
  readApiKey: () => fake.key,
  hasApiKey: () => fake.key !== null,
  setApiKey: () => undefined,
  clearApiKey: () => undefined,
  currentProvider: () => 'anthropic'
}))

import { registerCutalongIpc } from './cutalong'
import { saveSettings } from './store'
import { saveBrands, readBrands } from './brand-store'
import { renderCut, captionStyleFor } from './cut-render'
import { renderCutMotion, sceneForCut, subtitlePass } from './motion-render'
import { drawnCues, exportCues, writeUploadKit } from './upload-kit'
import { freePath } from './export-paths'
import { MODEL } from './planner'
import { FONTS_DIR } from './resources'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc, type Op } from '../shared/edit'
import { readCues, type Cue, type UploadKit } from '../shared/upload'
import { findFfmpeg, makeColourClip } from './test-media'

const FFMPEG = findFfmpeg()

const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const fn = fake.handlers.get(channel)
  if (!fn) throw new Error(`No handler for ${channel}`)
  return (await fn({ sender: {} }, ...args)) as T
}

type Rendered =
  | { ok: true; outputPath: string; upload: UploadKit | null; chaptersPath: string | null; creditsPath: string | null }
  | { ok: false; message: string }

/** Words said, with a pause of 1.2 s after the first sentence: a stretch with no caption on screen. */
const SAID =
  'Most people never look at this. | The camera is the real upgrade here, and the battery lasts two whole days. It is brighter outside too.'

function wordsFor(text: string, start = 0.4): { text: string; startSec: number; endSec: number }[] {
  const out: { text: string; startSec: number; endSec: number }[] = []
  let t = start
  for (const w of text.split(' ')) {
    if (w === '|') {
      t += 1.2
      continue
    }
    out.push({ text: w, startSec: t, endSec: t + 0.28 })
    t += 0.36
  }
  return out
}

/** A doc over a recording, with ops on its one version. */
function docOver(path: string, durationSec: number, size: [number, number], said: string, ops: Op[] = []): EditDoc {
  const source = { id: 's1', path, durationSec, width: size[0], height: size[1], fps: 30 }
  const base = createDoc({ id: `d-${Math.random().toString(36).slice(2)}`, title: 'My talk', source, words: wordsFromTranscript(wordsFor(said), 's1') })
  const r = applyOps(currentCut(base), ops, { words: base.words, sources: base.sources, assets: base.assets })
  expect(r.rejected).toEqual([])
  return { ...base, versions: [{ ...base.versions[0], cut: r.cut }] }
}

/** A subtitle file's events as pages: consecutive events showing the same words are one page on screen. */
function assPages(ass: string): Cue[] {
  const time = (t: string): number => {
    const [h, m, s] = t.split(':')
    return Number(h) * 3600 + Number(m) * 60 + Number(s)
  }
  const pages: Cue[] = []
  for (const line of ass.split('\n').filter((l) => l.startsWith('Dialogue:'))) {
    const parts = line.slice('Dialogue:'.length).split(',')
    const text = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').trim()
    const start = time(parts[1])
    const end = time(parts[2])
    const last = pages[pages.length - 1]
    if (last && last.text === text && start <= last.end + 1e-6) last.end = Math.max(last.end, end)
    else pages.push({ start, end, text })
  }
  return pages
}

/** How much of the caption band of a frame is bright: text, where the picture under it is red. */
function ink(ffmpeg: string, path: string, t: number): number {
  const r = spawnSync(
    ffmpeg,
    ['-hide_banner', '-v', 'error', '-ss', t.toFixed(3), '-i', path, '-frames:v', '1', '-vf', 'crop=iw:ih*0.5:0:ih*0.45,format=gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 64 * 1024 * 1024 }
  )
  const px = r.stdout as Buffer
  let bright = 0
  for (const v of px) if (v > 200) bright++
  return px.length ? bright / px.length : 0
}

describe.skipIf(!FFMPEG)('ready to upload', () => {
  const ffmpeg = FFMPEG as string
  let outDir = ''
  let clip = ''
  let long = ''
  const fetches: { url: string; body: string }[] = []
  const realFetch = globalThis.fetch

  beforeAll(async () => {
    fake.root = mkdtempSync(join(tmpdir(), 'cutalong-upload-'))
    for (const p of ['userData', 'videos', 'music', 'temp']) mkdirSync(join(fake.root, p), { recursive: true })
    outDir = join(fake.root, 'Exports')
    saveSettings({ outputDir: outDir, claudeWritesUpload: true })
    registerCutalongIpc({ send: () => undefined, mediaUrlFor: (p) => `media://${p}` })
    clip = makeColourClip(ffmpeg, join(fake.root, 'talk.mp4'), [{ color: 'red', hz: 440, sec: 16 }], '640x360')
    long = makeColourClip(ffmpeg, join(fake.root, 'long.mp4'), [{ color: 'red', hz: 440, sec: 40 }], '320x180')
    // A brand with its own lines around the parts made for each video.
    const list = await readBrands()
    await saveBrands({
      ...list,
      brands: [
        {
          ...list.brands[0],
          name: 'Field Notes',
          description:
            '{opening}\n\nThis video is sponsored by Acme: acme.example/fieldnotes\n\n{chapters}\n\nInstagram: @fieldnotes\n\n{credits}'
        }
      ]
    })
    // Every request anywhere goes through here, and is noted. Only the Messages API is answered.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      fetches.push({ url, body: typeof init?.body === 'string' ? init.body : '' })
      if (!/\/v1\/messages/.test(url)) throw new Error(`Nothing else may be reached: ${url}`)
      const answer = {
        titles: ['Two days on one charge', 'The real upgrade is the camera', 'Brighter outside, honestly'],
        opening: 'I lived with this phone for a week. The camera is the upgrade, and the battery lasts two days.',
        tags: ['phone review', 'battery life', 'camera test', 'two day battery', 'outdoor screen', 'smartphone', 'tech', 'upgrade']
      }
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [{ type: 'text', text: JSON.stringify(answer) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 80 }
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } }
      )
    }) as typeof fetch
  })

  afterAll(() => {
    globalThis.fetch = realFetch
    if (fake.root) rmSync(fake.root, { recursive: true, force: true })
  })

  beforeEach(() => {
    fetches.length = 0
    fake.key = null
    saveSettings({ claudeWritesUpload: true })
  })

  it('writes captions with the very pages the render burns in, to the hundredth, and they are on screen when they say', async () => {
    // A shot held for 1.5 s with nothing said in it, after the first sentence: no caption is on screen there.
    const doc = docOver(clip, 16, [640, 360], SAID, [
      { op: 'captions', set: { wordsPerScreen: 3, position: 'bottom' } },
      { op: 'insert', to: 1, beat: { source: 's1', inSec: 13, outSec: 14.5 } }
    ])
    const r = await invoke<Rendered>('cut:render', { doc, quality: 'final' })
    expect(r.ok).toBe(true)
    if (!r.ok || !r.upload) throw new Error('no export')
    const kit = r.upload
    expect(kit.files.srt).toBe(join(outDir, 'My talk v1.srt'))
    const srt = readCues(readFileSync(kit.files.srt!, 'utf8'))
    const vtt = readCues(readFileSync(kit.files.vtt!, 'utf8'))
    expect(vtt).toEqual(srt)

    // The render's own pages: the same doc through the same passes, with its work kept to read.
    const work = mkdtempSync(join(fake.root, 'work-'))
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const sources = doc.sources.map((s) => ({ ...s, hasAudio: true }))
    const motion = await renderCutMotion({
      cut,
      resolved,
      words: doc.words,
      sources,
      assets: doc.assets,
      brand: null,
      quality: 'final',
      ffmpeg,
      workDir: join(work, 'motion'),
      fontsDir: FONTS_DIR()
    })
    const pass = subtitlePass(cut, resolved, motion.scene)
    await renderCut(pass.cut, resolved, sources, {
      ffmpeg,
      outputPath: join(work, 'out.mp4'),
      workDir: work,
      quality: 'final',
      fontsDir: FONTS_DIR(),
      brand: null,
      overlays: motion.overlays,
      captionWords: pass.resolved.words
    })
    const burned = assPages(readFileSync(join(work, 'captions.ass'), 'utf8'))
    expect(burned.length).toBeGreaterThan(5)
    expect(srt.map((c) => c.text)).toEqual(burned.map((c) => c.text))
    srt.forEach((c, i) => {
      expect(c.start).toBeCloseTo(burned[i].start, 3)
      expect(c.end).toBeCloseTo(burned[i].end, 3)
    })
    // Every word said is in them, once, in order.
    expect(srt.map((c) => c.text).join(' ')).toBe(SAID.replace(' | ', ' '))

    // On screen: words in the middle of each page, none in the pause between the sentences.
    for (const c of srt) expect(ink(ffmpeg, r.outputPath, (c.start + c.end) / 2)).toBeGreaterThan(0.002)
    const gap = srt.findIndex((c, i) => i > 0 && c.start - srt[i - 1].end > 1.2)
    expect(srt[gap].text).toBe('The camera is')
    expect(ink(ffmpeg, r.outputPath, (srt[gap - 1].end + srt[gap].start) / 2)).toBe(0)
    expect(kit.captions).toEqual({ pages: srt.length, burned: true })
  }, 180000)

  it('writes the pages the graphics draw when they draw the captions', async () => {
    const doc = docOver(clip, 16, [640, 360], SAID, [{ op: 'captions', set: { preset: 'hierarchy' } }])
    const r = await invoke<Rendered>('cut:render', { doc, quality: 'final' })
    if (!r.ok || !r.upload) throw new Error('no export')
    const srt = readCues(readFileSync(r.upload.files.srt!, 'utf8'))
    const cut = currentCut(doc)
    const scene = sceneForCut({ cut, resolved: resolveCut(cut, doc.words, doc.sources), words: doc.words, sources: doc.sources, brand: null })
    const drawn = drawnCues(scene)
    expect(drawn.length).toBeGreaterThan(2)
    expect(srt.map((c) => c.text)).toEqual(drawn.map((c) => c.text))
    srt.forEach((c, i) => {
      expect(c.start).toBeCloseTo(drawn[i].start, 3)
      expect(c.end).toBeCloseTo(drawn[i].end, 3)
    })
    // Drawn as said, without the full stops the graphics leave off.
    expect(srt[0].text).toBe('Most people never look at this')
    // Words fade up as they are said, so by the middle of each page most of it is on screen.
    for (const c of srt) expect(ink(ffmpeg, r.outputPath, (c.start + c.end) / 2)).toBeGreaterThan(0.0005)
  }, 180000)

  it('writes the description from the brand’s template, with chapters and credits, and the titles and tags', async () => {
    const said = Array.from({ length: 6 }, (_, k) => `Part ${k + 1} is about the battery and the camera. It holds up well every day.`).join(' | ')
    const doc0 = docOver(long, 40, [320, 180], said)
    const beats = currentCut(doc0).beats
    const doc = {
      ...doc0,
      assets: [
        {
          id: 'a1',
          kind: 'video' as const,
          path: clip,
          title: 'City at night, 4K',
          durationSec: 9,
          width: 640,
          height: 360,
          origin: { type: 'video' as const, url: 'https://www.youtube.com/watch?v=a1', author: 'Nightfilm', license: null, range: { startSec: 30, endSec: 38 } }
        }
      ]
    }
    const ops: Op[] = [
      { op: 'chapters', set: [{ beat: beats[0].id, title: 'Battery' }, { beat: beats[4].id, title: 'Camera' }, { beat: beats[8].id, title: 'Every day' }] },
      { op: 'treat', beats: [beats[2].id], set: { frame: 'broll', broll: { path: clip, inSec: 0, muted: true } } }
    ]
    const r0 = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources, assets: doc.assets })
    expect(r0.rejected).toEqual([])
    const withAll: EditDoc = { ...doc, versions: [{ ...doc.versions[0], cut: r0.cut }] }
    const r = await invoke<Rendered>('cut:render', { doc: withAll, quality: 'final' })
    if (!r.ok || !r.upload) throw new Error('no export')
    const description = readFileSync(r.upload.files.description, 'utf8')
    expect(description.split('\n\n')[1]).toBe('This video is sponsored by Acme: acme.example/fieldnotes')
    expect(description).toContain('0:00 Battery\n')
    expect(description).toMatch(/\n\d:\d\d Camera\n\d:\d\d Every day\n/)
    expect(description).toContain('Instagram: @fieldnotes')
    expect(description.trim().endsWith('Credits\n- City at night, 4K · Nightfilm · https://www.youtube.com/watch?v=a1 · 0:30-0:38')).toBe(true)
    expect(r.upload.chapters).toBe(3)
    expect(r.chaptersPath).not.toBeNull()
    const titles = readFileSync(r.upload.files.titles, 'utf8')
    expect(titles.startsWith('Titles\n- ')).toBe(true)
    expect(r.upload.titles).toHaveLength(3)
    // A talk this repetitive has few words to tag; each comes once, and never more than 15.
    expect(new Set(r.upload.tags.map((t) => t.toLowerCase())).size).toBe(r.upload.tags.length)
    expect(r.upload.tags.length).toBeLessThanOrEqual(15)
    expect(r.upload.tags.map((t) => t.toLowerCase())).toEqual(expect.arrayContaining(['battery', 'camera']))
    expect(titles).toContain(r.upload.tags.join(', '))
  }, 240000)

  it('gives a Short no chapters', async () => {
    const said = Array.from({ length: 6 }, (_, k) => `Part ${k + 1} is about the battery and the camera. It holds up well every day.`).join(' | ')
    const doc = docOver(long, 40, [320, 180], said, [{ op: 'aspect', aspect: 'vertical' }])
    const beats = currentCut(doc).beats
    const r0 = applyOps(currentCut(doc), [{ op: 'chapters', set: [{ beat: beats[0].id, title: 'Battery' }, { beat: beats[4].id, title: 'Camera' }, { beat: beats[8].id, title: 'Every day' }] }], { words: doc.words, sources: doc.sources })
    const cut = r0.cut
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const scene = sceneForCut({ cut, resolved, words: doc.words, sources: doc.sources, brand: null })
    const dir = mkdtempSync(join(fake.root, 'short-'))
    const outputPath = join(dir, 'Short v2.mp4')
    const kit = await writeUploadKit({
      doc: { ...doc, versions: [{ ...doc.versions[0], cut }] },
      cut,
      resolved,
      pass: subtitlePass(cut, resolved, scene),
      scene,
      brand: (await readBrands()).brands[0],
      outputPath,
      width: 1080,
      height: 1920,
      durationSec: resolved.durationSec,
      write: null,
      why: 'no-key'
    })
    expect(kit.short).toBe(true)
    expect(kit.chapters).toBe(0)
    const description = readFileSync(kit.files.description, 'utf8')
    expect(description).not.toMatch(/\d:\d\d (Battery|Camera)/)
    // The same edit, wide, does get them.
    const wide = await writeUploadKit({
      doc: { ...doc, versions: [{ ...doc.versions[0], cut: { ...cut, aspect: 'wide' } }] },
      cut: { ...cut, aspect: 'wide' },
      resolved,
      pass: subtitlePass(cut, resolved, scene),
      scene,
      brand: (await readBrands()).brands[0],
      outputPath: join(dir, 'Wide v2.mp4'),
      width: 1920,
      height: 1080,
      durationSec: resolved.durationSec,
      write: null,
      why: 'no-key'
    })
    expect(wide.chapters).toBe(3)
  }, 60000)

  it('never names a file beside an export after one already there, and leaves older exports as they were', async () => {
    // An earlier export of the same version whose video was moved, its other files left behind.
    mkdirSync(outDir, { recursive: true })
    const old = { srt: join(outDir, 'Old talk v1.srt'), description: join(outDir, 'Old talk v1 description.txt') }
    writeFileSync(old.srt, 'an earlier export\n')
    writeFileSync(old.description, 'an earlier description\n')
    const before = Object.values(old).map((p) => [readFileSync(p, 'utf8'), statSync(p).mtimeMs])
    const doc = { ...docOver(clip, 16, [640, 360], SAID), title: 'Old talk' }
    const [a, b] = await Promise.all([
      invoke<Rendered>('cut:render', { doc, quality: 'final' }),
      invoke<Rendered>('cut:render', { doc, quality: 'final' })
    ])
    if (!a.ok || !b.ok) throw new Error('no export')
    const names = [a.outputPath, b.outputPath].map((p) => p.split('/').pop()).sort()
    expect(names).toEqual(['Old talk v1 (2).mp4', 'Old talk v1 (3).mp4'])
    for (const r of [a, b]) {
      const base = r.outputPath.replace(/\.mp4$/, '')
      expect(r.upload?.files).toEqual({
        srt: `${base}.srt`,
        vtt: `${base}.vtt`,
        description: `${base} description.txt`,
        titles: `${base} titles and tags.txt`
      })
      for (const f of Object.values(r.upload!.files)) expect(existsSync(f!)).toBe(true)
    }
    expect(Object.values(old).map((p) => [readFileSync(p, 'utf8'), statSync(p).mtimeMs])).toEqual(before)
    // And the names are taken the same way for anything: one already there moves the next along.
    expect(await freePath(outDir, 'Old talk v1', '.mp4', ['.srt'])).toBe(join(outDir, 'Old talk v1 (4).mp4'))
  }, 180000)

  describe('nothing is sent anywhere without a key and the switch', () => {
    const doc = (): EditDoc => docOver(clip, 16, [640, 360], SAID)

    it('without a key: no request at all, and they are made on this computer', async () => {
      const r = await invoke<Rendered>('cut:render', { doc: doc(), quality: 'final' })
      if (!r.ok || !r.upload) throw new Error('no export')
      expect(fetches).toEqual([])
      expect(r.upload.by).toBe('local')
      expect(r.upload.why).toBe('no-key')
      expect(r.upload.titles).toHaveLength(3)
    }, 120000)

    it('with a key and the switch off: no request at all', async () => {
      fake.key = 'sk-ant-test-key'
      saveSettings({ claudeWritesUpload: false })
      const r = await invoke<Rendered>('cut:render', { doc: doc(), quality: 'final' })
      if (!r.ok || !r.upload) throw new Error('no export')
      expect(fetches).toEqual([])
      expect(r.upload.why).toBe('off')
    }, 120000)

    it('with a key and the switch on: one request, to Claude, with the words and nothing else of the footage', async () => {
      fake.key = 'sk-ant-test-key'
      const d = doc()
      const r = await invoke<Rendered>('cut:render', { doc: d, quality: 'final' })
      if (!r.ok || !r.upload) throw new Error('no export')
      expect(fetches).toHaveLength(1)
      expect(fetches[0].url).toMatch(/\/v1\/messages/)
      const body = JSON.parse(fetches[0].body) as Record<string, unknown> & {
        system: { text: string; cache_control?: unknown }[]
        messages: { content: { text: string }[] }[]
        output_config: { format: { type: string } }
      }
      expect(body.model).toBe(MODEL)
      expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' })
      expect(body.output_config.format.type).toBe('json_schema')
      const sent = body.messages[0].content.map((c) => c.text).join('\n')
      expect(sent).toContain(SAID.replace(' | ', ' '))
      expect(sent).toContain('<brand name="Field Notes">')
      // No file of the person's, no path, no picture.
      expect(fetches[0].body).not.toContain(clip)
      expect(fetches[0].body).not.toContain('"image"')
      expect(r.upload.by).toBe('claude')
      expect(r.upload.titles[0]).toBe('Two days on one charge')
      expect(r.upload.tags).toContain('battery life')
      expect(r.upload.tags.length).toBeGreaterThanOrEqual(10)
      expect(readFileSync(r.upload.files.description, 'utf8').startsWith('I lived with this phone for a week.')).toBe(true)
    }, 120000)
  })

  it('reads the subtitles of a cut whose captions are off as captions for viewers to turn on', () => {
    const doc = docOver(clip, 16, [640, 360], SAID, [{ op: 'captions', set: { on: false } }])
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const scene = sceneForCut({ cut, resolved, words: doc.words, sources: doc.sources, brand: null })
    const cues = exportCues({ cut, pass: subtitlePass(cut, resolved, scene), scene, width: 640 })
    expect(cues.burned).toBe(false)
    expect(cues.cues.length).toBeGreaterThan(5)
    expect(captionStyleFor(cut.captions, 640).wordsPerGroup).toBe(cut.captions.wordsPerScreen)
  })
})
