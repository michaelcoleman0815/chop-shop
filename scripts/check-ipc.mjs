/**
 * Fails the build when the preload exposes a channel the main process never
 * registers.
 *
 * Several features once shipped with their renderer half working and their
 * main-process half absent, because a scripted edit silently failed to apply
 * and nothing compared the two sides. TypeScript cannot catch it: both halves
 * type-check perfectly while the channel simply does not exist at runtime.
 */
import { readFileSync } from 'fs'

const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')

const registered = new Set([...main.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]))
const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]))

const missing = [...invoked].filter((c) => !registered.has(c)).sort()
const unused = [...registered].filter((c) => !invoked.has(c)).sort()

if (unused.length > 0) {
  console.warn(`ipc: ${unused.length} handler(s) nothing invokes: ${unused.join(', ')}`)
}

if (missing.length > 0) {
  console.error(`ipc: ${missing.length} channel(s) invoked with no handler:`)
  for (const channel of missing) console.error(`  ${channel}`)
  process.exit(1)
}

console.log(`ipc: ${invoked.size} channels, all registered`)
