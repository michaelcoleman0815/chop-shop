import { useEffect, useState } from 'react'
import { isKeyed, num, type Anim, type Key } from '../../../../shared/anim'
import type { Op } from '../../../../shared/edit'
import type { TrackClip } from '../../../../shared/tracks'
import { homeDistance, type Object3D, type Scene3DPatch } from '../../../../shared/three/spec'
import { seconds } from '../format'
import { NumberField } from './ClipPanel'
import { whenSettled } from './GraphicPanel'

/**
 * A 3D clip's scene in its clip panel: the camera's settings, then its
 * objects, one picked at a time, with where each sits and how it turns.
 * Each is a number at the playhead; one with keys shows them along the
 * clip, and changing it sets a key where the playhead is. The diamond adds
 * or takes off a key there. Every change is one op, a change to the scene.
 */

interface Field<K extends string> {
  prop: K
  label: string
  unit?: string
  step: number
  usual: number
}

type CameraProp = 'x' | 'y' | 'z' | 'orbit' | 'fov' | 'tx' | 'ty'
type ObjectProp = 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz' | 'scale' | 'opacity'

const CAMERA: Field<CameraProp>[] = [
  { prop: 'x', label: 'Across', unit: 'px', step: 10, usual: 0 },
  { prop: 'y', label: 'Up', unit: 'px', step: 10, usual: 0 },
  { prop: 'z', label: 'Back', unit: 'px', step: 20, usual: 0 },
  { prop: 'orbit', label: 'Orbit', unit: '°', step: 1, usual: 0 },
  { prop: 'fov', label: 'Lens', unit: '°', step: 1, usual: 40 },
  { prop: 'tx', label: 'Looks at, across', unit: 'px', step: 10, usual: 0 },
  { prop: 'ty', label: 'Looks at, up', unit: 'px', step: 10, usual: 0 }
]

const OBJECT: Field<ObjectProp>[] = [
  { prop: 'x', label: 'Across', unit: 'px', step: 10, usual: 0 },
  { prop: 'y', label: 'Up', unit: 'px', step: 10, usual: 0 },
  { prop: 'z', label: 'Depth', unit: 'px', step: 20, usual: 0 },
  { prop: 'rx', label: 'Tilt', unit: '°', step: 1, usual: 0 },
  { prop: 'ry', label: 'Turn', unit: '°', step: 1, usual: 0 },
  { prop: 'rz', label: 'Roll', unit: '°', step: 1, usual: 0 },
  { prop: 'scale', label: 'Size', step: 0.05, usual: 1 },
  { prop: 'opacity', label: 'Opacity', step: 0.05, usual: 1 }
]

const TYPE_NAME: Record<Object3D['type'], string> = {
  card: 'Card',
  text: 'Title',
  box: 'Box',
  sphere: 'Sphere',
  plane: 'Plane',
  cylinder: 'Cylinder',
  torus: 'Ring',
  model: 'Model',
  mark: 'Logo'
}

/** What an object is called in the list: its name, a title's words, or what it is. */
function objectName(o: Object3D): string {
  const words = o.name ?? (o.type === 'text' ? o.text : o.type === 'card' ? o.title : undefined)
  const said = words ?? TYPE_NAME[o.type]
  return said.length > 18 ? `${said.slice(0, 17)}…` : said
}

const SAME = 1e-3

/** The value with a key at t, replacing one already there. */
function withKey(anim: Anim<number> | undefined, t: number, v: number): Anim<number> {
  const keys = isKeyed(anim) ? anim.keys.filter((k) => Math.abs(k.t - t) > SAME) : []
  return { keys: [...keys, { t, v }].sort((a, b) => a.t - b.t) }
}

/** The value with the key at t taken off; the last key's value holds once none are left. */
function withoutKey(anim: { keys: Key<number>[] }, t: number): Anim<number> {
  const keys = anim.keys.filter((k) => Math.abs(k.t - t) > SAME)
  return keys.length > 0 ? { keys } : (anim.keys[0]?.v ?? 0)
}

export function Scene3DFields({
  clip,
  local,
  length,
  canKey,
  frame,
  onOps,
  onSeek
}: {
  clip: TrackClip
  local: number
  length: number
  canKey: boolean
  frame: { width: number; height: number }
  onOps: (ops: Op[], said: string) => void
  onSeek: (t: number) => void
}): JSX.Element | null {
  const scene = clip.scene
  const [picked, setPicked] = useState<string | null>(null)
  if (!scene) return null
  const object = scene.objects.find((o) => o.id === picked) ?? scene.objects[0] ?? null
  const change = (patch: Scene3DPatch, said: string): void => onOps([{ op: 'clip-update', clip: clip.id, scene: patch } as Op], said)
  const home = Math.round(homeDistance(frame))

  return (
    <>
      <div className="cl-3d-group" role="group" aria-label="Camera">
        <span className="cl-kicker">Camera</span>
        <p className="cl-field-hint muted">At 0 it stands {home} px back, where the frame’s own plane fills the picture.</p>
        {CAMERA.map((f) => (
          <SceneKeyed
            key={f.prop}
            field={f}
            value={scene.camera[f.prop]}
            local={local}
            length={length}
            canKey={canKey}
            name={`the camera’s ${f.label.toLowerCase()}`}
            onSet={(v, said) => change({ camera: { [f.prop]: v } }, said)}
            onSeek={onSeek}
          />
        ))}
      </div>
      {scene.objects.length > 0 && object && (
        <div className="cl-3d-group" role="group" aria-label="Objects">
          <span className="cl-kicker">Objects</span>
          <div className="cl-segments" role="radiogroup" aria-label="Object">
            {scene.objects.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={o.id === object.id}
                className={o.id === object.id ? 'on' : ''}
                onClick={() => setPicked(o.id)}
              >
                {objectName(o)}
              </button>
            ))}
          </div>
          {(object.type === 'text' || (object.type === 'card' && object.title !== undefined)) && (
            <WordsField
              key={`${object.id}-words`}
              value={(object.type === 'text' ? object.text : object.title) ?? ''}
              onCommit={(words) =>
                change({ objects: [{ id: object.id, [object.type === 'text' ? 'text' : 'title']: words }] }, `${objectName(object)}’s words change.`)
              }
            />
          )}
          {OBJECT.map((f) => (
            <SceneKeyed
              key={`${object.id}-${f.prop}`}
              field={f}
              value={object[f.prop]}
              local={local}
              length={length}
              canKey={canKey}
              name={`${objectName(object)}’s ${f.label.toLowerCase()}`}
              onSet={(v, said) => change({ objects: [{ id: object.id, [f.prop]: v }] }, said)}
              onSeek={onSeek}
            />
          ))}
        </div>
      )}
    </>
  )
}

/** An object's words, a change when the field is left or Return is pressed. */
function WordsField({ value, onCommit }: { value: string; onCommit: (v: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    const words = draft.trim()
    if (!words) return setDraft(value)
    if (words !== value) whenSettled(() => onCommit(words))
  }
  return (
    <label className="cl-field">
      <span>Words</span>
      <input
        value={draft}
        maxLength={200}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setDraft(value)
        }}
      />
    </label>
  )
}

/** One of the scene's settings: its number at the playhead, its key diamond, and its keys along the clip. */
function SceneKeyed<K extends string>({
  field,
  value,
  local,
  length,
  canKey,
  name,
  onSet,
  onSeek
}: {
  field: Field<K>
  value: Anim<number> | undefined
  local: number
  length: number
  canKey: boolean
  name: string
  onSet: (v: Anim<number>, said: string) => void
  onSeek: (t: number) => void
}): JSX.Element {
  const keyed = isKeyed(value)
  const keys: Key<number>[] = keyed ? (value as { keys: Key<number>[] }).keys : []
  const here = keys.find((k) => Math.abs(k.t - local) <= SAME) ?? null
  const now = Math.round(num(value, local, length, field.usual) * 1000) / 1000
  const commit = (v: number): void => {
    if (keyed && canKey) onSet(withKey(value, local, v), `A key on ${name} is set.`)
    else onSet(v, `${name.charAt(0).toUpperCase()}${name.slice(1)} changes.`)
  }
  return (
    <div className="cl-keyed">
      <NumberField label={field.label} unit={field.unit} value={now} step={field.step} onCommit={commit}>
        <button
          type="button"
          className={`cl-key-toggle${here ? ' on' : ''}`}
          aria-pressed={!!here}
          aria-label={here ? `Take off the key on ${name} here` : `Set a key on ${name} here`}
          title={here ? 'Take off the key here' : 'Set a key here'}
          disabled={!canKey}
          onClick={() =>
            here
              ? onSet(withoutKey(value as { keys: Key<number>[] }, here.t), `A key on ${name} comes off.`)
              : onSet(withKey(value, local, now), `A key on ${name} is set.`)
          }
        />
      </NumberField>
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
        </div>
      )}
    </div>
  )
}
