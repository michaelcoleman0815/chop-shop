import { contextBudget, whisperPrompt } from '../shared/raw/prompt'

export type WhisperModel = 'base.en' | 'small.en' | 'medium.en' | 'large-v3-turbo'

/**
 * Each model's file in whisper.cpp's model repository, and the alignment preset whisper-cli knows it by
 * for word onsets (--dtw). Turbo is the large-v3 model with four decoder layers instead of thirty-two,
 * kept here in its 5-bit form: a third of the full file's size, the same words on the GPU.
 */
export const WHISPER_MODELS: Record<WhisperModel, { file: string; dtw: string }> = {
  'base.en': { file: 'ggml-base.en.bin', dtw: 'base.en' },
  'small.en': { file: 'ggml-small.en.bin', dtw: 'small.en' },
  'medium.en': { file: 'ggml-medium.en.bin', dtw: 'medium.en' },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo-q5_0.bin', dtw: 'large.v3.turbo' }
}

/**
 * Raw footage: write down what was said, fillers, false starts and retakes
 * included, listen for the names the creator uses, and listen again where
 * words went missing. Off for captions of finished videos.
 */
export interface VerbatimOptions {
  /** Product names and other names to listen for, most important first. */
  names: string[]
  /**
   * Listen again where there is sound no word accounts for (transcribe.ts),
   * for the takes raw footage hides. Off for a finished video, whose music
   * would only be heard as words that were never said.
   */
  again?: boolean
  /** In place of the verbatim style: a stretch listened to alone for its fillers (main/filler-listen). */
  prompt?: string
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
  /** Threads, where whisper runs on the CPU (Windows); whisper-cli's own four when absent. */
  threads?: number
  /**
   * One guess at each step instead of five: about two and a half times faster on the medium model, and on
   * clear speech the same words (main/clipping hears a long recording this way). Edits keep the search.
   */
  greedy?: boolean
  /**
   * Word onsets from the attention alignment, as the verbatim pass has them. Without it a word's time is
   * Whisper's guess from its segment, which on a sermon clip put half the captions a quarter-second or
   * more early and the worst nearly six; with it, within a tenth of a second, for a third more time.
   */
  align?: boolean
}): string[] {
  const args = [
    ...(o.threads ? ['-t', String(o.threads)] : []),
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
    '-pp',
    ...(o.greedy ? ['-bs', '1', '-bo', '1'] : [])
  ]
  if (!o.verbatim) return o.align ? [...args, '-ojf', '--dtw', WHISPER_MODELS[o.model].dtw, '-nfa'] : [...args, '-oj']
  const prompt = o.verbatim.prompt ?? whisperPrompt(o.verbatim.names)
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
    WHISPER_MODELS[o.model].dtw,
    '-nfa'
  ]
}
