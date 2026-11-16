import { useRef, type MouseEvent } from 'react'
import { clock } from '../format'
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
  /** How it comes in from the beat before, when that is not a hard cut: "a dissolve". */
  comesIn?: string | null
  /** A J or L cut into it, for the tooltip: "an L cut, 0.3 s". */
  splitEdit?: string | null
}

export function BeatStrip({
  beats,
  duration,
  time,
  playing,
  onToggle,
  onSeek
}: {
  beats: StripBeat[]
  duration: number
  time: number
  playing: boolean
  onToggle: () => void
  onSeek: (sec: number) => void
}): JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  // Inside a transition two beats overlap; the one coming in is the one playing.
  const now =
    [...beats].reverse().find((b) => time >= b.start && time < b.end) ??
    (time >= duration ? beats[beats.length - 1] : undefined)

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
            className={`cl-beat${b === now ? ' on' : ''}${b.bw ? ' bw' : ''}${b.comesIn ? ' joined' : ''}`}
            style={{ flexGrow: Math.max(0.05, b.end - b.start) }}
            title={`${b.label} · ${clock(b.start)}${b.comesIn ? ` · comes in with ${b.comesIn}` : ''}${b.splitEdit ? ` · ${b.splitEdit}` : ''}`}
          >
            {b === now ? b.label : ''}
          </span>
        ))}
        {duration > 0 && (
          <span className="cl-playhead" style={{ left: `${(Math.min(time, duration) / duration) * 100}%` }} />
        )}
      </div>
    </div>
  )
}
