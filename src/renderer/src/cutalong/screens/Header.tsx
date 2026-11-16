import type { ReactNode } from 'react'

/** Classic tools live in their own document; switching is a reload. */
export function openClassic(): void {
  window.location.hash = '#classic'
  window.location.reload()
}

export function Header({ children }: { children: ReactNode }): JSX.Element {
  return <header className="cl-header">{children}</header>
}
