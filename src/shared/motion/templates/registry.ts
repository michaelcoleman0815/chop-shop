import type { MotionCall, MotionCallInput, MotionItem, MotionKind } from '../schema'
import type { Frame, MotionTheme } from '../theme'
import type { TimeSpan, Timeline } from '../timing'
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
  fields: Field[]
  /** A call the planner's instructions show, and what it does, in a few words. */
  example: { call: Omit<MotionCallInput, 'kind'>; says: string }
  /** Why a call cannot be drawn, as a sentence; null when it can. */
  check(call: MotionCall): string | null
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
