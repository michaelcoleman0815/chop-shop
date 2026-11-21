import { lineName } from './plan'
import { ordinal, type TakeGroup } from './takes'

/**
 * What a switch of takes says. Which take of which line is Claude's to read
 * from what the person says: the planner's take step names the line by its
 * id in the <takes> block and the take by its number, and the editor plays
 * it with switchTakeOps (./plan).
 */

/** The sentence for a version that switches takes: "The 2nd take of the intro plays now." */
export function switchedSentence(group: TakeGroup, index: number): string {
  return `The ${ordinal(index + 1)} take of ${lineName(group)} plays now.`
}
