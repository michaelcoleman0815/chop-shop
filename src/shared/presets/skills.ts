import type { Preset } from './preset'

/**
 * Built-in slash commands for the editing skills: transitions, sound, colour,
 * speed and camera work. They sit after the core five (/tighten, /snappy,
 * /shorts, /captions, /hook) so typing "/" still shows those and the person's
 * own saved styles; a letter or two brings these up.
 *
 * Each is a style like any other preset, planned into ops by planStyle, so a
 * version made from one can be replayed and undone like the rest.
 */
export const SKILL_PRESETS: Preset[] = [
  {
    command: 'fade',
    title: 'Fade',
    summary: 'Fades in from black at the start and out to black at the end.',
    builtIn: true,
    style: { fade: { inSec: 0.5, outSec: 1, color: 'black' } },
    inspiration: null
  }
]
