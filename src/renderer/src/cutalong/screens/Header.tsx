import { createContext, useContext, type ReactNode } from 'react'
import { Button, Icon } from '../components/ui'

/** Where "back" goes from Projects, Brand, Presets and Settings: the chat being worked on. */
export const BackToWork = createContext<{ name: string; go: () => void } | null>(null)

export function Header({ children }: { children: ReactNode }): JSX.Element {
  const back = useContext(BackToWork)
  return (
    <header className="cl-header">
      {back && (
        <Button variant="text" onClick={back.go} aria-label={`Back to ${back.name}`}>
          <Icon.back />
          {back.name}
        </Button>
      )}
      {children}
    </header>
  )
}
