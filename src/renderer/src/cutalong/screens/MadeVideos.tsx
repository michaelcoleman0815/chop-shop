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
export function MadeVideos({ settings, onSettings }: { settings: Settings | null; onSettings: (next: Settings) => void }): JSX.Element {
  const on = typeof settings?.makeAutoUnder === 'number' && settings.makeAutoUnder > 0
  const [under, setUnder] = useState(String(settings?.makeAutoUnder ?? 2))
  const [cap, setCap] = useState(String(settings?.makeCap ?? DEFAULT_CAP))
  useEffect(() => {
    if (settings?.makeAutoUnder) setUnder(String(settings.makeAutoUnder))
    if (settings?.makeCap) setCap(String(settings.makeCap))
  }, [settings?.makeAutoUnder, settings?.makeCap])
  const amount = (s: string): number | null => {
    const n = Number(s.replace(/[$\s]/g, ''))
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
  }
  return (
    <section className="cl-section" aria-labelledby="set-make">
      <h2 id="set-make">Made videos</h2>
      <label className="cl-field">
        <span>The most one video may cost</span>
        <input
          inputMode="decimal"
          aria-label="The most one video may cost, in dollars"
          value={cap}
          disabled={!settings}
          onChange={(e) => setCap(e.target.value)}
          onBlur={() => {
            const n = amount(cap)
            void api.setSettings({ makeCap: n }).then(onSettings)
            if (!n) setCap(String(DEFAULT_CAP))
          }}
        />
        <span className="cl-field-hint cl-aside">
          In dollars. A prompt can say less, like “under $3”. Nothing is asked of a service that would take it past this.
        </span>
      </label>
      <div className="cl-field">
        <label className="cl-toggle">
          <input
            type="checkbox"
            role="switch"
            checked={on}
            aria-checked={on}
            disabled={!settings}
            onChange={(e) => void api.setSettings({ makeAutoUnder: e.target.checked ? (amount(under) ?? 2) : null }).then(onSettings)}
          />
          Go ahead without asking when a video costs less than
          <input
            className="cl-make-under"
            inputMode="decimal"
            aria-label="Dollars"
            value={under}
            disabled={!settings}
            onChange={(e) => setUnder(e.target.value)}
            onBlur={() => {
              if (on) void api.setSettings({ makeAutoUnder: amount(under) ?? 2 }).then(onSettings)
            }}
          />
        </label>
        <p className="cl-aside" role="status">
          {on
            ? `A video quoted under $${settings?.makeAutoUnder} is made straight away, and its reply says what it cost. Anything more waits for you.`
            : 'Every video is quoted first and waits for you to press Make it. Nothing is spent before that.'}
        </p>
      </div>
    </section>
  )
}
