import { createContext, useContext, type ReactNode } from 'react'
import { Button, Icon } from '../components/ui'

/** Where "back" goes from Projects, Brand, Presets and Settings: the chat being worked on. */
export const BackToWork = createContext<{ name: string; go: () => void } | null>(null)

/**
 * A video being made while its progress is out of sight (on another page, or in the editor): what it is, its
 * stage, and its Stop, so it can always be stopped from wherever the person is.
 */
export const MakeRunning = createContext<{ what: string; stage: string | null; stop: () => void } | null>(null)

export function Header({ children }: { children: ReactNode }): JSX.Element {
  const back = useContext(BackToWork)
  const running = useContext(MakeRunning)
  return (
    <header className="cl-header">
      {back && (
        <Button variant="text" className="cl-back-to-work" onClick={back.go} aria-label={`Back to ${back.name}`}>
          <Icon.back />
          <span>{back.name}</span>
        </Button>
      )}
      {children}
      {running && (
        <p className="cl-running" role="status">
          <span>
            Making {running.what}
            {running.stage ? <span className="cl-running-stage">{running.stage}</span> : null}
          </span>
          <Button variant="text" onClick={running.stop}>
            Stop
          </Button>
        </p>
      )}
    </header>
  )
}
