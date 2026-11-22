import { readFileSync, existsSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { WHISPER_MODELS, whisperArgs } from './whisper-args'
import { VERBATIM_STYLE } from '../shared/raw/prompt'

const base = { model: 'small.en' as const, modelFile: '/m/ggml-small.en.bin', wav: '/t/audio.wav', prefix: '/t/out' }

/** Flags whisper-cli v1.8.2 accepts, from examples/cli/cli.cpp. */
const KNOWN = new Set([
  '-t',
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

  it('gives whisper its threads first where it runs on the CPU, and nothing else changes', () => {
    expect(whisperArgs({ ...base, threads: 6 })).toEqual(['-t', '6', ...whisperArgs(base)])
    expect(whisperArgs({ ...base, threads: undefined })).toEqual(whisperArgs(base))
  })

  // When the whisper.cpp source the app is built from is checked out
  // (scripts/build-whisper.sh puts it in .build), check each flag against it.
  const cli = '.build/whisper.cpp/examples/cli/cli.cpp'
  it.skipIf(!existsSync(cli))('uses only flags the built whisper-cli parses', () => {
    const source = readFileSync(cli, 'utf8')
    for (const flag of KNOWN) expect(source.includes(`"${flag}"`), flag).toBe(true)
  })
})

describe('hearing a long recording fast', () => {
  it('asks for one guess at each step only when told to', () => {
    const base = { model: 'small.en' as const, modelFile: '/m/small.bin', wav: '/t/a.wav', prefix: '/t/out' }
    expect(whisperArgs(base)).not.toContain('-bs')
    const fast = whisperArgs({ ...base, greedy: true })
    expect(fast.slice(fast.indexOf('-bs'), fast.indexOf('-bs') + 4)).toEqual(['-bs', '1', '-bo', '1'])
  })
})

describe('large-v3 turbo', () => {
  it('reads its 5-bit file and aligns words with its own preset', () => {
    expect(WHISPER_MODELS['large-v3-turbo'].file).toBe('ggml-large-v3-turbo-q5_0.bin')
    const args = whisperArgs({
      model: 'large-v3-turbo',
      modelFile: '/m/turbo.bin',
      wav: '/t/a.wav',
      prefix: '/t/out',
      verbatim: { names: [] }
    })
    expect(args[args.indexOf('--dtw') + 1]).toBe('large.v3.turbo')
  })
})

describe('aligned words for clips', () => {
  it('asks for the full JSON and the model’s alignment when told to align', () => {
    const base = { model: 'small.en' as const, modelFile: '/m/small.bin', wav: '/t/a.wav', prefix: '/t/out' }
    const args = whisperArgs({ ...base, greedy: true, align: true })
    expect(args).toContain('-ojf')
    expect(args.slice(args.indexOf('--dtw'), args.indexOf('--dtw') + 3)).toEqual(['--dtw', 'small.en', '-nfa'])
    expect(whisperArgs(base)).not.toContain('--dtw')
  })
})
