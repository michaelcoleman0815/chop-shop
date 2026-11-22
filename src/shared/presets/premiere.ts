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
  /** Set when the edit went back onto the Premiere sequence it was made from: that sequence's name. */
  sequence?: string
}): { text: string; aside: string | null } {
  const f = r.facts
  if (r.sequence !== undefined) return returnReply({ ...r, sequence: r.sequence })
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

/**
 * The reply when an edit goes back onto the Premiere sequence it was made
 * from: what was added, on tracks of their own, and that the cuts are as
 * they were.
 */
function returnReply(r: {
  xmlPath: string
  srtPath: string | null
  opened: string | null
  facts: PremiereFacts
  sequence: string
}): { text: string; aside: string | null } {
  const f = r.facts
  const added = [
    f.cutaways ? plural(f.cutaways, 'cutaway') : null,
    f.music ? 'the music' : null,
    f.sounds ? plural(f.sounds, 'sound effect') : null
  ].filter((x): x is string => x !== null)
  const name = fileName(r.xmlPath)
  const where = r.opened ? `I opened ${name} in Premiere` : `${name} is ready for Premiere`
  const text = [
    added.length ? `${where}: ${r.sequence} with ${list(added)} on tracks of their own.` : `${where}.`,
    r.srtPath
      ? `The captions are in ${fileName(r.srtPath)}; drag it onto the sequence.`
      : added.length
        ? null
        : 'There is nothing new in it yet: ask for captions, sound effects, music or cutaways first.',
    f.cuts === 1 ? 'Your clip is where it was.' : `Your ${f.cuts} clips are where they were.`,
    r.opened ? null : 'I didn’t find Premiere on this computer, so it is beside your exports.'
  ]
    .filter(Boolean)
    .join(' ')
  const kept = f.leftOut.filter((x) => x !== 'the loudness' && x !== 'the voice polish')
  if (kept.length === 0) return { text, aside: null }
  const left = list(kept)
  const many = kept.length > 1 || /^([2-9]|\d{2,})/.test(kept[0])
  const markers = f.markers > 0 ? '; markers in Premiere show where' : ''
  return { text, aside: `${left.charAt(0).toUpperCase()}${left.slice(1)} ${many ? 'stay' : 'stays'} in Cutalong${markers}.` }
}
