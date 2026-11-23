import { useEffect, useState } from 'react'
import { EASE_NAMES, isKeyed, num, type Anim, type Ease, type Key } from '../../../../shared/anim'
import type { Op } from '../../../../shared/edit'
import { BLEND_MODES } from '../../../../shared/motion'
import type { KeyedProp, TrackClip } from '../../../../shared/tracks'
import { exprOf } from '../../../../shared/motion/anim'
import { clock, seconds } from '../format'
import { ExprField, ExprToggle, GradeFields } from './ClipCompositing'
import { whenSettled } from './GraphicPanel'
import { Button, Icon, IconButton } from './ui'

/**
 * A clip on a layer track, picked in the lanes: when it plays, and its
 * settings, each a number at the playhead. A setting with keys shows them
 * along a small ruler the clip's length, and changing it sets a key where the
 * playhead is; the diamond beside it adds or takes off a key there. Every
 * change is one op and one version, made when the field is left.
 */

interface Setting {
  prop: KeyedProp
  label: string
  /** Its value when nothing sets it, from the frame's size. */
  usual: (frame: { width: number; height: number }) => number
  step: number
  unit?: string
  /** The kinds it applies to; all picture kinds when absent. */
  kinds?: TrackClip['kind'][]
}

const PICTURE: TrackClip['kind'][] = ['video', 'image', 'text', 'solid', 'adjustment']
const CROPPED: TrackClip['kind'][] = ['video', 'image', 'adjustment']

const SETTINGS: Setting[] = [
  { prop: 'x', label: 'Across', usual: (f) => f.width / 2, step: 10, unit: 'px', kinds: PICTURE },
  { prop: 'y', label: 'Down', usual: (f) => f.height / 2, step: 10, unit: 'px', kinds: PICTURE },
  { prop: 'scale', label: 'Size', usual: () => 1, step: 0.05, kinds: PICTURE },
  { prop: 'rotation', label: 'Turn', usual: () => 0, step: 1, unit: '°', kinds: PICTURE },
  { prop: 'opacity', label: 'Opacity', usual: () => 1, step: 0.05, kinds: PICTURE },
  { prop: 'crop.left', label: 'Crop left', usual: () => 0, step: 0.02, kinds: CROPPED },
  { prop: 'crop.right', label: 'Crop right', usual: () => 0, step: 0.02, kinds: CROPPED },
  { prop: 'crop.top', label: 'Crop top', usual: () => 0, step: 0.02, kinds: CROPPED },
  { prop: 'crop.bottom', label: 'Crop bottom', usual: () => 0, step: 0.02, kinds: CROPPED },
  { prop: 'volume', label: 'Level', usual: () => 0, step: 1, unit: 'dB', kinds: ['video', 'sound'] }
]

/** A setting's value as the clip holds it: a number, keys, or nothing. */
function valueOf(clip: TrackClip, prop: KeyedProp): Anim<number> | undefined {
  if (prop === 'opacity') return clip.opacity
  if (prop === 'volume') return clip.volume
  if (prop.startsWith('crop.')) return clip.crop?.[prop.slice(5) as 'left' | 'top' | 'right' | 'bottom']
  return clip.transform?.[prop as 'x' | 'y' | 'scale' | 'rotation']
}

/** The change that sets a setting to one value for the whole clip. */
function setTo(clip: TrackClip, prop: KeyedProp, v: number): Op {
  if (prop === 'opacity') return { op: 'clip-update', clip: clip.id, opacity: v } as Op
  if (prop === 'volume') return { op: 'clip-update', clip: clip.id, volume: v } as Op
  if (prop.startsWith('crop.')) return { op: 'clip-update', clip: clip.id, crop: { ...clip.crop, [prop.slice(5)]: v } } as Op
  return { op: 'clip-update', clip: clip.id, transform: { ...clip.transform, [prop]: v } } as Op
}

const SAME = 1e-3
const round = (v: number, step: number): number => Math.round(v / step) * step

const KIND_NAME: Record<TrackClip['kind'], string> = {
  video: 'Video clip',
  image: 'Picture',
  text: 'Title',
  solid: 'Colour',
  sound: 'Sound',
  adjustment: 'Adjustment'
}

export function ClipPanel({
  clip,
  span,
  frame,
  time,
  onOps,
  onSeek,
  onClose
}: {
  clip: TrackClip
  /** Where it plays on the edit, or null when it is not in the cut. */
  span: { start: number; end: number } | null
  frame: { width: number; height: number }
  time: number
  onOps: (ops: Op[], said: string) => void
  onSeek: (sec: number) => void
  onClose: () => void
}): JSX.Element {
  const length = span ? span.end - span.start : 0
  const local = span ? Math.min(length, Math.max(0, time - span.start)) : 0
  const inside = !!span && time >= span.start && time <= span.end
  const settings = SETTINGS.filter((s) => !s.kinds || s.kinds.includes(clip.kind))
  const when = span ? `It plays from ${clock(span.start)} for ${seconds(length)}.` : 'Where it starts is not in the cut now, so it does not play.'

  return (
    <aside className="cl-notes cl-graphic cl-clip-panel" aria-label="Clip">
      <div className="cl-graphic-head">
        <span className="cl-heading">{clip.name ?? KIND_NAME[clip.kind]}</span>
        <IconButton label="Back to notes" onClick={onClose}>
          <Icon.close />
        </IconButton>
      </div>
      <div className="cl-notes-scroll cl-graphic-fields">
        <p className="cl-reply">
          {KIND_NAME[clip.kind]}. {when} {span && !inside ? 'Move the playhead onto it to set keys.' : ''}
        </p>

        {clip.kind === 'text' && clip.text && (
          <TextField
            label="Words"
            value={clip.text.value}
            onCommit={(value) => value && onOps([{ op: 'clip-update', clip: clip.id, text: { ...clip.text!, value } } as Op], 'The title changes.')}
          />
        )}
        {clip.kind === 'solid' && (
          <TextField
            label="Colour"
            value={clip.color ?? '#000000'}
            onCommit={(color) => onOps([{ op: 'clip-update', clip: clip.id, color } as Op], 'The colour changes.')}
          />
        )}
        {clip.kind === 'adjustment' && <GradeFields clip={clip} onOps={onOps} />}

        {settings.map((s) => (
          <KeyedField
            key={s.prop}
            setting={s}
            clip={clip}
            value={valueOf(clip, s.prop)}
            usual={s.usual(frame)}
            local={local}
            length={length}
            canKey={inside}
            onOps={onOps}
            onSeek={(t) => span && onSeek(span.start + t)}
          />
        ))}

        {clip.kind !== 'sound' && (
          <label className="cl-field">
            <span>Blend</span>
            <select
              value={clip.blend}
              onChange={(e) => onOps([{ op: 'clip-update', clip: clip.id, blend: e.target.value } as Op], 'How it blends changes.')}
            >
              {BLEND_MODES.map((b) => (
                <option key={b} value={b}>
                  {label(b)}
                </option>
              ))}
            </select>
          </label>
        )}
        {(clip.kind === 'video' || clip.kind === 'image') && (
          <div className="cl-field">
            <span>Fit</span>
            <div className="cl-segments" role="radiogroup" aria-label="Fit">
              {(['contain', 'cover', 'fill'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={clip.fit === f}
                  className={clip.fit === f ? 'on' : ''}
                  onClick={() => clip.fit !== f && onOps([{ op: 'clip-update', clip: clip.id, fit: f } as Op], 'How it fits changes.')}
                >
                  {f === 'contain' ? 'Whole' : f === 'cover' ? 'Fill frame' : 'Stretch'}
                </button>
              ))}
            </div>
          </div>
        )}
        {(clip.kind === 'video' || clip.kind === 'sound') && (
          <>
            <NumberField
              label="Speed"
              value={clip.speed}
              step={0.05}
              onCommit={(speed) => speed > 0 && onOps([{ op: 'clip-update', clip: clip.id, speed } as Op], 'Its speed changes.')}
            />
            <NumberField
              label="Starts in its file at"
              unit="s"
              value={clip.in}
              step={0.1}
              onCommit={(v) => onOps([{ op: 'clip-trim', clip: clip.id, edge: 'slip', by: v - clip.in } as Op], 'What plays inside it moves.')}
            />
          </>
        )}
      </div>
      <Button variant="text" onClick={() => onOps([{ op: 'clip-remove', clips: [clip.id] } as Op], 'One clip is gone.')}>
        Remove this clip
      </Button>
    </aside>
  )
}

const label = (s: string): string => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/-/g, ' ')

/** One setting: its number at the playhead, its key toggle, the ease of a key there, and its keys along the clip. */
function KeyedField({
  setting,
  clip,
  value,
  usual,
  local,
  length,
  canKey,
  onOps,
  onSeek
}: {
  setting: Setting
  clip: TrackClip
  value: Anim<number> | undefined
  usual: number
  local: number
  length: number
  canKey: boolean
  onOps: (ops: Op[], said: string) => void
  onSeek: (t: number) => void
}): JSX.Element {
  const keyed = isKeyed(value)
  const keys: Key<number>[] = keyed ? (value as { keys: Key<number>[] }).keys : []
  const here = keys.find((k) => Math.abs(k.t - local) <= SAME) ?? null
  const now = round(num(value, local, length, usual), setting.step < 1 ? 0.001 : 1)
  const name = setting.label.toLowerCase()
  const hasExpr = !!exprOf(value)
  const [writing, setWriting] = useState(false)

  const commit = (v: number): void => {
    if (keyed && canKey) onOps([{ op: 'key-set', clip: clip.id, prop: setting.prop, t: local, v, ...(here?.ease ? { ease: here.ease } : {}) } as Op], `A key on its ${name} is set.`)
    else onOps([setTo(clip, setting.prop, v)], `Its ${name} changes.`)
  }

  return (
    <div className="cl-keyed">
      <NumberField label={setting.label} unit={setting.unit} value={now} step={setting.step} onCommit={commit}>
        <button
          type="button"
          className={`cl-key-toggle${here ? ' on' : ''}`}
          aria-pressed={!!here}
          aria-label={here ? `Take off the key on ${name} here` : `Set a key on ${name} here`}
          title={here ? 'Take off the key here' : 'Set a key here'}
          disabled={!canKey}
          onClick={() =>
            here
              ? onOps([{ op: 'key-remove', clip: clip.id, prop: setting.prop, t: here.t } as Op], `A key on its ${name} comes off.`)
              : onOps([{ op: 'key-set', clip: clip.id, prop: setting.prop, t: local, v: now } as Op], `A key on its ${name} is set.`)
          }
        />
        <ExprToggle name={name} open={hasExpr || writing} set={hasExpr} onToggle={() => setWriting((w) => !w)} />
      </NumberField>
      {(hasExpr || writing) && (
        <ExprField clip={clip} prop={setting.prop} name={name} value={value} onOps={onOps} onDone={() => setWriting(false)} />
      )}
      {keyed && (
        <div className="cl-keyrow">
          <div className="cl-keyrow-track" aria-label={`Keys on ${name}`}>
            {keys.map((k) => (
              <button
                key={k.t}
                type="button"
                className={`cl-keyrow-key${k === here ? ' on' : ''}`}
                style={{ left: `${(k.t / Math.max(1e-6, length)) * 100}%` }}
                aria-label={`Key at ${seconds(k.t)}: ${k.v}`}
                title={`${seconds(k.t)}: ${k.v}`}
                onClick={() => onSeek(k.t)}
              />
            ))}
            <span className="cl-keyrow-now" style={{ left: `${(local / Math.max(1e-6, length)) * 100}%` }} aria-hidden="true" />
          </div>
          {here && (
            <select
              className="cl-keyrow-ease"
              aria-label={`How it moves on from the key at ${seconds(here.t)}`}
              value={typeof here.ease === 'string' ? here.ease : 'linear'}
              onChange={(e) =>
                onOps(
                  [{ op: 'key-set', clip: clip.id, prop: setting.prop, t: here.t, v: here.v, ease: e.target.value as Ease } as Op],
                  `A key on its ${name} eases another way.`
                )
              }
            >
              {EASE_NAMES.map((n) => (
                <option key={n} value={n}>
                  {label(n)}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  )
}

/** A number that becomes a change when the field is left or Return is pressed. */
function NumberField({
  label: name,
  unit,
  value,
  step,
  onCommit,
  children
}: {
  label: string
  unit?: string
  value: number
  step: number
  onCommit: (v: number) => void
  children?: React.ReactNode
}): JSX.Element {
  const shown = String(Math.round(value * 1000) / 1000)
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const commit = (): void => {
    const v = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(v)) return setDraft(shown)
    if (Math.abs(v - value) > 1e-9) whenSettled(() => onCommit(v))
  }
  return (
    <label className="cl-field cl-number">
      <span>
        {name}
        {unit ? <span className="muted"> {unit}</span> : null}
      </span>
      <span className="cl-number-row">
        <input
          value={draft}
          inputMode="decimal"
          step={step}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setDraft(shown)
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              const v = (Number(draft) || 0) + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1)
              setDraft(String(Math.round(v * 1000) / 1000))
            }
          }}
        />
        {children}
      </span>
    </label>
  )
}

function TextField({ label: name, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <label className="cl-field">
      <span>{name}</span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== value && whenSettled(() => onCommit(draft.trim()))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setDraft(value)
        }}
      />
    </label>
  )
}
