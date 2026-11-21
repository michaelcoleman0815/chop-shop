import { beatWords, currentCut, indexWords, type EditDoc, type Op } from '../../../shared/edit'

/**
 * The words of the edit in order, as the script and the word track show them:
 * every word the cut's beats cover, struck ones included, each with its beat.
 */
export interface TrackWord {
  id: string
  text: string
  beat: string
  struck: boolean
}

export function trackWords(doc: EditDoc): TrackWord[] {
  const cut = currentCut(doc)
  const struck = new Set(cut.removed)
  return cut.beats.flatMap((beat) =>
    beatWords(doc, beat).map((w) => ({ id: w.id, text: w.text, beat: beat.id, struck: struck.has(w.id) }))
  )
}

/**
 * The ops that toggle the marked words: each run of neighbouring words of the
 * same kind becomes one strike, or one unstrike, from its first word to its last.
 */
export function toggleOps(doc: EditDoc, marked: Iterable<string>): Op[] {
  const struck = new Set(currentCut(doc).removed)
  const index = indexWords(doc.words)
  const ids = [...marked].sort((a, b) => (index.pos.get(a) ?? 0) - (index.pos.get(b) ?? 0))
  const ops: Op[] = []
  let run: string[] = []
  const flush = (): void => {
    if (run.length === 0) return
    ops.push({ op: struck.has(run[0]) ? 'unstrike' : 'strike', from: run[0], to: run[run.length - 1] })
    run = []
  }
  for (const id of ids) {
    const prev = run[run.length - 1]
    const adjacent = prev !== undefined && (index.pos.get(id) ?? -2) === (index.pos.get(prev) ?? -9) + 1
    if (!adjacent || struck.has(id) !== struck.has(prev)) flush()
    run.push(id)
  }
  flush()
  return ops
}

/** What applying the marked words does, as the button says it. */
export function toggleLabel(doc: EditDoc, marked: Iterable<string>): string {
  const struck = new Set(currentCut(doc).removed)
  const ids = [...marked]
  const cutting = ids.filter((id) => !struck.has(id)).length
  const restoring = ids.length - cutting
  const words = (n: number): string => (n === 1 ? '1 word' : `${n} words`)
  if (cutting && restoring) return `Cut ${cutting} and bring back ${restoring} words`
  return cutting ? `Cut ${words(cutting)}` : `Bring back ${words(restoring)}`
}
