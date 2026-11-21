#!/usr/bin/env node
// The phone app, on this computer: serves mobile/dist and answers the
// CutalongEngine calls the app's web fallback makes (mobile/src/host/engine-web.ts)
// with the real ffmpeg and ffprobe here, and a stand-in for whisper. It also
// keeps the app's files on this disk (the phone keeps them with Capacitor's
// Filesystem) and serves them with Range requests, as a phone's WebView does.
//
// It answers as a phone would: its ffmpeg has no GPL parts, so a command that
// names a GPL filter or x264 fails the way the phone's ffmpeg would, and the
// phone's hardware encoder (h264_videotoolbox or h264_mediacodec) is run with
// x264 here, every other argument as the app gave it.
//
//   node dev/engine-bridge.mjs [--port 8737] [--root DIR] [--as ios|android]
//     [--ffmpeg PATH] [--ffprobe PATH] [--whisper PATH] [--pick-from DIR]
//     [--model-file PATH]
//
// FFMPEG_PATH and FFPROBE_PATH work as well as --ffmpeg and --ffprobe.
// CUTALONG_WHISPER_MANIFEST names a file of known words for the stand-in.

import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, promises as fs, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}

const PORT = Number(flag('port', process.env.PORT ?? 8737))
const ROOT = resolve(flag('root', join(here, '..', '.bridge')))
const AS = flag('as', 'ios') === 'android' ? 'android' : 'ios'
const FFMPEG = flag('ffmpeg', process.env.FFMPEG_PATH ?? 'ffmpeg')
const FFPROBE = flag('ffprobe', process.env.FFPROBE_PATH ?? 'ffprobe')
const WHISPER = flag('whisper', process.env.WHISPER_CLI ?? null)
const PICK_FROM = flag('pick-from', null)
const MODEL_FILE = flag('model-file', null)
const DIST = resolve(here, '..', 'dist')
const DOCUMENTS = join(ROOT, 'Documents')
const CACHE = join(ROOT, 'Caches')
const PHOTOS = join(ROOT, 'Photos')
const LOG = join(ROOT, 'bridge.log')

const LISTED = JSON.parse(readFileSync(resolve(here, '../../src/main/render/gpl-filters.json'), 'utf8'))
const MISSING = new Set([...LISTED.gpl, ...LISTED.libraries])
const MISSING_ENCODERS = new Set(LISTED.encoders)
const HARDWARE = AS === 'ios' ? 'h264_videotoolbox' : 'h264_mediacodec'

await fs.mkdir(DOCUMENTS, { recursive: true })
await fs.mkdir(CACHE, { recursive: true })
await fs.mkdir(PHOTOS, { recursive: true })

const log = (line) => {
  const text = `${new Date().toISOString()} ${line}\n`
  process.stdout.write(text)
  void fs.appendFile(LOG, text).catch(() => undefined)
}

// --- Lines, as server-sent events ------------------------------------------

const listeners = new Set()
const emit = (id, stream, line) => {
  const data = `data: ${JSON.stringify({ id, stream, line })}\n\n`
  for (const res of listeners) res.write(data)
}

// --- What the phone's ffmpeg lacks -----------------------------------------

/** The filters a filtergraph names. */
function filterNames(graph) {
  const names = []
  let part = ''
  let quoted = false
  const flush = () => {
    const body = part.replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim()
    const name = /^([A-Za-z0-9_]+)/.exec(body)?.[1]
    if (name) names.push(name)
    part = ''
  }
  for (let i = 0; i < graph.length; i++) {
    const c = graph[i]
    if (c === '\\') {
      part += c + (graph[i + 1] ?? '')
      i++
      continue
    }
    if (c === "'") quoted = !quoted
    if (!quoted && (c === ',' || c === ';')) flush()
    else part += c
  }
  flush()
  return names
}

function missingOnPhone(args) {
  const out = new Set()
  for (let i = 0; i < args.length - 1; i++) {
    const [f, v] = [args[i], args[i + 1]]
    if (f === '-filter_complex' || f === '-lavfi' || /^-(vf|af|filter)(:[av])?$/.test(f))
      for (const n of filterNames(v)) if (MISSING.has(n)) out.add(n)
    if (/^-(c|codec)(:[av])?$/.test(f) && MISSING_ENCODERS.has(v)) out.add(v)
  }
  return [...out]
}

/** The phone's arguments as this computer's ffmpeg runs them: its hardware encoder becomes x264. */
function runnableHere(args) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (args[i - 1] === '-c:v' && (args[i] === 'h264_videotoolbox' || args[i] === 'h264_mediacodec')) out.push('libx264')
    else out.push(args[i])
  }
  return out
}

// --- Running a tool --------------------------------------------------------

const running = new Map()
const KEPT = 64 * 1024

function readWavSeconds(path) {
  const b = readFileSync(path)
  let i = 12
  let rate = 16000
  let block = 2
  while (i + 8 <= b.length) {
    const id = b.toString('ascii', i, i + 4)
    const size = b.readUInt32LE(i + 4)
    if (id === 'fmt ') {
      rate = b.readUInt32LE(i + 12)
      block = b.readUInt16LE(i + 20)
    }
    if (id === 'data') return Math.min(size, b.length - i - 8) / (rate * block)
    i += 8 + size + (size % 2)
  }
  return 0
}

/**
 * whisper.cpp's stand-in: the words a manifest says a recording of this
 * length holds (the tests make their speech with espeak, so the words are
 * known), written where whisper writes them, with progress as whisper prints it.
 */
async function whisperStandIn(id, args) {
  const arg = (f) => args[args.indexOf(f) + 1]
  const wav = arg('-f')
  const prefix = arg('-of')
  const model = arg('-m')
  if (!existsSync(model)) return { code: 1, stdout: '', stderr: `error: failed to open '${model}'\n` }
  const seconds = readWavSeconds(wav)
  const manifestPath = process.env.CUTALONG_WHISPER_MANIFEST
  const manifest = manifestPath && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
  const match = manifest?.recordings.find((r) => Math.abs(r.durationSec - seconds) < 0.35)
  const words = match
    ? manifest.words.map((w) => ({ ...w, startSec: w.startSec + match.lead, endSec: w.endSec + match.lead }))
    : []
  log(`[whisper] ${basename(wav)} ${seconds.toFixed(2)} s -> ${match ? match.name : 'no words known'}`)
  const lines = []
  const say = (line) => {
    lines.push(line)
    emit(id, 'stderr', line)
  }
  say('whisper_print_progress_callback: progress = 50%')
  await new Promise((r) => setTimeout(r, Number(process.env.CUTALONG_WHISPER_DELAY_MS ?? 300)))
  const ms = (s) => Math.round(s * 1000)
  const transcription = words.map((w) => ({
    timestamps: { from: '', to: '' },
    offsets: { from: ms(w.startSec), to: ms(w.endSec) },
    text: ` ${w.text}`,
    tokens: [{ text: ` ${w.text}`, p: 0.97, t_dtw: -1, offsets: { from: ms(w.startSec), to: ms(w.endSec) } }]
  }))
  await fs.writeFile(`${prefix}.json`, JSON.stringify({ result: { language: 'en' }, transcription }))
  say('whisper_print_progress_callback: progress = 100%')
  return { code: 0, stdout: '', stderr: `${lines.join('\n')}\n` }
}

function runTool(id, tool, args) {
  if (tool === 'whisper' && !WHISPER) return whisperStandIn(id, args)
  if (tool === 'ffmpeg') {
    const missing = missingOnPhone(args)
    if (missing.length) {
      const stderr = `${missing.map((m) => (MISSING_ENCODERS.has(m) ? `Unknown encoder '${m}'` : `No such filter: '${m}'`)).join('\n')}\n`
      log(`[run ${id}] refused, as the phone's ffmpeg would: ${missing.join(', ')}`)
      return Promise.resolve({ code: 1, stdout: '', stderr })
    }
    if (args.includes(HARDWARE)) log(`[run ${id}] ${HARDWARE} runs as libx264 here`)
  }
  const bin = tool === 'ffprobe' ? FFPROBE : tool === 'whisper' ? WHISPER : FFMPEG
  const real = tool === 'ffmpeg' ? runnableHere(args) : args
  return new Promise((resolveRun) => {
    const child = spawn(bin, real)
    running.set(id, child)
    let stdout = ''
    let stderr = ''
    let cancelled = false
    child.cancel = () => {
      cancelled = true
      child.kill('SIGTERM')
    }
    const lines = (stream) => {
      let carry = ''
      return (d) => {
        const text = carry + d.toString()
        const parts = text.split(/\r?\n|\r/)
        carry = parts.pop() ?? ''
        for (const line of parts) emit(id, stream, line)
        if (stream === 'stdout') stdout += d.toString()
        else stderr = (stderr + d.toString()).slice(-KEPT)
      }
    }
    child.stdout.on('data', lines('stdout'))
    child.stderr.on('data', lines('stderr'))
    child.on('error', (err) => {
      running.delete(id)
      resolveRun({ code: 1, stdout, stderr: `${stderr}${err.message}\n` })
    })
    child.on('close', (code) => {
      running.delete(id)
      resolveRun({ code: cancelled ? 255 : (code ?? 255), stdout, stderr })
    })
  })
}

// --- Files -----------------------------------------------------------------

const random = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

async function freeName(dir, name) {
  const ext = extname(name)
  const stem = basename(name, ext)
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? name : `${stem} ${n}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
}

const KINDS = {
  video: /\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts)$/i,
  audio: /\.(wav|mp3|m4a|aac|flac|aif|aiff|caf)$/i,
  image: /\.(png|jpe?g|webp|gif|heic)$/i
}

let queued = null

/** Copies picked files into the app's storage, as a phone's picker does. */
async function bringIn(paths) {
  const dir = join(DOCUMENTS, 'Picked')
  await fs.mkdir(dir, { recursive: true })
  const files = []
  for (const p of paths) {
    const dest = await freeName(dir, basename(p))
    await fs.copyFile(p, dest)
    files.push({ path: dest, name: basename(dest), bytes: (await fs.stat(dest)).size })
  }
  return files
}

const fsOps = {
  read: async ({ path }) => ({ text: await fs.readFile(path, 'utf8') }),
  write: async ({ path, text, base64 }) => {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, base64 !== undefined ? Buffer.from(base64, 'base64') : text)
    return {}
  },
  mkdir: async ({ path }) => (await fs.mkdir(path, { recursive: true }), {}),
  remove: async ({ path }) => (await fs.rm(path, { recursive: true, force: true }), {}),
  stat: async ({ path }) => {
    const s = await fs.stat(path).catch(() => null)
    return { stat: s ? { size: s.size, mtimeMs: s.mtimeMs, directory: s.isDirectory() } : null }
  },
  rename: async ({ from, to }) => (await fs.rename(from, to), {}),
  copy: async ({ from, to }) => (await fs.copyFile(from, to), {}),
  list: async ({ path }) => {
    const entries = await fs.readdir(path, { withFileTypes: true }).catch(() => [])
    return { entries: entries.map((e) => ({ name: e.name, directory: e.isDirectory(), file: e.isFile() })) }
  },
  tempdir: async ({ prefix }) => {
    const path = join(CACHE, `${prefix}${random()}`)
    await fs.mkdir(path, { recursive: true })
    return { path }
  },
  claim: async ({ path }) => {
    await fs.mkdir(dirname(path), { recursive: true })
    try {
      await (await fs.open(path, 'wx')).close()
      return { claimed: true }
    } catch (err) {
      if (err.code === 'EEXIST') return { claimed: false }
      throw err
    }
  }
}

/** Only the app's own storage, the picked files' folder and the dist are served or touched. */
function allowed(path) {
  const p = resolve(path)
  return p.startsWith(ROOT + '/') || (PICK_FROM && p.startsWith(resolve(PICK_FROM) + '/'))
}

// --- HTTP ------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg'
}

async function body(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

function send(res, status, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  res.writeHead(status, { 'content-type': typeof value === 'string' ? 'text/plain; charset=utf-8' : 'application/json' })
  res.end(text)
}

/** A file with Range support, which a video element needs to seek. */
async function serveFile(req, res, path) {
  const stat = await fs.stat(path).catch(() => null)
  if (!stat || !stat.isFile()) return send(res, 404, `No file at ${path}`)
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
    if (start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
      return res.end()
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes'
    })
    return createReadStream(path, { start, end }).pipe(res)
  }
  res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' })
  createReadStream(path).pipe(res)
}

const ffmpegVersion = /version (\S+)/.exec(spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' }).stdout ?? '')?.[1] ?? 'unknown'

/**
 * The bridge's own addresses. Any website open in the same browser can reach
 * 127.0.0.1 too, and the engine calls run this computer's ffmpeg with the
 * arguments they are given (any file in, any file out), so they answer only the
 * app's own page and tools run here.
 */
const OWN = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])

/** Why a request is refused, or null when it comes from the app's page or a tool on this computer. */
function refused(req) {
  // Another name resolving here (DNS rebinding) arrives with that name as its Host.
  if (!OWN.has(String(req.headers.host ?? '').toLowerCase())) return 'Only 127.0.0.1 and localhost reach the engine.'
  // A page from another site: a browser names its origin. Node, curl and Playwright's request API send none.
  const origin = req.headers.origin
  if (origin && !OWN.has(origin.toLowerCase().replace(/^http:\/\//, ''))) return 'Only the app’s own page reaches the engine.'
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return 'Only the app’s own page reaches the engine.'
  return null
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  if (path.startsWith('/engine/')) {
    const why = refused(req)
    if (why) {
      log(`[refused] ${req.method} ${path} from ${req.headers.origin ?? req.headers.host ?? 'unknown'}`)
      return send(res, 403, why)
    }
  }
  try {
    if (path === '/engine/lines') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(': lines\n\n')
      listeners.add(res)
      req.on('close', () => listeners.delete(res))
      return
    }
    if (path === '/engine/media') {
      const file = url.searchParams.get('path') ?? ''
      if (!allowed(file)) return send(res, 403, 'Only the app’s own files are served.')
      return serveFile(req, res, file)
    }
    if (path === '/engine/upload' && req.method === 'POST') {
      const dir = join(DOCUMENTS, 'Picked')
      await fs.mkdir(dir, { recursive: true })
      const dest = await freeName(dir, basename(url.searchParams.get('name') ?? `file-${random()}`))
      await fs.writeFile(dest, await body(req))
      return send(res, 200, { path: dest, name: basename(dest), bytes: (await fs.stat(dest)).size })
    }
    if (path.startsWith('/engine/fs/') && req.method === 'POST') {
      const op = fsOps[path.slice('/engine/fs/'.length)]
      const args = JSON.parse((await body(req)).toString() || '{}')
      for (const p of [args.path, args.from, args.to].filter(Boolean))
        if (!allowed(p)) return send(res, 403, `Outside the app’s storage: ${p}`)
      if (!op) return send(res, 404, 'No such file operation.')
      return send(res, 200, await op(args))
    }
    if (path.startsWith('/engine/') && req.method === 'POST') {
      const op = path.slice('/engine/'.length)
      const args = JSON.parse((await body(req)).toString() || '{}')
      if (op === 'info')
        return send(res, 200, {
          platform: AS,
          documents: DOCUMENTS,
          cache: CACHE,
          ffmpegVersion,
          whisperVersion: WHISPER ? 'whisper-cli' : '1.8.2 (stand-in)',
          encoders: AS === 'ios' ? ['h264_videotoolbox', 'hevc_videotoolbox'] : ['h264_mediacodec', 'hevc_mediacodec']
        })
      if (op === 'run') {
        const started = Date.now()
        // The arguments as the app gave them, so what the phone's own build must have can be read off a session.
        log(`[run ${args.id}] ${args.tool} ${JSON.stringify(args.args)}`)
        const result = await runTool(args.id, args.tool, args.args)
        log(`[run ${args.id}] ${args.tool} exited ${result.code} after ${Date.now() - started} ms`)
        return send(res, 200, result)
      }
      if (op === 'cancel') {
        running.get(args.id)?.cancel()
        return send(res, 200, {})
      }
      if (op === 'pick-next') {
        queued = args.paths ?? null
        return send(res, 200, {})
      }
      if (op === 'pick') {
        const kinds = args.kinds ?? ['video', 'audio', 'image']
        let paths = queued
        queued = null
        if (!paths && PICK_FROM) {
          paths = (await fs.readdir(PICK_FROM)).map((n) => join(PICK_FROM, n)).filter((p) => kinds.some((k) => KINDS[k].test(p)))
          if (!args.multiple) paths = paths.slice(0, 1)
        }
        if (!paths) return send(res, 200, { files: null })
        const files = await bringIn(paths)
        log(`[pick] ${files.map((f) => f.name).join(', ')}`)
        return send(res, 200, { files })
      }
      if (op === 'photos') {
        if (!allowed(args.path) || !existsSync(args.path)) return send(res, 200, { saved: false, message: 'There is no file to save.' })
        const dest = await freeName(PHOTOS, basename(args.path))
        await fs.copyFile(args.path, dest)
        log(`[photos] saved ${basename(dest)}`)
        return send(res, 200, { saved: true })
      }
      if (op === 'download') {
        if (!allowed(args.dest)) return send(res, 403, 'Outside the app’s storage.')
        await fs.mkdir(dirname(args.dest), { recursive: true })
        const part = `${args.dest}.part`
        if (MODEL_FILE) {
          // A stand-in for the model, copied in steps so the app shows its progress.
          const data = await fs.readFile(MODEL_FILE)
          await fs.writeFile(part, '')
          for (let i = 1; i <= 10; i++) {
            await fs.appendFile(part, data.subarray(Math.floor(((i - 1) * data.length) / 10), Math.floor((i * data.length) / 10)))
            emit(args.id, 'stderr', `downloaded ${i * 10}%`)
            await new Promise((r) => setTimeout(r, 120))
          }
        } else {
          const r = await fetch(args.url)
          if (!r.ok || !r.body) return send(res, 502, `The model download failed: HTTP ${r.status}.`)
          const total = Number(r.headers.get('content-length') ?? 0)
          const out = await fs.open(part, 'w')
          let got = 0
          for await (const chunk of r.body) {
            await out.write(chunk)
            got += chunk.length
            if (total) emit(args.id, 'stderr', `downloaded ${Math.round((got / total) * 100)}%`)
          }
          await out.close()
        }
        await fs.rename(part, args.dest)
        log(`[download] ${basename(args.dest)}`)
        return send(res, 200, {})
      }
      return send(res, 404, `No engine call ${op}.`)
    }
    // The app itself.
    const file = path === '/' ? join(DIST, 'index.html') : join(DIST, decodeURIComponent(path))
    if (!file.startsWith(DIST)) return send(res, 403, 'No.')
    return serveFile(req, res, file)
  } catch (err) {
    // A file that is not there is an answer, as it is on a phone: the app asks before it makes one.
    if (err?.code === 'ENOENT') return send(res, 404, err.message)
    log(`[error] ${path}: ${err?.stack ?? err}`)
    send(res, 500, err instanceof Error ? err.message : String(err))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  log(`Cutalong's phone app at http://127.0.0.1:${PORT}/ as ${AS === 'ios' ? 'an iPhone' : 'an Android phone'}`)
  log(`ffmpeg ${ffmpegVersion} (${FFMPEG}), ffprobe ${FFPROBE}, whisper ${WHISPER ?? 'stand-in'}; files in ${ROOT}`)
})
