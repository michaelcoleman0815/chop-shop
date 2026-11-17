import { useState } from 'react'
import { KEY_STEPS } from '../../../../shared/make/key-steps'
import { listOf } from '../../../../shared/make/quote'
import type { Draft } from '../../../../shared/make/draft'
import type { Cutalong } from '../useCutalong'
import { Button } from './ui'

const COUNT = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

/** The script as pages of a shooting script: each part's heading, then its lines, numbered as the shots they become. */
function Lined({ draft }: { draft: Draft }): JSX.Element {
  const starts = draft.sections.length ? draft.sections : [0]
  const parts = starts.map((from, k) => ({
    heading: draft.outline[k] ?? '',
    lines: draft.phrases.slice(from, starts[k + 1] ?? draft.phrases.length).map((text, i) => ({ text, shot: from + i + 1 }))
  }))
  return (
    <div className="cl-script cl-make-page" aria-label="Script">
      {parts.map((p, k) => (
        <section key={`${k}-${p.heading}`}>
          {p.heading && <h3 className="cl-make-slug">{p.heading}</h3>}
          {p.lines.map((l) => (
            <p key={l.shot} className="cl-make-line" data-shot={l.shot}>
              {l.text}
            </p>
          ))}
        </section>
      ))}
    </div>
  )
}

/**
 * What a made video's quote shows under its sentence: the parts it will
 * follow, in a sentence; the script, opened by the reply's "Read the script"
 * button as the pages of a shooting script, each line numbered as the shot it
 * becomes (the editor's script panel, set in the same .cl-script), and edited
 * as plain text when asked, then quoted again; and, when a service's key is
 * missing, how to get one. The cost lines stay behind the reply's Details.
 */
export function MakeBrief({ app, id }: { app: Cutalong; id: string }): JSX.Element | null {
  const draft = app.make.draft(id)
  const open = app.make.scriptOpen(id)
  const [editing, setEditing] = useState(false)
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
      {open && !editing && (
        <div className="cl-make-script">
          <Lined draft={draft} />
          <button type="button" className="cl-link" onClick={() => setEditing(true)}>
            Edit the script
          </button>
        </div>
      )}
      {open && editing && (
        <label className="cl-field cl-make-script">
          <span className="sr-only">Script</span>
          <textarea rows={12} value={script ?? draft.script} onChange={(e) => setScript(e.target.value)} spellCheck />
          <span className="cl-row">
            <Button disabled={!changed} onClick={() => script !== null && void app.make.editScript(id, script)}>
              Quote this script
            </Button>
            <Button variant="text" onClick={() => setEditing(false)}>
              Back to the script
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
