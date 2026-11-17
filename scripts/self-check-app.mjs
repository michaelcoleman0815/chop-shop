#!/usr/bin/env node
/**
 * Starts a packaged app in its self-check (src/main/self-check.ts) and says
 * what it found: each helper run the way the app runs it, Skia and
 * onnxruntime loaded inside Electron, and a face found in a test picture.
 * Fails when any of it does not work, or when the app does not answer in
 * three minutes.
 *
 *   node scripts/self-check-app.mjs release/win-unpacked/Cutalong.exe
 */
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const exe = process.argv[2]
if (!exe || !existsSync(exe)) {
  console.log(`::error::no app at ${exe}`)
  process.exit(1)
}
const dir = mkdtempSync(join(tmpdir(), 'cutalong-self-check-'))
const report = join(dir, 'report.json')
try {
  const started = Date.now()
  const r = spawnSync(exe, [], {
    env: { ...process.env, CUTALONG_SELF_CHECK: report, ELECTRON_ENABLE_LOGGING: '1' },
    encoding: 'utf8',
    timeout: 180_000
  })
  const sec = ((Date.now() - started) / 1000).toFixed(1)
  if (r.error) console.log(`::error::the app could not be run: ${r.error.message}`)
  if (!existsSync(report)) {
    console.log(`::error::the app (exit ${r.status}, signal ${r.signal}, ${sec} s) wrote no self-check report`)
    console.log(`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000))
    process.exitCode = 1
  } else {
    const { ok, checks } = JSON.parse(readFileSync(report, 'utf8'))
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
    console.log(`the app checked itself in ${sec} s and exited ${r.status}`)
    if (!ok || r.status !== 0) {
      for (const c of checks.filter((c) => !c.ok)) console.log(`::error::${c.name}: ${c.detail}`)
      console.log(`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000))
      process.exitCode = 1
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
