import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { trackLoudness } from '../music'
import { ffmpegRun, findFfmpeg } from '../test-media'
import { probeFile } from './files'
import { describeIndex, loadIndex, scanLibrary, searchLibrary, type LibraryIndex, type LibraryItem } from './library'
import { librarySource } from './sources/library'

/**
 * The person's own folder, indexed: a messy one made here with real media
 * of every kind the library knows, odd names, files Cutalong cannot use,
 * hidden folders, an app's library, and links that loop, break, lead out of
 * the folder and lead to the same file twice. Then scanned again, to show
 * only what changed is opened, and a hundred thousand files, to show the
 * walk stays fast and small.
 */

const FFMPEG = findFfmpeg()
const base = mkdtempSync(join(tmpdir(), 'cutalong-library-'))
const root = join(base, 'Documents')
const outside = join(base, 'outside')
const cache = join(base, 'cache')
afterAll(() => rmSync(base, { recursive: true, force: true }))

const run = (args: string[]): void => ffmpegRun(FFMPEG as string, args)
const at = (...p: string[]): string => {
  const path = join(root, ...p)
  mkdirSync(join(path, '..'), { recursive: true })
  return path
}

/** A name with a line break in it; Windows allows no control character in a name, so there it has a space. */
const ODD_NAME = process.platform === 'win32' ? 'odd name #1 %20.png' : 'odd\nname #1 %20.png'

const deps = () => ({ probe: (p: string) => probeFile(FFMPEG as string, p), loudness: (p: string) => trackLoudness(FFMPEG as string, p) })

beforeAll(() => {
  if (!FFMPEG) return
  mkdirSync(root, { recursive: true })
  mkdirSync(join(outside, 'folder'), { recursive: true })
  const alpha = 'color=c=red@0.5:s=320x180:d=1,format=rgba'
  run(['-f', 'lavfi', '-i', alpha, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', at('Overlays', 'Light Leak 4444.mov')])
  run(['-f', 'lavfi', '-i', alpha, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '200k', at('Overlays', 'subscribe button.webm')])
  run(['-f', 'lavfi', '-i', 'color=c=white@0.6:s=200x100,format=rgba', '-frames:v', '1', at('Overlays', 'sparkle.png')])
  run(['-f', 'lavfi', '-i', 'color=c=yellow@0.4:s=160x90:r=30,format=rgba', '-frames:v', '12', at('Overlays', 'glow', 'glow_%04d.png')])
  run(['-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=1', '-frames:v', '3', '-start_number', '1', at('Shots', 'photo_%03d.png')])
  run(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360', '-frames:v', '1', at('Photos', 'photo.jpg')])
  run(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-f', 'mp4', at('B-Roll', 'City at Night', 'IMG_0042.MOV')])
  run(['-f', 'lavfi', '-i', 'sine=frequency=600:duration=0.5', at('SFX', 'Whooshes', 'Big_Whoosh_FINAL_v2 (copy).wav')])
  run(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=25', '-c:a', 'libmp3lame', '-b:a', '64k', at('Music', 'Lofi Beds', 'calm bed.mp3')])
  run(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', join(outside, 'folder', 'ext.wav')])
  run(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=15', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(outside, 'outside.mp4')])
  // Odd names: other scripts, an emoji, a line break, 200 characters.
  copyFileSync(at('B-Roll', 'City at Night', 'IMG_0042.MOV'), at('Café B-roll', 'ねこ 🐈 clip.mp4'))
  copyFileSync(at('Overlays', 'sparkle.png'), at('Overlays', ODD_NAME))
  copyFileSync(at('Photos', 'photo.jpg'), at('Photos', `${'a'.repeat(200)}.jpg`))
  // Looks, fonts and animations.
  writeFileSync(at('Looks', 'Teal Orange.cube'), 'TITLE "Teal Orange"\nLUT_3D_SIZE 33\n0 0 0\n')
  copyFileSync(join(__dirname, '..', '..', '..', 'resources', 'fonts', 'Sora.ttf'), at('Fonts', 'Sora.ttf'))
  writeFileSync(at('Animations', 'confetti.json'), '{"v":"5.7.4","fr":30,"ip":0,"op":90,"w":1080,"h":1920,"nm":"confetti","ddd":0,"assets":[],"layers":[]}')
  writeFileSync(at('Animations', 'package.json'), '{"name":"not-an-animation","version":"1.0.0"}')
  // Files Cutalong knows and cannot use, and files that are nothing to an edit.
  for (const name of ['Lower Third.mogrt', 'Intro.aep', 'Edit.prproj', 'Glow.ffx', 'Glitch Pack.drfx', 'Grade.prfpset']) writeFileSync(at('Templates', name), '')
  writeFileSync(at('Paperwork', 'notes.pdf'), '%PDF-1.4')
  writeFileSync(at('Paperwork', 'taxes.docx'), '')
  // Places never walked into: an app's library, a hidden folder, node_modules.
  copyFileSync(join(outside, 'outside.mp4'), at('Old Project.fcpbundle', 'Original Media', 'clip.mp4'))
  copyFileSync(join(outside, 'outside.mp4'), at('.cache', 'hidden.mp4'))
  copyFileSync(join(outside, 'outside.mp4'), at('node_modules', 'pkg', 'demo.mp4'))
  // Links: back to the root (a loop), to nowhere, to a file and a folder outside, and to a file already here.
  symlinkSync(root, join(root, 'Loop'))
  symlinkSync(join(base, 'nowhere.mp4'), join(root, 'Broken.mp4'))
  symlinkSync(join(outside, 'outside.mp4'), join(root, 'Linked clip.mp4'))
  symlinkSync(join(outside, 'folder'), join(root, 'External'))
  symlinkSync(at('Overlays', 'Light Leak 4444.mov'), join(root, 'Again.mov'))
})

const describeMedia = FFMPEG ? describe : describe.skip

describeMedia('indexing the person’s own folder', () => {
  let index: LibraryIndex
  const item = (name: string): LibraryItem | undefined => index.items.find((i) => i.n === name || i.p.endsWith(name))

  it('finds every kind of asset, with what it measured', async () => {
    // Nothing from the library goes anywhere: a scan never touches the network.
    const net = vi.fn(() => {
      throw new Error('the library went online')
    })
    vi.stubGlobal('fetch', net)
    try {
      index = (await scanLibrary(root, { cacheDir: cache, deps: deps() })).index
    } finally {
      vi.unstubAllGlobals()
    }
    expect(net).not.toHaveBeenCalled()

    expect(item('Light Leak 4444.mov')).toMatchObject({ k: 'overlay', a: 1, c: 'prores', w: 320, h: 180 })
    expect(item('subscribe button.webm')).toMatchObject({ k: 'overlay', a: 1, c: 'vp9' })
    expect(item('sparkle.png')).toMatchObject({ k: 'overlay', a: 1, w: 200, h: 100 })
    expect(item('IMG_0042.MOV')).toMatchObject({ k: 'video', w: 320, h: 180, c: 'h264' })
    expect(item('IMG_0042.MOV')?.d).toBeCloseTo(2, 0)
    expect(item('IMG_0042.MOV')?.t).toBe('roll city night')
    expect(item('photo.jpg')).toMatchObject({ k: 'image', w: 640, h: 360 })
    const whoosh = item('Big_Whoosh_FINAL_v2 (copy).wav')
    expect(whoosh).toMatchObject({ k: 'sfx', t: 'sfx whoosh big' })
    expect(typeof whoosh?.l).toBe('number')
    expect(item('calm bed.mp3')).toMatchObject({ k: 'music' })
    expect(item('calm bed.mp3')?.l).toBeUndefined()
    expect(item('Teal Orange.cube')).toMatchObject({ k: 'lut', z: 33 })
    expect(item('Sora.ttf')).toMatchObject({ k: 'font' })
    expect(item('confetti.json')).toMatchObject({ k: 'lottie', w: 1080, h: 1920, fps: 30, f: 90, d: 3 })
    expect(item('package.json')).toBeUndefined()
  })

  it('reads twelve numbered frames as one sequence, and three as three pictures', () => {
    const glow = index.items.filter((i) => i.p.includes('glow'))
    expect(glow).toHaveLength(1)
    expect(glow[0]).toMatchObject({ k: 'overlay', f: 12, a: 1, w: 160, h: 90, n: 'glow (12 frames)' })
    expect(glow[0].p.endsWith(join('glow', 'glow_%04d.png'))).toBe(true)
    expect(index.items.filter((i) => /photo_\d{3}\.png$/.test(i.p)).map((i) => i.k)).toEqual(['image', 'image', 'image'])
  })

  it('takes odd names in its stride', () => {
    expect(item('ねこ 🐈 clip.mp4')?.k).toBe('video')
    expect(item(ODD_NAME)?.k).toBe('overlay')
    expect(item(`${'a'.repeat(200)}.jpg`)?.k).toBe('image')
  })

  it('follows links out of the folder once; one back in, a loop or a broken one is counted, never followed', () => {
    expect(item('Linked clip.mp4')?.k).toBe('video')
    expect(item('ext.wav')?.k).toBe('sfx')
    // The link to a file already in the folder: the file is indexed where it is, under its own folder's words.
    const prores = index.items.filter((i) => i.c === 'prores')
    expect(prores).toHaveLength(1)
    expect(prores[0].p).toBe(join(root, 'Overlays', 'Light Leak 4444.mov'))
    expect(index.report.linkLoops).toBe(2)
    expect(index.report.brokenLinks).toBe(1)
    expect(index.report.linksFollowed).toBe(2)
  })

  it('never walks into an app’s library, a hidden folder or node_modules', () => {
    expect(index.items.some((i) => i.p.includes('.fcpbundle') || i.p.includes('.cache') || i.p.includes('node_modules'))).toBe(false)
  })

  it('says plainly what it cannot use, and why, instead of failing', () => {
    const by = Object.fromEntries(index.unsupported.map((g) => [g.ext, g]))
    for (const ext of ['mogrt', 'aep', 'prproj', 'ffx', 'drfx', 'prfpset', 'fcpbundle']) expect(by[ext]?.count).toBe(1)
    expect(by.mogrt.why).toMatch(/only run inside Premiere Pro/)
    expect(by.aep.why).toMatch(/Render the comp to ProRes 4444/)
    expect(by.fcpbundle.what).toBe('Final Cut Pro libraries')
    expect(index.report.ignored).toBeGreaterThanOrEqual(2)
    expect(describeIndex(index)).toMatch(
      /^\d+ files: 3 clips, 5 pictures, 5 overlays, 2 sound effects, 1 music track, 1 LUT, 1 font, 1 Lottie animation\. I cannot use .*Premiere motion graphics templates \(1\)[^;]*\.$/
    )
  })

  it('is searched by the words of its folders and names', () => {
    expect(searchLibrary(index.items, 'whoosh transition')[0].item.n).toBe('Big_Whoosh_FINAL_v2 (copy).wav')
    expect(searchLibrary(index.items, 'glow', { kinds: ['overlay', 'sequence'] })[0].item.f).toBe(12)
    expect(searchLibrary(index.items, 'city night')[0].item.n).toBe('IMG_0042.MOV')
    expect(searchLibrary(index.items, 'teal orange', { kinds: ['lut'] })).toHaveLength(1)
  })

  it('scans again opening only what changed, and forgets what is gone', async () => {
    const again = await scanLibrary(root, { cacheDir: cache, deps: deps() })
    expect(again.stats.measured).toBe(0)
    expect(again.stats.reused).toBe(index.items.length)
    const whoosh = join(root, 'SFX', 'Whooshes', 'Big_Whoosh_FINAL_v2 (copy).wav')
    utimesSync(whoosh, new Date(), new Date(Date.now() + 5000))
    unlinkSync(join(root, 'Photos', 'photo.jpg'))
    const third = await scanLibrary(root, { cacheDir: cache, deps: deps() })
    expect(third.stats.measured).toBe(1)
    expect(third.index.items.some((i) => i.p.endsWith('photo.jpg') && !i.p.includes('aaaa'))).toBe(false)
    const kept = await loadIndex(cache, root)
    expect(kept?.items).toHaveLength(third.index.items.length)
    expect(kept?.unsupported.length).toBe(third.index.unsupported.length)
  })

  it('offers its files as B-roll, used where they are, a sequence made into one clip with its transparency', async () => {
    const src = librarySource({ items: () => index.items, ffmpeg: FFMPEG as string })
    const [glow] = await src.search('glow', { kinds: ['video'] })
    expect(glow).toMatchObject({ source: 'library', kind: 'video', alpha: true, license: { id: 'own' }, pageUrl: null, mediaUrl: null })
    const got = await src.fetch(glow, join(base, 'assets'))
    expect(got.asset).toMatchObject({ kind: 'video', width: 160, height: 90, origin: { type: 'file', license: null } })
    expect(got.asset.path.endsWith('.webm')).toBe(true)
    expect(got.credit).toBeNull()
    const [clip] = await src.search('city night')
    const used = await src.fetch(clip, join(base, 'assets'))
    expect(used.asset.path).toBe(join(root, 'B-Roll', 'City at Night', 'IMG_0042.MOV'))
  })
})

describe('a huge, messy Documents folder', () => {
  const count = Number(process.env.CUTALONG_LIBRARY_FILES ?? 100_000)
  const big = join(base, 'Huge')

  it(`walks ${count.toLocaleString('en-US')} files fast and small, measuring only what is media`, async () => {
    // Mostly documents, a quarter media, some JSON, in a thousand folders.
    const kinds = ['pdf', 'docx', 'txt', 'xlsx', 'zip', 'pages', 'key', 'mp4', 'jpg', 'wav', 'json', 'mov']
    let documents = 0
    for (let d = 0; d < 1000; d++) {
      const folder = join(big, `Folder ${d % 37}`, `Sub ${d}`)
      mkdirSync(folder, { recursive: true })
      for (let f = 0; f < count / 1000; f++) {
        const k = (d + f) % kinds.length
        if (k < 7) documents++
        writeFileSync(join(folder, `File ${d}-${f} final v${f % 3}.${kinds[k]}`), '')
      }
    }
    let probes = 0
    const fakeProbe = async (): Promise<null> => {
      probes++
      return null
    }
    let peak = 0
    const before = process.memoryUsage().heapUsed
    const sample = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed - before)), 20)
    const started = performance.now()
    const { index, stats } = await scanLibrary(big, { cacheDir: cache, deps: { probe: fakeProbe }, concurrency: 8 })
    const ms = performance.now() - started
    clearInterval(sample)
    peak = Math.max(peak, process.memoryUsage().heapUsed - before)
    const rate = Math.round(count / (ms / 1000))
    const report = { files: stats.files, indexed: stats.indexed, probes, ms: Math.round(ms), filesPerSec: rate, heapPeakMB: Number((peak / 1024 / 1024).toFixed(1)) }
    console.log(`[library] ${JSON.stringify(report)}`)
    expect(stats.files).toBe(count)
    // Documents are counted, never opened; media and JSON are measured.
    expect(index.report.ignored).toBe(documents)
    expect(probes).toBeLessThan(count * 0.4)
    const again = performance.now()
    const second = await scanLibrary(big, { cacheDir: cache, deps: { probe: fakeProbe }, concurrency: 8 })
    const rescan = Math.round(performance.now() - again)
    console.log(`[library] rescan ${rescan} ms, measured ${second.stats.measured}`)
    expect(second.stats.measured).toBe(0)
    expect(peak / 1024 / 1024).toBeLessThan(400)
  }, 300_000)
})
