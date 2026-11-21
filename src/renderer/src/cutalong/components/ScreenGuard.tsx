import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './ui'

/**
 * What a screen shows when drawing it fails: a sentence and a way back,
 * instead of a blank window. The place Cutalong reopens at launch is
 * forgotten at once, so quitting and opening it again starts on Start rather
 * than in the same fault. The rail stays outside, so every other screen can
 * still be reached.
 */

interface Props {
  children: ReactNode
  /** A new screen or edit clears the fault and tries again. */
  resetKey: string
  /** Forgets the place to reopen at launch. */
  forget: () => void
  /** The way back. Without one, the window is reloaded. */
  onBack?: () => void
  backLabel?: string
}

interface State {
  error: Error | null
  open: boolean
}

export class ScreenGuard extends Component<Props, State> {
  state: State = { error: null, open: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[cutalong] a screen failed to draw:', error, info.componentStack)
    this.props.forget()
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null, open: false })
  }

  render(): ReactNode {
    const { error, open } = this.state
    if (!error) return this.props.children
    const back = (): void => {
      this.setState({ error: null, open: false })
      if (this.props.onBack) this.props.onBack()
      else window.location.reload()
    }
    return (
      <div className="cl-empty cl-fault" role="alert">
        <p className="cl-reply">Something went wrong showing this. Your edits are saved.</p>
        <div className="cl-actions">
          <Button variant="primary" onClick={back}>
            {this.props.backLabel ?? 'Back to start'}
          </Button>
          <button type="button" className="cl-link" aria-expanded={open} onClick={() => this.setState({ open: !open })}>
            {open ? 'Hide details' : 'Details'}
          </button>
        </div>
        {open && <p className="cl-aside mono">{error.message}</p>}
      </div>
    )
  }
}
