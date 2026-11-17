import { execFileSync } from 'child_process'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * The phone app's page: the Mac's React app (src/renderer/src/cutalong) on
 * the phone's host (src/host), built into dist for Capacitor. The shared
 * main-process modules it runs import Node's 'path', which is POSIX on a
 * phone and comes from src/shims/path.ts.
 *
 * CUTALONG_DRIVE=1 builds in the app's own flow for CI (src/host/drive.ts),
 * which runs only when the runner has put drive.json in the app's documents.
 * A build for the stores leaves it out.
 */
const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '..')
const version = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version

/** The commit the app is built from, which the source offer in Settings' Licences names. */
function commit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

interface PackageJson {
  name: string
  version: string
  license?: string | { type?: string }
  licenses?: { type?: string }[]
}

/**
 * The npm packages the page is built from, each with its licence, written
 * as licences/packages.json beside what scripts/licences.mjs fetched for
 * the engine, the fonts and the models.
 */
function packageLicences(): Plugin {
  return {
    name: 'cutalong-package-licences',
    apply: 'build',
    generateBundle(_options, bundle) {
      const dirs = new Set<string>()
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue
        for (const id of Object.keys(file.modules)) {
          const path = id.replace(/^\0/, '').split('?')[0]
          const at = path.lastIndexOf('/node_modules/')
          if (at < 0) continue
          const [scope, name] = path.slice(at + '/node_modules/'.length).split('/')
          dirs.add(join(path.slice(0, at), 'node_modules', scope.startsWith('@') ? `${scope}/${name}` : scope))
        }
      }
      const packages = new Map<string, { name: string; version: string; licence: string; text: string | null }>()
      for (const dir of dirs) {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson
        const licence =
          typeof pkg.license === 'string'
            ? pkg.license
            : (pkg.license?.type ?? pkg.licenses?.map((l) => l.type).join(' or ') ?? 'see the package')
        const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|-|$)/i.test(f))
        const text = file ? readFileSync(join(dir, file), 'utf8').replace(/\r\n?/g, '\n').trim() : null
        packages.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, licence, text })
      }
      this.emitFile({
        type: 'asset',
        fileName: 'licences/packages.json',
        source: JSON.stringify([...packages.values()].sort((a, b) => a.name.localeCompare(b.name)))
      })
    }
  }
}

export default defineConfig({
  root: here,
  base: './',
  plugins: [react(), packageLicences()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit()),
    __DRIVE__: JSON.stringify(process.env.CUTALONG_DRIVE === '1')
  },
  resolve: {
    alias: [{ find: /^path$/, replacement: resolve(here, 'src/shims/path.ts') }],
    // One React for the app and the phone's entry.
    dedupe: ['react', 'react-dom']
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // iOS 15 and Android's WebView: what Capacitor 8 runs on.
    target: ['es2020', 'safari15', 'chrome100'],
    chunkSizeWarningLimit: 4000
  },
  server: { fs: { allow: [root] } }
})
