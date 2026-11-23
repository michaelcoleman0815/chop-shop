import type { BlendMode, ParticlesLayer, Size, Transform } from '../motion/types'
import { particleSettings } from './presets'
import type { ParticleSpec } from './schema'

/**
 * A particles clip as the compositor's layer: the frame-sized box the
 * system lives in, its settings made whole for this frame, and a key that
 * names the system exactly, so every frame of it, in the editor or the
 * export, carries on from the same steps.
 */

interface Base {
  id: string
  start: number
  end: number
  transform: Transform
  blend?: BlendMode
}

export function particlesLayer(base: Base, clip: { particles?: ParticleSpec; src?: string }, length: number, design: Size): ParticlesLayer {
  const settings = particleSettings(clip.particles, design)
  const key = JSON.stringify([settings, design.width, design.height, Math.round(length * 1000)])
  return {
    ...base,
    // Light adds itself to what is under it, unless the clip is blended some other way.
    ...(!base.blend && settings.blend === 'add' ? { blend: 'add' as const } : {}),
    kind: 'particles',
    particles: settings,
    key,
    w: design.width,
    h: design.height,
    ...(settings.sprite === 'image' && clip.src ? { file: clip.src } : {})
  }
}
