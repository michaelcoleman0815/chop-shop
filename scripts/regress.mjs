#!/usr/bin/env node
/**
 * Bundles the regression suite against a stubbed Electron and runs it.
 *
 * The suite imports main-process modules directly, so Electron has to be
 * stubbed rather than launched; ffmpeg and ffprobe stay real, because the point
 * is to check what actually comes out of them.
 */
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, rmSync } from 'fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [transcript, outDir] = process.argv.slice(2)
if (!transcript || !outDir) {
  console.error('usage: node scripts/regress.mjs <transcript.json> <output dir>')
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })
const bundle = join(root, '.regress.cjs')

try {
  execFileSync(
    join(root, 'node_modules/.bin/esbuild'),
    [
      join(root, 'tests/regress.ts'),
      '--bundle',
      '--platform=node',
      `--alias:electron=${join(root, 'tests/electron-stub.cjs')}`,
      '--external:@ffprobe-installer/ffprobe',
      '--external:ffmpeg-static',
      `--outfile=${bundle}`,
      '--log-level=warning'
    ],
    { stdio: 'inherit' }
  )
  execFileSync('node', [bundle, transcript, outDir], { stdio: 'inherit' })
} finally {
  rmSync(bundle, { force: true })
}
