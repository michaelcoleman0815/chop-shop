#!/usr/bin/env node
/**
 * fetch-fonts.sh for a computer without bash: the same caption faces, read
 * from that script's own fetch lines, so the list is kept in one place. A
 * preset naming a font that is not here does not fail: libass quietly
 * substitutes something else, so the style renders wrong with no error.
 *
 *   node scripts/fetch-fonts.mjs
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = readFileSync(join(root, 'scripts', 'fetch-fonts.sh'), 'utf8')
const dest = join(root, 'resources', 'fonts')

const vars = Object.fromEntries([...script.matchAll(/^([A-Z_]+)="([^"$]*)"\s*$/gm)].map((m) => [m[1], m[2]]))
const fonts = [...script.matchAll(/^fetch\s+"([^"]+)"\s+"([^"]+)"/gm)].map((m) => ({
  name: m[1],
  url: m[2].replace(/\$\{?([A-Z_]+)\}?/g, (_, v) => {
    if (!(v in vars)) throw new Error(`fetch-fonts.sh uses $${v}, which it does not set`)
    return vars[v]
  })
}))
if (fonts.length === 0) throw new Error('found no fetch lines in fetch-fonts.sh')

mkdirSync(dest, { recursive: true })
for (const { name, url } of fonts) {
  const path = join(dest, name)
  if (existsSync(path) && statSync(path).size > 0) {
    console.log(`have ${name}`)
    continue
  }
  let bytes = null
  for (let attempt = 1; !bytes; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`${url} answered ${res.status}`)
      bytes = Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (attempt >= 3) throw err
      console.log(`retrying ${name}: ${err.message}`)
    }
  }
  writeFileSync(path, bytes)
  console.log(`fetched ${name}`)
}
