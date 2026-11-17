import { useEffect, useRef, useState } from 'react'
import { logCrew, memberFor, type CrewEntry, type CrewId } from '../crew'
import { elapsed } from '../format'
import { grow } from '../motion'
import { isThinking, workingLine } from '../working'
import { CrewAtWork } from './Crew'
import { LivingMark } from './Shapes'

/**
 * What Cutalong is doing right now, and for how long. A bar fills when the
 * work can say how far along it is; while Claude thinks it cannot, so the bar
 * sweeps instead of pretending to a number.
 *
 * Long work (`big`) is shown as the crew doing it: the living mark leads, and
 * under it each member the job has needed so far, the one at work saying what
 * they are doing and the ones before saying what they did, then a thin
 * progress line with the time. Quick thinking, and work in a small panel,
 * keeps the small row.
 */
export interface Progress {
  stage: string
  /** 0 to 100, or null while there is no way to know. */
  percent: number | null
}

export function Working({
  progress,
  since,
  big = false,
  crew,
  helpers,
  mark = 60
}: {
  progress: Progress
  since?: number
  /** Long work, shown with the living mark and the crew. */
  big?: boolean
  /** The crew so far, when the reply keeps it (for its credits); otherwise it is kept here. */
  crew?: CrewEntry[]
  /** Who is on it while the stage is Cutalong's own: the members notes were handed to. */
  helpers?: CrewId[]
  /** The living mark's size. */
  mark?: number
}): JSX.Element {
  const now = useNow(since !== undefined)
  const secs = since !== undefined ? (now - since) / 1000 : 0
  const known = typeof progress.percent === 'number'
  const own = useCrewLog(progress.stage)
  // The stopwatch is for eyes; a screen reader hears the stage change instead. It holds its
  // place from the start, hidden for the first second, so nothing moves when it begins to count.
  const time =
    since !== undefined ? (
      <span className={`cl-progress-time${secs < 1 ? ' waiting' : ''}`} aria-hidden="true">
        {elapsed(secs)}
      </span>
    ) : null
  const bar = (
    <span className={`cl-progress-bar${known ? '' : ' unknown'}`} aria-hidden="true">
      <span style={known ? grow(Math.max(4, Math.min(100, progress.percent as number))) : undefined} />
    </span>
  )

  const current = memberFor(progress.stage)
  // Notes being worked on: the members they were handed to are the ones at work.
  const onNotes = !current && helpers && helpers.length > 0 ? helpers : null
  const log: CrewEntry[] = onNotes
    ? onNotes.map((id) => ({ id, stage: `Working on ${helpers!.length === 1 ? 'your note' : 'your notes'}` }))
    : (crew ?? own)
  const working = new Set<CrewId>(onNotes ?? (current ? [current] : []))

  if (big && log.length > 0) {
    return (
      <div className="cl-progress big crewed">
        <LivingMark size={mark} />
        <CrewAtWork log={log} working={working} line={workingLine(progress.stage, progress.percent)} />
        {/* A stage no one owns (Cutalong thinking between their turns) is said plainly. */}
        {working.size === 0 && <span className="cl-progress-stage">{progress.stage}</span>}
        <span className="cl-progress-foot">
          {bar}
          {time}
        </span>
      </div>
    )
  }
  if (big && !isThinking(progress.stage)) {
    return (
      <div className="cl-progress big">
        <LivingMark size={mark} />
        <span className="cl-progress-stage">{progress.stage}</span>
        <span className="cl-progress-line">{workingLine(progress.stage, progress.percent)}</span>
        <span className="cl-progress-foot">
          {bar}
          {time}
        </span>
      </div>
    )
  }
  return (
    <div className="cl-progress">
      <span className="cl-progress-stage">{progress.stage}</span>
      {time}
      {bar}
    </div>
  )
}

/** The crew of the work on screen, kept for as long as it shows, from the stages it reports. */
function useCrewLog(stage: string): CrewEntry[] {
  const log = useRef<CrewEntry[]>([])
  log.current = logCrew(log.current, stage)
  return log.current
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
