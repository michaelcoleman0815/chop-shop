import type { Op } from '../../../../shared/edit'
import { DEFAULT_PRESET, PRESETS } from '../../../../shared/particles/presets'
import { PARTICLE_PRESETS, type ParticlePreset, type ParticleSpec } from '../../../../shared/particles/schema'
import type { TrackClip } from '../../../../shared/tracks'
import { NumberField, TextField } from './ClipPanel'

/**
 * A particles clip's own settings in the clip panel: which preset it starts
 * from, and the few that change how it reads most, its colour, size, speed
 * and wind. Each shows the preset's value until it is changed; choosing a
 * preset starts afresh from it. How many are born a second is a keyed
 * setting with the others (ClipPanel), so it can build up and die away.
 */

type Numeric = 'size' | 'speed' | 'wind'

const NUMBERS: { key: Numeric; label: string; step: number; unit: string; min: number }[] = [
  { key: 'size', label: 'Particle size', step: 1, unit: 'px', min: 0.5 },
  { key: 'speed', label: 'Speed', step: 10, unit: 'px a second', min: 0 },
  { key: 'wind', label: 'Wind', step: 10, unit: 'to the right', min: -20_000 }
]

export function ParticleFields({ clip, onOps }: { clip: TrackClip; onOps: (ops: Op[], said: string) => void }): JSX.Element {
  const spec: ParticleSpec = clip.particles ?? {}
  const preset = spec.preset ?? DEFAULT_PRESET
  const look = PRESETS[preset]
  const change = (particles: ParticleSpec, said: string): void => onOps([{ op: 'clip-update', clip: clip.id, particles } as Op], said)
  const colours = spec.colors ?? look.colors

  return (
    <>
      <label className="cl-field">
        <span>Kind</span>
        <select
          value={preset}
          onChange={(e) => {
            const next = e.target.value as ParticlePreset
            change({ preset: next, ...(spec.seed !== undefined ? { seed: spec.seed } : {}) }, `It becomes ${PRESETS[next].title.toLowerCase()}.`)
          }}
        >
          {PARTICLE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {PRESETS[p].title}
            </option>
          ))}
        </select>
      </label>
      <p className="cl-particle-about muted">{look.summary}.</p>
      <TextField
        label={colours.length > 1 ? `Colour, the first of ${colours.length}` : 'Colour'}
        value={colours[0]}
        onCommit={(c) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) && change({ colors: [c] }, 'Its colour changes.')}
      />
      {NUMBERS.map((n) => (
        <NumberField
          key={n.key}
          label={n.label}
          unit={n.unit}
          value={spec[n.key] ?? look[n.key]}
          step={n.step}
          onCommit={(v) => v >= n.min && change({ [n.key]: v }, `Its ${n.label.toLowerCase()} changes.`)}
        />
      ))}
    </>
  )
}
