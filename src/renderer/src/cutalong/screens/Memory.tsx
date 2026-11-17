import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { learnedFor, PLANNER_PREFERENCES, seenFor } from '../../../../shared/memory'
import { Button, Icon } from '../components/ui'
import type { Cutalong } from '../useCutalong'

/**
 * What I've learned about how you edit, on the brand page: plain statements
 * with how often they were seen, each one deletable or rewordable, and a
 * switch to stop learning. The strongest go to Claude with each request.
 */

function sentence(paused: boolean, items: number, signals: number): string {
  if (paused)
    return items > 0
      ? "Learning is paused. I'm not noting anything new, and what's listed still goes with your requests."
      : "Learning is paused. I'm not noting anything new."
  if (items > 0)
    return "I noticed these from what you ask for, undo and keep. Delete any that's wrong, or put it in your own words."
  if (signals > 0) return "Nothing to say yet. I wait until I've seen something at least twice."
  return "As you edit, I'll notice what you ask for again and again, what you undo and what you keep, and list it here."
}

/** A statement, with any slash command in it set as a command. */
function Statement({ text }: { text: string }): JSX.Element {
  const parts = text.split(/((?<=^|\s)\/[a-z][a-z0-9-]*)/i)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="mono">
            {part}
          </span>
        ) : (
          part
        )
      )}
    </>
  )
}

function where(items: number): string {
  const which =
    items > PLANNER_PREFERENCES ? `The first ${PLANNER_PREFERENCES} go` : items === 1 ? 'This goes' : 'These go'
  return `${which} to Claude with every request and note you send. Nothing else I note leaves this Mac.`
}

export function MemorySection({ app }: { app: Cutalong }): JSX.Element {
  const memory = app.memory
  const { view } = memory
  // What this page's brand has learned from its own chats.
  const items = learnedFor(view, app.brand.id)
  const seen = seenFor(view, app.brand.id)
  const notices = memory.notices.filter((n) => n.brand === app.brand.id)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)

  const save = (e: FormEvent): void => {
    e.preventDefault()
    if (!editing) return
    void memory.edit(editing.id, editing.text)
    setEditing(null)
  }
  const escape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') setEditing(null)
  }

  return (
    <section className="cl-section cl-memory" aria-labelledby="brand-memory">
      <h2 id="brand-memory">What I&apos;ve learned about how you edit</h2>
      <p className="cl-reply">{sentence(view.paused, items.length, seen)}</p>

      {notices.map((n) => (
        <div key={n.id} className="cl-row">
          <p className="cl-aside">{n.text}</p>
          <Button variant="text" onClick={() => memory.dismissNotice(n.id)}>
            Keep it
          </Button>
          <Button variant="text" onClick={() => memory.undoDefault(n)}>
            Undo
          </Button>
        </div>
      ))}

      {items.length > 0 && (
        <>
          <ul className="cl-list">
            {items.map((p) => (
              <li key={p.id}>
                {editing?.id === p.id ? (
                  <form className="cl-field cl-memory-edit" onSubmit={save}>
                    <div className="cl-row">
                      <input
                        aria-label="In your own words"
                        value={editing.text}
                        maxLength={300}
                        autoFocus
                        onChange={(e) => setEditing({ id: p.id, text: e.target.value })}
                        onKeyDown={escape}
                      />
                      <Button small type="submit">
                        Save
                      </Button>
                      <Button variant="text" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <span className="cl-list-main">
                      <span>
                        <Statement text={p.text} />
                      </span>
                      {p.edited && <span className="cl-project-meta">In your words</span>}
                    </span>
                    <Button
                      variant="text"
                      aria-label={`Edit “${p.text}”`}
                      onClick={() => setEditing({ id: p.id, text: p.text })}
                    >
                      Edit
                    </Button>
                    <button type="button" aria-label={`Forget “${p.text}”`} onClick={() => void memory.forget(p.id)}>
                      <Icon.close />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="cl-aside">{where(items.length)}</p>
        </>
      )}

      <label className="cl-toggle">
        <input type="checkbox" checked={!view.paused} onChange={(e) => void memory.setPaused(!e.target.checked)} />
        Learn from how I edit
      </label>
    </section>
  )
}
