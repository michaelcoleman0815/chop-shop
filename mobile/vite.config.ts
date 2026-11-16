import { readFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The phone app's page: the Mac's React app (src/renderer/src/cutalong) on
 * the phone's host (src/host), built into dist for Capacitor. The shared
 * main-process modules it runs import Node's 'path', which is POSIX on a
 * phone and comes from src/shims/path.ts.
 */
const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '..')
const version = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version

export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
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
