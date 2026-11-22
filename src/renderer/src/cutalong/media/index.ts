import broll from './broll-1.jpg'
import talk1 from './talk-1.jpg'
import talk2 from './talk-2.jpg'
import talk3 from './talk-3.jpg'

/**
 * Real stills from the owner's own footage (MVI_9293, a laptop review, and
 * MVI_9294, its B-roll), bundled so they load in the packaged app as in the
 * browser: the presets on Start show them, and the browser mock's posters are
 * them. Never painted stand-ins (the skill, "Quiet by default").
 */
export const STILLS = { talk1, talk2, talk3, broll } as const
export const STILL_LIST: readonly string[] = [talk1, talk2, talk3, broll]
