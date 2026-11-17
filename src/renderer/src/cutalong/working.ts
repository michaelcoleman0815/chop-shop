/**
 * What Cutalong says while it works on something big: the stage as a title,
 * and under it one plain line about what is happening. Quick thinking keeps
 * the small row; the living mark and the line are for the long work.
 */

/** Stages that are only Claude thinking: quick, so they keep the small row. */
export function isThinking(stage: string): boolean {
  return /^thinking\b/i.test(stage.trim())
}

const LINES: [RegExp, string][] = [
  [/^(listening|transcribing)\b/i, 'Writing down every word, so cuts can fall between sentences.'],
  [/^(reading the (footage|recording)|looking through your footage)\b/i, 'Going through it shot by shot.'],
  [/^finding the beat\b/i, 'Listening to the music for where the cuts can fall.'],
  [/^finding clips\b/i, 'Reading the whole recording for moments that stand on their own.'],
  [/^watching your (videos|clips)\b/i, 'Learning your pace, your cuts and your sound.'],
  [/^looking for b-roll\b/i, 'Looking through your sources for shots that fit what is said.'],
  [/^finding you in the picture\b/i, 'Finding where you are in each frame, so a crop keeps you in it.']
]

/** The transcription model's download, as "Downloading model" or by its name ("Downloading base.en"). */
const DOWNLOAD = /^downloading (model|(tiny|base|small|medium|large)\S*)\b/i

/**
 * The plain line under a stage: what it is doing, or else how far along it
 * is. `here` names the device, as a sentence would: "this computer", "this phone".
 */
export function workingLine(stage: string, percent: number | null, here = 'this computer'): string {
  if (DOWNLOAD.test(stage.trim())) return `Once only: after this, words are written down on ${here}.`
  const said = LINES.find(([re]) => re.test(stage.trim()))
  if (said) return said[1]
  if (percent === null) return 'This can take a minute.'
  if (percent < 15) return 'Just started.'
  if (percent < 50) return 'Under way.'
  if (percent < 85) return 'More than halfway.'
  return 'Nearly done.'
}
