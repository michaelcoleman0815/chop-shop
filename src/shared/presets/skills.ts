import { NAMED_LOOKS } from '../edit/look'
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
    command: 'hype',
    title: 'Hype edit',
    summary:
      'Fast gaming and commentary cuts: punch-ins, big captions, a pixel scan to open, and speed lines into impacts on the big moments.',
    builtIn: true,
    style: {
      tighten: { maxGapSec: 0.25, padSec: 0.04, fillers: true },
      pad: { inSec: 0.04, outSec: 0.06 },
      pace: { secondsPerShot: 1.8 },
      punchIn: { scale: 1.15 },
      captions: { on: true, wordsPerScreen: 2, position: 'chest', uppercase: true },
      loudness: { lufs: -14 },
      fx: { open: true, moments: 4 }
    },
    inspiration: null
  },
  {
    command: 'fade',
    title: 'Fade',
    summary: 'Fades in from black at the start and out to black at the end.',
    builtIn: true,
    style: { fade: { inSec: 0.5, outSec: 1, color: 'black' } },
    inspiration: null
  },
  // The named looks: /clean, /warm, /cool, /cinematic, /vintage.
  ...Object.entries(NAMED_LOOKS).map(([command, l]) => ({
    command,
    title: `${l.title} look`,
    summary: l.summary,
    builtIn: true,
    style: { look: l.look },
    inspiration: null
  }))
]
