import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { app } from 'electron'
import { spawn, spawnSync } from 'child_process'
import { existsSync, promises as fs, readdirSync } from 'fs'
import { arch, cpus, release, tmpdir } from 'os'
import { join } from 'path'
import { FFMPEG_PATH, FFPROBE_PATH } from './ffmpeg'
import { YTDLP_PATH } from './fetch-video'
import { FONTS_DIR, resourcePath, WHISPER_PATH } from './resources'
import { detectFaces, FACE_MODEL_PATH, hasFaceFinder, VISION_PATH } from './track'
import { RELEASES_URL } from './updater'
import { makeRenderer, take } from '../shared/vision/synthetic'

/**
 * The packaged app checking itself, for the build that makes it. Started
 * with CUTALONG_SELF_CHECK naming a file, it opens no window and touches no
 * settings or projects: it runs each helper it ships the way the app runs
 * it, loads its native modules inside Electron, finds the face in a made-up
 * picture, writes what it saw to that file as JSON and quits, with 0 when
 * every part works and 1 when one does not.
 */

interface Check {
  name: string
  ok: boolean
  detail: string
}

/** Runs a helper and keeps the first lines it says. */
function said(bin: string, args: string[]): { ok: boolean; detail: string } {
  if (!existsSync(bin)) return { ok: false, detail: `missing: ${bin}` }
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(0, 6).join(' | ')
  if (r.error) return { ok: false, detail: `${bin}: ${r.error.message}` }
  return { ok: r.status === 0, detail: `${bin} (exit ${r.status}): ${out}` }
}

/** A clip of the synthetic talking face the vision tests use, made with this ffmpeg. */
async function faceClip(path: string): Promise<{ durationSec: number }> {
  const t = take({ seed: 3, words: 6 })
  const { scene } = t
  const render = makeRenderer(scene)
  const durationSec = 2
  const n = Math.round(durationSec * scene.fps)
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(FFMPEG_PATH, [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray'],
      ...['-s', `${scene.width}x${scene.height}`, '-r', String(scene.fps), '-i', '-'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path]
    ])
    let err = ''
    ff.stderr.on('data', (d) => (err += d))
    ff.on('error', reject)
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited with ${code}`))))
    for (let i = 0; i < n; i++) ff.stdin.write(Buffer.from(render(i / scene.fps)))
    ff.stdin.end()
  })
  return { durationSec }
}

async function check(name: string, run: () => Promise<string> | string): Promise<Check> {
  try {
    return { name, ok: true, detail: await run() }
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

export async function selfCheck(reportPath: string): Promise<number> {
  const checks: Check[] = []
  const add = (c: Check): void => {
    checks.push(c)
    console.log(`[self-check] ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
  }
  const bin = resourcePath('bin')

  add({
    name: 'app',
    ok: true,
    detail: [
      `Cutalong ${app.getVersion()}`,
      `Electron ${process.versions.electron}`,
      `Chrome ${process.versions.chrome}`,
      `Node ${process.versions.node}`,
      `${process.platform} ${arch()} ${release()}`,
      `${cpus().length} processors (${cpus()[0]?.model ?? 'unknown'})`,
      `packaged ${app.isPackaged}`,
      `resources ${process.resourcesPath}`,
      `exe ${app.getPath('exe')}`
    ].join('; ')
  })
  add({
    name: 'helpers folder',
    ok: existsSync(bin),
    detail: existsSync(bin) ? `${bin}: ${readdirSync(bin).join(', ')}` : `missing: ${bin}`
  })
  add({ name: 'ffmpeg', ...said(FFMPEG_PATH, ['-hide_banner', '-version']) })
  add(
    await check('ffmpeg can render what Cutalong asks of it', async () => {
      const r = spawnSync(FFMPEG_PATH, ['-hide_banner', '-filters'], { encoding: 'utf8' })
      const e = spawnSync(FFMPEG_PATH, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
      const filters = r.stdout ?? ''
      const encoders = e.stdout ?? ''
      const want = ['subtitles', 'lut3d', 'sendcmd', 'showinfo', 'loudnorm', 'ebur128', 'xfade', 'zoompan', 'overlay']
      const missing = want.filter((f) => !new RegExp(` ${f} `).test(filters))
      if (!/ libx264 /.test(encoders)) missing.push('libx264')
      if (!/ aac /.test(encoders)) missing.push('aac')
      if (missing.length) throw new Error(`this ffmpeg has no ${missing.join(', ')}`)
      return `${want.join(', ')}, libx264 and aac; zscale ${/ zscale /.test(filters) ? 'yes' : 'no'}`
    })
  )
  add({ name: 'ffprobe', ...said(FFPROBE_PATH, ['-hide_banner', '-version']) })
  add({ name: 'whisper-cli', ...said(WHISPER_PATH(), ['-h']) })
  add({ name: 'yt-dlp', ...said(YTDLP_PATH(), ['--version']) })
  if (process.platform === 'darwin') {
    add({ name: 'Vision helper', ok: existsSync(VISION_PATH()), detail: VISION_PATH() })
  }
  add(
    await check('fonts', async () => {
      const dir = FONTS_DIR()
      const files = (await fs.readdir(dir)).filter((f) => /\.(ttf|otf)$/i.test(f))
      if (files.length === 0) throw new Error(`no fonts in ${dir}`)
      return `${dir}: ${files.join(', ')}`
    })
  )
  add(
    await check('maps', async () => {
      const tiles = resourcePath('maps', 'tiles')
      if (!existsSync(join(tiles, '0', '0', '0.jpg'))) throw new Error(`no world tile in ${tiles}`)
      return tiles
    })
  )
  add(
    await check('graphics engine', async () => {
      const font = join(FONTS_DIR(), 'Sora.ttf')
      if (existsSync(font)) GlobalFonts.registerFromPath(font, 'Sora')
      const canvas = createCanvas(160, 48)
      const g = canvas.getContext('2d')
      g.fillStyle = '#ff5a36'
      g.fillRect(0, 0, 160, 48)
      g.fillStyle = '#ffffff'
      g.font = '24px Sora'
      g.fillText('Cutalong', 8, 32)
      const png = await canvas.encode('png')
      return `drew a ${png.length} byte PNG with Skia`
    })
  )
  add(
    await check('face finder', async () => {
      if (!hasFaceFinder())
        throw new Error(`no face finder: ${process.platform === 'win32' ? FACE_MODEL_PATH() : VISION_PATH()}`)
      const dir = await fs.mkdtemp(join(tmpdir(), 'cutalong-self-check-'))
      try {
        const clip = join(dir, 'face.mp4')
        const { durationSec } = await faceClip(clip)
        const started = Date.now()
        const samples = await detectFaces(clip, 0, durationSec, 2)
        const seen = samples.filter((s) => s.faces.length > 0).length
        if (samples.length === 0 || seen === 0) throw new Error(`found no face in ${samples.length} samples`)
        const f = samples.find((s) => s.faces.length > 0)?.faces[0]
        const where = f ? `x ${f.x.toFixed(2)} y ${f.y.toFixed(2)} w ${f.w.toFixed(2)}` : ''
        return `a face in ${seen} of ${samples.length} samples in ${Date.now() - started} ms, the first at ${where}`
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    })
  )
  if (process.platform === 'win32') {
    // Which copies of the C++ runtime the native modules loaded: the app's own, or one Windows had.
    add(
      await check('native libraries loaded', async () => {
        const modules = `(Get-Process -Id ${process.pid}).Modules`
        const wanted = `Where-Object { $_.ModuleName -match '^(msvcp|vcruntime|onnxruntime|skia)' }`
        const r = spawnSync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', `${modules} | ${wanted} | ForEach-Object { $_.FileName }`],
          { encoding: 'utf8', timeout: 60_000 }
        )
        const files = (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean)
        return files.length ? files.join(', ') : `none listed: ${r.stderr?.trim() || r.error?.message || 'no answer'}`
      })
    )
  }
  add(
    await check('updates', async () => {
      const file = join(process.resourcesPath, 'app-update.yml')
      if (!app.isPackaged) return 'not packaged: updates are off'
      if (!existsSync(file)) throw new Error(`no ${file}: the app could not check for updates`)
      // The feed must be the releases the app sends people to, or this copy never hears of the next one.
      const text = await fs.readFile(file, 'utf8')
      const field = (key: string): string =>
        (new RegExp(`^${key}:[ \\t]*(\\S.*)$`, 'm').exec(text)?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '')
      const feed = `${field('provider')} ${field('owner')}/${field('repo')}`
      const wanted = `github ${/github\.com\/([^/]+\/[^/]+)\//.exec(RELEASES_URL)?.[1] ?? ''}`
      if (feed !== wanted) throw new Error(`${file} reads updates from ${feed}, not ${wanted}`)
      // A signed build names its publisher, and then installs only updates signed by the same one.
      const signed = /^publisherName:/m.test(text)
      return `${file}: ${feed}, ${signed ? 'installing only updates signed as this copy is' : 'unsigned, so updates are not checked for a signature'}`
    })
  )

  const failed = checks.filter((c) => !c.ok)
  await fs.writeFile(reportPath, JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
  return failed.length === 0 ? 0 : 1
}
