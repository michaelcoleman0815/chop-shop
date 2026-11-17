import { chmodSync, writeFileSync } from 'fs'

/**
 * Stand-in programs for tests: ffmpeg, whisper or yt-dlp played by a few
 * lines of JavaScript, so one stand-in runs on a Mac, on Linux and on
 * Windows. On a Mac or Linux its #! line runs it; Windows runs no script by
 * its name, so there the test setup (test-setup.ts) hands it to Node.
 *
 * The path is where the code under test looks: on Windows a stand-in for
 * whisper-cli.exe is a file of that name holding JavaScript.
 *
 * Only tests import this.
 */
export function standIn(path: string, source: string): string {
  const node = process.execPath.includes(' ') ? '/usr/bin/env node' : process.execPath
  writeFileSync(path, `#!${node}\n${source}`)
  chmodSync(path, 0o755)
  return path
}

/** A program's file name on this computer: Windows' end in .exe. */
export const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

/**
 * A stand-in's way of handing over to the real program, as a shell's exec
 * would: the same arguments, the same pipes, and it ends as the real one
 * ended, with its code or by its signal.
 */
export const HAND_OVER = String.raw`
function handOver(real, args) {
  const r = require('child_process').spawnSync(real, args, { stdio: 'inherit' })
  if (r.error) {
    process.stderr.write(String(r.error) + '\n')
    process.exit(127)
  }
  if (r.signal) process.kill(process.pid, r.signal)
  process.exit(r.status === null ? 1 : r.status)
}
`
