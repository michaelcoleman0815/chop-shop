import type { ReactNode } from 'react'
import { keyGuide, type KeyServiceId } from '../../../../shared/setup'
import { Icon } from './ui'

/**
 * How to get a service's key, as numbered steps with the page each one
 * happens on (shared/setup/guides.ts). The setup screen on Start, Settings
 * and any feature that needs a key show these same steps. Every page opens in
 * the browser; the last step, pasting the key, holds the field when one is
 * given, and the step that fixes what went wrong is drawn as the one to do.
 */

/** "an Anthropic key", "a fal.ai key". */
export function aKey(name: string): string {
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} key`
}

export function KeySteps({
  service,
  current = null,
  paste
}: {
  service: KeyServiceId
  /** The step that fixes what went wrong, counted from 0. */
  current?: number | null
  /** The field the key is pasted into, in the last step, and the id its label points at. */
  paste?: { id: string; field: ReactNode }
}): JSX.Element {
  const guide = keyGuide(service)
  const last = guide.steps.length - 1
  return (
    // A list without bullets is still read as a list, numbered.
    <ol className="cl-steps" role="list" aria-label={`How to get ${aKey(guide.name)}`}>
      {guide.steps.map((step, i) => {
        const now = i === current
        return (
          <li key={step.text} className={now ? 'now' : undefined} aria-current={now ? 'step' : undefined}>
            <span className="cl-step-n" aria-hidden="true">
              {i + 1}
            </span>
            {i === last && paste ? (
              <label className="cl-step-text" htmlFor={paste.id}>
                {step.text}
              </label>
            ) : (
              <span className="cl-step-text">{step.text}</span>
            )}
            {step.link && (
              <a className="cl-btn secondary small cl-step-link" href={step.link.url} target="_blank" rel="noreferrer">
                {step.link.label}
                <Icon.external />
                <span className="sr-only">, opens in your browser</span>
              </a>
            )}
            {i === last && paste && <div className="cl-step-field">{paste.field}</div>}
          </li>
        )
      })}
    </ol>
  )
}
