import { useRef, useState, type PointerEvent } from 'react'
import type { MotionItem } from '../../../../shared/motion'

/**
 * Over the preview while a callout is selected: click on the picture to
 * point it at a spot, or drag a box around the thing it is about. The model
 * cannot see the frame, so this is how a callout finds its part. The region
 * goes into the graphic as fractions of the frame.
 */

const clamp = (v: number): number => Math.min(1, Math.max(0, v))
const round = (v: number): number => Math.round(v * 1000) / 1000

/** Styles that aim at a point rather than frame a region. */
const POINTS = new Set(['', 'spec', 'pointer'])

export function RegionPicker({ item, onPick }: { item: MotionItem; onPick: (box: number[]) => void }): JSX.Element {
  const area = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  const at = (e: PointerEvent): [number, number] => {
    const r = area.current?.getBoundingClientRect()
    if (!r || r.width === 0 || r.height === 0) return [0.5, 0.5]
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)]
  }

  const finish = (e: PointerEvent): void => {
    if (!drag) return
    const [x1, y1] = at(e)
    setDrag(null)
    const w = Math.abs(x1 - drag.x0)
    const h = Math.abs(y1 - drag.y0)
    if (w < 0.015 && h < 0.015) {
      // A click: a point for the styles that aim, a modest box around it for the rest.
      if (POINTS.has(item.style)) onPick([round(x1), round(y1)])
      else onPick([round(clamp(x1 - 0.15)), round(clamp(y1 - 0.04)), 0.3, 0.08])
      return
    }
    onPick([
      round(Math.min(x1, drag.x0)),
      round(Math.min(y1, drag.y0)),
      round(Math.max(0.01, w)),
      round(Math.max(0.01, h))
    ])
  }

  const shown = drag
    ? {
        left: Math.min(drag.x0, drag.x1),
        top: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0)
      }
    : item.box.length === 4
      ? { left: item.box[0], top: item.box[1], width: item.box[2], height: item.box[3] }
      : null

  return (
    <div
      ref={area}
      className="cl-region"
      aria-label="Click or drag on the picture to place the graphic"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        const [x, y] = at(e)
        setDrag({ x0: x, y0: y, x1: x, y1: y })
      }}
      onPointerMove={(e) => {
        if (!drag) return
        const [x, y] = at(e)
        setDrag({ ...drag, x1: x, y1: y })
      }}
      onPointerUp={finish}
      onPointerCancel={() => setDrag(null)}
    >
      {shown && (
        <span
          className="cl-region-box"
          style={{
            left: `${shown.left * 100}%`,
            top: `${shown.top * 100}%`,
            width: `${shown.width * 100}%`,
            height: `${shown.height * 100}%`
          }}
        />
      )}
      {!drag && item.box.length === 2 && (
        <span className="cl-region-point" style={{ left: `${item.box[0] * 100}%`, top: `${item.box[1] * 100}%` }} />
      )}
    </div>
  )
}
