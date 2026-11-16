import { useState } from 'react'
import { KEY_STEPS } from '../../../../shared/make/key-steps'
import { listOf } from '../../../../shared/make/quote'
import type { Cutalong } from '../useCutalong'
import { Button } from './ui'

const COUNT = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

/**
 * What a made video's quote shows under its sentence: the parts it will
 * follow, in a sentence; the script, opened by the reply's "Edit the script"
 * button and quoted again when changed; and, when a service's key is
 * missing, how to get one. The cost lines stay behind the reply's Details.
 */
export function MakeBrief({ app, id }: { app: Cutalong; id: string }): JSX.Element | null {
  const draft = app.make.draft(id)
  const open = app.make.scriptOpen(id)
  const [script, setScript] = useState<string | null>(null)
  if (!draft) return null
  const parts = draft.outline.filter(Boolean)
  const changed = script !== null && script.trim() !== draft.script.trim()
  return (
    <div className="cl-make">
      {parts.length > 1 && (
        <p className="cl-aside">
          In {COUNT[parts.length] ?? parts.length} parts: {listOf(parts)}.
        </p>
      )}
      {open && (
        <label className="cl-field cl-make-script">
          <span className="sr-only">Script</span>
          <textarea rows={12} value={script ?? draft.script} onChange={(e) => setScript(e.target.value)} spellCheck />
          <span className="cl-row">
            <Button disabled={!changed} onClick={() => script !== null && void app.make.editScript(id, script)}>
              Quote this script
            </Button>
          </span>
        </label>
      )}
      {draft.quote.keys.map((k) => {
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
