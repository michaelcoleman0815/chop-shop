#!/usr/bin/env node
/**
 * Runs the app's own main-process code on real files, outside the app: the
 * footage lab (docs/research/raw-footage.md, "The real footage lab").
 *
 *   node scripts/lab.mjs <prepare|v1|clip|hear|render|score|sync|povs> [args]
 *
 * Each entry in tests/lab is bundled against src/ with Electron stubbed
 * (tests/lab/electron-stub.cjs) and run in plain node, so it is the same code
 * the app runs: cut:session and cut:prepare, the takes and length planners,
 * /clipping's findClips, the transcriber and the export.
 *
 * Folders come from the environment, so nothing of a person's machine is
 * written into the code:
 *   LAB_USERDATA  the app's userData: models/ggml-<model>.bin, settings.json, brand.json
 *   LAB_APP       holds resources/bin/whisper-cli and resources/fonts
 *   LAB_TEMP      scratch for extracted audio (it is footage: keep it with the media)
 *   LAB_VIDEOS    the output folder for exports
 */
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [entry, ...args] = process.argv.slice(2)
const entries = ['prepare', 'v1', 'clip', 'hear', 'render', 'score', 'sync', 'povs']
if (!entry || !entries.includes(entry)) {
  console.error(`usage: node scripts/lab.mjs <${entries.join('|')}> [args]`)
  process.exit(2)
}
const missing = ['LAB_USERDATA', 'LAB_APP', 'LAB_TEMP', 'LAB_VIDEOS'].filter((k) => !process.env[k])
if (missing.length) {
  console.error(`set ${missing.join(', ')} first (see the comment at the top of scripts/lab.mjs)`)
  process.exit(2)
}

// The app's own dependencies stay outside the bundle, as electron-vite keeps them
// (externalizeDepsPlugin): some carry native binaries a bundle cannot hold.
const { dependencies = {} } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const externals = Object.keys(dependencies).map((name) => `--external:${name}`)

const dir = mkdtempSync(join(tmpdir(), 'cutalong-lab-'))
const bundle = join(dir, `${entry}.cjs`)
try {
  execFileSync(
    join(root, 'node_modules/.bin/esbuild'),
    [
      join(root, 'tests/lab', `${entry}.ts`),
      '--bundle',
      '--platform=node',
      '--target=node20',
      `--alias:electron=${join(root, 'tests/lab/electron-stub.cjs')}`,
      ...externals,
      `--outfile=${bundle}`,
      '--log-level=warning'
    ],
    { stdio: 'inherit' }
  )
  if (!existsSync(bundle)) throw new Error('the bundle was not written')
  // The bundle lives outside the repo, so its externals resolve from the repo's node_modules.
  const r = spawnSync(process.execPath, ['--max-old-space-size=1024', bundle, ...args], {
    stdio: 'inherit',
    env: { ...process.env, NODE_PATH: join(root, 'node_modules') }
  })
  process.exitCode = r.status ?? 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
