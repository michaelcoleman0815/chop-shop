import { useEffect, useRef, useState } from 'react'
import { isKeyed, num, type Anim, type Key } from '../../../../shared/anim'
import type { Cut, Op } from '../../../../shared/edit'
import {
  defaultFx,
  EQ_BAND_TYPES,
  FX_KINDS,
  FX_LABEL,
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  heardOf,
  MAX_EQ_BANDS,
  MAX_EFFECTS,
  stripsOf,
  type AudioFx,
  type EqBand,
  type Strip
} from '../../../../shared/mix'
import { seconds } from '../format'
import { EXPORT_ONLY } from '../mix-graph'
import { whenSettled } from './GraphicPanel'
import { Icon, IconButton } from './ui'

/**
 * The Mix tab: a strip for every sound in the edit (the voice, each track
 * that sounds, the music bed), each with its fader, its pan, mute and solo,
 * and its effects in order. A fader or a pan with keys shows its value at the
 * playhead, and moving it sets a key there; the diamond beside it adds or
 * takes off a key there. Every change is one op and one version, made when
 * the slider is let go or the field is left.
 */

type OnOps = (ops: Op[], said: string) => void

const SAME_KEY = 0.05
/** How long the arrow keys rest before a fader's change is made. */
const KEYS_SETTLE_MS = 600

const dbText = (v: number): string => `${v > 0.05 ? '+' : ''}${Math.abs(v) < 0.05 ? '0' : v.toFixed(1)} dB`
const panText = (v: number): string => (Math.abs(v) < 0.005 ? 'Centre' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}`)

/** An effect's name inside a sentence: "reverb", "high-pass", and EQ as it is. */
const fxName = (kind: AudioFx['kind']): string => (kind === 'eq' ? 'EQ' : FX_LABEL[kind].toLowerCase())

/** What a strip is called in a sentence: "the voice", "the music", "Sound 1". */
const whoOf = (s: Strip): string => (s.kind === 'voice' ? 'the voice' : s.kind === 'music' ? 'the music' : s.name)
const Whose = (s: Strip): string => {
  const who = whoOf(s)
  return `${who.charAt(0).toUpperCase()}${who.slice(1)}${who.endsWith('s') ? '’' : '’s'}`
}

/** What each strip is, under its name. */
function aboutOf(s: Strip, cut: Cut): string {
  if (s.kind === 'voice') return 'The recording, before the music.'
  if (s.kind === 'music') return 'The bed, after its own level and dips.'
  const track = cut.tracks?.find((t) => t.id === s.target)
  return track?.kind === 'picture' ? 'Its videos’ own sound.' : 'Its sound clips.'
}

/** A level or pan with a key at `t`: replacing one there, the rest kept in order. */
function withKey(a: Anim<number> | undefined, t: number, v: number): Anim<number> {
  const keys: Key<number>[] = isKeyed(a) ? a.keys.filter((k) => Math.abs(k.t - t) > SAME_KEY) : []
  return { keys: [...keys, { t, v }].sort((x, y) => x.t - y.t) }
}

/** The key at `t` taken off; with none left, the value it held stays. */
function withoutKey(a: Anim<number>, t: number, held: number): Anim<number> {
  if (!isKeyed(a)) return a
  const keys = a.keys.filter((k) => Math.abs(k.t - t) > SAME_KEY)
  return keys.length === 0 ? held : { keys }
}

export function Mixer({
  cut,
  time,
  durationSec,
  onOps,
  onSeek
}: {
  cut: Cut
  time: number
  durationSec: number
  onOps: OnOps
  onSeek: (sec: number) => void
}): JSX.Element {
  const strips = stripsOf(cut)
  const heard = heardOf(cut)
  const soloing = strips.some((s) => s.solo)
  const isHeard = (s: Strip): boolean => {
    if (s.kind === 'voice') return heard.voice
    if (s.kind === 'music') return heard.music
    const track = cut.tracks?.find((t) => t.id === s.target)
    return !!track && heard.track(track)
  }
  return (
    <aside className="cl-notes cl-mixer" aria-label="Mix">
      <div className="cl-notes-scroll">
        <p className="cl-reply">
          {soloing
            ? 'Only the soloed sounds are heard, here and in the export.'
            : 'Each sound has a strip: its level, where it sits between the speakers, and its effects, in order.'}
        </p>
        <ol className="cl-mix-strips">
          {strips.map((s) => (
            <StripRow
              key={s.target}
              strip={s}
              about={aboutOf(s, cut)}
              heard={isHeard(s)}
              time={time}
              durationSec={durationSec}
              onOps={onOps}
              onSeek={onSeek}
            />
          ))}
        </ol>
      </div>
      <p className="cl-project-meta">The export mixes exactly this; the preview comes close. Each change is a version you can undo.</p>
    </aside>
  )
}

function StripRow({
  strip: s,
  about,
  heard,
  time,
  durationSec,
  onOps,
  onSeek
}: {
  strip: Strip
  about: string
  heard: boolean
  time: number
  durationSec: number
  onOps: OnOps
  onSeek: (sec: number) => void
}): JSX.Element {
  const mix = (change: Record<string, unknown>, said: string): void => onOps([{ op: 'mix', target: s.target, ...change } as Op], said)
  const effects = s.mix.effects
  const setEffects = (next: AudioFx[], said: string): void => mix({ effects: next }, said)
  return (
    <li className={`cl-mix-strip${heard ? '' : ' unheard'}`}>
      <div className="cl-mix-head">
        <span className="cl-mix-name">
          <span className="cl-mix-title">{s.name}</span>
          <span className="cl-project-meta">{heard ? about : s.mute ? 'Muted.' : 'Not heard while another sound is soloed.'}</span>
        </span>
        <span className="cl-mix-toggles">
          <button
            type="button"
            className={`cl-mix-toggle${s.mute ? ' on' : ''}`}
            aria-pressed={s.mute}
            onClick={() => mix({ mute: !s.mute }, s.mute ? `${Whose(s)} sound is back.` : `${Whose(s)} sound is muted.`)}
          >
            Mute
          </button>
          <button
            type="button"
            className={`cl-mix-toggle${s.solo ? ' on' : ''}`}
            aria-pressed={s.solo}
            onClick={() => mix({ solo: !s.solo }, s.solo ? `${Whose(s)} solo is off.` : `Only ${whoOf(s)} plays.`)}
          >
            Solo
          </button>
        </span>
      </div>

      <Fader
        label="Level"
        noun="level"
        name={`${whoOf(s)}’s level`}
        value={s.mix.gainDb}
        min={GAIN_MIN_DB}
        max={GAIN_MAX_DB}
        step={0.5}
        usual={0}
        format={dbText}
        time={time}
        durationSec={durationSec}
        onSet={(gainDb, said) => mix({ gainDb }, `${Whose(s)} ${said}`)}
        onSeek={onSeek}
      />
      <Fader
        label="Pan"
        noun="pan"
        name={`${whoOf(s)}’s pan`}
        value={s.mix.pan}
        min={-1}
        max={1}
        step={0.01}
        usual={0}
        format={panText}
        time={time}
        durationSec={durationSec}
        onSet={(pan, said) => mix({ pan }, `${Whose(s)} ${said}`)}
        onSeek={onSeek}
      />

      {effects.length > 0 && (
        <ol className="cl-mix-fx-list" aria-label={`${Whose(s)} effects`}>
          {effects.map((fx, i) => (
            <EffectRow
              key={`${i}-${fx.kind}`}
              fx={fx}
              onChange={(next, said) => setEffects(effects.map((f, k) => (k === i ? next : f)), `${Whose(s)} ${said}`)}
              onRemove={() => mix({ remove: [i + 1] }, `${Whose(s)} ${fxName(fx.kind)} comes off.`)}
            />
          ))}
        </ol>
      )}
      {effects.length < MAX_EFFECTS && (
        <select
          className="cl-mix-add"
          aria-label={`Add an effect to ${whoOf(s)}`}
          value=""
          onChange={(e) => {
            const kind = e.target.value as AudioFx['kind']
            if (kind) mix({ add: [defaultFx(kind)] }, `${Whose(s)} ${fxName(kind)} is on.`)
          }}
        >
          <option value="">Add an effect</option>
          {FX_KINDS.map((k) => (
            <option key={k} value={k}>
              {FX_LABEL[k]}
            </option>
          ))}
        </select>
      )}
    </li>
  )
}

/**
 * A slider that makes its change when it is let go: a value for the whole
 * video, or, once it has keys, a key at the playhead. Double-click puts it
 * back to its usual value.
 */
function Fader({
  label,
  noun,
  name,
  value,
  min,
  max,
  step,
  usual,
  format,
  time,
  durationSec,
  onSet,
  onSeek
}: {
  label: string
  /** What it sets, in a sentence: "level", "pan". */
  noun: string
  name: string
  value: Anim<number> | undefined
  min: number
  max: number
  step: number
  usual: number
  format: (v: number) => string
  time: number
  durationSec: number
  onSet: (value: Anim<number>, said: string) => void
  onSeek: (sec: number) => void
}): JSX.Element {
  const keyed = isKeyed(value)
  const keys: Key<number>[] = keyed ? (value as { keys: Key<number>[] }).keys : []
  const here = keys.find((k) => Math.abs(k.t - time) <= SAME_KEY) ?? null
  const now = Math.min(max, Math.max(min, num(value, time, durationSec, usual)))
  const [draft, setDraft] = useState<number | null>(null)
  const held = useRef<number | null>(null)
  const shown = draft ?? now

  const set = (v: number): void => {
    if (keyed) onSet(withKey(value, time, v), `${noun} has a key at ${seconds(time)}.`)
    else onSet(v, `${noun} changes.`)
  }
  const pause = useRef<ReturnType<typeof setTimeout> | null>(null)
  const letGo = (): void => {
    if (pause.current) clearTimeout(pause.current)
    pause.current = null
    const v = held.current
    held.current = null
    setDraft(null)
    if (v !== null && Math.abs(v - now) > 1e-9) whenSettled(() => set(v))
  }
  // Keys move it a step at a time: the change is made once they stop for a moment, not at every step.
  const keyedUp = (): void => {
    if (pause.current) clearTimeout(pause.current)
    pause.current = setTimeout(letGo, KEYS_SETTLE_MS)
  }
  useEffect(() => () => {
    if (pause.current) clearTimeout(pause.current)
  }, [])
  // A new value from the cut, or the playhead moving, is what the slider shows once it is let go.
  useEffect(() => {
    if (held.current === null) setDraft(null)
  }, [now])

  return (
    <div className="cl-mix-fader">
      <span className="cl-mix-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        aria-label={name}
        aria-valuetext={format(shown)}
        onChange={(e) => {
          held.current = Number(e.target.value)
          setDraft(held.current)
        }}
        onPointerUp={letGo}
        onKeyUp={keyedUp}
        onBlur={letGo}
        onDoubleClick={() => Math.abs(now - usual) > 1e-9 && set(usual)}
      />
      <output className="cl-mix-readout">{format(shown)}</output>
      <button
        type="button"
        className={`cl-key-toggle${here ? ' on' : ''}`}
        aria-pressed={!!here}
        aria-label={here ? `Take off the key on ${name} here` : `Set a key on ${name} here`}
        title={here ? 'Take off the key here' : 'Set a key here'}
        onClick={() =>
          here
            ? onSet(withoutKey(value as Anim<number>, here.t, here.v), `${noun} loses its key at ${seconds(here.t)}.`)
            : onSet(withKey(keyed ? value : now, time, now), `${noun} has a key at ${seconds(time)}.`)
        }
      />
      {keyed && (
        <div className="cl-keyrow cl-mix-keys">
          <div className="cl-keyrow-track" aria-label={`Keys on ${name}`}>
            {keys.map((k) => (
              <button
                key={k.t}
                type="button"
                className={`cl-keyrow-key${k === here ? ' on' : ''}`}
                style={{ left: `${(k.t / Math.max(1e-6, durationSec)) * 100}%` }}
                aria-label={`Key at ${seconds(k.t)}: ${format(k.v)}`}
                title={`${seconds(k.t)}: ${format(k.v)}`}
                onClick={() => onSeek(k.t)}
              />
            ))}
            <span className="cl-keyrow-now" style={{ left: `${(time / Math.max(1e-6, durationSec)) * 100}%` }} aria-hidden="true" />
          </div>
        </div>
      )}
    </div>
  )
}

interface Setting {
  key: string
  label: string
  unit?: string
  min: number
  max: number
  step: number
}

/** The few settings each effect shows; the rest keep their usual values, and Claude can set any of them. */
const SETTINGS: Record<Exclude<AudioFx['kind'], 'eq'>, Setting[]> = {
  highpass: [{ key: 'freq', label: 'Below', unit: 'Hz', min: 20, max: 2000, step: 5 }],
  lowpass: [{ key: 'freq', label: 'Above', unit: 'Hz', min: 500, max: 20000, step: 100 }],
  compressor: [
    { key: 'thresholdDb', label: 'Threshold', unit: 'dB', min: -60, max: 0, step: 1 },
    { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5 },
    { key: 'makeupDb', label: 'Makeup', unit: 'dB', min: 0, max: 24, step: 0.5 }
  ],
  gate: [
    { key: 'thresholdDb', label: 'Threshold', unit: 'dB', min: -80, max: 0, step: 1 },
    { key: 'rangeDb', label: 'Down by', unit: 'dB', min: -80, max: 0, step: 1 }
  ],
  deesser: [{ key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.05 }],
  noise: [{ key: 'reduceDb', label: 'Down by', unit: 'dB', min: 1, max: 40, step: 1 }],
  reverb: [
    { key: 'room', label: 'Room', min: 0, max: 1, step: 0.05 },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.05 }
  ],
  delay: [
    { key: 'timeMs', label: 'Time', unit: 'ms', min: 20, max: 2000, step: 10 },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.05 },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.05 }
  ],
  limiter: [{ key: 'ceilingDb', label: 'Ceiling', unit: 'dB', min: -12, max: 0, step: 0.5 }]
}

const BAND_NAME: Record<EqBand['type'], string> = { peak: 'Bell', lowshelf: 'Low shelf', highshelf: 'High shelf', notch: 'Notch' }

function EffectRow({
  fx,
  onChange,
  onRemove
}: {
  fx: AudioFx
  onChange: (next: AudioFx, said: string) => void
  onRemove: () => void
}): JSX.Element {
  const name = FX_LABEL[fx.kind]
  const lower = fxName(fx.kind)
  return (
    <li className={`cl-mix-fx${fx.bypass ? ' bypassed' : ''}`}>
      <div className="cl-mix-fx-head">
        <span className="cl-mix-fx-name">{name}</span>
        <button
          type="button"
          className={`cl-mix-toggle${fx.bypass ? ' on' : ''}`}
          aria-pressed={fx.bypass}
          title={fx.bypass ? 'Heard again' : 'Kept, but not heard'}
          onClick={() => onChange({ ...fx, bypass: !fx.bypass }, fx.bypass ? `${lower} is heard again.` : `${lower} is bypassed.`)}
        >
          Bypass
        </button>
        <IconButton label={`Take the ${lower} off`} onClick={onRemove}>
          <Icon.close />
        </IconButton>
      </div>
      {EXPORT_ONLY.has(fx.kind) && <p className="cl-project-meta">Heard in the export. The preview plays without it.</p>}
      {fx.kind === 'eq' ? (
        <EqBands fx={fx} onChange={onChange} />
      ) : (
        <div className="cl-mix-fx-fields">
          {SETTINGS[fx.kind].map((st) => (
            <MixNumber
              key={st.key}
              setting={st}
              value={(fx as unknown as Record<string, number>)[st.key]}
              onCommit={(v) => onChange({ ...fx, [st.key]: v } as AudioFx, `${lower} changes.`)}
            />
          ))}
        </div>
      )}
    </li>
  )
}

function EqBands({ fx, onChange }: { fx: Extract<AudioFx, { kind: 'eq' }>; onChange: (next: AudioFx, said: string) => void }): JSX.Element {
  const setBand = (i: number, band: EqBand): void =>
    onChange({ ...fx, bands: fx.bands.map((b, k) => (k === i ? band : b)) }, 'EQ changes.')
  return (
    <div className="cl-mix-bands">
      {fx.bands.map((b, i) => (
        <div key={i} className="cl-mix-band">
          <select
            aria-label={`Band ${i + 1}`}
            value={b.type}
            onChange={(e) => setBand(i, { ...b, type: e.target.value as EqBand['type'] })}
          >
            {EQ_BAND_TYPES.map((t) => (
              <option key={t} value={t}>
                {BAND_NAME[t]}
              </option>
            ))}
          </select>
          <MixNumber
            setting={{ key: 'freq', label: 'At', unit: 'Hz', min: 20, max: 20000, step: 10 }}
            value={b.freq}
            onCommit={(freq) => setBand(i, { ...b, freq })}
          />
          {b.type !== 'notch' && (
            <MixNumber
              setting={{ key: 'gainDb', label: 'Gain', unit: 'dB', min: -24, max: 24, step: 0.5 }}
              value={b.gainDb}
              onCommit={(gainDb) => setBand(i, { ...b, gainDb })}
            />
          )}
          {(b.type === 'peak' || b.type === 'notch') && (
            <MixNumber
              setting={{ key: 'q', label: 'Width Q', min: 0.1, max: 18, step: 0.1 }}
              value={b.q}
              onCommit={(q) => setBand(i, { ...b, q })}
            />
          )}
          {fx.bands.length > 1 && (
            <IconButton
              label={`Take band ${i + 1} off`}
              onClick={() => onChange({ ...fx, bands: fx.bands.filter((_, k) => k !== i) }, 'EQ loses a band.')}
            >
              <Icon.close />
            </IconButton>
          )}
        </div>
      ))}
      {fx.bands.length < MAX_EQ_BANDS && (
        <button
          type="button"
          className="cl-btn text small cl-mix-band-add"
          onClick={() => onChange({ ...fx, bands: [...fx.bands, { type: 'peak', freq: 3000, gainDb: 0, q: 1 }] }, 'EQ has another band.')}
        >
          Add a band
        </button>
      )}
    </div>
  )
}

/** A setting's number, kept to its range, that becomes a change when the field is left or Return is pressed. */
function MixNumber({ setting, value, onCommit }: { setting: Setting; value: number; onCommit: (v: number) => void }): JSX.Element {
  const shown = String(Math.round(value * 1000) / 1000)
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const commit = (): void => {
    const v = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(v)) return setDraft(shown)
    const kept = Math.min(setting.max, Math.max(setting.min, v))
    if (kept !== v) setDraft(String(kept))
    if (Math.abs(kept - value) > 1e-9) whenSettled(() => onCommit(kept))
  }
  return (
    <label className="cl-field cl-number cl-mix-number">
      <span>
        {setting.label}
        {setting.unit ? <span className="muted"> {setting.unit}</span> : null}
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
            const v = (Number(draft) || 0) + (e.key === 'ArrowUp' ? setting.step : -setting.step) * (e.shiftKey ? 10 : 1)
            setDraft(String(Math.round(Math.min(setting.max, Math.max(setting.min, v)) * 1000) / 1000))
          }
        }}
      />
    </label>
  )
}
