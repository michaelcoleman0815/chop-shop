#!/usr/bin/env node
// Fetches the licence of everything built into the phone app besides its own
// code, from each source at the commit the engine pins (engine/scripts/
// versions.env), into public/licences, where the app's Licences section in
// Settings reads them; notices.json lists them. The npm packages the page is
// built from are listed at build time instead (vite.config.ts).
//
//   node scripts/licences.mjs
//
// Run it again when a pinned version changes, and commit what it writes.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(mobile, 'public', 'licences')
const pins = Object.fromEntries(
  (await readFile(join(mobile, 'engine', 'scripts', 'versions.env'), 'utf8'))
    .split('\n')
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
)

/** A file in a pinned source, as the raw file on its host. */
const pinned = (key, path) => {
  const repo = pins[`${key}_REPO`].replace('https://github.com/', '')
  return `https://raw.githubusercontent.com/${repo}/${pins[`${key}_COMMIT`]}/${path}`
}
const version = (key) => pins[`${key}_TAG`].replace(/^(n|v|VER-|release-)/, '').replace(/-/g, '.')

// Fonts and the models are not pinned by the engine: their licences come from where they are published.
const FONTS = 'https://raw.githubusercontent.com/google/fonts/main/ofl'
const WHISPER_MODELS = 'https://raw.githubusercontent.com/openai/whisper/v20240930/LICENSE'

const components = [
  {
    id: 'ffmpeg',
    name: 'FFmpeg',
    version: version('FFMPEG'),
    licence: 'LGPL 2.1 or later',
    lgpl: true,
    files: [pinned('FFMPEG', 'COPYING.LGPLv2.1')]
  },
  {
    id: 'engine',
    name: "FFmpeg's tools in Cutalong's engine, from ffmpeg-kit",
    version: version('FFMPEG'),
    licence: 'LGPL 2.1 or later',
    lgpl: true,
    same: 'ffmpeg'
  },
  {
    id: 'fribidi',
    name: 'FriBidi',
    version: version('FRIBIDI'),
    licence: 'LGPL 2.1 or later',
    lgpl: true,
    files: [pinned('FRIBIDI', 'COPYING')]
  },
  { id: 'libass', name: 'libass', version: version('LIBASS'), licence: 'ISC', files: [pinned('LIBASS', 'COPYING')] },
  {
    id: 'freetype',
    name: 'FreeType',
    version: version('FREETYPE'),
    licence: 'FreeType License',
    files: [pinned('FREETYPE', 'docs/FTL.TXT')]
  },
  {
    id: 'harfbuzz',
    name: 'HarfBuzz',
    version: version('HARFBUZZ'),
    licence: 'MIT',
    files: [pinned('HARFBUZZ', 'COPYING')]
  },
  { id: 'zimg', name: 'zimg', version: version('ZIMG'), licence: 'WTFPL', files: [pinned('ZIMG', 'COPYING')] },
  {
    id: 'libwebp',
    name: 'libwebp',
    version: version('LIBWEBP'),
    licence: 'BSD 3-clause',
    files: [pinned('LIBWEBP', 'COPYING'), pinned('LIBWEBP', 'PATENTS')]
  },
  {
    id: 'dav1d',
    name: 'dav1d',
    version: version('DAV1D'),
    licence: 'BSD 2-clause',
    files: [pinned('DAV1D', 'COPYING')]
  },
  { id: 'opus', name: 'Opus', version: version('OPUS'), licence: 'BSD 3-clause', files: [pinned('OPUS', 'COPYING')] },
  {
    id: 'whisper',
    name: 'whisper.cpp and ggml',
    version: version('WHISPER'),
    licence: 'MIT',
    files: [pinned('WHISPER', 'LICENSE')]
  },
  {
    id: 'whisper-models',
    name: 'Whisper models (base.en, small.en), downloaded when first used',
    version: '',
    licence: 'MIT',
    files: [WHISPER_MODELS]
  },
  { id: 'anton', name: 'Anton', version: '', licence: 'SIL Open Font License 1.1', files: [`${FONTS}/anton/OFL.txt`] },
  {
    id: 'archivo-black',
    name: 'Archivo Black',
    version: '',
    licence: 'SIL Open Font License 1.1',
    files: [`${FONTS}/archivoblack/OFL.txt`]
  },
  { id: 'sora', name: 'Sora', version: '', licence: 'SIL Open Font License 1.1', files: [`${FONTS}/sora/OFL.txt`] }
]

await mkdir(out, { recursive: true })
for (const c of components) {
  if (!c.files) continue
  const texts = []
  for (const url of c.files) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: ${res.status}`)
    texts.push((await res.text()).replace(/\r\n?/g, '\n').trimEnd())
  }
  await writeFile(join(out, `${c.id}.txt`), `${texts.join('\n\n\n')}\n`)
  console.log(`${c.id}.txt: ${texts.reduce((n, t) => n + t.length, 0)} characters`)
}

const notices = {
  // The source the LGPL parts are offered from: the engine's folder, at the commit the app was built from.
  source: { repository: 'https://github.com/michaelcoleman0815/chop-shop', folder: 'mobile/engine' },
  freetype: 'Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights reserved.',
  components: components.map(({ id, name, version, licence, lgpl, same }) => ({
    name,
    version,
    licence,
    ...(lgpl ? { lgpl } : {}),
    text: `${same ?? id}.txt`
  }))
}
await writeFile(join(out, 'notices.json'), `${JSON.stringify(notices, null, 1)}\n`)
console.log(`notices.json: ${components.length} components`)
