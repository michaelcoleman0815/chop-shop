import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { shellStandIn, standIn } from './test-bin'

/**
 * A stand-in written for a shell (#!/bin/sh) can't run on Windows, where it
 * once failed two narration tests in a way that read as the code's fault.
 * There (and with CUTALONG_STAND_INS=node) running one fails the test, saying
 * what it is and what to write instead (test-setup.ts).
 */
const SAY = (file: string, line: string): string =>
  `${file} is a stand-in written for a shell (${line}), which Windows can't run. Write it with standIn() from src/main/test-bin.ts: a few lines of JavaScript, which run on every computer.`

describe('a stand-in written for a shell', () => {
  it('is told apart by its #! line, by path or through env', () => {
    for (const line of ['#!/bin/sh', '#!/bin/bash -e', '#!/usr/bin/env bash', '#! /bin/sh', '#!/usr/bin/env sh', '#!/bin/zsh'])
      expect(shellStandIn('/tmp/x/ffmpeg', line), line).toBe(SAY('/tmp/x/ffmpeg', line))
  })

  it('is not mistaken for a Node stand-in, any other program, or a file with no #! line', () => {
    const lines = ['#!/usr/bin/env node', `#!${process.execPath}`, '#!C:\\hostedtoolcache\\windows\\node\\22.0.0\\x64\\node.exe', '#!/usr/bin/python3', '#!/bin/shell-tool', null]
    for (const line of lines) expect(shellStandIn('/tmp/x/ffmpeg', line), String(line)).toBeNull()
  })

  // Where stand-ins run on Node: Windows, or CUTALONG_STAND_INS=node elsewhere.
  it.runIf(process.platform === 'win32' || process.env.CUTALONG_STAND_INS === 'node')('fails to run, saying so, and a Node one runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-bin-'))
    try {
      // As a test once wrote one, by hand.
      const shell = join(dir, 'ffmpeg-sh')
      writeFileSync(shell, '#!/bin/sh\nhead -c 4 /dev/zero\n', { mode: 0o755 })
      expect(() => spawnSync(shell, ['-version'])).toThrow(SAY(shell, '#!/bin/sh'))
      // The test it was run in fails with that, after it; this one takes it back, having checked it.
      const run = createRequire(import.meta.url)('child_process').shellStandInsRun as string[]
      expect(run.splice(0)).toEqual([SAY(shell, '#!/bin/sh')])
      const node = standIn(join(dir, 'ffmpeg-node'), "process.stdout.write('ran')\n")
      expect(spawnSync(node, ['-version']).stdout.toString()).toBe('ran')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
