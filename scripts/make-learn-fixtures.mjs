#!/usr/bin/env node
// Makes the speech recordings the learning tests line finished videos up
// against, with the exact time of every word, into src/main/learn-fixtures.
// Needs espeak-ng and ffmpeg. Usage: npm run fixtures:learn
import { build } from 'esbuild'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL, fileURLToPath } from 'url'
import { createRequire } from 'module'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const out = join(tmpdir(), `cutalong-fixtures-${Date.now()}.cjs`)
await build({
  entryPoints: [join(root, 'src/main/learn-fixtures.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'error',
  external: ['ffmpeg-static'],
  outfile: out
})
const require = createRequire(pathToFileURL(join(root, 'package.json')))
const fixtures = require(out)
const espeak = fixtures.findEspeak()
const ffmpeg = fixtures.findFfmpeg()
if (!espeak || !ffmpeg) {
  console.error(`Needs ${!espeak ? 'espeak-ng' : 'ffmpeg'} on the PATH.`)
  process.exit(1)
}
const dir = join(root, 'src/main/learn-fixtures')
fixtures.writeSpeechFixtures(espeak, ffmpeg, dir)
for (const name of ['talk', 'other']) {
  const truth = fixtures.readTruth(name, dir)
  console.log(
    `${name}: ${truth.words.length} words, ${truth.durationSec.toFixed(1)} s, ${truth.breaths.length} breaths`
  )
}
