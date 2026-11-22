// Builds the test app's web part into www/: the self-test, bundled with the
// desktop code it runs (src/main/*.ts in this repository), and the sample
// media tools/make_media.py made.
//
//   node build.mjs MEDIA_DIR
//
// Without MEDIA_DIR the app builds and runs, but its self-test has nothing to
// work on.
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const www = join(here, 'www')
const media = process.argv[2] ? resolve(process.argv[2]) : null

rmSync(www, { recursive: true, force: true })
mkdirSync(www, { recursive: true })

// src/main/intake.ts imports child_process for the Mac; the phone has none.
const noChildProcess = {
  name: 'no-child-process',
  setup(b) {
    b.onResolve({ filter: /^(node:)?child_process$/ }, () => ({ path: join(here, 'src/child-process.ts') }))
  }
}

await build({
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(www, 'app.js'),
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  sourcemap: true,
  // The desktop code it bundles lives outside this app, and the packages that code imports (zod)
  // are found here, as CI installs only this app's.
  nodePaths: [join(here, 'node_modules')],
  plugins: [noChildProcess],
  logLevel: 'info'
})
cpSync(join(here, 'index.html'), join(www, 'index.html'))

if (media) {
  if (!existsSync(join(media, 'expect.json'))) {
    console.error(`${media} has no expect.json: make it with tools/make_media.py first.`)
    process.exit(1)
  }
  cpSync(media, join(www, 'media'), { recursive: true })
  console.log(`media from ${media}`)
} else {
  console.warn('No media given: the self-test will have nothing to work on (see README.md).')
}
