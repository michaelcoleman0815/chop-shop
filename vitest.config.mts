import { defineConfig } from 'vitest/config'

/**
 * Unit tests live beside the code they cover, as *.test.ts. Main-process tests
 * that need real media run the system ffmpeg against clips they synthesise
 * themselves, so nothing depends on a file only one machine has. Stand-in
 * programs are scripts with a #! line, which src/main/test-setup.ts runs on
 * Windows too.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    setupFiles: ['src/main/test-setup.ts']
  }
})
