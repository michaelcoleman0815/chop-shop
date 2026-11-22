import { useState } from 'react'
import type { Cutalong } from '../useCutalong'
import { Button } from './ui'

/**
 * The few questions asked before a made video's script is written: each a
 * row of options as pills, or your own words, and one primary button that
 * writes it. Nothing is written or spent until it is pressed; typing a reply
 * in the composer answers them too (useMake).
 */
export function MakeQuestions({ app, id }: { app: Cutalong; id: string }): JSX.Element | null {
  const questions = app.make.questions(id)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [own, setOwn] = useState<Record<string, string>>({})
  if (!questions) return null
  const answerOf = (q: string): string => own[q]?.trim() || picked[q] || ''
  const ready = questions.every((q) => answerOf(q.id))
  return (
    <div className="cl-make-ask">
      {questions.map((q) => (
        <fieldset key={q.id} className="cl-make-question">
          <legend>{q.ask}</legend>
          <div className="cl-row" role="radiogroup" aria-label={q.ask}>
            {q.options.map((o) => (
              <Button
                key={o.label}
                small
                role="radio"
                aria-checked={picked[q.id] === o.adds && !own[q.id]?.trim()}
                className="cl-pill"
                onClick={() => {
                  setPicked((p) => ({ ...p, [q.id]: o.adds }))
                  setOwn((p) => ({ ...p, [q.id]: '' }))
                }}
              >
                {o.label}
              </Button>
            ))}
            <input
              className="cl-make-own"
              aria-label={`${q.ask} In your own words`}
              placeholder="Or in your own words"
              value={own[q.id] ?? ''}
              onChange={(e) => setOwn((p) => ({ ...p, [q.id]: e.target.value }))}
            />
          </div>
        </fieldset>
      ))}
      <Button variant="primary" disabled={!ready} onClick={() => void app.make.answer(id, questions.map((q) => answerOf(q.id)))}>
        Write the script
      </Button>
    </div>
  )
}
