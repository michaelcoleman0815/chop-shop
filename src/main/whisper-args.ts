import { contextBudget, whisperPrompt } from '../shared/raw/prompt'

export type WhisperModel = 'base.en' | 'small.en' | 'medium.en'

/**
 * Raw footage: write down what was said, fillers, false starts and retakes
 * included, listen for the names the creator uses, and listen again where
 * words went missing. Off for captions of finished videos.
 */
export interface VerbatimOptions {
  /** Product names and other names to listen for, most important first. */
  names: string[]
}

/**
 * whisper-cli's arguments. Every flag is checked against whisper.cpp v1.8.2,
 * the version scripts/build-whisper.sh builds (examples/cli/cli.cpp).
 */
export function whisperArgs(o: {
  model: WhisperModel
  modelFile: string
  wav: string
  prefix: string
  verbatim?: VerbatimOptions
}): string[] {
  const args = [
    '-m',
    o.modelFile,
    '-f',
    o.wav,
    '-of',
    o.prefix,
    // One token per segment is what yields real per-word timings; without it
    // whisper spreads words evenly across a whole segment.
    '-ml',
    '1',
    // A token is not a word: alone, -ml 1 cuts "epileptic" into "epile" and
    // "ptic", and each fragment becomes its own caption. Splitting on word
    // boundaries instead is what makes word-level captions read as speech.
    '-sow',
    // --print-progress is the only way to see how far along a long file is.
    // -np would suppress it along with everything else.
    '-pp'
  ]
  if (!o.verbatim) return [...args, '-oj']
  const prompt = whisperPrompt(o.verbatim.names)
  return [
    ...args,
    // Each token with how sure Whisper was of it, and its aligned onset.
    '-ojf',
    // The verbatim prompt on every window, and a context budget it fills, so
    // no text is carried from one window to the next: carried text is what
    // lets Whisper skip or merge a retake (docs/research/raw-footage.md).
    '--prompt',
    prompt,
    '--carry-initial-prompt',
    '-mc',
    String(contextBudget(prompt)),
    // Word onsets from the attention alignment. whisper-cli turns flash
    // attention on by default, and whisper.cpp quietly turns the alignment
    // off when it is on; that is why an earlier -dtw trial changed nothing.
    '--dtw',
    o.model,
    '-nfa'
  ]
}
