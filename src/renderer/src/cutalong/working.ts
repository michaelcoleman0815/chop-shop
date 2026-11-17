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
  [/^finding you in the picture\b/i, 'Finding where you are in each frame, so a crop keeps you in it.'],
  [/^downloading model\b/i, 'Once only: after this, words are written down on this computer.'],
  // A video made from nothing (main/make).
  [/^downloading the voice\b/i, 'Once only: after this, the voice reads on this computer.'],
  [/^writing the script\b/i, 'Part by part, in words written to be read aloud.'],
  [/^narrating the script: timing\b/i, 'Finding when each word is said, so every shot lands on its line.'],
  [/^narrating\b/i, 'Reading every line aloud, with a breath between the parts.'],
  [/^planning the shots\b/i, 'Choosing a picture for every line, and how the camera moves over it.'],
  [/^drawing\b.*\bcharacter sheet\b/i, 'One picture of them first, so they look the same in every shot.']
]

/** The plain line under a stage: what it is doing, or else how far along it is. */
export function workingLine(stage: string, percent: number | null): string {
  const said = LINES.find(([re]) => re.test(stage.trim()))
  if (said) return said[1]
  if (percent === null) return 'This can take a minute.'
  if (percent < 15) return 'Just started.'
  if (percent < 50) return 'Under way.'
  if (percent < 85) return 'More than halfway.'
  return 'Nearly done.'
}
