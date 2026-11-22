import type { TrackedObject } from '../../../src/main/track'
import { ON_THE_MAC } from '../host/limits'

export type { TrackedObject }

/**
 * Following what the speaker holds up, as the phone's page sees it. The Mac's Vision helper follows it
 * (src/main/track.ts, a process the page cannot start), so on the phone the graphic stays where the plan puts
 * it, and the reply says why in one sentence (src/main/plan-follow.ts).
 */
export async function trackObject(): Promise<TrackedObject> {
  throw new Error(ON_THE_MAC.follow)
}
