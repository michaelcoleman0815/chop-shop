import { useEffect, useState } from 'react'
import type { Anim } from '../../../../shared/anim'
import { parseExpr } from '../../../../shared/anim/expr'
import type { Op } from '../../../../shared/edit'
import { exprOf } from '../../../../shared/motion/anim'
import { GRADE_SETTINGS, type GradeSetting } from '../../../../shared/motion/adjust'
import type { KeyedProp, TrackClip } from '../../../../shared/tracks'
import { whenSettled } from './GraphicPanel'
import { Icon } from './ui'

/**
 * A clip's compositing settings in its panel (ClipPanel): an expression on
 * any keyed setting (shared/anim/expr), and an adjustment clip's grade. An
 * expression that cannot be read says why under its field before it is ever
 * sent; one the edit refuses (it reads round in a circle) says so as any
 * refused change does.
 */

/** The small toggle beside a setting's key diamond that opens its expression. */
export function ExprToggle({ name, open, set, onToggle }: { name: string; open: boolean; set: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className={`cl-expr-toggle${set ? ' on' : ''}`}
      aria-pressed={open}
      aria-label={set ? `The expression on ${name}` : `Write an expression for ${name}`}
      title={set ? 'Its expression' : 'Write an expression'}
      onClick={onToggle}
    >
      <span aria-hidden="true">ƒ</span>
    </button>
  )
}

/** An expression on one setting: shown while it is set or being written, and sent when the field is left. */
export function ExprField({
  clip,
  prop,
  name,
  value,
  onOps,
  onDone
}: {
  clip: TrackClip
  prop: KeyedProp
  name: string
  value: Anim<number> | undefined
  onOps: (ops: Op[], said: string) => void
  /** Called once an empty field is left with nothing set: it closes. */
  onDone: () => void
}): JSX.Element {
  const set = exprOf(value) ?? ''
  const [draft, setDraft] = useState(set)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDraft(set)
    setError(null)
  }, [set])
  const id = `cl-expr-${clip.id}-${prop.replace('.', '-')}`

  const commit = (): void => {
    const text = draft.trim()
    if (text === set) {
      setError(null)
      if (!text) onDone()
      return
    }
    if (text) {
      const read = parseExpr(text)
      if (!read.ok) return setError(read.reason)
    }
    setError(null)
    whenSettled(() =>
      onOps([{ op: 'clip-expr', clip: clip.id, prop, expr: text } as Op], text ? `An expression moves its ${name}.` : `The expression on its ${name} comes off.`)
    )
    if (!text) onDone()
  }

  return (
    <label className="cl-field cl-expr">
      <span>
        Expression <span className="muted">for {name}</span>
      </span>
      <input
        className="mono"
        value={draft}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoFocus={!set}
        placeholder="wiggle(2, 10)"
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-msg` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(set)
            setError(null)
          }
        }}
      />
      {error && (
        <span id={`${id}-msg`} className="cl-field-msg error" role="status">
          <Icon.alert />
          <span>{error}</span>
        </span>
      )}
    </label>
  )
}

const GRADE_LABEL: Record<GradeSetting, { label: string; unit?: string; step: number; min: number; max: number }> = {
  exposure: { label: 'Exposure', unit: 'stops', step: 0.25, min: -2, max: 2 },
  contrast: { label: 'Contrast', step: 0.1, min: -1, max: 1 },
  saturation: { label: 'Saturation', step: 0.1, min: -1, max: 1 },
  temperature: { label: 'Warmth', step: 0.1, min: -1, max: 1 },
  tint: { label: 'Tint', step: 0.1, min: -1, max: 1 },
  lift: { label: 'Faded blacks', step: 0.1, min: 0, max: 1 },
  vignette: { label: 'Vignette', step: 0.1, min: 0, max: 1 },
  blur: { label: 'Blur', unit: 'px', step: 1, min: 0, max: 200 }
}

/** An adjustment clip's grade, one number a setting, over everything under it while it plays. */
export function GradeFields({ clip, onOps }: { clip: TrackClip; onOps: (ops: Op[], said: string) => void }): JSX.Element {
  return (
    <div className="cl-grade" role="group" aria-label="Its grade">
      {GRADE_SETTINGS.map((k) => (
        <GradeNumber
          key={k}
          setting={k}
          value={clip.grade?.[k] ?? 0}
          onCommit={(v) => {
            const { label, min, max } = GRADE_LABEL[k]
            const clamped = Math.min(max, Math.max(min, v))
            const grade = { ...clip.grade, [k]: clamped }
            if (Math.abs(clamped) < 1e-9) delete grade[k]
            onOps([{ op: 'clip-update', clip: clip.id, grade } as Op], `Its ${label.toLowerCase()} changes.`)
          }}
        />
      ))}
    </div>
  )
}

function GradeNumber({ setting, value, onCommit }: { setting: GradeSetting; value: number; onCommit: (v: number) => void }): JSX.Element {
  const { label, unit, step } = GRADE_LABEL[setting]
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
        {label}
        {unit ? <span className="muted"> {unit}</span> : null}
      </span>
      <input
        value={draft}
        inputMode="decimal"
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
    </label>
  )
}
