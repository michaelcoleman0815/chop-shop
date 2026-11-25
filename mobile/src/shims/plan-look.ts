import type { Still } from '../../../src/main/plan-frames'

/**
 * The planner's eyes, as the phone's page sees them. The Mac reads frames of the footage and draws the planned edit
 * with Skia and ffmpeg's processes (src/main/plan-look.ts), which the page has neither of, so on the phone a plan is
 * made from the words, once, as it always was there: with no frames there is nothing for a critic to judge
 * (src/main/planner.ts).
 */
export async function footageFrames(): Promise<Still[]> {
  return []
}

export async function editStills(_doc: unknown, looks: unknown[]): Promise<null[]> {
  return looks.map(() => null)
}
