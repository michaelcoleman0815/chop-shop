import { onWindows } from './platform'

/** The longest name a project gets, in characters: room for " 12.cutalong" within any file system's 255 bytes. */
export const PROJECT_NAME_CHARS = 50

/**
 * A project's name, from a file's name or the first thing typed: one line,
 * with "-" for the characters a file name can't have, no leading dot (which
 * hides a file on a Mac), and at most 50 characters, cut where a word ends.
 * A first message can be a paragraph; as the name of the file the chat is
 * saved in it was too long to save, and the chat was lost.
 */
export function projectName(raw: string): string {
  const name = plainName(raw)
  return onWindows ? notADevice(name) : name
}

/**
 * Windows keeps a few names for its devices, whatever follows the first dot:
 * a file called "Con.mp4" or "aux.cutalong" cannot be made there, and
 * writing to one writes to nowhere. Such a name gets an underscore.
 */
export function notADevice(name: string): string {
  return name.replace(/^[^.]*/, (first) =>
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(first.trimEnd()) ? `${first.trimEnd()}_` : first
  )
}

function plainName(raw: string): string {
  const line = raw
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
  const chars = Array.from(line)
  if (chars.length === 0) return 'Untitled'
  if (chars.length <= PROJECT_NAME_CHARS) return line
  const cut = chars.slice(0, PROJECT_NAME_CHARS).join('')
  const space = cut.lastIndexOf(' ')
  return (space >= PROJECT_NAME_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '')
}
