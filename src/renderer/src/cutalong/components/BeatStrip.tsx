import { useRef, type MouseEvent } from 'react'
import { clock } from '../format'
import { along } from '../motion'
import { Icon, IconButton } from './ui'

/**
 * The edit drawn to length: one rounded segment per beat, the playing one in
 * ink with its label, the playhead in coral. Clicking anywhere on the strip
 * moves the playhead there.
 */

export interface StripBeat {
  id: string
  label: string
  start: number
  end: number
  bw: boolean
}

/** A graphic on the cut: a thin bar over the beats it covers, in a row of its own when graphics overlap. */
export interface StripMark {
  id: string
  label: string
  start: number
  end: number
  row: number
}

export function BeatStrip({
  beats,
  duration,
  time,
  playing,
  onToggle,
  onSeek,
  marks = [],
  selected = null,
  onMark
}: {
  beats: StripBeat[]
  duration: number
  time: number
  playing: boolean
  onToggle: () => void
  onSeek: (sec: number) => void
  marks?: StripMark[]
  selected?: string | null
  onMark?: (id: string) => void
}): JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  const now =
    beats.find((b) => time >= b.start && time < b.end) ?? (time >= duration ? beats[beats.length - 1] : undefined)

  const seek = (e: MouseEvent): void => {
    const box = track.current?.getBoundingClientRect()
    if (!box || duration <= 0) return
    onSeek(Math.min(duration, Math.max(0, ((e.clientX - box.left) / box.width) * duration)))
  }

  return (
    <div className="cl-strip">
      <IconButton label={playing ? 'Pause' : 'Play'} filled onClick={onToggle}>
        {playing ? <Icon.pause /> : <Icon.play />}
      </IconButton>
      <span className="cl-timecode">
        {clock(time)} <span className="muted">/ {clock(duration)}</span>
      </span>
      <div
        ref={track}
        className="cl-beats"
        role="slider"
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={`${clock(time)} of ${clock(duration)}`}
        tabIndex={0}
        onClick={seek}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') onSeek(Math.min(duration, time + 1))
          if (e.key === 'ArrowLeft') onSeek(Math.max(0, time - 1))
        }}
      >
        {beats.map((b) => (
          <span
            key={b.id}
            className={`cl-beat${b === now ? ' on' : ''}${b.bw ? ' bw' : ''}`}
            style={{ flexGrow: Math.max(0.05, b.end - b.start) }}
            title={`${b.label} · ${clock(b.start)}`}
          >
            {b === now ? b.label : ''}
          </span>
        ))}
        {duration > 0 &&
          marks.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`cl-mark${m.id === selected ? ' on' : ''}`}
              style={{
                left: `${(m.start / duration) * 100}%`,
                width: `${(Math.max(0, m.end - m.start) / duration) * 100}%`,
                top: -11 - m.row * 8
              }}
              aria-label={`${m.label}, ${clock(m.start)}`}
              aria-pressed={m.id === selected}
              title={`${m.label} · ${clock(m.start)}`}
              onClick={(e) => {
                e.stopPropagation()
                onMark?.(m.id)
              }}
            />
          ))}
        {duration > 0 && <span className="cl-playhead" style={along(Math.min(time, duration) / duration)} />}
      </div>
    </div>
  )
}
