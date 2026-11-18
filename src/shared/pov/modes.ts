/**
 * How the views of a gaming session several players recorded are chosen
 * (pov/choose): following whoever is talking, staying on the person's own
 * view and cutting to the others for their reactions, everyone at once in a
 * grid where they all react together, or the person's own view throughout.
 * Alone, so the plan's commands can name them without the edit's code.
 */
export const POV_MODES = ['talking', 'reactions', 'everyone', 'mine'] as const
export type PovMode = (typeof POV_MODES)[number]

/** What the words after /povs ask for: "talking", "reactions everyone", "mine", "2s". */
export function readPovWords(rest: string): { mode: PovMode; everyone: boolean; minSec: number } | null {
  const t = rest.toLowerCase()
  const minSec = Number(/(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/.exec(t)?.[1] ?? 0)
  const talking = /\b(talk|talking|talker|speaker|speaking|who'?s talking|follow)\b/.test(t)
  const reactions = /\b(react|reactions?|reacting|laughs?|screams?)\b/.test(t)
  const everyone = /\b(every(one|body)|all of us|grids?|together|at once|all)\b/.test(t)
  const mine = /\b(mine|my own|only me|just me|home|off)\b/.test(t)
  if (mine && !talking && !reactions && !everyone) return { mode: 'mine', everyone: false, minSec }
  if (talking) return { mode: 'talking', everyone, minSec }
  if (reactions) return { mode: 'reactions', everyone, minSec }
  if (everyone) return { mode: 'everyone', everyone: true, minSec }
  // /povs alone: home base, the others for their reactions, everyone when it goes off.
  if (!t.replace(/[\d.]+\s*s(ec(onds?)?)?/, '').trim()) return { mode: 'reactions', everyone: true, minSec }
  return null
}
