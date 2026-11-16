import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * The small pieces every screen uses, drawn to the design system: pills for
 * buttons and chips, one primary per view, coral only on the mark.
 */

export function Mark({ size = 30, white = false }: { size?: number; white?: boolean }): JSX.Element {
  return (
    <svg width={size} height={(size * 52) / 64} viewBox="0 0 64 52" aria-hidden="true">
      <rect x="2" y="4" width="44" height="18" rx="9" fill={white ? '#FFFFFF' : 'var(--ink)'} />
      <rect
        x="18"
        y="30"
        width="42"
        height="16"
        rx="8"
        fill="none"
        stroke={white ? '#FFFFFF' : 'var(--coral)'}
        strokeWidth="5"
        strokeDasharray="7 6"
      />
    </svg>
  )
}

export function Lockup({ onClick }: { onClick?: () => void }): JSX.Element {
  return (
    <button type="button" className="cl-lockup" onClick={onClick} aria-label="Cutalong, start">
      <Mark />
      <span aria-hidden="true">cutalong</span>
    </button>
  )
}

/** The assistant's avatar: the mark in white on a coral tile. */
export function AssistantAvatar(): JSX.Element {
  return (
    <span className="cl-assistant-avatar" aria-hidden="true">
      <Mark size={20} white />
    </span>
  )
}

type Variant = 'primary' | 'secondary' | 'text'

export function Button({
  variant = 'secondary',
  small = false,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean; children: ReactNode }): JSX.Element {
  return (
    <button type="button" className={`cl-btn ${variant}${small ? ' small' : ''} ${className}`} {...rest}>
      {children}
    </button>
  )
}

export function IconButton({
  label,
  filled = false,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; filled?: boolean; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`cl-icon-btn${filled ? ' filled' : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

export const Icon = {
  plus: (): JSX.Element => (
    <svg width="17" height="17" viewBox="0 0 24 24" {...stroke} strokeWidth="1.9" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  send: (): JSX.Element => (
    <svg width="17" height="17" viewBox="0 0 24 24" {...stroke} strokeWidth="2" aria-hidden="true">
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  ),
  back: (): JSX.Element => (
    <svg width="17" height="17" viewBox="0 0 24 24" {...stroke} strokeWidth="1.9" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
  play: (): JSX.Element => (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
    </svg>
  ),
  pause: (): JSX.Element => (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />
    </svg>
  ),
  close: (): JSX.Element => (
    <svg width="12" height="12" viewBox="0 0 24 24" {...stroke} strokeWidth="2.2" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
