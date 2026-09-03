#!/usr/bin/env node
// Scores a cached analysis against the gate the selection prompt enforces.
// Usage: npm run eval:clips -- [path to an analysis json]
import { build } from 'esbuild'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { pathToFileURL } from 'url'

const cacheDir = join(homedir(), 'Library/Application Support/chop-shop/analysis')
const target =
  process.argv[2] ??
  readdirSync(cacheDir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => join(cacheDir, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]

if (!target) {
  console.error('No analysis found. Run one in the app first, or pass a path.')
  process.exit(1)
}

const out = join(tmpdir(), `chopshop-eval-${Date.now()}.mjs`)
await build({
  entryPoints: ['src/shared/clip-quality.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'error',
  outfile: out
})
const { judgeClips } = await import(pathToFileURL(out).href)

const data = JSON.parse(readFileSync(target, 'utf8'))
const words = data.transcript.words
const clips = data.clips
const verdicts = judgeClips(clips, words)

const mm = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
console.log(`\n${clips.length} clips from ${words.length.toLocaleString()} words`)
if (data.options) {
  console.log(`genre ${data.options.genre ?? 'auto'}, asked for ${data.options.maxClips}`)
}
console.log('')

let clean = 0
const tally = new Map()
for (const v of verdicts) {
  const mark = v.faults.length === 0 ? 'PASS' : 'FAIL'
  if (v.faults.length === 0) clean++
  console.log(
    `${mark}  ${mm(v.startSec)}  ${String(Math.round(v.endSec - v.startSec)).padStart(3)}s  ${v.title}`
  )
  for (const f of v.faults) {
    tally.set(f.code, (tally.get(f.code) ?? 0) + 1)
    console.log(`        ${f.code}: ${f.detail}`)
  }
}

const rate = Math.round((clean / clips.length) * 100)
console.log(`\nclean: ${clean}/${clips.length}  (${rate}%)`)
if (tally.size > 0) {
  console.log('faults by kind:')
  for (const [code, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(2)}  ${code}`)
  }
}
// Published points of comparison, so the number means something.
console.log('\nfor reference: one tester discarded 20-40% of a market leader\'s clips')
console.log('on podcasts, and found 15% usable on a real 35 minute sermon.')
