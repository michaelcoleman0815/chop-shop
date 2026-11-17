import { useEffect, useRef, useState } from 'react'
import { brandName } from '../../../../shared/brands'
import type { Cutalong } from '../useCutalong'
import { Button, Icon } from './ui'

/**
 * The brand a chat is in, as one quiet control in the thread header: its
 * name, and a menu of the person's brands to switch to. Only there when there
 * is more than one brand to choose from. Switching an edit makes a version.
 */
export function BrandSwitch({ app }: { app: Cutalong }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  if (app.brands.brands.length < 2) return null
  const current = app.chatBrand
  return (
    <span className="cl-menu-anchor" ref={anchor}>
      <Button
        variant="text"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Brand: ${brandName(current)}. Switch brand`}
        onClick={() => setOpen((o) => !o)}
      >
        {brandName(current)}
        <Icon.chevron />
      </Button>
      {open && (
        <div className="cl-menu" role="menu" aria-label="Brands">
          {app.brands.brands.map((b) => (
            <button
              key={b.id}
              type="button"
              role="menuitemradio"
              aria-checked={b.id === current.id}
              onClick={() => {
                setOpen(false)
                if (b.id !== current.id) app.switchBrand(b.id)
              }}
            >
              {brandName(b)}
              <span className="meta">
                {b.id === current.id
                  ? 'This chat is in it'
                  : b.id === app.brands.default
                    ? 'Your default'
                    : app.doc
                      ? 'Switch this edit to it'
                      : 'Use it for this chat'}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
