import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Only for desktop-args.test.ts, which writes the desktop renderer's
// arguments for the phone's self-test (the repository's own tests are
// src/**/*.test.ts and never include it).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['desktop-args.test.ts'],
    environment: 'node'
  }
})
