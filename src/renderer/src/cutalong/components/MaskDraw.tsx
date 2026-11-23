import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { isKeyed } from '../../../../shared/anim'
import type { Op } from '../../../../shared/edit'
import { sampleTransform, type Layer, type LayerMask, type Size, type Transform, type VideoLayer } from '../../../../shared/motion'
import { boxToPicture, cropAt, pathAt, storedPath, withPathKey, type ClipMask, type TrackClip } from '../../../../shared/tracks'
import { MEDIA_CORS, mediaUrlFor } from '../api'
import { loadReadablePicture } from '../mattes-preview'
import type { RotoEdit } from './RotoFields'

/**
 * Over the preview while a clip's mask is drawn or moved, or its key's
 * colour is picked: the mask's path at the playhead, where the clip shows it
 * (moved, scaled and turned as the clip is). Drawing, a click places a point
 * and a click on the first point closes the shape; moving, a point drags, a
 * double-click turns it between a corner and a curve, and Delete takes the
 * one picked away. A path with keys gets a key at the playhead for each
 * change; one without simply changes. Picking, a click takes the colour of
 * the clip's own picture there for its key.
 */

const SAME_PX = 9

/** The layer's own pixels to the frame's, at a moment: as the compositor moves it (shared/motion draw). */
function transformMatrix(tf: Transform | undefined, local: number, length: number): DOMMatrix {
  const s = sampleTransform(tf, local, length)
  let m = new DOMMatrix().translate(s.x, s.y)
  if (s.rot) m = m.rotate(s.rot)
  if (s.kx || s.ky) m = m.multiply(new DOMMatrix([1, Math.tan((s.ky * Math.PI) / 180), Math.tan((s.kx * Math.PI) / 180), 1, 0, 0]))
  if (s.sx !== 1 || s.sy !== 1) m = m.scale(s.sx, s.sy)
  if (s.ax || s.ay) m = m.translate(-s.ax, -s.ay)
  return m
}

/** A mask's path coordinates to the frame's: the layer's move, then the mask's origin and its own move. */
function maskMatrix(layer: Layer, mask: LayerMask | undefined, design: Size, local: number, length: number): DOMMatrix {
  // A layer's own transform starts from its position alone; its opacity is not a move.
  let m = transformMatrix(layer.transform, local, length)
  const origin = mask?.origin ?? { x: -design.width / 2, y: -design.height / 2 }
  m = m.translate(origin.x, origin.y)
  if (mask?.transform) m = m.multiply(transformMatrix(mask.transform, local, length))
  return m
}

/** Smooth handles for point i, from its neighbours, as a curve through them. */
function smoothed(path: number[][], i: number): number[] {
  const p = path[i]
  const a = path[(i - 1 + path.length) % path.length]
  const b = path[(i + 1) % path.length]
  const tx = (b[0] - a[0]) * 0.2
  const ty = (b[1] - a[1]) * 0.2
  return [p[0], p[1], -tx, -ty, tx, ty]
}

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase()

export function MaskDraw({
  edit,
  clip,
  layer,
  span,
  time,
  design,
  box,
  onOps,
  onEdit,
  frame
}: {
  edit: RotoEdit
  clip: TrackClip
  /** The clip's layer as it is drawn now, for where it sits. */
  layer: Layer | undefined
  span: { start: number; end: number } | null
  time: number
  design: Size
  box: { w: number; h: number }
  onOps: (ops: Op[], said: string) => void
  onEdit: (edit: RotoEdit | null) => void
  /** A video clip's frame now, for picking a colour from it. */
  frame?: (layer: VideoLayer, local: number) => CanvasImageSource | null
}): JSX.Element | null {
  const area = useRef<HTMLDivElement>(null)
  const length = span ? span.end - span.start : 0
  const local = span ? Math.min(length, Math.max(0, time - span.start)) : 0
  const picking = 'pick' in edit
  const index = 'mask' in edit ? edit.mask : null
  const masks = clip.masks ?? []
  const mask: ClipMask | undefined = index !== null ? masks[index] : undefined
  // A new mask's points while it is drawn, a moved mask's path while a point drags.
  const [drawn, setDrawn] = useState<number[][]>([])
  const [dragging, setDragging] = useState<{ point: number; path: number[][] } | null>(null)
  const [picked, setPicked] = useState<number | null>(null)

  useEffect(() => {
    setDrawn([])
    setDragging(null)
    setPicked(null)
  }, [clip.id, index, picking])

  const m = useMemo(
    () => (layer ? maskMatrix(layer, index !== null ? layer.masks?.[index] : undefined, design, local, length) : null),
    [layer, index, design, local, length]
  )
  const kx = box.w / design.width
  const ky = box.h / design.height
  const toScreen = (x: number, y: number): [number, number] => {
    if (!m) return [x * kx, y * ky]
    const p = m.transformPoint(new DOMPoint(x, y))
    return [p.x * kx, p.y * ky]
  }
  const fromScreen = (sx: number, sy: number): [number, number] => {
    const p = m ? m.inverse().transformPoint(new DOMPoint(sx / kx, sy / ky)) : new DOMPoint(sx / kx, sy / ky)
    return [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]
  }
  const at = (e: PointerEvent | MouseEvent): [number, number] => {
    const r = area.current?.getBoundingClientRect()
    return r ? [e.clientX - r.left, e.clientY - r.top] : [0, 0]
  }

  const path: number[][] = index === null ? drawn.map((p) => [p[0], p[1], 0, 0, 0, 0]) : (dragging?.path ?? (mask ? pathAt(mask.path, local, length) : []))
  const screen = path.map((p) => {
    const [x, y] = toScreen(p[0], p[1])
    const [ix, iy] = toScreen(p[0] + p[2], p[1] + p[3])
    const [ox, oy] = toScreen(p[0] + p[4], p[1] + p[5])
    return { x, y, ix, iy, ox, oy }
  })
  const closed = index !== null
  const d =
    screen.length === 0
      ? ''
      : `M${screen[0].x} ${screen[0].y}` +
        screen
          .slice(1)
          .concat(closed ? [screen[0]] : [])
          .map((b, k) => {
            const a = screen[k]
            return `C${a.ox} ${a.oy} ${b.ix} ${b.iy} ${b.x} ${b.y}`
          })
          .join('') +
        (closed ? 'Z' : '')

  /** A moved mask's new path, as a change: at the playhead's key when its path has keys. */
  const commit = (next: number[][], words: string): void => {
    if (index === null || !mask) return
    const stored = storedPath(next)
    const keyed = isKeyed(mask.path)
    const pathValue = keyed ? withPathKey(mask.path, local, stored, length) : stored
    onOps([{ op: 'clip-update', clip: clip.id, masks: masks.map((x, k) => (k === index ? { ...x, path: pathValue } : x)) } as Op], keyed ? 'A key on a mask’s shape is set.' : words)
  }

  const close = (): void => {
    if (drawn.length < 3) return
    const added: ClipMask = { path: storedPath(drawn.map((p) => [p[0], p[1], 0, 0, 0, 0])), mode: 'add', invert: false, feather: 0, expand: 0, opacity: 1 }
    onOps([{ op: 'clip-update', clip: clip.id, masks: [...masks, added] } as Op], 'A mask goes on the clip.')
    setDrawn([])
    onEdit({ clip: clip.id, mask: masks.length })
  }

  const pick = (sx: number, sy: number): void => {
    if (!layer || (layer.kind !== 'video' && layer.kind !== 'image')) return
    const lm = transformMatrix(layer.transform, local, length)
    const p = lm.inverse().transformPoint(new DOMPoint(sx / kx, sy / ky))
    const read = (img: CanvasImageSource, iw: number, ih: number): void => {
      if (!iw || !ih) return
      const shares = boxToPicture([p.x + design.width / 2, p.y + design.height / 2, 0, 0], iw / ih, design, clip.fit, cropAt(clip.crop, local, length))
      const px = Math.min(iw - 1, Math.max(0, Math.floor(shares[0] * iw)))
      const py = Math.min(ih - 1, Math.max(0, Math.floor(shares[1] * ih)))
      const c = document.createElement('canvas')
      c.width = 1
      c.height = 1
      const ctx = c.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      try {
        ctx.drawImage(img, px, py, 1, 1, 0, 0, 1, 1)
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
        const key = { ...(clip.key ?? { tolerance: 0.35, softness: 0.15, spill: 0.5 }), colour: toHex(r, g, b) }
        onOps([{ op: 'clip-update', clip: clip.id, key } as Op], 'The key takes out the colour picked.')
        onEdit(null)
      } catch {
        // A picture the page may not read: nothing is picked.
      }
    }
    if (layer.kind === 'video') {
      const img = frame?.(layer, local)
      const v = img as HTMLVideoElement | null
      if (v) read(v, v.videoWidth, v.videoHeight)
    } else if (layer.file) {
      void loadReadablePicture(mediaUrlFor(layer.file), MEDIA_CORS).then((img) => img && read(img, img.naturalWidth, img.naturalHeight))
    }
  }

  const nearest = (x: number, y: number): number => {
    let best = -1
    let bestD = SAME_PX
    screen.forEach((p, i) => {
      const dd = Math.hypot(p.x - x, p.y - y)
      if (dd <= bestD) {
        bestD = dd
        best = i
      }
    })
    return best
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable]')) return
      if (e.key === 'Escape') onEdit(null)
      else if (e.key === 'Enter' && index === null) close()
      else if ((e.key === 'Delete' || e.key === 'Backspace') && index !== null && picked !== null && path.length > 3) {
        e.preventDefault()
        commit(
          path.filter((_, k) => k !== picked),
          'A point comes off a mask.'
        )
        setPicked(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!span || time < span.start || time > span.end || !layer) return null

  return (
    <div
      ref={area}
      className={`cl-roto${picking ? ' picking' : ''}`}
      aria-label={picking ? 'Click the colour to take out' : index === null ? 'Click to place the mask’s points' : 'Drag the mask’s points'}
      onPointerDown={(e) => {
        const [x, y] = at(e)
        if (picking) return pick(x, y)
        const i = nearest(x, y)
        if (index === null) {
          // The first point again closes the shape.
          if (i === 0 && drawn.length >= 3) return close()
          setDrawn((pts) => [...pts, fromScreen(x, y)])
          return
        }
        if (i < 0) {
          setPicked(null)
          return
        }
        e.currentTarget.setPointerCapture(e.pointerId)
        setPicked(i)
        setDragging({ point: i, path: path.map((p) => [...p]) })
      }}
      onPointerMove={(e) => {
        if (!dragging) return
        const [x, y] = fromScreen(...at(e))
        const next = dragging.path.map((p, k) => (k === dragging.point ? [x, y, p[2], p[3], p[4], p[5]] : p))
        setDragging({ ...dragging, path: next })
      }}
      onPointerUp={() => {
        if (!dragging) return
        const moved = dragging.path[dragging.point]
        const was = mask ? pathAt(mask.path, local, length)[dragging.point] : null
        setDragging(null)
        if (was && Math.hypot(moved[0] - was[0], moved[1] - was[1]) > 0.5) commit(dragging.path, 'A mask changes shape.')
      }}
      onPointerCancel={() => setDragging(null)}
      onDoubleClick={(e) => {
        if (index === null || picking) return
        const i = nearest(...at(e.nativeEvent))
        if (i < 0) return
        const p = path[i]
        const corner = p[2] === 0 && p[3] === 0 && p[4] === 0 && p[5] === 0
        commit(
          path.map((q, k) => (k === i ? (corner ? smoothed(path, i) : [q[0], q[1], 0, 0, 0, 0]) : q)),
          corner ? 'A mask’s point becomes a curve.' : 'A mask’s point becomes a corner.'
        )
      }}
    >
      {!picking && (
        <svg className="cl-roto-svg" width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`} aria-hidden="true">
          {d && <path className="cl-roto-under" d={d} />}
          {d && <path className="cl-roto-line" d={d} />}
          {screen.map((p, i) => (
            <circle key={i} className={`cl-roto-point${i === picked ? ' on' : ''}${index === null && i === 0 && drawn.length >= 3 ? ' first' : ''}`} cx={p.x} cy={p.y} r={5} />
          ))}
        </svg>
      )}
    </div>
  )
}
