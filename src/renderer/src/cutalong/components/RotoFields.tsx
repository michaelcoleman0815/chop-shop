import { useState } from 'react'
import { isKeyed, keyTime, num, type Key } from '../../../../shared/anim'
import type { Op } from '../../../../shared/edit'
import { ellipsePath, pathAt, storedPath, withPathKey, type ClipMask, type MaskPath, type TrackClip } from '../../../../shared/tracks'
import { NumberField } from './ClipPanel'
import { Button, Icon, IconButton } from './ui'

/**
 * A picture clip's masks, matte, key and following, under its other
 * settings (ClipPanel): masks to add (an oval, or one drawn on the preview),
 * each with how it combines, which side it keeps, its feather and its
 * growth, and a key on its path at the playhead; a matte from the person, the
 * objects or another clip; following what is under it; and a colour keyed
 * out, picked from the picture. Each change is one op, made as the field is
 * left; the drawing happens over the preview (MaskDraw).
 */

/** What the preview is doing for a clip: drawing a new mask (mask null), moving one's points, or picking the key's colour. */
export type RotoEdit = { clip: string; mask: number | null } | { clip: string; pick: true }

export interface RotoProps {
  edit: RotoEdit | null
  onEdit: (edit: RotoEdit | null) => void
  /** The other picture clips, for a matte taken from one. */
  others: { id: string; label: string }[]
  /** Asks for these ops and follows what they ask to: the sentence to show, or '' once it follows. */
  onFollow: (ask: Op[]) => Promise<string>
}

const SAME = 1e-3
const KEY_DEFAULT = { colour: '#00FF00', tolerance: 0.35, softness: 0.15, spill: 0.5 }

const MODE_NAME: Record<ClipMask['mode'], string> = { add: 'Add', subtract: 'Subtract', intersect: 'Overlap' }

/** The change that gives a clip these masks. */
const masksOp = (clip: TrackClip, masks: ClipMask[]): Op => ({ op: 'clip-update', clip: clip.id, masks }) as Op

/** A #rrggbb for the colour input, from whatever the key holds. */
function hex(colour: string): string {
  const c = colour.trim()
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toUpperCase()
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`.toUpperCase()
  return '#00FF00'
}

export function RotoFields({
  clip,
  span,
  frame,
  time,
  onOps,
  edit,
  onEdit,
  others,
  onFollow
}: RotoProps & {
  clip: TrackClip
  span: { start: number; end: number } | null
  frame: { width: number; height: number }
  time: number
  onOps: (ops: Op[], said: string) => void
}): JSX.Element {
  const [said, setSaid] = useState('')
  const [following, setFollowing] = useState(false)
  const length = span ? span.end - span.start : 0
  const local = span ? Math.min(length, Math.max(0, time - span.start)) : 0
  const inside = !!span && time >= span.start && time <= span.end
  const masks = clip.masks ?? []
  const mine = edit && edit.clip === clip.id ? edit : null
  const drawingNew = !!mine && 'mask' in mine && mine.mask === null
  const picking = !!mine && 'pick' in mine

  const setMask = (i: number, change: Partial<ClipMask>, words: string): void =>
    onOps([masksOp(clip, masks.map((m, k) => (k === i ? { ...m, ...change } : m)))], words)

  const follow = (ask: Op[]): void => {
    setFollowing(true)
    setSaid('')
    void onFollow(ask)
      .then((sentence) => setSaid(sentence))
      .finally(() => setFollowing(false))
  }

  const matte = clip.matte
  const matteFrom = matte?.from ?? ''
  const fromClip = matteFrom.startsWith('clip:')

  return (
    <div className="cl-roto-fields">
      <div className="cl-roto-group" role="group" aria-label="Masks">
        <span className="cl-roto-title">Masks</span>
        {masks.length === 0 && !drawingNew && <p className="cl-aside">Masks cut the clip to a shape: an oval, or one you draw on the picture.</p>}
        {masks.map((m, i) => {
          const keys: Key<MaskPath>[] = isKeyed(m.path) ? (m.path as { keys: Key<MaskPath>[] }).keys : []
          const here = keys.find((k) => Math.abs(keyTime(k, length) - local) <= SAME) ?? null
          const editing = !!mine && 'mask' in mine && mine.mask === i
          return (
            <div key={i} className={`cl-roto-mask${editing ? ' on' : ''}`}>
              <div className="cl-roto-mask-head">
                <span>{m.name ?? `Mask ${i + 1}`}</span>
                <button
                  type="button"
                  className={`cl-key-toggle${here ? ' on' : ''}`}
                  aria-pressed={!!here}
                  aria-label={here ? `Take off the key on mask ${i + 1}'s shape here` : `Set a key on mask ${i + 1}'s shape here`}
                  title={here ? 'Take off the key here' : 'Set a key on its shape here'}
                  disabled={!inside}
                  onClick={() => {
                    if (here) {
                      const left = keys.filter((k) => k !== here)
                      const path = left.length === 0 ? storedPath(pathAt(m.path, local, length)) : { keys: left }
                      setMask(i, { path }, `A key on mask ${i + 1}'s shape comes off.`)
                    } else {
                      const now = storedPath(pathAt(m.path, local, length))
                      setMask(i, { path: withPathKey(m.path, local, now, length) }, `A key on mask ${i + 1}'s shape is set.`)
                    }
                  }}
                />
                <span className="spacer" />
                <Button variant="text" small aria-pressed={editing} disabled={!inside} onClick={() => onEdit(editing ? null : { clip: clip.id, mask: i })}>
                  {editing ? 'Done' : 'Move its points'}
                </Button>
                <IconButton label={`Remove mask ${i + 1}`} onClick={() => onOps([masksOp(clip, masks.filter((_, k) => k !== i))], 'A mask comes off.')}>
                  <Icon.close />
                </IconButton>
              </div>
              <div className="cl-segments" role="radiogroup" aria-label={`How mask ${i + 1} combines`}>
                {(['add', 'subtract', 'intersect'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={m.mode === mode}
                    className={m.mode === mode ? 'on' : ''}
                    onClick={() => m.mode !== mode && setMask(i, { mode }, 'How a mask combines changes.')}
                  >
                    {MODE_NAME[mode]}
                  </button>
                ))}
              </div>
              <div className="cl-segments" role="radiogroup" aria-label={`What mask ${i + 1} keeps`}>
                {[false, true].map((invert) => (
                  <button
                    key={String(invert)}
                    type="button"
                    role="radio"
                    aria-checked={m.invert === invert}
                    className={m.invert === invert ? 'on' : ''}
                    onClick={() => m.invert !== invert && setMask(i, { invert }, invert ? 'A mask keeps what is outside it.' : 'A mask keeps what is inside it.')}
                  >
                    {invert ? 'Outside' : 'Inside'}
                  </button>
                ))}
              </div>
              <div className="cl-roto-pair">
                <NumberField
                  label="Feather"
                  unit="px"
                  value={num(m.feather, local, length, 0)}
                  step={5}
                  onCommit={(feather) => feather >= 0 && setMask(i, { feather }, 'A mask’s edge softens.')}
                />
                <NumberField label="Grow" unit="px" value={num(m.expand, local, length, 0)} step={5} onCommit={(expand) => setMask(i, { expand }, 'A mask grows.')} />
              </div>
              <Button
                variant="text"
                small
                disabled={following}
                onClick={() =>
                  m.follow
                    ? setMask(i, { follow: undefined }, 'A mask stays where it is.')
                    : follow([masksOp(clip, masks.map((x, k) => (k === i ? { ...x, follow: { scale: true } } : x)))])
                }
              >
                {m.follow ? 'Stop following' : 'Follow what it covers'}
              </Button>
            </div>
          )
        })}
        <div className="cl-row">
          <Button
            small
            onClick={() => {
              // An oval in the middle of the frame, most of its short side across.
              const d = Math.min(frame.width, frame.height) * 0.6
              const path = ellipsePath([(frame.width - d) / 2, (frame.height - d) / 2, d, d])
              onOps([masksOp(clip, [...masks, { path, mode: 'add', invert: false, feather: 0, expand: 0, opacity: 1 }])], 'A mask goes on the clip.')
            }}
          >
            Add an oval
          </Button>
          <Button small aria-pressed={drawingNew} disabled={!inside} onClick={() => onEdit(drawingNew ? null : { clip: clip.id, mask: null })}>
            {drawingNew ? 'Stop drawing' : 'Draw a mask'}
          </Button>
        </div>
        {drawingNew && <p className="cl-aside">Click the picture to place points, and click the first point again to close the shape.</p>}
      </div>

      <div className="cl-roto-group" role="group" aria-label="Matte">
        <label className="cl-field">
          <span>Matte</span>
          <select
            value={matteFrom}
            onChange={(e) => {
              const from = e.target.value
              if (!from) onOps([{ op: 'clip-update', clip: clip.id, matte: null } as Op], 'The clip shows whole again.')
              else onOps([{ op: 'clip-update', clip: clip.id, matte: { from, mode: matte?.mode ?? 'alpha', invert: matte?.invert ?? false } } as Op], 'The clip is cut to a matte.')
            }}
          >
            <option value="">None</option>
            <option value="person">You, the person</option>
            <option value="objects">The objects in the picture</option>
            {others.map((o) => (
              <option key={o.id} value={`clip:${o.id}`}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {matte && (
          <>
            <div className="cl-segments" role="radiogroup" aria-label="Where the clip shows">
              {[false, true].map((invert) => (
                <button
                  key={String(invert)}
                  type="button"
                  role="radio"
                  aria-checked={matte.invert === invert}
                  className={matte.invert === invert ? 'on' : ''}
                  onClick={() =>
                    matte.invert !== invert &&
                    onOps([{ op: 'clip-update', clip: clip.id, matte: { ...matte, invert } } as Op], invert ? 'The clip shows everywhere but the matte.' : 'The clip shows only in the matte.')
                  }
                >
                  {invert ? (matte.from === 'person' ? 'Behind you' : 'Outside it') : matte.from === 'person' ? 'Only on you' : 'Inside it'}
                </button>
              ))}
            </div>
            {fromClip && (
              <div className="cl-segments" role="radiogroup" aria-label="What of the other clip cuts it">
                {(['alpha', 'luma'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={matte.mode === mode}
                    className={matte.mode === mode ? 'on' : ''}
                    onClick={() => matte.mode !== mode && onOps([{ op: 'clip-update', clip: clip.id, matte: { ...matte, mode } } as Op], 'How the matte cuts changes.')}
                  >
                    {mode === 'alpha' ? 'Its shape' : 'Its brightness'}
                  </button>
                ))}
              </div>
            )}
            <p className="cl-aside">
              {fromClip
                ? 'The other clip only cuts this one now, and is not shown itself.'
                : 'From the cut-out Vision makes on a Mac. Without one the clip shows whole.'}
            </p>
          </>
        )}
      </div>

      <div className="cl-roto-group" role="group" aria-label="Following">
        <span className="cl-roto-title">Following</span>
        {clip.follow ? (
          <>
            <p className="cl-aside">
              {clip.follow.path ? 'It moves with what was under it as it started, and grows and shrinks with it.' : 'It is waiting to find what to follow.'}
            </p>
            <div className="cl-row">
              <Button variant="text" small onClick={() => onOps([{ op: 'clip-update', clip: clip.id, follow: null } as Op], 'The clip stays where it is put.')}>
                Stop following
              </Button>
            </div>
          </>
        ) : (
          <div className="cl-row">
            <Button small disabled={following} onClick={() => follow([{ op: 'clip-update', clip: clip.id, follow: { scale: true } } as Op])}>
              {following ? 'Following' : 'Follow what is under it'}
            </Button>
          </div>
        )}
        {said && <p className="cl-aside">{said}</p>}
      </div>

      {(clip.kind === 'video' || clip.kind === 'image') && (
        <div className="cl-roto-group" role="group" aria-label="Key">
          <span className="cl-roto-title">Key</span>
          {clip.key ? (
            <>
              <div className="cl-row">
                <label className="cl-swatch">
                  <input
                    type="color"
                    aria-label="The colour taken out"
                    value={hex(clip.key.colour)}
                    onChange={(e) => onOps([{ op: 'clip-update', clip: clip.id, key: { ...clip.key!, colour: e.target.value.toUpperCase() } } as Op], 'The key takes another colour out.')}
                  />
                  <span className="cl-roto-hex">{hex(clip.key.colour)}</span>
                </label>
                <Button small aria-pressed={picking} disabled={!inside} onClick={() => onEdit(picking ? null : { clip: clip.id, pick: true })}>
                  {picking ? 'Stop picking' : 'Pick from the picture'}
                </Button>
              </div>
              {picking && <p className="cl-aside">Click the colour to take out, on the picture.</p>}
              {(['tolerance', 'softness', 'spill'] as const).map((k) => (
                <NumberField
                  key={k}
                  label={k === 'tolerance' ? 'Tolerance' : k === 'softness' ? 'Softness' : 'Spill'}
                  value={clip.key![k]}
                  step={0.05}
                  onCommit={(v) => onOps([{ op: 'clip-update', clip: clip.id, key: { ...clip.key!, [k]: Math.min(1, Math.max(0, v)) } } as Op], 'The key changes.')}
                />
              ))}
              <div className="cl-row">
                <Button variant="text" small onClick={() => onOps([{ op: 'clip-update', clip: clip.id, key: null } as Op], 'The key comes off.')}>
                  Take the key off
                </Button>
              </div>
            </>
          ) : (
            <div className="cl-row">
              <Button small onClick={() => onOps([{ op: 'clip-update', clip: clip.id, key: KEY_DEFAULT } as Op], 'The green comes out of the clip.')}>
                Key out a colour
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
