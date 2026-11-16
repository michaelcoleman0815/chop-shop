import { MotionCallSchema, type MotionCall, type MotionItem } from './schema'
import { template } from './templates'

/**
 * Graphics in the app's voice: what a version added, changed or took away,
 * and what one graphic is, for the editor and the version summary.
 */

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const count = (n: number, one: string, many: string): string => `${NUMBER_WORDS[n] ?? n} ${n === 1 ? one : many}`

/** "a lower third for Sam Lee". */
export function graphicName(call: MotionCall | MotionItem): string {
  return template(call.kind)?.name(call) ?? 'a graphic'
}

/** The same, starting with a capital: "A lower third for Sam Lee". */
export function graphicTitle(call: MotionCall | MotionItem): string {
  const name = graphicName(call)
  return name.charAt(0).toUpperCase() + name.slice(1)
}

interface OpLike {
  op: string
}

/** Clauses for describePlan: "a lower third for Sam Lee comes in", "one graphic is gone". */
export function motionPhrases(ops: OpLike[]): string[] {
  const said: string[] = []
  const added = ops.filter((o) => o.op === 'motion-add')
  if (added.length > 0 && added.length <= 3) {
    for (const o of added) {
      const call = MotionCallSchema.safeParse(withoutOp(o))
      said.push(`${call.success ? graphicName(call.data) : 'a graphic'} comes in`)
    }
  } else if (added.length > 3) said.push(`${count(added.length, 'graphic', 'graphics')} come in`)
  const changed = ops.filter((o) => o.op === 'motion-update').length
  if (changed > 0) said.push(`${count(changed, 'graphic', 'graphics')} ${changed === 1 ? 'changes' : 'change'}`)
  const removed = ops.reduce(
    (n, o) => n + (o.op === 'motion-remove' ? ((o as { ids?: string[] }).ids?.length ?? 0) : 0),
    0
  )
  if (removed > 0) said.push(`${count(removed, 'graphic', 'graphics')} ${removed === 1 ? 'is' : 'are'} gone`)
  return said
}

function withoutOp(o: OpLike): Record<string, unknown> {
  const { op: _op, ...rest } = o as OpLike & Record<string, unknown>
  return rest
}
