#!/usr/bin/env node
/**
 * Checks a packaged Windows app before anyone opens it. First that what
 * Cutalong looks for is where it looks: the helpers, fonts, maps and face
 * model beside app.asar, the native modules unpacked from it with the C++
 * runtime beside onnxruntime, and none of what was pruned. Then, in the
 * app's own Electron run as Node, that Skia draws and onnxruntime runs the
 * face model, each loaded through app.asar as the app loads it.
 * self-check-app.mjs then opens the app itself.
 *
 *   node scripts/check-windows-app.mjs release/win-unpacked
 */
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join, relative, resolve } from 'path'

const require = createRequire(import.meta.url)

const app = resolve(process.argv[2] ?? 'release/win-unpacked')
const exe = join(app, 'Cutalong.exe')
const res = join(app, 'resources')
const unpacked = join(res, 'app.asar.unpacked', 'node_modules')
const ortBin = join(unpacked, 'onnxruntime-node', 'bin', 'napi-v6')
const ort = join(ortBin, 'win32', 'x64')

let failed = false
const fail = (message) => {
  console.log(`::error::${message}`)
  failed = true
}
const size = (path) => {
  if (!existsSync(path)) return 0
  const s = statSync(path)
  return s.isDirectory() ? readdirSync(path).reduce((n, f) => n + size(join(path, f)), 0) : s.size
}
const list = (dir) => (existsSync(dir) ? readdirSync(dir).join(', ') : 'none')
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`

for (const path of [
  exe,
  join(res, 'app.asar'),
  join(res, 'app-update.yml'),
  join(res, 'bin', 'whisper-cli.exe'),
  join(res, 'bin', 'yt-dlp.exe'),
  join(res, 'fonts', 'Sora.ttf'),
  join(res, 'maps', 'tiles', '0', '0', '0.jpg'),
  join(res, 'faces', 'face_detection_yunet_2026may.onnx'),
  join(res, 'faces', 'LICENSE'),
  join(unpacked, 'ffmpeg-static', 'ffmpeg.exe'),
  join(unpacked, '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
  join(unpacked, '@napi-rs', 'canvas-win32-x64-msvc'),
  join(ort, 'onnxruntime_binding.node'),
  join(ort, 'onnxruntime.dll'),
  join(ort, 'msvcp140.dll'),
  join(ort, 'vcruntime140.dll'),
  join(ort, 'vcruntime140_1.dll')
]) {
  if (existsSync(path)) console.log(`ok   ${relative(app, path)} (${mb(size(path))})`)
  else fail(`the app has no ${relative(app, path)}`)
}

// What the app never loads on Windows x64, left out by electron-builder.yml.
for (const path of [
  join(ortBin, 'linux'),
  join(ortBin, 'darwin'),
  join(ortBin, 'win32', 'arm64'),
  join(ort, 'DirectML.dll'),
  join(ort, 'dxcompiler.dll')
]) {
  if (existsSync(path)) fail(`the app still has ${relative(app, path)}, which it never loads`)
}
// The app's own files are its build and package.json. Anything else in app.asar was packed by mistake, as the
// whole project is when a platform's files list holds only exclusions (electron-builder.yml).
try {
  const asar = require('@electron/asar')
  const entries = asar.listPackage(join(res, 'app.asar'))
  const top = [...new Set(entries.map((e) => e.split(/[\\/]/).filter(Boolean)[0]))].sort()
  const stray = top.filter((t) => !['node_modules', 'out', 'package.json'].includes(t))
  if (stray.length) fail(`app.asar holds more than the app: ${stray.join(', ')}`)
  else console.log(`ok   app.asar holds ${top.join(', ')} (${entries.length} entries)`)
} catch (err) {
  fail(`app.asar could not be read: ${err.message}`)
}
console.log(`fonts: ${list(join(res, 'fonts'))}`)
console.log(`helpers: ${list(join(res, 'bin'))}`)
console.log(
  [
    `app.asar ${mb(size(join(res, 'app.asar')))}`,
    `unpacked ${mb(size(join(res, 'app.asar.unpacked')))}`,
    `of which onnxruntime-node ${mb(size(join(unpacked, 'onnxruntime-node')))}`,
    `whole app ${mb(size(app))}`
  ].join(', ')
)

/** Runs in the app's Electron as Node: loads each native module through app.asar, as the app does. */
async function inside(resources, reportPath) {
  const { writeFileSync } = require('fs')
  const { join } = require('path')
  const modules = join(resources, 'app.asar', 'node_modules')
  const out = { electron: process.versions.electron, node: process.versions.node }
  try {
    const { createCanvas } = require(join(modules, '@napi-rs', 'canvas'))
    const canvas = createCanvas(64, 64)
    canvas.getContext('2d').fillRect(0, 0, 64, 64)
    out.skia = `drew a ${canvas.toBuffer('image/png').length} byte PNG`
  } catch (err) {
    out.skiaError = String((err && err.stack) || err)
  }
  try {
    const ort = require(join(modules, 'onnxruntime-node'))
    const model = join(resources, 'faces', 'face_detection_yunet_2026may.onnx')
    const session = await ort.InferenceSession.create(model, { executionProviders: ['cpu'] })
    const input = new ort.Tensor('float32', new Float32Array(3 * 384 * 640), [1, 3, 384, 640])
    const answer = await session.run({ input })
    out.onnxruntime = `YuNet answered a blank frame with ${Object.keys(answer).sort().join(', ')}`
  } catch (err) {
    out.onnxruntimeError = String((err && err.stack) || err)
  }
  writeFileSync(reportPath, JSON.stringify(out, null, 2))
}

const dir = mkdtempSync(join(tmpdir(), 'cutalong-app-check-'))
try {
  const script = join(dir, 'inside.js')
  const report = join(dir, 'report.json')
  writeFileSync(script, `(${inside.toString()})(process.argv[2], process.argv[3])\n`)
  const r = spawnSync(exe, [script, res, report], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 120_000
  })
  const said = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  if (said) console.log(said)
  if (!existsSync(report)) {
    fail(`Cutalong.exe as Node wrote no report (exit ${r.status}${r.error ? `, ${r.error.message}` : ''})`)
  } else {
    const found = JSON.parse(readFileSync(report, 'utf8'))
    console.log(`Electron ${found.electron}, Node ${found.node}`)
    if (found.skia) console.log(`ok   Skia in the app: ${found.skia}`)
    else fail(`Skia does not load in the app: ${found.skiaError}`)
    if (found.onnxruntime) console.log(`ok   onnxruntime in the app: ${found.onnxruntime}`)
    else fail(`onnxruntime does not load in the app: ${found.onnxruntimeError}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
