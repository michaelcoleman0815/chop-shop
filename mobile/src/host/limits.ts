import { fxCommandEntries } from '../../../src/shared/fx'
import { motionCommandEntries } from '../../../src/shared/motion'

/**
 * What the phone does not do yet, each said in one plain sentence. They
 * need the Mac's yt-dlp, its face finder or Vision, a local model, or a
 * canvas the export draws motion graphics, scene effects and a grid's ground
 * on. The app says so before anything starts (useCutalong asks device.away),
 * and the phone's API answers with the same sentence if it is reached another
 * way.
 */
export const ON_THE_MAC = {
  vlog: 'Vlogs are made on the Mac for now. Here I cut a recording, or a few clips of one talk, into an edit.',
  clipping: '/clipping is on the Mac for now. Here I cut a recording into one edit.',
  premiere: 'Premiere projects are made on the Mac for now.',
  link: 'Videos and pictures from links are on the Mac for now. Add your own with +.',
  broll: 'Finding B-roll online is on the Mac for now. Add your own clips with +.',
  graphics: 'Motion graphics are on the Mac for now.',
  effects: 'Scene effects are on the Mac for now.',
  hype: 'The hype edit is on the Mac for now: its scans, speed lines and impacts are drawn there.',
  grid: 'Grids of several videos are on the Mac for now. Here I cut one recording, or a few clips of one talk.',
  maps: 'Maps are on the Mac for now.',
  icon: 'Icons are on the Mac for now.',
  reframe: 'Following the speaker is on the Mac for now.',
  angle: 'A second camera is added on the Mac for now.',
  povs: 'Cutting between several players’ views of one session is on the Mac for now. Here I cut one recording, or a few clips of one talk.',
  lut: 'LUT files are on the Mac for now. The looks work here: try /look warm.',
  brand: 'Learning your look from your videos and edits is on the Mac for now.',
  learn: 'Learning from your edits is on the Mac for now.',
  study: 'Learning a style from a video is on the Mac for now.'
} as const

/** Slash commands that are on the Mac for now, with what the phone says when one is typed. */
export function commandsOnTheMac(): Record<string, string> {
  const away: Record<string, string> = {
    vlog: ON_THE_MAC.vlog,
    clipping: ON_THE_MAC.clipping,
    premiere: ON_THE_MAC.premiere,
    broll: ON_THE_MAC.broll,
    icon: ON_THE_MAC.icon,
    screenshot: ON_THE_MAC.link,
    phone: ON_THE_MAC.link,
    reframe: ON_THE_MAC.reframe,
    angle: ON_THE_MAC.angle,
    povs: ON_THE_MAC.povs,
    lut: ON_THE_MAC.lut,
    map: ON_THE_MAC.maps,
    hype: ON_THE_MAC.hype,
    grid: ON_THE_MAC.grid
  }
  for (const entry of motionCommandEntries()) away[entry.command] ??= ON_THE_MAC.graphics
  for (const entry of fxCommandEntries()) away[entry.command] ??= ON_THE_MAC.effects
  return away
}
