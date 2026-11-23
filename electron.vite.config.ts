import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // The app's bridge, and the export's 3D page's one channel (main/three-render.ts).
        input: { index: resolve('src/preload/index.ts'), three: resolve('src/preload/three.ts') }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        // The app, and the page the export draws 3D clips in (renderer/three.html).
        input: { index: resolve('src/renderer/index.html'), three: resolve('src/renderer/three.html') }
      }
    }
  }
})
