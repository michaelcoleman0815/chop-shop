import { useEffect, useState } from 'react'
import { elapsed } from '../format'
import { grow } from '../motion'

/**
 * What Cutalong is doing right now, and for how long: "Thinking · 42s". The
 * mark beside it marches while this row shows (motion.css). A bar fills when
 * the work can say how far along it is; while Claude thinks it cannot, so
 * the bar sweeps instead of pretending to a number.
 */
export interface Progress {
  stage: string
  /** 0 to 100, or null while there is no way to know. */
  percent: number | null
}

export function Working({ progress, since }: { progress: Progress; since?: number }): JSX.Element {
  const now = useNow(since !== undefined)
  const secs = since !== undefined ? (now - since) / 1000 : 0
  const known = typeof progress.percent === 'number'
  return (
    <div className="cl-progress">
      <span className="cl-progress-stage">{progress.stage}</span>
      {secs >= 1 && (
        // The stopwatch is for eyes; a screen reader hears the stage change instead.
        <span className="cl-progress-time" aria-hidden="true">
          {elapsed(secs)}
        </span>
      )}
      <span className={`cl-progress-bar${known ? '' : ' unknown'}`} aria-hidden="true">
        <span style={known ? grow(Math.max(4, Math.min(100, progress.percent as number))) : undefined} />
      </span>
    </div>
  )
}

/** The time, once a second, while something is counting. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [ticking])
  return now
}
