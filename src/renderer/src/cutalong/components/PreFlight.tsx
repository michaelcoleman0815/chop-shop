import { useState } from 'react'
import { planCostFor } from '../../../../shared/setup'
import { device } from '../api'
import { clock } from '../format'
import { footageLine, preflightSteps, SHAPES, type PreflightCard, type PreflightChoice } from '../preflight'
import { Poster } from './Poster'
import { Button } from './ui'

/**
 * Before I start: shown once, under new footage and what was asked of it,
 * before anything long runs. What you asked (which you can still change),
 * the steps I take, what it costs on your key, and the shape and captions,
 * which are yours to set before anything is cut. One primary: Start the cut.
 * Once started it folds to one line of what was chosen.
 */
export function PreFlight({
  card,
  open,
  onStart
}: {
  card: PreflightCard
  /** Waiting for an answer; false once started, or when the work it waited for is gone. */
  open: boolean
  onStart: (choice: PreflightChoice) => void
}): JSX.Element | null {
  const [ask, setAsk] = useState(card.ask)
  const [changing, setChanging] = useState(false)
  const [aspect, setAspect] = useState<PreflightChoice['aspect']>(null)
  const [captions, setCaptions] = useState(true)

  if (card.choice) {
    const shape = SHAPES.find((s) => s.id === card.choice!.aspect)?.label ?? 'As shot'
    return (
      <p className="cl-preflight-done">
        Started the cut: {shape.toLowerCase()}, {card.choice.captions ? 'with captions' : 'no captions'}.
      </p>
    )
  }
  // A card left waiting when the app closed has nothing to start any more.
  if (!open) return null

  const steps = preflightSteps(device.here, { aspect, captions })
  return (
    <section className="cl-preflight" aria-label="Before I start">
      <h2 className="cl-preflight-title">Before I start</h2>
      <div className="cl-preflight-ask">
        {card.files[0] && (
          <span className="cl-preflight-still">
            <Poster path={card.files[0].path} name={card.files[0].name} />
          </span>
        )}
        <div className="cl-preflight-said">
          <span className="cl-preflight-label">You asked</span>
          {changing ? (
            <>
              <label className="sr-only" htmlFor="cl-preflight-ask">
                What you’d like
              </label>
              <textarea
                id="cl-preflight-ask"
                className="cl-preflight-field"
                rows={3}
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
                autoFocus
              />
            </>
          ) : (
            <p className="cl-preflight-words">{ask}</p>
          )}
          <span className="cl-preflight-meta">
            {footageLine(card.files.length, card.minutes, clock)} · on {device.here}
          </span>
        </div>
      </div>

      <div className="cl-preflight-part">
        <span className="cl-preflight-label">What I’ll do</span>
        <ol className="cl-preflight-steps">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>

      <div className="cl-preflight-cost">
        <div className="cl-preflight-row">
          <span className="cl-preflight-strong">What it costs</span>
          <span className="cl-preflight-strong">{planCostFor(card.minutes ?? 10)}</span>
        </div>
        <span className="cl-preflight-meta">
          On your Anthropic key, for reading the words and planning the cut
          {card.minutes === null ? ', reckoned for 10 minutes of footage' : ''}. Transcribing and rendering are free,
          on {device.here}.
        </span>
      </div>

      <div className="cl-preflight-sets">
        <div className="cl-preflight-set">
          <span>Spoken language</span>
          <span className="cl-preflight-meta">English, which is what I transcribe here</span>
        </div>
        <div className="cl-preflight-set">
          <span id="cl-preflight-captions">Captions</span>
          <label className="cl-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={captions}
              aria-checked={captions}
              aria-labelledby="cl-preflight-captions"
              onChange={(e) => setCaptions(e.target.checked)}
            />
          </label>
        </div>
        <div className="cl-preflight-set shape">
          <span id="cl-preflight-shape">Shape</span>
          <div className="cl-segments" role="radiogroup" aria-labelledby="cl-preflight-shape">
            {SHAPES.map((s) => (
              <button
                key={s.label}
                type="button"
                role="radio"
                aria-checked={aspect === s.id}
                className={aspect === s.id ? 'on' : ''}
                onClick={() => setAspect(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="cl-actions">
        <Button variant="primary" disabled={!ask.trim()} onClick={() => onStart({ ask: ask.trim(), aspect, captions })}>
          Start the cut
        </Button>
        {!changing && (
          <Button variant="text" onClick={() => setChanging(true)}>
            Change what I asked
          </Button>
        )}
      </div>
    </section>
  )
}
