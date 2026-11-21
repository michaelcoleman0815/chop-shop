import { Children, createContext, useContext, useId, type ReactNode } from 'react'

/**
 * Settings' building blocks: a row says what a setting is in a title and one
 * line, with its control at the end; what a setting needs more room for
 * (a key's steps, a list of folders) opens under its row. Rows sit on paper
 * cards in groups, one section at a time. While something is typed in the
 * search, every row whose words match shows instead, under its section.
 */

/** What is typed in Settings' search, lowercased; empty shows the section picked. */
export const SettingsFind = createContext('')

/** The id of the row's title, which the row's control is labelled by. */
const RowTitle = createContext<string | undefined>(undefined)

/** Whether every word typed is somewhere in what a row says about itself. */
export function matches(query: string, words: string): boolean {
  const said = words.toLowerCase()
  return query
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => said.includes(w))
}

export function SetRow({
  title,
  desc,
  tag,
  control,
  find,
  children
}: {
  title: string
  /** One line, two at most: what it does or how it stands. */
  desc?: ReactNode
  /** A word or two beside the title that says something at a glance: "Paid", "On this Mac". */
  tag?: string
  control?: ReactNode
  /** More words to be found by, when the line says them only in part. */
  find?: string
  /** What opens under the row. */
  children?: ReactNode
}): JSX.Element | null {
  const query = useContext(SettingsFind)
  const id = useId()
  if (query && !matches(query, [title, typeof desc === 'string' ? desc : '', tag ?? '', find ?? ''].join(' ')))
    return null
  // Only something to show opens room under the row: a closed panel leaves none.
  const more = Children.toArray(children).length > 0
  return (
    <RowTitle.Provider value={id}>
      <div className="cl-set-row">
        <div className="cl-set-text">
          <span className="cl-set-title" id={id}>
            {title}
            {tag && <span className="cl-set-tag">{tag}</span>}
          </span>
          {desc && (
            <p className="cl-set-desc" role="status">
              {desc}
            </p>
          )}
        </div>
        {control && <div className="cl-set-control">{control}</div>}
        {more && <div className="cl-set-more">{children}</div>}
      </div>
    </RowTitle.Provider>
  )
}

/** A card of rows, with a small heading over it when the section has more than one. */
export function SetGroup({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="cl-set-group">
      {title && <h3 className="cl-set-subhead">{title}</h3>}
      <div className="cl-set-card">{children}</div>
    </div>
  )
}

/** A switch labelled by its row's title. */
export function SetSwitch({
  checked,
  disabled,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}): JSX.Element {
  const title = useContext(RowTitle)
  return (
    <label className="cl-toggle">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-checked={checked}
        aria-labelledby={title}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}

/** A choice of several, as a menu, labelled by its row's title. */
export function SetSelect<T extends string>({
  value,
  options,
  disabled,
  onChange
}: {
  value: T
  options: { id: T; label: string }[]
  disabled?: boolean
  onChange: (id: T) => void
}): JSX.Element {
  const title = useContext(RowTitle)
  return (
    <span className="cl-select">
      <select
        value={value}
        aria-labelledby={title}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  )
}

/** A choice of a few, side by side, labelled by its row's title. */
export function SetSegments<T extends string>({
  value,
  options,
  disabled,
  onChange
}: {
  value: T
  options: { id: T; label: string }[]
  disabled?: boolean
  onChange: (id: T) => void
}): JSX.Element {
  const title = useContext(RowTitle)
  return (
    <div className="cl-segments" role="radiogroup" aria-labelledby={title}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={value === o.id ? 'on' : ''}
          disabled={disabled}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
