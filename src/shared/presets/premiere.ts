/**
 * /premiere: the current version as a Premiere project, cut on the person's
 * own files. The project is made in the main process (main/premiere-cut.ts);
 * this is what it carried, and the reply that says so.
 */

/** What a Premiere project carries, counted, and what stays in Cutalong. */
export interface PremiereFacts {
  /** Cuts on the picture track. */
  cuts: number
  recordings: number
  /** Beats that show a cutaway. */
  cutaways: number
  music: boolean
  sounds: number
  markers: number
  /** As phrases for a sentence: "the look", "2 camera moves". */
  leftOut: string[]
}

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`

const list = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** The reply: where the project went, what it has, and what stayed in Cutalong. */
export function premiereReply(r: {
  xmlPath: string
  srtPath: string | null
  /** The Premiere it opened in, when there is one on this computer. */
  opened: string | null
  facts: PremiereFacts
}): { text: string; aside: string | null } {
  const f = r.facts
  const has = [
    `${plural(f.cuts, 'cut')} from ${f.recordings === 1 ? 'your recording' : `${f.recordings} recordings`}`,
    f.cutaways ? plural(f.cutaways, 'cutaway') : null,
    f.music ? 'the music' : null,
    f.sounds ? plural(f.sounds, 'sound effect') : null
  ].filter((x): x is string => x !== null)
  const name = fileName(r.xmlPath)
  const text = [
    r.opened
      ? `I opened ${name} in Premiere: ${list(has)}, on your own files.`
      : `${name} is ready for Premiere: ${list(has)}, on your own files.`,
    r.srtPath ? `The captions are in ${fileName(r.srtPath)}.` : null,
    r.opened ? null : 'I didn’t find Premiere on this computer, so it is beside your exports.'
  ]
    .filter(Boolean)
    .join(' ')
  if (f.leftOut.length === 0) return { text, aside: null }
  const left = list(f.leftOut)
  // "The look stays", "2 camera moves stay".
  const many = f.leftOut.length > 1 || /^([2-9]|\d{2,})/.test(f.leftOut[0])
  const where = f.markers > 0 ? '; markers in Premiere show where' : ''
  return {
    text,
    aside: `${left.charAt(0).toUpperCase()}${left.slice(1)} ${many ? 'stay' : 'stays'} in Cutalong${where}.`
  }
}
