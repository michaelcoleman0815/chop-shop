import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProjectSummary } from '../../../../shared/types'
import { when } from '../format'

/** Classic tools live in their own document; switching is a reload. */
export function openClassic(): void {
  window.location.hash = '#classic'
  window.location.reload()
}

export function Header({ children }: { children: ReactNode }): JSX.Element {
  return <header className="cl-header">{children}</header>
}

function useDismiss(open: boolean, close: () => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return ref
}

/** Projects: every Cutalong edit, newest first, and a way to open one from disk. */
export function ProjectsMenu({
  recent,
  onOpen,
  onBrowse
}: {
  recent: ProjectSummary[]
  onOpen: (path: string) => void
  onBrowse: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div className="cl-menu-anchor" ref={ref}>
      <button type="button" className="cl-btn text" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Projects
      </button>
      {open && (
        <div className="cl-menu" role="menu">
          {recent.map((p) => (
            <button
              key={p.path}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onOpen(p.path)
              }}
            >
              {p.name}
              <span className="meta">Edited {when(p.openedAt)}</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onBrowse()
            }}
          >
            Open a project file…
          </button>
        </div>
      )}
    </div>
  )
}

/** The account corner: for now, the way through to the classic tools. */
export function AccountMenu({ version }: { version: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div className="cl-menu-anchor" ref={ref}>
      <button
        type="button"
        className="cl-avatar"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="8.5" r="3.5" />
          <path d="M5 20c1.4-3.6 4-5.2 7-5.2s5.6 1.6 7 5.2" />
        </svg>
      </button>
      {open && (
        <div className="cl-menu" role="menu">
          <button type="button" role="menuitem" onClick={openClassic}>
            Classic tools
            <span className="meta">Clip finder, timeline editor, Live Buffer and Settings</span>
          </button>
          {version && (
            <button type="button" role="menuitem" disabled>
              <span className="meta">Version {version}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
