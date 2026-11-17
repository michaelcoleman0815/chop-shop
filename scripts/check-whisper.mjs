#!/usr/bin/env node
/**
 * Transcribes thirty seconds of the checked-in speech fixture with the
 * whisper-cli in resources/bin, as the app runs it, and says what it heard
 * and how long that took: proof that the helper works, not only that it
 * starts. Then again from a folder named in three scripts, which reaches
 * whisper whole only where it asks Windows for UTF-8 (build-whisper.mjs).
 *
 *   node scripts/check-whisper.mjs [model.bin]
 *
 * Without a model it fetches whisper.cpp's tiny English one (75 MB) into
 * .build/models, where CI keeps it between runs.
 */
import { spawnSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { availableParallelism, tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const windows = process.platform === 'win32'
const bin = join(root, 'resources', 'bin', windows ? 'whisper-cli.exe' : 'whisper-cli')
if (!existsSync(bin)) throw new Error(`no whisper-cli at ${bin}: build it first`)
const ffmpeg = require('ffmpeg-static')

let model = process.argv[2]
if (!model) {
  model = join(root, '.build', 'models', 'ggml-tiny.en.bin')
  if (!existsSync(model)) {
    mkdirSync(dirname(model), { recursive: true })
    const url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin'
    console.log(`fetching ${url}`)
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`${url} answered ${res.status}`)
    writeFileSync(`${model}.part`, Buffer.from(await res.arrayBuffer()))
    renameSync(`${model}.part`, model)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'cutalong-whisper-'))
try {
  const wav = join(dir, 'talk.wav')
  const made = spawnSync(ffmpeg, [
    ...['-hide_banner', '-loglevel', 'error', '-y', '-i', join(root, 'src', 'main', 'learn-fixtures', 'talk.m4a')],
    ...['-t', '30', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]
  ])
  if (made.status !== 0) throw new Error(`ffmpeg could not make the sound: ${made.stderr}`)

  // The app's own threads on Windows (main/transcribe.ts whisperThreads).
  const cores = availableParallelism()
  const threads = windows ? ['-t', String(Math.max(Math.min(4, cores), Math.min(8, Math.floor(cores / 2))))] : []

  /** whisper-cli on one file, with the app's flags for word timings. */
  const transcribe = (audio, prefix) => {
    const started = Date.now()
    const r = spawnSync(bin, [...threads, '-m', model, '-f', audio, '-of', prefix, '-ml', '1', '-sow', '-oj'], {
      encoding: 'utf8'
    })
    const sec = (Date.now() - started) / 1000
    if (r.status !== 0) {
      const said = `${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-8).join('\n')
      return { ok: false, sec, text: '', said: `exit ${r.status ?? r.error}: ${said}` }
    }
    const json = JSON.parse(readFileSync(`${prefix}.json`, 'utf8'))
    const text = (json.transcription ?? []).map((s) => s.text).join('').replace(/\s+/g, ' ').trim()
    return { ok: text.split(' ').length >= 20, sec, text, said: '' }
  }

  const first = transcribe(wav, join(dir, 'talk'))
  console.log(`whisper-cli heard, in ${first.sec.toFixed(1)} s of 30 s of speech:\n  ${first.text || first.said}`)
  if (!first.ok) {
    console.log('::error::whisper-cli did not transcribe the speech fixture')
    process.exit(1)
  }
  if (!/camera|setting/i.test(first.text)) console.log('::warning::whisper-cli heard different words from the fixture')

  // A folder named in Polish, Japanese and French: whole only through UTF-8.
  const far = join(dir, 'Łódź 日本 été')
  mkdirSync(far)
  copyFileSync(wav, join(far, 'talk.wav'))
  const again = transcribe(join(far, 'talk.wav'), join(far, 'talk'))
  if (again.ok) console.log(`and from ${far}, in ${again.sec.toFixed(1)} s`)
  else console.log(`::warning::whisper-cli could not read from ${far}: ${again.said}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
