import { useState } from 'react'
import { KEY_STEPS } from '../../../../shared/make/key-steps'
import type { Cutalong } from '../useCutalong'
import { Button } from './ui'

/**
 * What a made video's quote shows under its sentence: the outline it will
 * follow, the script behind "Edit the script" (changed there, it is quoted
 * again), and, when a service's key is missing, how to get one. The cost
 * lines stay behind the reply's own Details.
 */
export function MakeBrief({ app, id }: { app: Cutalong; id: string }): JSX.Element | null {
  const draft = app.make.draft(id)
  const [editing, setEditing] = useState(false)
  const [script, setScript] = useState<string | null>(null)
  if (!draft) return null
  const keys = draft.quote.keys
  return (
    <div className="cl-make">
      {draft.outline.length > 0 && (
        <ol className="cl-make-outline" aria-label="Outline">
          {draft.outline.map((h, i) => (
            <li key={`${i}-${h}`}>{h}</li>
          ))}
        </ol>
      )}
      {draft.script && (
        <button type="button" className="cl-link" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>
          {editing ? 'Hide the script' : 'Edit the script'}
        </button>
      )}
      {editing && (
        <label className="cl-field">
          <span className="sr-only">Script</span>
          <textarea rows={12} value={script ?? draft.script} onChange={(e) => setScript(e.target.value)} />
          <span className="cl-row">
            <Button
              disabled={script === null || script.trim() === draft.script.trim()}
              onClick={() => {
                if (script === null) return
                setEditing(false)
                void app.make.editScript(id, script)
              }}
            >
              Quote this script
            </Button>
          </span>
        </label>
      )}
      {keys.map((k) => {
        const s = KEY_STEPS[k]
        return (
          <div key={k} className="cl-make-key" role="note" aria-label={`Getting a ${s.name} key`}>
            <p className="cl-aside">To use {s.name}, add its key in Settings:</p>
            <ol>
              {s.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        )
      })}
    </div>
  )
}
