import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { brandName } from '../../../../shared/brands'
import type { Cutalong } from '../useCutalong'
import { Button, Icon } from './ui'

/**
 * The brand a chat is in, as one quiet control in the thread header: its
 * name, and a menu of the person's brands to switch to. Only there when there
 * is more than one brand to choose from. Switching an edit makes a version.
 *
 * The menu takes focus on the brand in use; arrows move between brands,
 * Escape closes it and gives focus back to the button. Opened from the
 * keyboard it appears at once; opened with a pointer it scales in (motion.css).
 */
export function BrandSwitch({ app }: { app: Cutalong }): JSX.Element | null {
  const [open, setOpen] = useState<null | 'pointer' | 'key'>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('mousedown', away)
    // Focus goes to the brand in use, so arrows start from there.
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
    ;(items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0])?.focus()
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  if (app.brands.brands.length < 2) return null
  const current = app.chatBrand

  const close = (): void => {
    setOpen(null)
    anchor.current?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus()
  }
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const go = (i: number): void => items[(i + items.length) % items.length]?.focus()
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
    else if (e.key === 'Tab') setOpen(null)
    else return
    if (e.key !== 'Tab') e.preventDefault()
  }

  return (
    <span className="cl-menu-anchor" ref={anchor}>
      <Button
        variant="text"
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-label={`Brand: ${brandName(current)}. Switch brand`}
        // detail is 0 when Enter or Space pressed the button.
        onClick={(e) => setOpen((o) => (o ? null : e.detail === 0 ? 'key' : 'pointer'))}
      >
        <span className="cl-btn-label">{brandName(current)}</span>
        <Icon.chevron />
      </Button>
      {open && (
        <div
          ref={menu}
          className="cl-menu"
          role="menu"
          aria-label="Brands"
          data-by-key={open === 'key' ? '' : undefined}
          onKeyDown={onMenuKey}
        >
          {app.brands.brands.map((b) => (
            <button
              key={b.id}
              type="button"
              role="menuitemradio"
              aria-checked={b.id === current.id}
              tabIndex={-1}
              onClick={() => {
                close()
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
