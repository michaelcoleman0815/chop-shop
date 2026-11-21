import type { Aspect, EditDoc } from '../../../shared/edit'

/**
 * Before long work starts on new footage: what was asked, and the two things
 * that are the person's to set before anything is cut (the shape and whether
 * there are captions), shown on one card in the thread (components/PreFlight).
 * The steps it lists are the ones the app takes; the cost is the published
 * reckoning for that much footage (shared/setup/cost). Nothing here guesses at
 * a plan: the plan needs the transcript, which this card comes before.
 */
export interface PreflightAsk {
  ask: string
  files: { path: string; name: string }[]
  /** The footage's length, in minutes, when the host could measure it. */
  minutes: number | null
}

export interface PreflightChoice {
  ask: string
  /** The shape asked for; null keeps it as shot. */
  aspect: Exclude<Aspect, 'original'> | null
  captions: boolean
}

export interface PreflightCard extends PreflightAsk {
  /** Set once the cut started, with what was chosen. */
  choice?: PreflightChoice
}

export const SHAPES: { id: PreflightChoice['aspect']; label: string }[] = [
  { id: null, label: 'As shot' },
  { id: 'vertical', label: 'Vertical 9:16' },
  { id: 'wide', label: 'Wide 16:9' },
  { id: 'square', label: 'Square' }
]

/**
 * The first version as chosen on the card: its shape and its captions set on
 * v1 itself, as if the edit had been made that way, since nothing has been cut
 * yet. A doc already past v1 is left as it is.
 */
export function withChoice(doc: EditDoc, choice: Pick<PreflightChoice, 'aspect' | 'captions'>): EditDoc {
  if (doc.versions.length !== 1) return doc
  const [v1] = doc.versions
  const cut = {
    ...v1.cut,
    aspect: choice.aspect ?? v1.cut.aspect,
    captions: { ...v1.cut.captions, on: choice.captions }
  }
  return { ...doc, versions: [{ ...v1, cut }] }
}

/** The steps the card lists, in the app's own words, for the device the work runs on. */
export function preflightSteps(here: string, choice: Pick<PreflightChoice, 'aspect' | 'captions'>): string[] {
  const shape = SHAPES.find((s) => s.id === choice.aspect)
  const how = [choice.aspect ? shape?.label.split(' ')[0].toLowerCase() : null, choice.captions ? 'with captions' : 'no captions']
    .filter(Boolean)
    .join(', ')
  return [
    `Write down every word, on ${here}`,
    'Read what you asked with Claude and plan the cut from the words',
    `Make v1, ${how}`
  ]
}

/** "3 clips · 14:20". */
export function footageLine(files: number, minutes: number | null, clock: (sec: number) => string): string {
  const what = `${files} ${files === 1 ? 'clip' : 'clips'}`
  return minutes !== null ? `${what} · ${clock(minutes * 60)}` : what
}
