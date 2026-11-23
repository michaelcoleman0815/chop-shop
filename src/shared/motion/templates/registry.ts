import type { MotionCall, MotionCallInput, MotionItem, MotionKind } from '../schema'
import type { Frame, MotionTheme } from '../theme'
import type { TimeSpan, Timeline } from '../timing'
import type { FaceBox } from '../captions'
import type { Layer } from '../types'

/**
 * A template turns a call (its slots) into layers on the output clock. Each
 * one also says, in plain words, what it is and how it reads its slots: that
 * text goes into the planner's instructions, the slash menu and the editor's
 * controls, so there is one description of every graphic.
 */

export interface BuildContext {
  item: MotionItem
  frame: Frame
  theme: MotionTheme
  /** When it lands, starts and ends, in output seconds. */
  span: TimeSpan
  tl: Timeline
  /** Output seconds for an anchor, or null when it is not in the cut. */
  time(ref: string): number | null
  /** The faces in frame when it lands, from face tracking, as fractions of the frame. Empty when unknown. */
  faces: FaceBox[]
  /** A picture in the edit by asset id, with its size when known. */
  picture(id: string): { width: number; height: number } | null
}

/** A control the editor shows for a graphic. */
export type Field =
  | { slot: 'text'; index: number; label: string }
  | { slot: 'items'; label: string }
  | { slot: 'values'; index: number; label: string }
  | { slot: 'icon'; label: string }
  | { slot: 'box'; label: string }

export interface Template {
  kind: MotionKind
  /** "Lower third". */
  title: string
  /** One sentence: what it is, then how its slots are read. For the planner and the slash menu. */
  about: string
  /** Its variants, the default first. */
  styles: readonly string[]
  /** Where it can go, the default first. Empty when it fills the frame. */
  places: readonly string[]
  /** Seconds it stays when the call leaves `to` empty. */
  length: number
  /** Seconds the entrance starts before its anchor, so it finishes on the word. */
  lead: number
  /**
   * How it meets the captions. A backdrop replaces the picture, so drawn
   * captions move over it to the middle. A card has words of its own (an end
   * card, a title that quotes the speech), so captions wait until it is gone.
   */
  covers?: 'backdrop' | 'card'
  /** How one call meets the captions, when that depends on the call (a map inset in a corner covers nothing). */
  coversFor?(call: MotionCall): 'backdrop' | 'card' | undefined
  /**
   * Drawn round the speaker, on their picture: when a card takes the screen
   * while it is up (a page sliding in after a list), it leaves as the card
   * comes in rather than staying on top of it.
   */
  aroundSpeaker?: boolean
  /**
   * The stretch of the frame's height it holds while it is up, in pixels, for one that sits across the
   * speaker's picture (a keyword pop): drawn captions step out of its way, or wait for it, rather than run
   * under it. Null when it holds no such stretch.
   */
  band?(ctx: BuildContext): { top: number; bottom: number } | null
  fields: Field[]
  /** A call the planner's instructions show, and what it does, in a few words. */
  example: { call: Omit<MotionCallInput, 'kind'>; says: string }
  /** Why a call cannot be drawn, as a sentence; null when it can. */
  check(call: MotionCall): string | null
  /** The edit's pictures it shows, by asset id: they must be in the edit, and are credited with it. */
  pictures?(call: MotionCall): string[]
  /** Rows for Details: where what it shows comes from, such as a map's facts and data. */
  details?(call: MotionCall): { label: string; value: string }[]
  build(ctx: BuildContext): Layer[]
  /** A short name for one call: "a lower third for Sam Lee". */
  name(call: MotionCall): string
}

const registry = new Map<MotionKind, Template>()

export function register(...templates: Template[]): void {
  for (const t of templates) registry.set(t.kind, t)
}

export function template(kind: MotionKind): Template | undefined {
  return registry.get(kind)
}

/** Every template that is built, in the order they were registered. */
export function templates(): Template[] {
  return [...registry.values()]
}
