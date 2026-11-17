import { useEffect, useState } from 'react'
import { DEFAULT_CAP } from '../../../../shared/make/quote'
import type { Settings } from '../../../../shared/types'
import { api } from '../api'

/**
 * Money for videos made from nothing: the most one may cost, and whether a
 * video under an amount is made without waiting for its button. Off unless
 * turned on; every reply still says what was spent. What goes where is said
 * under Other AI services, and again in every quote.
 */

/** Dollars as typed, or null when they are not an amount. */
function amount(s: string): number | null {
  const n = Number(s.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

/** A dollar amount in a small field with its sign in front. */
function Dollars({
  label,
  value,
  disabled,
  onChange,
  onDone
}: {
  label: string
  value: string
  disabled: boolean
  onChange: (v: string) => void
  onDone: () => void
}): JSX.Element {
  return (
    <span className="cl-dollars">
      <span aria-hidden="true">$</span>
      <input
        inputMode="decimal"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onDone}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </span>
  )
}

export function MadeVideos({
  settings,
  onSettings
}: {
  settings: Settings | null
  onSettings: (next: Settings) => void
}): JSX.Element {
  const on = typeof settings?.makeAutoUnder === 'number' && settings.makeAutoUnder > 0
  const [under, setUnder] = useState(String(settings?.makeAutoUnder ?? 2))
  const [cap, setCap] = useState(String(settings?.makeCap ?? DEFAULT_CAP))
  useEffect(() => {
    if (settings?.makeAutoUnder) setUnder(String(settings.makeAutoUnder))
    if (settings?.makeCap) setCap(String(settings.makeCap))
  }, [settings?.makeAutoUnder, settings?.makeCap])
  const limit = settings?.makeCap ?? DEFAULT_CAP
  return (
    <section className="cl-section" aria-labelledby="set-make">
      <h2 id="set-make">Made videos</h2>
      <div className="cl-field">
        <span className="cl-row cl-make-limit">
          The most one video may cost
          <Dollars
            label="The most one video may cost, in dollars"
            value={cap}
            disabled={!settings}
            onChange={setCap}
            onDone={() => {
              const n = amount(cap)
              setCap(String(n ?? DEFAULT_CAP))
              void api.setSettings({ makeCap: n }).then(onSettings)
            }}
          />
        </span>
        <p className="cl-aside">
          A prompt can ask for less, like “under $3”, never more. Nothing is asked of a service, Claude included, that
          would take a video past ${limit}, with what it has cost already.
        </p>
      </div>
      <div className="cl-field">
        <span className="cl-row cl-make-auto">
          <label className="cl-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={on}
              aria-checked={on}
              disabled={!settings}
              onChange={(e) =>
                void api
                  .setSettings({
                    makeAutoUnder: e.target.checked ? (amount(under) ?? 2) : null
                  })
                  .then(onSettings)
              }
            />
            Go ahead without asking when a video costs less than
          </label>
          <Dollars
            label="Go ahead without asking under this many dollars"
            value={under}
            disabled={!settings}
            onChange={setUnder}
            onDone={() => {
              const n = amount(under) ?? 2
              setUnder(String(n))
              if (on) void api.setSettings({ makeAutoUnder: n }).then(onSettings)
            }}
          />
        </span>
        <p className="cl-aside" role="status">
          {on
            ? `A new video whose whole cost, its script included, comes to less than $${settings?.makeAutoUnder} is made straight away, and its reply says what it cost. Anything more waits for you, and so does every change to a made video, and a video whose questions you answered by typing: I read your words back first, and nothing is written until you tap Yes.`
            : 'Every video is quoted first and waits for you to press Make it. Before that, only Claude writes its script, with your Anthropic key.'}
        </p>
      </div>
    </section>
  )
}
