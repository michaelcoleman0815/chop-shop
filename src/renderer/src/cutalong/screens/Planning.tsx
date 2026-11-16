import { useEffect, useState } from 'react'
import type { Settings } from '../../../../shared/types'
import { api } from '../api'
import { Button } from '../components/ui'

/**
 * Who plans the edits: Claude, the default, or a model on this Mac through
 * Ollama, which is free and offline and plans less well. The main process
 * checks a local model's plans exactly as it checks Claude's.
 */
export function Planning({
  settings,
  onSettings
}: {
  settings: Settings | null
  onSettings: (next: Settings) => void
}): JSX.Element {
  const [local, setLocal] = useState<{ up: boolean; models: { name: string }[] } | null>(null)

  useEffect(() => {
    void api.localPlanners().then(setLocal)
  }, [])

  const chosen = settings?.localPlanner ?? null
  const pick = async (localPlanner: string | null): Promise<void> => onSettings(await api.setSettings({ localPlanner }))
  const names = local?.models.map((m) => m.name) ?? []

  return (
    <section className="cl-section" aria-labelledby="set-planning">
      <h2 id="set-planning">Planning edits</h2>
      <p className="cl-reply">
        {chosen
          ? `I plan the edits with ${chosen} on this Mac, for free and offline. Claude plans them better.`
          : 'Claude plans the edits. A model on this Mac can plan them for free and offline, though not as well.'}
      </p>
      {names.length > 0 ? (
        <div className="cl-segments" role="radiogroup" aria-label="Plan edits with">
          {[null, ...names].map((name) => {
            const on = chosen === name
            return (
              <button
                key={name ?? 'claude'}
                type="button"
                role="radio"
                aria-checked={on}
                className={on ? 'on' : ''}
                disabled={!settings}
                onClick={() => void pick(name)}
              >
                {name ?? 'Claude'}
              </button>
            )
          })}
        </div>
      ) : local ? (
        <div className="cl-row">
          <p className="cl-aside">
            {local.up
              ? 'Ollama is running on this Mac with no models pulled yet.'
              : 'Ollama is not running on this Mac. Start it, and the models it has show up here.'}
          </p>
          {chosen && (
            <Button small onClick={() => void pick(null)}>
              Plan with Claude
            </Button>
          )}
        </div>
      ) : null}
    </section>
  )
}
