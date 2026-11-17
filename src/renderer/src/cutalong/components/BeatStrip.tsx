import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { BeatPick } from '../../../../shared/edit'
import { clock } from '../format'
import { along } from '../motion'
import { Icon, IconButton } from './ui'

/**
 * The edit drawn to length: one rounded segment per beat, the playing one in
 * ink with its label, the playhead in coral. Clicking anywhere on the strip
 * moves the playhead there.
 *
 * A stretch of beats can be picked, for a note or a command to act on: drag
 * across them, Shift-click a second beat, or, from the keyboard, Shift and an
 * arrow from the beat at the playhead (Shift with Home or End to either end).
 * Escape lets it go and Delete cuts it. A picked beat wears a quiet ring and
 * a bar runs under the stretch; neither is coral, which is the playhead's.
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
  /** How it plays when not as recorded, for the tooltip: "at 2x", "cutaway backwards". */
  plays?: string | null
}

/** A graphic on the cut: a thin bar over the beats it covers, in a row of its own when graphics overlap. */
export interface StripMark {
  id: string
  label: string
  start: number
  end: number
  row: number
}

/** How far a press moves before it is a drag rather than a click. */
const DRAG_PX = 4

export function BeatStrip({
  beats,
  duration,
  time,
  playing,
  onToggle,
  onSeek,
  marks = [],
  selected = null,
  onMark,
  pick = null,
  onPick,
  onCutPick
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
  /** The stretch picked, from where it started to where it reaches. */
  pick?: BeatPick | null
  onPick?: (pick: BeatPick | null) => void
  /** Delete or Backspace with a stretch picked. */
  onCutPick?: () => void
}): JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  // Inside a transition two beats overlap; the one coming in is the one playing.
  const now =
    [...beats].reverse().find((b) => time >= b.start && time < b.end) ??
    (time >= duration ? beats[beats.length - 1] : undefined)

  const a = pick ? beats.findIndex((b) => b.id === pick.anchor) : -1
  const z = pick ? beats.findIndex((b) => b.id === pick.focus) : -1
  const picked = a >= 0 && z >= 0 ? beats.slice(Math.min(a, z), Math.max(a, z) + 1) : []
  const pickedIds = new Set(picked.map((b) => b.id))
  const first = picked[0]
  const last = picked[picked.length - 1]

  const seek = (clientX: number): void => {
    const box = track.current?.getBoundingClientRect()
    if (!box || duration <= 0) return
    onSeek(Math.min(duration, Math.max(0, ((clientX - box.left) / box.width) * duration)))
  }

  /** The beat drawn under a point across the strip: the one there, or the nearest across a gap. */
  const beatAtX = (clientX: number): StripBeat | undefined => {
    const el = track.current
    if (!el) return undefined
    let best: { b: StripBeat; d: number } | undefined
    for (const node of el.querySelectorAll<HTMLElement>('.cl-beat')) {
      const r = node.getBoundingClientRect()
      const d = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0
      const b = beats.find((x) => x.id === node.dataset.beat)
      if (b && (!best || d < best.d)) best = { b, d }
    }
    return best?.b
  }

  const press = useRef<{ x: number; anchor: string; moved: boolean; pointer: number } | null>(null)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.cl-mark')) return
    const beat = beatAtX(e.clientX)
    if (!beat) return
    if (e.shiftKey && onPick) {
      // Shift-click: from where the stretch started, or the beat at the playhead, to this one.
      e.preventDefault()
      onPick({ anchor: pick?.anchor ?? now?.id ?? beat.id, focus: beat.id })
      return
    }
    press.current = { x: e.clientX, anchor: beat.id, moved: false, pointer: e.pointerId }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const p = press.current
    if (!p || p.pointer !== e.pointerId) return
    if (!p.moved && Math.abs(e.clientX - p.x) < DRAG_PX) return
    p.moved = true
    const beat = beatAtX(e.clientX)
    if (beat && onPick) onPick({ anchor: p.anchor, focus: beat.id })
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const p = press.current
    press.current = null
    if (!p || p.pointer !== e.pointerId) return
    if (p.moved) return
    // A click lets any stretch go and moves the playhead, as it always did.
    if (pick) onPick?.(null)
    seek(e.clientX)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const extend = (to: number): void => {
      const anchor = pick?.anchor ?? now?.id
      const target = beats[Math.max(0, Math.min(beats.length - 1, to))]
      if (anchor && target && onPick) onPick({ anchor, focus: target.id })
    }
    const at = beats.findIndex((b) => b.id === (pick?.focus ?? now?.id))
    if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault()
      // The first Shift and arrow picks the beat at the playhead; each one after reaches a beat further.
      extend(pick ? at + (e.key === 'ArrowRight' ? 1 : -1) : at)
      return
    }
    if (e.shiftKey && (e.key === 'Home' || e.key === 'End')) {
      e.preventDefault()
      extend(e.key === 'Home' ? 0 : beats.length - 1)
      return
    }
    if (e.key === 'Escape' && pick) {
      e.preventDefault()
      onPick?.(null)
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && pick) {
      e.preventDefault()
      onCutPick?.()
      return
    }
    if (e.key === 'ArrowRight') onSeek(Math.min(duration, time + 1))
    if (e.key === 'ArrowLeft') onSeek(Math.max(0, time - 1))
  }

  // The bar under a picked stretch, measured from the beats as they are drawn.
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const el = track.current
    if (!el || !first || !last) {
      setBar(null)
      return
    }
    const measure = (): void => {
      const from = el.querySelector<HTMLElement>(`[data-beat="${CSS.escape(first.id)}"]`)
      const to = el.querySelector<HTMLElement>(`[data-beat="${CSS.escape(last.id)}"]`)
      if (from && to) setBar({ left: from.offsetLeft, width: to.offsetLeft + to.offsetWidth - from.offsetLeft })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [first, last, beats])

  const pickedSay =
    first && last
      ? `${picked.length === 1 ? 'One beat' : `${picked.length} beats`} picked, ${clock(first.start)} to ${clock(last.end)}. A note or a command acts on ${picked.length === 1 ? 'it' : 'them'}; Delete cuts ${picked.length === 1 ? 'it' : 'them'}, Escape lets go.`
      : ''

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
        className={`cl-beats${picked.length ? ' picking' : ''}`}
        role="slider"
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={`${clock(time)} of ${clock(duration)}`}
        aria-describedby="cl-picked"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (press.current = null)}
        onKeyDown={onKeyDown}
      >
        {beats.map((b) => (
          <span
            key={b.id}
            data-beat={b.id}
            className={`cl-beat${b === now ? ' on' : ''}${b.bw ? ' bw' : ''}${b.comesIn ? ' joined' : ''}${pickedIds.has(b.id) ? ' picked' : ''}`}
            style={{ flexGrow: Math.max(0.05, b.end - b.start) }}
            title={`${b.label} · ${clock(b.start)}${b.comesIn ? ` · comes in with ${b.comesIn}` : ''}${b.splitEdit ? ` · ${b.splitEdit}` : ''}${b.plays ? ` · ${b.plays}` : ''}`}
          >
            {b === now ? b.label : ''}
          </span>
        ))}
        {bar && <span className="cl-pick" style={{ left: bar.left, width: bar.width }} aria-hidden="true" />}
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
      <span id="cl-picked" className="sr-only" aria-live="polite">
        {pickedSay}
      </span>
    </div>
  )
}
