#!/usr/bin/env node
/**
 * Exports a short edit with a 3D clip inside Electron, the way the app does
 * (src/main/self-check.ts, "3D layers"), from this checkout's build, and says
 * what the frames showed. Build first with `npx electron-vite build`.
 *
 *   node scripts/three-export-check.mjs [folder to keep the export in]
 */
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const root = resolve(new URL('..', import.meta.url).pathname)
if (!existsSync(join(root, 'out/main/index.js')) || !existsSync(join(root, 'out/renderer/three.html'))) {
  console.error('no build: run npx electron-vite build first')
  process.exit(1)
}
const electron = createRequire(import.meta.url)('electron')
const keep = process.argv[2] ? resolve(process.argv[2]) : ''
const dir = mkdtempSync(join(tmpdir(), 'cutalong-3d-check-'))
const report = join(dir, 'report.json')
try {
  const r = spawnSync(electron, [root], {
    env: { ...process.env, CUTALONG_SELF_CHECK: report, CUTALONG_SELF_CHECK_ONLY: '3d', CUTALONG_SELF_CHECK_KEEP: keep, ELECTRON_RENDERER_URL: '' },
    encoding: 'utf8',
    timeout: 180_000
  })
  if (!existsSync(report)) {
    console.error(`no report (exit ${r.status}, signal ${r.signal})`)
    console.error(`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000))
    process.exit(1)
  }
  const { ok, checks } = JSON.parse(readFileSync(report, 'utf8'))
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
  if (!ok) {
    console.error(`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000))
    process.exitCode = 1
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
