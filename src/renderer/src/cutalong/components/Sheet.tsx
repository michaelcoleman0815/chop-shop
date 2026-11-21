import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A sheet over the screen for one task that needs room of its own: adding a
 * shoot, picking a caption look, finding a sound. On a phone it rises from the
 * bottom with a grab handle (home.css, under .cl-app.phone); on a computer it
 * is a card in the middle of the window. Escape, the scrim and the close
 * button all close it, and focus starts inside it and goes back where it was.
 */
export function Sheet({
  label,
  title,
  onClose,
  children,
  foot,
  className = ''
}: {
  /** What a screen reader hears the sheet called. */
  label: string
  /** The heading drawn at its top, beside Close. */
  title?: ReactNode
  onClose: () => void
  children: ReactNode
  /** The sheet's buttons, kept at its foot while what is above scrolls. */
  foot?: ReactNode
  className?: string
}): JSX.Element {
  const box = useRef<HTMLElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus], button, input, [tabindex="0"]')
    first?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      before?.focus?.({ preventScroll: true })
    }
    // Once, when the sheet opens: what is inside it changes without moving focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Drawn at the app's root, so no transformed parent (a composer opening, a panel moving) holds it in place,
  // and inside .cl-app, so the phone's rules for it apply.
  const root = document.querySelector('.cl-app') ?? document.body
  return createPortal(
    <div className="cl-sheet-layer">
      <button type="button" className="cl-sheet-scrim" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <section ref={box} className={`cl-sheet ${className}`.trim()} role="dialog" aria-modal="true" aria-label={label}>
        <span className="cl-sheet-grab" aria-hidden="true" />
        {title !== undefined && (
          <header className="cl-sheet-head">
            <span className="cl-sheet-title">{title}</span>
            <button type="button" className="cl-sheet-close" aria-label="Close" onClick={onClose}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </header>
        )}
        <div className="cl-sheet-body">{children}</div>
        {foot && <footer className="cl-sheet-foot">{foot}</footer>}
      </section>
    </div>,
    root
  )
}
