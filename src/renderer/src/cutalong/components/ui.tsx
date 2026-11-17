import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { LivingMark } from './Shapes'

/**
 * The small pieces every screen uses, drawn to the design system: pills for
 * buttons and chips, one primary per view, coral only on the mark.
 */

export function Mark({ size = 30, white = false }: { size?: number; white?: boolean }): JSX.Element {
  return (
    <svg width={size} height={(size * 52) / 64} viewBox="0 0 64 52" aria-hidden="true">
      <rect x="2" y="4" width="44" height="18" rx="9" fill={white ? 'currentColor' : 'var(--ink)'} />
      <rect
        className="cl-cut"
        x="18"
        y="30"
        width="42"
        height="16"
        rx="8"
        fill="none"
        stroke={white ? 'currentColor' : 'var(--coral)'}
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

/**
 * The assistant's tile: the mark on a small sheet of paper. Only the newest
 * reply shows it (cutalong.css), so the mark's coral is on screen once. While
 * the reply is still being thought out, the mark is the small living blob.
 */
export function AssistantAvatar({ working = false }: { working?: boolean }): JSX.Element {
  return (
    <span className={`cl-assistant-avatar${working ? ' living' : ''}`} aria-hidden="true">
      {working ? <LivingMark size={30} /> : <Mark size={20} />}
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
  ),
  /** Opens a menu below. */
  chevron: (): JSX.Element => (
    <svg width="12" height="12" viewBox="0 0 24 24" {...stroke} strokeWidth="2.2" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  /** Done. */
  check: (): JSX.Element => (
    <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} strokeWidth="2.4" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  /** A recording that is sound only. */
  wave: (): JSX.Element => (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} strokeWidth="1.9" aria-hidden="true">
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
    </svg>
  )
}
