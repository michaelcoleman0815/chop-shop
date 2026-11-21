import { useState } from 'react'
import type { EditDoc, Op } from '../../../../shared/edit'
import type { Resolved } from '../../../../shared/edit/resolve'
import { biggerOp, holdOp, landingWord, pickLine, pickOf } from '../picktools'
import { toggleLabel, toggleOps } from '../word-track'
import { Button } from './ui'

/**
 * The tools that follow a word pick, on the word track (a phone, a narrow
 * window) and under the script (a computer): what was picked and how long it
 * is, then cut it (or bring it back), make it bigger, hold a beat longer, a
 * sound on it, and a line to say anything else about these words, which is
 * left as a note on the beats they span.
 */
export function PickTools({
  doc,
  resolved,
  marked,
  onApply,
  onSound,
  onNote,
  onClear
}: {
  doc: EditDoc
  resolved: Resolved
  marked: ReadonlySet<string>
  onApply: (ops: Op[], fallback: string) => void
  /** Opens the sounds sheet on a word (SoundSheet). */
  onSound?: (wordId: string) => void
  /** Leaves a note on the beats the words span. */
  onNote?: (text: string, range: { from: string; to: string }) => void
  onClear: () => void
}): JSX.Element {
  const [say, setSay] = useState('')
  const pick = pickOf(doc, resolved, marked)
  const word = landingWord(pick)
  const bigger = biggerOp(pick)
  const hold = holdOp(pick)
  const done = (ops: Op[], fallback: string): void => {
    onApply(ops, fallback)
    onClear()
  }
  const send = (): void => {
    const text = say.trim()
    if (!text || !pick.beats || !onNote) return
    onNote(`${text} (on “${pick.quote}”)`, pick.beats)
    setSay('')
    onClear()
  }
  return (
    <div className="cl-picktools" role="group" aria-label="What to do with the words you picked">
      <div className="cl-picktools-head">
        <span className="cl-picktools-quote">“{pick.quote}”</span>
        <span className="cl-picktools-meta">{pickLine(pick)}</span>
      </div>
      <div className="cl-picktools-row">
        <Button small onClick={() => done(toggleOps(doc, marked), 'Words changed.')}>
          {toggleLabel(doc, marked)}
        </Button>
        {bigger && (
          <Button small onClick={() => done([bigger], 'Made it bigger.')}>
            {pick.playing.length > 1 && word ? `Make “${word.text.replace(/[^\p{L}\p{N}'’-]/gu, '')}” bigger` : 'Make it bigger'}
          </Button>
        )}
        {hold && (
          <Button small onClick={() => done([hold], 'Held it a beat longer.')}>
            Hold a beat longer
          </Button>
        )}
        {word && onSound && (
          <Button
            small
            onClick={() => {
              onSound(word.id)
              onClear()
            }}
          >
            A sound here
          </Button>
        )}
        <Button variant="text" small onClick={onClear}>
          Clear
        </Button>
      </div>
      {onNote && pick.beats && (
        <form
          className="cl-picktools-say"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <label className="sr-only" htmlFor="cl-picktools-say">
            Say what to do with these words
          </label>
          <input
            id="cl-picktools-say"
            value={say}
            placeholder="Say what to do with them"
            onChange={(e) => setSay(e.target.value)}
          />
          <Button variant="primary" small type="submit" disabled={!say.trim()}>
            Add note
          </Button>
        </form>
      )}
    </div>
  )
}
