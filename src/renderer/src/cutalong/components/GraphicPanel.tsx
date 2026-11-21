import { useEffect, useState } from 'react'
import {
  graphicTitle,
  rowsToText,
  template,
  textToRows,
  type MotionChange,
  type MotionItem,
  type MotionRow,
  type MotionScene
} from '../../../../shared/motion'
import { clock, seconds } from '../format'
import { Button, Icon, IconButton } from './ui'

/**
 * The graphic selected in the editor: what it is and when, in a sentence,
 * and its few slots as plain controls. Every change is a new version, like
 * any other edit. The chat and the slash commands stay the main way in; this
 * is for the finishing touches.
 */
export function GraphicPanel({
  item,
  scene,
  onChange,
  onRemove,
  onClose
}: {
  item: MotionItem
  scene: MotionScene
  onChange: (change: MotionChange) => void
  onRemove: () => void
  onClose: () => void
}): JSX.Element {
  const tpl = template(item.kind)
  const placed = scene.items.find((i) => i.id === item.id)
  const hidden = scene.hidden.find((h) => h.id === item.id)
  const when = placed
    ? `It comes in at ${clock(placed.start)} and stays ${seconds(placed.end - placed.start)}.`
    : (hidden?.reason ?? '')
  const styles = tpl?.styles.filter(Boolean) ?? []
  const places = tpl?.places ?? []
  const style = item.style || styles[0]
  // Where what it shows comes from: a map's facts and data, behind Details.
  const details = tpl?.details?.(item) ?? []
  const [open, setOpen] = useState(false)

  return (
    <aside className="cl-notes cl-graphic" aria-label="Graphic">
      <div className="cl-graphic-head">
        <span className="cl-heading">{tpl?.title ?? 'Graphic'}</span>
        <IconButton label="Back to notes" onClick={onClose}>
          <Icon.close />
        </IconButton>
      </div>
      <div className="cl-notes-scroll cl-graphic-fields">
        <p className="cl-reply">
          {graphicTitle(item)}. {when}
        </p>
        {details.length > 0 && (
          <button type="button" className="cl-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide details' : 'Details'}
          </button>
        )}
        {open && details.length > 0 && (
          <dl className="cl-details">
            {details.map((d) => (
              <div key={d.label} style={{ display: 'contents' }}>
                <dt>{d.label}</dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {tpl?.fields.map((f) => {
          if (f.slot === 'text') {
            return (
              <TextSlot
                key={`text-${f.index}`}
                label={f.label}
                value={item.text[f.index] ?? ''}
                onCommit={(v) => {
                  const text = [...item.text]
                  while (text.length <= f.index) text.push('')
                  text[f.index] = v
                  onChange({ text })
                }}
              />
            )
          }
          if (f.slot === 'items') {
            return <RowsSlot key="items" label={f.label} rows={item.items} onCommit={(items) => onChange({ items })} />
          }
          if (f.slot === 'values') {
            return (
              <TextSlot
                key={`value-${f.index}`}
                label={f.label}
                value={item.values[f.index] === undefined ? '' : String(item.values[f.index])}
                numeric
                onCommit={(v) => {
                  const n = Number(v)
                  if (!Number.isFinite(n)) return
                  const values = [...item.values]
                  while (values.length <= f.index) values.push(0)
                  values[f.index] = n
                  onChange({ values })
                }}
              />
            )
          }
          if (f.slot === 'icon') {
            return (
              <TextSlot
                key="icon"
                label={f.label}
                value={item.icon}
                onCommit={(icon) => onChange({ icon: icon || 'none' })}
              />
            )
          }
          return (
            <p key="box" className="cl-project-meta">
              {f.label}.
            </p>
          )
        })}
        {styles.length > 1 && (
          <div className="cl-field">
            <span>Style</span>
            <div className="cl-segments" role="radiogroup" aria-label="Style">
              {styles.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={s === style}
                  className={s === style ? 'on' : ''}
                  onClick={() => s !== style && onChange({ style: s })}
                >
                  {label(s)}
                </button>
              ))}
            </div>
          </div>
        )}
        {places.length > 1 && (
          <div className="cl-field">
            <span>Place</span>
            <div className="cl-segments" role="radiogroup" aria-label="Place">
              {places.map((p) => {
                const on = (item.place || places[0]) === p
                return (
                  <button
                    key={p || 'auto'}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={on ? 'on' : ''}
                    onClick={() => !on && onChange({ place: p || 'none' })}
                  >
                    {p ? label(p) : 'Auto'}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
      <Button variant="text" onClick={onRemove}>
        Remove this graphic
      </Button>
    </aside>
  )
}

const label = (s: string): string => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/-/g, ' ')

/** Whether a pointer is pressed right now, for a field left by a click. */
let pressed = false
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => (pressed = true), true)
  document.addEventListener('pointerup', () => (pressed = false), true)
  document.addEventListener('pointercancel', () => (pressed = false), true)
}

/**
 * Makes the change a field holds once it is left. Left by pressing something
 * else, it waits for that press to land first: the change makes a version, a
 * version starts a transition, and a click that finished during it was lost
 * (typing a name, then picking a style, kept the name and dropped the style).
 */
function whenSettled(run: () => void): void {
  if (!pressed) {
    run()
    return
  }
  const done = (): void => {
    window.removeEventListener('pointerup', done, true)
    window.removeEventListener('pointercancel', done, true)
    setTimeout(run, 0)
  }
  window.addEventListener('pointerup', done, true)
  window.addEventListener('pointercancel', done, true)
}

/** A line of text that becomes a change when the person leaves the field or presses Return. */
function TextSlot({
  label: name,
  value,
  numeric = false,
  onCommit
}: {
  label: string
  value: string
  numeric?: boolean
  onCommit: (value: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft.trim() !== value.trim()) {
      const next = draft.trim()
      whenSettled(() => onCommit(next))
    }
  }
  return (
    <label className="cl-field">
      <span>{name}</span>
      <input
        value={draft}
        inputMode={numeric ? 'decimal' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setDraft(value)
        }}
      />
    </label>
  )
}

function RowsSlot({
  label: name,
  rows,
  onCommit
}: {
  label: string
  rows: MotionRow[]
  onCommit: (rows: MotionRow[]) => void
}): JSX.Element {
  const text = rowsToText(rows)
  const [draft, setDraft] = useState(text)
  useEffect(() => setDraft(text), [text])
  return (
    <label className="cl-field">
      <span>{name}</span>
      <textarea
        rows={Math.min(8, Math.max(3, rows.length + 1))}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft.trim() !== text.trim()) {
            const next = textToRows(draft, rows)
            whenSettled(() => onCommit(next))
          }
        }}
      />
    </label>
  )
}
