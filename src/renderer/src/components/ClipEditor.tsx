import { useCallback, useRef, useState } from 'react'
import type { TranscriptWord, ZoomKeyframe } from '../../../shared/types'
import { groupWords, respaceGroup } from '../../../shared/words'
import { timecode } from '../lib/format'

export interface Segment {
  start: number
  end: number
}

interface Props {
  durationSec: number
  segments: Segment[]
  zooms: ZoomKeyframe[]
  words: TranscriptWord[]
  currentSec: number
  onSeek: (t: number) => void
  onSegments: (s: Segment[]) => void
  onZooms: (z: ZoomKeyframe[]) => void
  onWords: (w: TranscriptWord[]) => void
}

type Drag =
  | { kind: 'edge'; index: number; side: 'start' | 'end' }
  | { kind: 'zoom'; index: number }
  | null

const MIN_SEGMENT = 0.2

export default function ClipEditor({
  durationSec,
  segments,
  zooms,
  words,
  currentSec,
  onSeek,
  onSegments,
  onZooms,
  onWords
}: Props): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag>(null)
  const [selected, setSelected] = useState<number | null>(null)

  const pct = (t: number): number => (durationSec > 0 ? (t / durationSec) * 100 : 0)

  const timeAt = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect) return 0
      const ratio = (clientX - rect.left) / rect.width
      return Math.max(0, Math.min(durationSec, ratio * durationSec))
    },
    [durationSec]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return
      const t = timeAt(e.clientX)

      if (drag.kind === 'zoom') {
        const next = zooms.map((z, i) => (i === drag.index ? { ...z, atSec: t } : z))
        onZooms(next.sort((a, b) => a.atSec - b.atSec))
        return
      }

      const next = segments.map((s) => ({ ...s }))
      const seg = next[drag.index]
      // Segments may not cross their neighbours, or the timeline stops
      // describing a playable order.
      const lower = drag.index > 0 ? next[drag.index - 1].end : 0
      const upper = drag.index < next.length - 1 ? next[drag.index + 1].start : durationSec

      if (drag.side === 'start') seg.start = Math.max(lower, Math.min(seg.end - MIN_SEGMENT, t))
      else seg.end = Math.min(upper, Math.max(seg.start + MIN_SEGMENT, t))

      onSegments(next)
    },
    [drag, segments, zooms, timeAt, durationSec, onSegments, onZooms]
  )

  const splitAtPlayhead = useCallback(() => {
    const i = segments.findIndex((s) => currentSec > s.start + MIN_SEGMENT && currentSec < s.end - MIN_SEGMENT)
    if (i === -1) return
    const seg = segments[i]
    const next = [...segments]
    next.splice(i, 1, { start: seg.start, end: currentSec }, { start: currentSec, end: seg.end })
    onSegments(next)
  }, [segments, currentSec, onSegments])

  const deleteSelected = useCallback(() => {
    if (selected === null) return
    onSegments(segments.filter((_, i) => i !== selected))
    setSelected(null)
  }, [selected, segments, onSegments])

  const addZoom = useCallback(() => {
    onZooms([...zooms, { atSec: currentSec, scale: 1.25, cx: 0.5, cy: 0.45 }].sort((a, b) => a.atSec - b.atSec))
  }, [zooms, currentSec, onZooms])

  const kept = segments.reduce((sum, s) => sum + (s.end - s.start), 0)
  const groups = groupWords(words, 4)

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="label">Edit</div>
        <div className="spacer" />
        <span className="mono muted">
          {timecode(kept)} of {timecode(durationSec)}
        </span>
      </div>

      <div
        ref={trackRef}
        className="editor-track"
        onPointerMove={onPointerMove}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
        onClick={(e) => {
          if (!drag) onSeek(timeAt(e.clientX))
        }}
      >
        {segments.map((s, i) => (
          <div
            key={i}
            className={`editor-seg ${selected === i ? 'on' : ''}`}
            style={{ left: `${pct(s.start)}%`, width: `${Math.max(0.5, pct(s.end) - pct(s.start))}%` }}
            onClick={(e) => {
              e.stopPropagation()
              setSelected(i)
            }}
          >
            <span
              className="editor-handle left"
              onPointerDown={(e) => {
                e.stopPropagation()
                setDrag({ kind: 'edge', index: i, side: 'start' })
              }}
            />
            <span
              className="editor-handle right"
              onPointerDown={(e) => {
                e.stopPropagation()
                setDrag({ kind: 'edge', index: i, side: 'end' })
              }}
            />
          </div>
        ))}

        {zooms
          .filter((z) => z.scale > 1.01)
          .map((z) => (
            <span
              key={`${z.atSec}-${z.scale}`}
              className="editor-zoom"
              style={{ left: `${pct(z.atSec)}%` }}
              title={`${z.scale.toFixed(2)}x`}
              onPointerDown={(e) => {
                e.stopPropagation()
                setDrag({ kind: 'zoom', index: zooms.indexOf(z) })
              }}
            />
          ))}

        <div className="editor-head" style={{ left: `${pct(currentSec)}%` }} />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={splitAtPlayhead}>Split</button>
        <button onClick={deleteSelected} disabled={selected === null}>
          Delete cut
        </button>
        <button onClick={addZoom}>Add zoom</button>
        <button
          className="ghost"
          disabled={zooms.length === 0}
          onClick={() => onZooms([])}
        >
          Clear zooms
        </button>
        <div className="spacer" />
        <span className="muted">{segments.length} cuts</span>
      </div>

      <div className="label" style={{ marginTop: 24, marginBottom: 8 }}>
        Captions
      </div>
      <div className="editor-captions">
        {groups.map((group, gi) => (
          <div className="row" key={gi} style={{ gap: 8 }}>
            <button
              className="ghost mono"
              style={{ minWidth: 74 }}
              onClick={() => onSeek(group[0].startSec)}
            >
              {timecode(group[0].startSec)}
            </button>
            <input
              type="text"
              defaultValue={group.map((w) => w.text).join(' ')}
              style={{ flex: 1 }}
              onBlur={(e) => {
                const replacement = respaceGroup(group, e.target.value)
                const before = words.slice(0, words.indexOf(group[0]))
                const after = words.slice(words.indexOf(group[group.length - 1]) + 1)
                onWords([...before, ...replacement, ...after])
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
