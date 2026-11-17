import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * An export whose ffmpeg is killed partway, through the app's own IPC
 * handler: as the system does when it runs short of memory, with SIGKILL and
 * no line of ffmpeg's own about it. One was seen under heavy load, during
 * Export all of /clipping's clips: the killed clip's name sat in the export
 * folder all the while it rendered, and was left there, empty, when the app
 * went too. Nothing of a render that does not finish is ever in the export
 * folder, and the reply says what happened in a sentence, with ffmpeg's lines
 * behind Details.
 */

type Handler = (...args: unknown[]) => unknown

const fake = vi.hoisted(() => ({ root: '', handlers: new Map<string, Handler>() }))

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
    net: { fetch: async () => { throw new Error('No network in this test.') } },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./ffmpeg', async () => {
  const os = await import('os')
  const path = await import('path')
  const { findFfprobe } = await import('./test-media')
  return {
    // ffmpeg, through a stand-in that kills the render the test points at.
    FFMPEG_PATH: path.join(os.tmpdir(), `cutalong-killing-ffmpeg-${process.pid}.sh`),
    FFPROBE_PATH: findFfprobe() ?? 'ffprobe',
    probe: async () => ({ durationSec: 6, width: 1080, height: 1920, fps: 30 })
  }
})
vi.mock('./transcribe', () => ({ hasModel: () => true, downloadModel: async () => '/m', transcribe: async () => ({ words: [] }) }))
vi.mock('./analysis-cache', () => ({ readAnalysis: async () => null }))

import { FFMPEG_PATH } from './ffmpeg'
import { registerCutalongIpc } from './cutalong'
import { saveSettings } from './store'
import { findFfmpeg, makeColourClip } from './test-media'
import { clipDoc, CLIP_PROFILES, exportAllFailed, exportNote, type Clip } from '../shared/clipping'
import { renderFailure, toolSaid } from '../shared/failure'
import { runRender } from './cut-render'
import type { EditDoc } from '../shared/edit'

const REAL = findFfmpeg()

/**
 * ffmpeg, and the Nth render that writes an .mp4 killed once it has started
 * writing: what the export folder holds at that moment is noted, then ffmpeg
 * and this script are sent the signal, so the app sees ffmpeg stopped by it.
 */
const KILLING = `#!/bin/sh
real="$CUTALONG_TEST_FFMPEG"
last=""; for a in "$@"; do last="$a"; done
case "$last" in *.mp4) ;; *) exec "$real" "$@" ;; esac
case " $* " in *" -progress "*) ;; *) exec "$real" "$@" ;; esac
n=$(cat "$CUTALONG_TEST_COUNT" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$CUTALONG_TEST_COUNT"
[ "$n" = "\${CUTALONG_TEST_KILL_AT:-0}" ] || exec "$real" "$@"
"$real" "$@" &
child=$!
i=0
while [ ! -s "$last" ] && [ "$i" -lt 600 ]; do sleep 0.05; i=$((i + 1)); done
ls -A "$CUTALONG_TEST_EXPORTS" > "$CUTALONG_TEST_SEEN" 2>/dev/null
kill -"\${CUTALONG_TEST_SIGNAL:-KILL}" "$child"
kill -"\${CUTALONG_TEST_SIGNAL:-KILL}" $$
`

const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const fn = fake.handlers.get(channel)
  if (!fn) throw new Error(`No handler for ${channel}`)
  return (await fn({ sender: {} }, ...args)) as T
}

type Rendered =
  | { ok: true; outputPath: string }
  | { ok: false; message: string; details?: { label: string; value: string }[] }

const MEMORY =
  'The renderer was stopped before it finished, perhaps because the Mac ran short of memory, so nothing was saved.'

describe.skipIf(!REAL)('an export whose renderer is killed partway', () => {
  let outDir = ''
  let grace: EditDoc
  let home: EditDoc

  /** Kills the nth render from now with the signal. */
  const killRender = (n: number, signal: 'KILL' | 'TERM'): void => {
    rmSync(process.env.CUTALONG_TEST_COUNT as string, { force: true })
    rmSync(process.env.CUTALONG_TEST_SEEN as string, { force: true })
    process.env.CUTALONG_TEST_KILL_AT = String(n)
    process.env.CUTALONG_TEST_SIGNAL = signal
  }
  /** What the export folder held when the render was killed. */
  const seen = (): string[] =>
    readFileSync(process.env.CUTALONG_TEST_SEEN as string, 'utf8')
      .split('\n')
      .filter(Boolean)

  beforeAll(() => {
    fake.root = mkdtempSync(join(tmpdir(), 'cutalong-export-killed-'))
    for (const p of ['userData', 'videos', 'music']) mkdirSync(join(fake.root, p), { recursive: true })
    outDir = join(fake.root, 'Exports')
    saveSettings({ outputDir: outDir })
    writeFileSync(FFMPEG_PATH, KILLING)
    chmodSync(FFMPEG_PATH, 0o755)
    Object.assign(process.env, {
      CUTALONG_TEST_FFMPEG: REAL as string,
      CUTALONG_TEST_COUNT: join(fake.root, 'renders'),
      CUTALONG_TEST_SEEN: join(fake.root, 'seen'),
      CUTALONG_TEST_EXPORTS: outDir
    })
    registerCutalongIpc({ send: () => undefined, mediaUrlFor: (p) => `media://${p}` })
    // A service, as /clipping cuts it: two moments, each a vertical clip with captions.
    const long = makeColourClip(REAL as string, join(fake.root, 'Sunday service.mp4'), [
      { color: 'green', hz: 440, sec: 8 },
      { color: 'red', hz: 660, sec: 8 }
    ])
    const source = { path: long, durationSec: 16, width: 320, height: 180, fps: 30, audio: null }
    const words = (from: number) =>
      Array.from({ length: 12 }, (_, i) => ({ text: 'WORD', startSec: from + i * 0.5, endSec: from + 0.4 + i * 0.5 }))
    const clip = (id: string, title: string, from: number): EditDoc =>
      clipDoc({ id, title, source, words: words(from), profile: CLIP_PROFILES.livestream })
    grace = clip('c1', 'What grace looks like', 1)
    home = clip('c2', 'Home is not a place you earn', 9)
  })

  beforeEach(() => {
    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(outDir, { recursive: true })
  })

  afterAll(() => {
    delete process.env.CUTALONG_TEST_KILL_AT
    rmSync(FFMPEG_PATH, { force: true })
    if (fake.root) rmSync(fake.root, { recursive: true, force: true })
  })

  it('leaves nothing in the export folder, while it renders or after, and says it may have run short of memory', async () => {
    killRender(1, 'KILL')
    const r = await invoke<Rendered>('cut:render', { doc: grace, quality: 'final', name: 'What grace looks like' })
    // While ffmpeg wrote, nothing of it was in the export folder: had the app gone then too, nothing would be left.
    expect(seen()).toEqual([])
    expect(readdirSync(outDir)).toEqual([])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toBe(MEMORY)
    // What ffmpeg said, behind Details: its last lines, and that it was stopped.
    expect(r.details).toHaveLength(1)
    expect(r.details?.[0].label).toBe('What ffmpeg said')
    expect(r.details?.[0].value).toMatch(/ffmpeg was stopped by SIGKILL\.$/)
    // The editor's reply: the sentence, and the lines behind Details.
    expect(renderFailure(r)).toEqual({ text: MEMORY, details: r.details })
  }, 120000)

  it('says only that it stopped partway when another signal stopped it', async () => {
    killRender(1, 'TERM')
    const r = await invoke<Rendered>('cut:render', { doc: grace, quality: 'final', name: 'What grace looks like' })
    expect(seen()).toEqual([])
    expect(readdirSync(outDir)).toEqual([])
    expect(r).toMatchObject({ ok: false, message: 'The renderer stopped partway, so nothing was saved.' })
    if (r.ok) return
    expect(r.details?.[0].value).toMatch(/ffmpeg was stopped by SIGTERM\.$/)
  }, 120000)

  it('says what stopped it when ffmpeg was killed before it printed a line', async () => {
    const silent = join(fake.root, 'killed-at-once.sh')
    writeFileSync(silent, '#!/bin/sh\nkill -KILL $$\n')
    chmodSync(silent, 0o755)
    const failed = await runRender(silent, ['-y', join(fake.root, 'out.mp4')], 4).catch((err: unknown) => err)
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toBe(MEMORY)
    expect(toolSaid(failed)).toEqual({ tool: 'ffmpeg', said: 'ffmpeg was stopped by SIGKILL.' })
  })

  it('in Export all, goes on to the next clip, names the one killed, and leaves no file of it', async () => {
    killRender(1, 'KILL')
    // Export all, as useClipping runs it: one clip after another, each under its title.
    const clips = [
      { id: 'c1', title: 'What grace looks like', doc: grace },
      { id: 'c2', title: 'Home is not a place you earn', doc: home }
    ]
    const results: Rendered[] = []
    for (const c of clips) results.push(await invoke<Rendered>('cut:render', { doc: c.doc, quality: 'final', name: c.title }))
    expect(results.map((r) => r.ok)).toEqual([false, true])
    expect(seen()).toEqual([])
    const files = readdirSync(outDir)
    expect(files.filter((f) => f.startsWith('What grace'))).toEqual([])
    expect(files).toContain('Home is not a place you earn.mp4')
    expect(existsSync(join(outDir, 'What grace looks like.mp4'))).toBe(false)
    // What Export all says once it is done, and the killed clip's card.
    const killed = results[0]
    if (killed.ok) return
    const failure = renderFailure(killed)
    const said = exportAllFailed(2, 1, [{ title: 'What grace looks like', ...failure }])
    expect(said.text).toBe(`1 of 2 clips are exported. I couldn't export “What grace looks like”. ${MEMORY}`)
    expect(said.details?.map((d) => d.label)).toEqual(['What ffmpeg said about “What grace looks like”'])
    expect(said.details?.[0].value).toMatch(/ffmpeg was stopped by SIGKILL\.$/)
    const card = { kept: true, exported: undefined, doc: grace } as unknown as Clip
    expect(exportNote(card, { percent: null, error: failure.text })).toBe('Not exported')
  }, 180000)
})
