#!/usr/bin/env node
// Checks the cutting as it stands against every edit Cutalong has learned
// from on this Mac: the test set in userData/learn. Run it before and after a
// change to /tighten or a new cutter, and compare.
// Usage: npm run eval:learn -- [folder holding the learned .json files]
import { build } from 'esbuild'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const support = join(homedir(), 'Library/Application Support')
const dir =
  process.argv[2] ??
  [join(support, 'Chop Shop', 'learn'), join(support, 'chop-shop', 'learn')].find((d) => existsSync(d))
if (!dir || !existsSync(dir)) {
  console.error('No learned edits found. Learn from one on the Brand page first, or pass the folder.')
  process.exit(1)
}

const out = join(tmpdir(), `cutalong-eval-learn-${Date.now()}.cjs`)
await build({
  stdin: {
    contents:
      "export { readPairs } from './src/main/learn-store'\n" +
      "export { CUTTERS, evaluateCutter, fitHabits, summarizeLearning } from './src/shared/learn'",
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'error',
  outfile: out
})
const learn = createRequire(pathToFileURL(join(root, 'package.json')))(out)

const pairs = await learn.readPairs(dir)
if (pairs.length === 0) {
  console.error(`Nothing learned yet in ${dir}.`)
  process.exit(1)
}
const pct = (v) => (v === null ? '-' : `${Math.round(v * 100)}%`)
console.log(`\n${pairs.length} learned video${pairs.length === 1 ? '' : 's'} in ${dir}\n`)
for (const p of pairs) {
  const kept = p.words.filter((w) => w.label === 'kept').length
  const cut = p.words.filter((w) => w.label === 'cut').length
  console.log(`  ${p.title}: ${kept} kept, ${cut} cut, from ${p.recordings.length} recording(s)`)
}
console.log('')
const habits = learn.fitHabits(pairs)
for (const c of learn.CUTTERS) {
  const r = learn.evaluateCutter(c.cut, pairs)
  console.log(`${c.name}`)
  console.log(`  cut what you cut     ${pct(r.removals.recall)}  (${r.removals.both} of ${r.removals.creator})`)
  console.log(`  what it cut, you cut ${pct(r.removals.precision)}  (${r.removals.both} of ${r.removals.cutter})`)
  console.log(`  kept what you kept   ${pct(r.keeps)}`)
  console.log(
    `  same cut lands       ${r.boundaryMs.median ?? '-'} ms apart, ${r.boundaryMs.p90 ?? '-'} ms at most (9 in 10)`
  )
  console.log(`  pauses left          yours ${r.pauses.creatorSec ?? '-'} s, its ${r.pauses.cutterSec ?? '-'} s`)
  console.log(`  missed in retakes    ${r.removals.missedInTakes}`)
  console.log(`  ${learn.summarizeLearning(r, habits, c.name).sentence}\n`)
}
