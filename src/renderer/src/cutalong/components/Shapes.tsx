import { type CSSProperties, type ReactNode } from 'react'
import { bloom, shapePath, type Avatar, type ColourName, type ShapeName } from '../shapes'

/**
 * Marks drawn in code: a brand's colour as a plain dot, a brand's avatar as
 * a circle with its initials, and two older pieces (a sticker, the living
 * mark) kept for what still imports them. Since "quiet by default"
 * (2026-11-21) a brand is no longer an organic shape: the shape it saved is
 * kept in its data and simply not drawn.
 */

export function Blob({
  colour,
  size,
  className = ''
}: {
  /** Saved with the brand, no longer drawn: a brand is a dot of its colour. */
  shape?: ShapeName
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
      <circle cx="50" cy="50" r="46" />
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

/**
 * A brand's own avatar: a circle in its colour with its initials, as a
 * channel's mark is drawn anywhere else. A colour picked again simply takes
 * the new colour, on the same short transition as any fill.
 */
export function BrandAvatar({
  avatar,
  size,
  name = '',
  className = ''
}: {
  avatar: Avatar
  size: number
  /** The brand's name, for its initials; none draws the plain circle. */
  name?: string
  className?: string
}): JSX.Element {
  const letters = initialsOf(name)
  return (
    <span
      className={`cl-brand-avatar ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38), '--bloom': bloom(avatar.colour) } as CSSProperties}
      aria-hidden="true"
    >
      {letters}
    </span>
  )
}

/** Up to two initials from a name: "Lighting at home" is "LH", "studio" is "S". */
function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w) && !/^(a|an|the|at|of|and|in|on|for|to)$/i.test(w))
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
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
