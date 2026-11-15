import { defineConfig } from 'vitest/config'

/**
 * Unit tests live beside the code they cover, as *.test.ts. Main-process tests
 * that need real media run the system ffmpeg against clips they synthesise
 * themselves, so nothing depends on a file only one machine has.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000
  }
})
