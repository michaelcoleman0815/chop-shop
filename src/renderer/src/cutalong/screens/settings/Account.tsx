import { useEffect, useState } from 'react'
import type { AccountStatus } from '../../../../../shared/account'
import { api } from '../../api'
import { Button, Icon } from '../../components/ui'
import { SetGroup, SetRow } from './rows'

/**
 * The account in Settings: sign in with a code sent to your email, and the keys, settings, brands and presets on
 * this copy are on every other one signed in to it (shared/account). No password: the code is the sign-in.
 */
export function AccountSection({ onSynced }: { onSynced: () => Promise<void> }): JSX.Element {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  useEffect(() => {
    void api.accountStatus().then(setStatus)
  }, [])
  // After a sync, what came in shows at once: the key, the brands, the presets.
  const synced = (next: AccountStatus): void => {
    setStatus(next)
    void onSynced()
  }
  if (!status) return <SetGroup>{null}</SetGroup>
  return status.email ? <SignedIn status={status} onStatus={synced} /> : <SignIn onStatus={synced} />
}

/** "just now", "4 minutes ago", "2 hours ago", then the day. */
export function syncedAgo(iso: string, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return min === 1 ? 'a minute ago' : `${min} minutes ago`
  const hours = Math.round(min / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function SignedIn({ status, onStatus }: { status: AccountStatus; onStatus: (s: AccountStatus) => void }): JSX.Element {
  const [busy, setBusy] = useState<'sync' | 'out' | null>(null)
  const run = async (what: 'sync' | 'out', work: () => Promise<AccountStatus>): Promise<void> => {
    setBusy(what)
    try {
      onStatus(await work())
    } finally {
      setBusy(null)
    }
  }
  return (
    <SetGroup>
      <SetRow
        title={status.email ?? ''}
        tag="Signed in"
        desc={
          status.problem ? (
            <span className="cl-field-msg error" role="status">
              <Icon.alert />
              <span>{status.problem}</span>
            </span>
          ) : status.syncedAt ? (
            `Your keys, settings, brands and presets are in your account. Synced ${syncedAgo(status.syncedAt)}.`
          ) : (
            'Your keys, settings, brands and presets go to your account on the next sync.'
          )
        }
        find="account sign in sync email"
        control={
          <span className="cl-row" style={{ gap: 'var(--space-2)' }}>
            <Button small disabled={busy !== null} onClick={() => void run('sync', () => api.accountSync())}>
              {busy === 'sync' ? 'Syncing' : 'Sync now'}
            </Button>
            <Button small variant="text" disabled={busy !== null} onClick={() => void run('out', () => api.accountSignOut())}>
              Sign out
            </Button>
          </span>
        }
      />
    </SetGroup>
  )
}

/** Signing in: an address, then the code sent to it. Settings' Account and Start's key steps both show it. */
export function SignIn({ onStatus }: { onStatus: (s: AccountStatus) => void }): JSX.Element {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const ask = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    const r = await api.accountRequestCode(email)
    setBusy(false)
    if (r.ok) setSent(email.trim())
    else setProblem(r.message)
  }
  const verify = async (): Promise<void> => {
    if (!sent) return
    setBusy(true)
    setProblem(null)
    const r = await api.accountVerify(sent, code)
    setBusy(false)
    if (r.ok) onStatus(r.status)
    else setProblem(r.message)
  }

  return (
    <SetGroup>
      <SetRow
        title="Your account"
        desc={
          sent
            ? `I sent a six-digit code to ${sent}. It works for ten minutes.`
            : 'Sign in, and your keys, settings, brands and presets follow you to every copy of Cutalong: a Mac, a PC, your phone. Your footage stays where it is.'
        }
        find="account sign in sync email login"
      >
        <div className="cl-field">
          <div className="cl-key-paste small">
            {sent ? (
              <input
                id="set-account-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                maxLength={6}
                aria-invalid={problem ? true : undefined}
                aria-describedby="set-account-line"
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && code.length === 6) void verify()
                }}
              />
            ) : (
              <input
                id="set-account-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                aria-invalid={problem ? true : undefined}
                aria-describedby="set-account-line"
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && email.trim()) void ask()
                }}
              />
            )}
            {sent ? (
              <Button variant="primary" small disabled={busy || code.length !== 6} onClick={() => void verify()}>
                {busy ? 'Signing in' : 'Sign in'}
              </Button>
            ) : (
              <Button variant="primary" small disabled={busy || !email.trim()} onClick={() => void ask()}>
                {busy ? 'Sending' : 'Email me a code'}
              </Button>
            )}
          </div>
          <p id="set-account-line" className={`cl-field-msg${problem ? ' error' : ''}`} role="status">
            {problem && <Icon.alert />}
            {problem && <span key={problem}>{problem}</span>}
          </p>
          {sent && (
            <Button
              small
              variant="text"
              onClick={() => {
                setSent(null)
                setCode('')
                setProblem(null)
              }}
            >
              Use another address
            </Button>
          )}
        </div>
      </SetRow>
    </SetGroup>
  )
}
