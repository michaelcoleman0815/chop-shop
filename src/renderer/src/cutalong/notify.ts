import { currentVersion } from '../../../shared/edit/doc'
import { resolveCut } from '../../../shared/edit/resolve'
import type { EditDoc } from '../../../shared/edit'
import type { NoteIn } from '../../../shared/types'
import { clock } from './format'
import { shapeWord } from './home'

/**
 * Whether Cutalong tells you, with a note from the system, when long work
 * finishes while you are in another app (main/notify.ts). Asked once, under
 * the first long work on a computer, and remembered here: 'on', 'off', or
 * null while not yet asked. A phone never asks: its work pauses when the app
 * is put away, and it keeps the screen on while it runs.
 */
const KEY = 'cutalong:notify'

export function notifyChoice(): 'on' | 'off' | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'on' || v === 'off' ? v : null
  } catch {
    return 'off'
  }
}

export function setNotify(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // Without storage the question is asked again next time.
  }
}

/** The note for a version just made: "v3 of Google Book review is ready", its length, shape and captions, then its summary. */
export function versionNote(doc: EditDoc): NoteIn {
  const v = currentVersion(doc)
  let length: string | null = null
  try {
    length = clock(resolveCut(v.cut, doc.words, doc.sources).durationSec)
  } catch {
    length = null
  }
  const facts = [length, shapeWord(v.cut.aspect), v.cut.captions.on ? 'captions on' : 'no captions'].filter(Boolean)
  const said = v.summary.trim()
  return {
    title: `v${v.n} of ${doc.title} is ready`,
    body: `${facts.join(', ')}.${said ? ` ${said}` : ''} Export it?`,
    actions: ['Export', 'Watch']
  }
}

/** The note for a finished export. */
export function exportNote(title: string, line: string): NoteIn {
  return { title: `${title} is exported`, body: line, actions: [] }
}
