import { readFileSync, existsSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { whisperArgs } from './whisper-args'
import { VERBATIM_STYLE } from '../shared/raw/prompt'

const base = { model: 'small.en' as const, modelFile: '/m/ggml-small.en.bin', wav: '/t/audio.wav', prefix: '/t/out' }

/** Flags whisper-cli v1.8.2 accepts, from examples/cli/cli.cpp. */
const KNOWN = new Set([
  '-m',
  '-f',
  '-of',
  '-ml',
  '-sow',
  '-pp',
  '-oj',
  '-ojf',
  '--prompt',
  '--carry-initial-prompt',
  '-mc',
  '--dtw',
  '-nfa'
])

/** Presets whisper-cli v1.8.2 knows for --dtw. */
const DTW_PRESETS = ['tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en', 'medium', 'medium.en']

describe('whisper-cli arguments', () => {
  it('leaves captions of finished videos as they were', () => {
    expect(whisperArgs(base)).toEqual([
      '-m',
      base.modelFile,
      '-f',
      base.wav,
      '-of',
      base.prefix,
      '-ml',
      '1',
      '-sow',
      '-pp',
      '-oj'
    ])
  })

  it('asks for every word, the names and the aligned onsets for raw footage', () => {
    const args = whisperArgs({ ...base, verbatim: { names: ['Pixel 9 Pro', 'M4 MacBook Air'] } })
    const flags = args.filter((a) => a.startsWith('-'))
    for (const f of flags) expect(KNOWN.has(f), f).toBe(true)
    const value = (flag: string): string => args[args.indexOf(flag) + 1]
    expect(value('--prompt')).toBe(`${VERBATIM_STYLE} Pixel 9 Pro, M4 MacBook Air.`)
    expect(args).toContain('--carry-initial-prompt')
    expect(args).toContain('-ojf')
    expect(args).not.toContain('-oj')
    // A budget under the prompt's length: none left for text carried between windows.
    const mc = Number(value('-mc'))
    expect(mc).toBeGreaterThanOrEqual(8)
    expect(mc).toBeLessThan(66)
    // The alignment only runs with flash attention off.
    expect(value('--dtw')).toBe('small.en')
    expect(args).toContain('-nfa')
    for (const m of ['base.en', 'small.en', 'medium.en'] as const) {
      expect(DTW_PRESETS).toContain(
        whisperArgs({ ...base, model: m, verbatim: { names: [] } })[args.indexOf('--dtw') + 1]
      )
    }
  })

  // When the whisper.cpp source the app is built from is checked out
  // (scripts/build-whisper.sh puts it in .build), check each flag against it.
  const cli = '.build/whisper.cpp/examples/cli/cli.cpp'
  it.skipIf(!existsSync(cli))('uses only flags the built whisper-cli parses', () => {
    const source = readFileSync(cli, 'utf8')
    for (const flag of KNOWN) expect(source.includes(`"${flag}"`), flag).toBe(true)
  })
})
