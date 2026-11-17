import { useRef, type CSSProperties } from 'react'
import { CREW, crewColour, doneLine, liveLine, type CrewEntry, type CrewId } from '../crew'
import { shapePath } from '../shapes'
import { Icon } from './ui'

/**
 * The crew, drawn: each member a simple shape in their colour with two eyes.
 * The shape is SVG; the eyes are their own small boxes, so a blink is a
 * transform. A face is still unless it is at work (motion.css): then each
 * moves in their own way, and gives one small hop when they finish.
 */

/** Where the eyes sit on each shape, as a share of its box. */
const EYES: Record<CrewId, { y: number; x: number }> = {
  echo: { y: 44, x: 39 },
  snip: { y: 44, x: 38 },
  quill: { y: 44, x: 41 },
  scout: { y: 54, x: 39 },
  tint: { y: 44, x: 39 },
  reel: { y: 44, x: 37 }
}

export function CrewFace({
  id,
  size,
  state = 'still',
  className = ''
}: {
  id: CrewId
  size: number
  state?: 'still' | 'working' | 'done' | 'hop'
  className?: string
}): JSX.Element {
  const member = CREW[id]
  const eyes = EYES[id]
  return (
    <span
      className={`cl-crew-face ${state} ${className}`}
      data-crew={id}
      style={
        {
          '--size': `${size}px`,
          '--crew': crewColour(id),
          '--eye-y': `${eyes.y}%`,
          '--eye-x': `${eyes.x}%`
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" width={size} height={size}>
        {id === 'scout' ? (
          <>
            {/* Round, with a nub of an antenna: it is always listening out for something. */}
            <path d="M50 17C50 11 53 7 59 5" fill="none" stroke="var(--crew)" strokeWidth="5" strokeLinecap="round" />
            <circle cx="60" cy="5" r="5" fill="var(--crew)" />
            <path d={shapePath('circle')} transform="translate(8 14) scale(0.84)" fill="var(--crew)" />
          </>
        ) : (
          <path d={shapePath(member.shape)} fill="var(--crew)" />
        )}
      </svg>
      <span className="cl-crew-eyes">
        <span />
        <span />
      </span>
    </span>
  )
}

/**
 * The crew at work on a job: each member who has joined it, in the order
 * they did, saying what they are doing now or what they did. The one at work
 * carries the plain line about it. Members join only for stages the app
 * really reports, so the line-up grows as the work does.
 */
export function CrewAtWork({
  log,
  working,
  line
}: {
  log: CrewEntry[]
  /** Who is at it right now. */
  working: ReadonlySet<CrewId>
  /** One plain sentence about what the one at work is doing. */
  line?: string
}): JSX.Element {
  // A member who has just finished hops once; one who was done before this showed stays still.
  const was = useRef<Set<CrewId>>(new Set())
  const finished = useRef<Map<CrewId, number>>(new Map())
  const now = Date.now()
  for (const id of was.current) if (!working.has(id)) finished.current.set(id, now)
  was.current = new Set(working)
  return (
    <ol className="cl-crew" aria-label="The crew on this">
      {log.map((e) => {
        const at = working.has(e.id)
        const done = finished.current.get(e.id)
        const hop = !at && done !== undefined && now - done < 700
        return (
          <li key={e.id} className={`cl-crew-row${at ? ' working' : ' done'}`}>
            <CrewFace id={e.id} size={34} state={at ? 'working' : hop ? 'hop' : 'done'} />
            <span className="cl-crew-text">
              <span className="cl-crew-line">
                <b>{CREW[e.id].name}</b>
                {(at ? liveLine(e) : doneLine(e)).slice(CREW[e.id].name.length)}
              </span>
              {at && line && <span className="cl-crew-plain">{line}</span>}
            </span>
            {!at && (
              <span className="cl-crew-done" aria-label="done">
                <Icon.check />
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/** "A, B and C." */
const sentence = (parts: string[]): string =>
  `${parts.length < 2 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`}.`

/** Who did the work behind a reply, in one quiet line, like the credits at the end of a film. */
export function Credits({ crew }: { crew: CrewEntry[] | undefined }): JSX.Element | null {
  if (!crew?.length) return null
  return (
    <div className="cl-credits">
      <span className="cl-credits-faces" aria-hidden="true">
        {crew.map((e) => (
          <CrewFace key={e.id} id={e.id} size={20} />
        ))}
      </span>
      <span className="cl-credits-line">{sentence(crew.map(doneLine))}</span>
    </div>
  )
}
