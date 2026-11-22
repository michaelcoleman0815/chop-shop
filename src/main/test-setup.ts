import { closeSync, openSync, readSync } from 'fs'
import { createRequire } from 'module'
import { isAbsolute } from 'path'
import { promisify } from 'util'
import { afterEach } from 'vitest'
import { shellStandIn } from './test-bin'
import { patchRenames } from './windows-rename'

/**
 * Stand-in programs on Windows. Tests stand in for ffmpeg, whisper or yt-dlp
 * with a small script whose first line is #! and names Node (test-bin.ts).
 * On a Mac or Linux that line runs it; Windows runs only real programs by
 * name, so here a spawn of such a file is handed to Node, as the line would
 * hand it. A stand-in written for a shell (#!/bin/sh) can't run here at all:
 * its spawn throws, and the test that made it fails, saying so and what to
 * write instead. Nothing else is touched (a #! line naming any other program
 * is left to it), and off Windows nothing at all, unless
 * CUTALONG_STAND_INS=node asks for it there, to try the Windows way.
 */
if (process.platform === 'win32' || process.env.CUTALONG_STAND_INS === 'node') {
  const require = createRequire(import.meta.url)
  const cp = require('child_process') as Record<string, unknown>
  // Every test file's setup sees the one child_process, so what shell stand-ins were run is kept on it.
  const shellRuns = (cp.shellStandInsRun ??= []) as string[]
  afterEach(() => {
    const ran = shellRuns.splice(0)
    if (ran.length) throw new Error(ran[0])
  })
  if (!cp.standInsRunOnNode) {
    /** A file's #! line, or null: only an absolute path is read, as a stand-in's always is. */
    const hashBang = (file: unknown): string | null => {
      if (typeof file !== 'string' || !isAbsolute(file)) return null
      try {
        const fd = openSync(file, 'r')
        try {
          const head = Buffer.alloc(512)
          const read = readSync(fd, head, 0, head.length, 0)
          const line = head.toString('latin1', 0, read).split(/\r?\n/)[0]
          return line.startsWith('#!') ? line : null
        } finally {
          closeSync(fd)
        }
      } catch {
        return null
      }
    }
    /** Whether a #! line runs Node: #!/usr/bin/env node, or Node's own path. */
    const isNodeScript = (line: string | null): boolean => !!line && /^#!.*\bnode(\.exe)?\s*$/i.test(line)
    type Spawner = (file: string, ...rest: unknown[]) => unknown
    const viaNode =
      (run: Spawner): Spawner =>
      (file, ...rest) => {
        const line = hashBang(file)
        const shell = shellStandIn(file, line)
        if (shell) {
          ;(cp.shellStandInsRun as string[]).push(shell)
          throw new Error(shell)
        }
        if (!isNodeScript(line)) return run(file, ...rest)
        // The arguments are optional: options or a callback may come second.
        const [args, ...more] = Array.isArray(rest[0]) ? rest : [[], ...rest]
        return run(process.execPath, [file, ...(args as string[])], ...more)
      }
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
      const real = cp[name] as Spawner & { [promisify.custom]?: Spawner }
      const wrapped = viaNode(real) as Spawner & { [promisify.custom]?: Spawner }
      // promisify(execFile) resolves to { stdout, stderr } through this, and to stdout alone without it.
      const promised = real[promisify.custom]
      if (promised) wrapped[promisify.custom] = viaNode(promised)
      cp[name] = wrapped
    }
    cp.standInsRunOnNode = true
    // Modules that imported child_process see the same functions.
    ;(require('module') as { syncBuiltinESMExports: () => void }).syncBuiltinESMExports()
  }
}

/**
 * Renames as the app makes them on Windows (main/windows-rename.ts, which the
 * main process installs as it starts): one over a file something is reading
 * waits for it. CUTALONG_STAND_INS=node installs them elsewhere too, to try.
 */
if (process.platform === 'win32' || process.env.CUTALONG_STAND_INS === 'node') patchRenames('win32')
