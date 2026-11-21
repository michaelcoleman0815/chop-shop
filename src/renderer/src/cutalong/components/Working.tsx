import { useEffect, useRef, useState } from 'react'
import { device } from '../api'
import { doneLine, CREW, logCrew, memberFor, type CrewEntry, type CrewId } from '../crew'
import { elapsed } from '../format'
import { grow } from '../motion'
import { isThinking, workingLine } from '../working'
import { Icon } from './ui'

/**
 * What Cutalong is doing right now, and for how long. A bar fills when the
 * work can say how far along it is; while Claude thinks it cannot, so the bar
 * sweeps instead of pretending to a number.
 *
 * Long work (`big`) is shown as a checklist of the steps it has taken so far:
 * the one under way in its own words ("Transcribing take-3.mov"), the ones
 * before ticked and in the past ("Transcribed take-3.mov"), then a thin
 * progress line with the time. No characters and no orb: the work is the
 * picture. Quick thinking, and work in a small panel, keeps the small row.
 */
export interface Progress {
  stage: string
  /** 0 to 100, or null while there is no way to know. */
  percent: number | null
  /** The plain line under long work, when the work says its own (a phone keeping its screen on). */
  line?: string
}

export function Working({
  progress,
  since,
  big = false,
  crew,
  helpers
}: {
  progress: Progress
  since?: number
  /** Long work, shown as a checklist of its steps. */
  big?: boolean
  /** The crew so far, when the reply keeps it (for its credits); otherwise it is kept here. */
  crew?: CrewEntry[]
  /** Who is on it while the stage is Cutalong's own: the members notes were handed to. */
  helpers?: CrewId[]
  /** Kept for callers that still say how big the mark was; nothing is drawn by it now. */
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
    const line = progress.line ?? workingLine(progress.stage, progress.percent, device.here)
    return (
      <div className="cl-progress big stepped">
        <ol className="cl-steps-done" aria-label="What I have done so far">
          {log.map((e) => {
            const at = working.has(e.id)
            return (
              <li key={`${e.id}-${e.stage}`} className={at ? 'now' : 'done'}>
                <span className="cl-step-mark" aria-hidden="true">
                  {at ? <span className="cl-step-dot" /> : <Icon.check />}
                </span>
                <span>{at ? e.stage : pastOf(e)}</span>
                {!at && <span className="sr-only">, done</span>}
              </li>
            )
          })}
          {/* A stage no step owns (Cutalong thinking between steps) is said plainly. */}
          {working.size === 0 && (
            <li className="now">
              <span className="cl-step-mark" aria-hidden="true">
                <span className="cl-step-dot" />
              </span>
              <span>{progress.stage}</span>
            </li>
          )}
        </ol>
        {line && <span className="cl-progress-line">{line}</span>}
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
        <span className="cl-progress-stage">{progress.stage}</span>
        <span className="cl-progress-line">
          {progress.line ?? workingLine(progress.stage, progress.percent, device.here)}
        </span>
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

/** A step done, in the past and in its own words: "Transcribed take-3.mov". */
function pastOf(e: CrewEntry): string {
  const said = doneLine(e)
  const name = CREW[e.id].name
  // The line names whoever did it; the checklist only says what was done.
  if (!said.startsWith(`${name} `) || said.endsWith('did their part')) return e.stage
  const rest = said.slice(name.length + 1)
  return rest.charAt(0).toUpperCase() + rest.slice(1)
}

/** The steps of the work on screen, kept for as long as it shows, from the stages it reports. */
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
