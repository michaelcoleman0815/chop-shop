import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { bloom, shapePath, type Avatar, type ColourName, type ShapeName } from '../shapes'

/**
 * Shapes with character, drawn from shapes.ts: a blob, a sticker with a word
 * or a number on it, a brand's avatar that morphs when its shape or colour is
 * picked, and the living mark that breathes while Cutalong works on something
 * big. Every one of them moves only by transform, opacity and filter.
 */

export function Blob({
  shape,
  colour,
  size,
  className = ''
}: {
  shape: ShapeName
  colour: ColourName
  size: number
  className?: string
}): JSX.Element {
  return (
    <svg
      className={`cl-blob ${className}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      style={{ '--bloom': bloom(colour) } as CSSProperties}
    >
      <path d={shapePath(shape)} />
    </svg>
  )
}

/**
 * A sticker: a short word or number on a shape, popped onto what it marks
 * (a version's badge, a count, "new"). The words are for the eye; whatever
 * it marks says the same in its own label.
 */
export function Sticker({
  shape = 'scallop',
  colour,
  size = 34,
  tilt = -8,
  className = '',
  children
}: {
  shape?: ShapeName
  colour: ColourName
  size?: number
  /** Degrees it sits at, as if pressed on by hand. */
  tilt?: number
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <span
      className={`cl-sticker ${className}`}
      style={{ '--size': `${size}px`, '--tilt': `${tilt}deg` } as CSSProperties}
      aria-hidden="true"
    >
      <Blob shape={shape} colour={colour} size={size} />
      <span className="cl-sticker-text">{children}</span>
    </span>
  )
}

interface Layer extends Avatar {
  key: number
  leaving: boolean
}

/**
 * A brand's own avatar. When its shape or colour changes, the new one pops
 * in over the old, which softens and fades: a morph made of two pictures, so
 * it stays on the compositor. Changed again mid-way, it moves on from where
 * it is: the one popping in starts to leave from there, and the one already
 * leaving keeps fading rather than vanishing.
 */
export function BrandAvatar({
  avatar,
  size,
  className = ''
}: {
  avatar: Avatar
  size: number
  /** The brand's name, for when the avatar draws its initials; this one draws the shape alone. */
  name?: string
  className?: string
}): JSX.Element {
  const [layers, setLayers] = useState<Layer[]>(() => [{ ...avatar, key: 0, leaving: false }])
  const timer = useRef<number | null>(null)

  useEffect(() => {
    setLayers((now) => {
      const top = now[now.length - 1]
      if (top.shape === avatar.shape && top.colour === avatar.colour) return now
      // Picked again mid-morph: the shape still fading keeps fading under the two new layers.
      const fading = now.slice(0, -1).filter((l) => l.leaving).slice(-1)
      return [...fading, { ...top, leaving: true }, { ...avatar, key: top.key + 1, leaving: false }]
    })
  }, [avatar.shape, avatar.colour])

  // The old picture goes once it has faded.
  useEffect(() => {
    if (layers.length < 2) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setLayers((now) => now.filter((l) => !l.leaving)), 420)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [layers])

  return (
    <span className={`cl-avatar-blob ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      {layers.map((l) => (
        <Blob
          key={l.key}
          shape={l.shape}
          colour={l.colour}
          size={size}
          className={l.leaving ? 'leaving' : l.key > 0 ? 'arriving' : ''}
        />
      ))}
    </span>
  )
}

/**
 * The living mark: while Cutalong works on something big, its mark becomes a
 * soft, iridescent blob that breathes and slowly shifts (motion.css). Three
 * blurred shapes in the bloom colours turn at their own speeds over a warm
 * core; under reduced motion it only breathes, in opacity.
 */
export function LivingMark({ size = 64, className = '' }: { size?: number; className?: string }): JSX.Element {
  return (
    <span className={`cl-living ${className}`} style={{ '--size': `${size}px` } as CSSProperties} aria-hidden="true">
      <span className="cl-living-turn one">
        <svg viewBox="0 0 100 100">
          <path d={shapePath('star')} />
        </svg>
      </span>
      <span className="cl-living-turn two">
        <svg viewBox="0 0 100 100">
          <path d={shapePath('flower')} />
        </svg>
      </span>
      <span className="cl-living-turn three">
        <svg viewBox="0 0 100 100">
          <path d={shapePath('clover')} />
        </svg>
      </span>
      <span className="cl-living-core" />
    </span>
  )
}
