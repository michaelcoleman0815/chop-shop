import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { clock } from '../format'

/**
 * The layer tracks along the strip, one lane each, on the strip's own clock:
 * picture tracks above the edit (the top track highest), sound tracks below.
 * A clip is a block: click it to pick it, drag it to move it, drag either end
 * to trim it. Moves and trims snap to the words, the beats, the other clips'
 * ends and the playhead, so a clip lands on a word as easily as on a time,
 * and each is one op, made when the pointer comes up. Delete takes a picked
 * clip away; S splits it at the playhead.
 */

export interface LaneClip {
  id: string
  label: string
  kind: string
  start: number
  end: number
  /** Its keys, as edit seconds, for the small marks along it. */
  keys: number[]
}

export interface Lane {
  id: string
  name: string
  kind: 'picture' | 'sound'
  hidden: boolean
  mute: boolean
  locked: boolean
  clips: LaneClip[]
}

/** A moment a move or a trim can land on: an anchor the edit knows, and its time. */
export interface Snap {
  t: number
  anchor: string
}

/** How far a press moves before it is a drag rather than a click. */
const DRAG_PX = 4
/** How near a snap point, in pixels, an edge is pulled onto it. */
const SNAP_PX = 8

type Grab = 'move' | 'in' | 'out'

export function Lanes({
  lanes,
  duration,
  time,
  selected,
  snaps,
  onSelect,
  onMove,
  onTrim,
  onRemove,
  onSplit
}: {
  lanes: Lane[]
  duration: number
  time: number
  selected: string | null
  snaps: Snap[]
  onSelect: (id: string | null) => void
  /** A clip moved: its start to this anchor, its end now at this second of the edit. */
  onMove: (id: string, from: string, endSec: number) => void
  onTrim: (id: string, edge: 'in' | 'out', to: string) => void
  onRemove: (id: string) => void
  onSplit: (id: string, at: string) => void
}): JSX.Element | null {
  const box = useRef<HTMLDivElement>(null)
  const press = useRef<{ id: string; grab: Grab; x: number; start: number; end: number; moved: boolean; pointer: number } | null>(null)
  const ghost = useRef<HTMLElement | null>(null)

  if (lanes.length === 0) return null
  const pct = (t: number): string => `${(Math.max(0, Math.min(duration, t)) / Math.max(1e-6, duration)) * 100}%`
  const width = (): number => box.current?.getBoundingClientRect().width ?? 1

  /** The anchor nearest t within the snap distance, or a time on the edit's clock. */
  const anchorAt = (t: number, skip: string): Snap => {
    const perPx = duration / Math.max(1, width())
    let best: Snap | null = null
    for (const s of snaps) {
      if (s.anchor === skip) continue
      if (Math.abs(s.t - t) <= SNAP_PX * perPx && (!best || Math.abs(s.t - t) < Math.abs(best.t - t))) best = s
    }
    if (Math.abs(time - t) <= SNAP_PX * perPx && (!best || Math.abs(time - t) < Math.abs(best.t - t)))
      best = { t: time, anchor: `start+${time.toFixed(2)}` }
    const clamped = Math.max(0, Math.min(duration, t))
    return best ?? { t: clamped, anchor: clamped < 0.005 ? 'start' : `start+${clamped.toFixed(2)}` }
  }

  const down = (e: PointerEvent<HTMLElement>, clip: LaneClip, grab: Grab, locked: boolean): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    onSelect(clip.id)
    if (locked) return
    press.current = { id: clip.id, grab, x: e.clientX, start: clip.start, end: clip.end, moved: false, pointer: e.pointerId }
    ghost.current = (e.currentTarget.closest('.cl-lclip') as HTMLElement | null) ?? null
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const shown = (p: NonNullable<typeof press.current>, dx: number): { start: number; end: number; anchor: Snap | null } => {
    const dt = (dx / Math.max(1, width())) * duration
    if (p.grab === 'move') {
      const len = p.end - p.start
      const s = anchorAt(p.start + dt, '')
      const start = Math.max(0, Math.min(duration - 0.05, s.t))
      return { start, end: start + len, anchor: { ...s, t: start } }
    }
    if (p.grab === 'in') {
      const s = anchorAt(p.start + dt, '')
      return { start: Math.min(s.t, p.end - 0.05), end: p.end, anchor: s }
    }
    const s = anchorAt(p.end + dt, '')
    return { start: p.start, end: Math.max(s.t, p.start + 0.05), anchor: s }
  }

  const move = (e: PointerEvent<HTMLElement>): void => {
    const p = press.current
    if (!p || p.pointer !== e.pointerId) return
    const dx = e.clientX - p.x
    if (!p.moved && Math.abs(dx) < DRAG_PX) return
    p.moved = true
    // Drawn where it would land, without a render per pixel; the op lands it for real on release.
    const at = shown(p, dx)
    if (ghost.current) {
      ghost.current.style.left = pct(at.start)
      ghost.current.style.width = `${((at.end - at.start) / Math.max(1e-6, duration)) * 100}%`
      ghost.current.dataset.dragging = 'true'
    }
  }

  const up = (e: PointerEvent<HTMLElement>): void => {
    const p = press.current
    press.current = null
    if (ghost.current) delete ghost.current.dataset.dragging
    ghost.current = null
    if (!p || p.pointer !== e.pointerId || !p.moved) return
    const at = shown(p, e.clientX - p.x)
    if (!at.anchor) return
    if (p.grab === 'move') onMove(p.id, at.anchor.anchor, at.end)
    else onTrim(p.id, p.grab, at.anchor.anchor)
  }

  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!selected) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      onRemove(selected)
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault()
      onSplit(selected, `start+${time.toFixed(2)}`)
    } else if (e.key === 'Escape') onSelect(null)
  }

  return (
    <div ref={box} className="cl-lanes" onKeyDown={key}>
      {lanes.map((lane) => (
        <div
          key={lane.id}
          className={`cl-lane ${lane.kind}${lane.hidden || lane.mute ? ' off' : ''}${lane.locked ? ' locked' : ''}`}
          aria-label={`${lane.name}${lane.hidden ? ', hidden' : ''}${lane.mute ? ', muted' : ''}${lane.locked ? ', locked' : ''}`}
          role="group"
        >
          <span className="cl-lane-name" aria-hidden="true">
            {lane.name}
          </span>
          {lane.clips.map((c) => (
            <div
              key={c.id}
              className={`cl-lclip ${c.kind}${c.id === selected ? ' on' : ''}`}
              style={{ left: pct(c.start), width: `${((c.end - c.start) / Math.max(1e-6, duration)) * 100}%` }}
              role="button"
              tabIndex={0}
              aria-pressed={c.id === selected}
              aria-label={`${c.label}, ${clock(c.start)} to ${clock(c.end)}`}
              title={`${c.label} · ${clock(c.start)} to ${clock(c.end)}`}
              onPointerDown={(e) => down(e, c, 'move', lane.locked)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={() => (press.current = null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(c.id)
                }
              }}
            >
              <span
                className="cl-lclip-edge in"
                aria-hidden="true"
                onPointerDown={(e) => down(e, c, 'in', lane.locked)}
                onPointerMove={move}
                onPointerUp={up}
              />
              <span className="cl-lclip-label">{c.label}</span>
              {c.keys.map((k, i) => (
                <span
                  key={i}
                  className="cl-lclip-key"
                  aria-hidden="true"
                  style={{ left: `${((k - c.start) / Math.max(1e-6, c.end - c.start)) * 100}%` }}
                />
              ))}
              <span
                className="cl-lclip-edge out"
                aria-hidden="true"
                onPointerDown={(e) => down(e, c, 'out', lane.locked)}
                onPointerMove={move}
                onPointerUp={up}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
