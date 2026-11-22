import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  boxRect,
  changesColour,
  currentCut,
  frameAt,
  jumpZooms,
  lookMatrix,
  pictureSpan,
  pieceFraming,
  pieceTime,
  resolveCut,
  svgColourMatrix,
  windowShare,
  type EditDoc
} from '../../../../shared/edit'
import { buildScene, designSize, themeFrom } from '../../../../shared/motion'
import { captionStyleFor, shownWords, styleCues, subtitleAt, subtitleWords } from '../../../../shared/subtitles'
import type { Brand } from '../../../../shared/brand'
import { api } from '../api'
import { MotionCanvas } from './MotionCanvas'
import { Subtitles } from './Subtitles'

/**
 * A clip as its edit shows it at one moment, for its card: the recording's frame
 * cropped where the editor crops it (on the speaker, punched in, or as a square
 * on black), in its look's colour, with its hook and its caption drawn over it by
 * the editor's own drawing (MotionCanvas, Subtitles). A raw frame cropped down
 * the middle said nothing of the edit the card opens.
 */

/** When the still is taken: early, with the hook up and the first caption on. */
export function stillMoment(durationSec: number): number {
  return Math.min(1.5, durationSec / 4)
}

const ASPECT: Record<string, number> = { vertical: 9 / 16, square: 1, wide: 16 / 9 }

export function ClipStill({
  doc,
  brand,
  onReady
}: {
  doc: EditDoc
  brand: Brand
  onReady?: () => void
}): JSX.Element {
  const holder = useRef<HTMLSpanElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [src, setSrc] = useState<string | null>(null)
  const grade = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  const cut = currentCut(doc)
  const resolved = useMemo(() => resolveCut(cut, doc.words, doc.sources), [cut, doc.words, doc.sources])
  const time = stillMoment(resolved.durationSec)
  const scene = useMemo(
    () =>
      buildScene({
        cut,
        resolved,
        words: doc.words,
        size: designSize(cut.aspect, doc.sources[0]),
        theme: themeFrom(brand),
        assets: doc.assets,
        pictures: doc.sources
      }),
    [cut, resolved, doc.words, doc.sources, doc.assets, brand]
  )
  const captionStyle = useMemo(
    () => captionStyleFor(cut.captions, scene.size.width, brand.autoApply ? brand.colors : null),
    [cut.captions, scene.size.width, brand]
  )
  const cue = useMemo(() => {
    if (!cut.captions.on) return null
    const words = subtitleWords(cut, resolved, scene).words
    return subtitleAt(styleCues(shownWords(words, cut.captions, resolved.words), captionStyle), time)
  }, [cut, resolved, scene, captionStyle, time])

  // The picture on screen at that moment, and where in its recording that is.
  const at = resolved.pieces.findIndex((p) => time >= pictureSpan(p).outStart && time < pictureSpan(p).outEnd)
  const piece = at >= 0 ? resolved.pieces[at] : resolved.pieces[0]
  const source = piece ? doc.sources.find((s) => s.id === piece.source) : undefined
  const srcSec = piece ? pieceTime(piece, time) : 0
  const rb = piece ? resolved.beats.find((b) => b.id === piece.beat) : undefined
  const t = rb ? cut.beats[rb.index]?.treatment : undefined

  // Framed as the editor's deck frames it (screens/Editor Deck): the box, the punch-in and the follow.
  const frameWhole = ASPECT[cut.aspect] ?? 9 / 16
  const boxed = cut.box && t && t.frame === 'speaker' && !t.camera && !t.broll && !t.grid && !t.angle ? cut.box : null
  const frameAspect = boxed ? boxed.aspect : frameWhole
  const jumps = useMemo(() => jumpZooms(cut, resolved, doc.sources), [cut, resolved, doc.sources])
  const zoom = (t?.zoom ?? 1) * (at >= 0 ? (jumps[at] ?? 1) : 1)
  const framing = piece && t && !t.camera ? pieceFraming(cut, t, piece, source?.subject) : null
  const picture: CSSProperties = {
    objectPosition:
      framing && piece && source
        ? `${windowShare(frameAt(framing, time - pictureSpan(piece).outStart), source, frameAspect) * 100}% 50%`
        : undefined,
    transform: zoom > 1.001 ? `scale(${zoom})` : undefined,
    transformOrigin: zoom > 1.001 && t?.zoomAt !== undefined ? `50% ${t.zoomAt * 100}%` : undefined
  }
  let area: CSSProperties = { inset: 0 }
  if (boxed) {
    const height = 1080 / frameWhole
    const r = boxRect(boxed, { width: 1080, height })
    area = { left: 0, right: 0, top: `${(r.y / height) * 100}%`, bottom: `${((height - r.y - r.height) / height) * 100}%` }
  }
  const look = cut.look ?? null
  const matrix = useMemo(() => (look && changesColour(look) ? svgColourMatrix(lookMatrix(look)) : null), [look])

  // The whole frame of the recording, uncropped: the crop is the edit's, made here.
  useEffect(() => {
    if (!source) return
    let live = true
    api
      .clipPoster(source.path, srcSec, 'source')
      .then((url) => live && setSrc(url || null))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [source?.path, srcSec])

  useLayoutEffect(() => {
    const el = holder.current
    if (!el) return
    const fit = (): void => setSize({ w: el.clientWidth, h: el.clientHeight })
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <span className="cl-still" ref={holder} style={{ position: 'absolute', inset: 0, background: '#000000' }}>
      {matrix && (
        <svg className="cl-look-defs" aria-hidden="true" focusable="false">
          <filter id={grade} colorInterpolationFilters="sRGB">
            <feColorMatrix type="matrix" values={matrix} />
          </filter>
        </svg>
      )}
      <span
        className="cl-still-picture"
        style={{ position: 'absolute', overflow: 'hidden', ...area, ...(matrix ? { filter: `url(#${grade})` } : {}) }}
      >
        {src && <img src={src} alt="" draggable={false} style={picture} onLoad={onReady} />}
      </span>
      {size.w > 0 && (
        <>
          <Subtitles cue={cue} style={captionStyle} frame={scene.size} time={time} width={size.w} height={size.h} />
          <MotionCanvas scene={scene} assets={doc.assets} time={time} width={size.w} height={size.h} />
        </>
      )}
    </span>
  )
}
