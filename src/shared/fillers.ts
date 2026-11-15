/**
 * Sounds people make while thinking. Deliberately conservative: "like",
 * "actually" and "literally" carry meaning often enough that cutting them
 * mangles sentences, so they are not here.
 *
 * Shared so the clip exporter and the edit document agree on what counts as a
 * filler: a word one side cuts and the other keeps would leave a caption for a
 * sound that is gone, or a sound with no caption.
 */
export const FILLERS: ReadonlySet<string> = new Set([
  'um',
  'umm',
  'ummm',
  'uh',
  'uhh',
  'uhhh',
  'er',
  'erm',
  'ah',
  'ahh',
  'hmm',
  'mhm',
  'mm'
])

export function isFiller(word: string): boolean {
  return FILLERS.has(word.toLowerCase().replace(/[^a-z]/gi, ''))
}
