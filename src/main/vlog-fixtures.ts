import { execFile, spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { FIXTURES } from './learn-fixtures'
import type { Gps, LeftOut } from '../shared/vlog/schema'

/**
 * A synthetic vlog shoot with its answers planted, made with ffmpeg alone:
 * a day in several places, each with its own look and moving content, clips
 * recorded through the day with gaps between places, a phone and an action
 * camera whose clock is seven hours off, a few places on the map, talking to
 * camera (the checked-in espeak recording the learning tests use, so this
 * runs on any computer with ffmpeg), shaky starts, a phone lowered at the
 * end, a pocket recording, a soft clip, a near-identical take, a clip with
 * no time on it, an upright clip among wide ones, and one clear highlight
 * late in the day: a crowd going wild under flashing lights.
 *
 * Only tests and the end-to-end check import this.
 */

const run = promisify(execFile)

/** ffprobe as the app finds it: the bundled one first, as the Mac app ships ffprobe 5. */
export function findFfprobe(): string | null {
  const candidates = [process.env.FFPROBE_PATH]
  try {
    candidates.push(require('@ffprobe-installer/ffprobe').path as string)
  } catch {
    // Not installed in this checkout.
  }
  candidates.push('ffprobe')
  for (const bin of candidates) {
    if (!bin) continue
    if (bin !== 'ffprobe' && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}

export type Look = 'home' | 'street' | 'park' | 'beach' | 'dinner' | 'venue'
export type Sound = 'room' | 'street' | 'wind' | 'crowd' | 'laughter' | 'music' | 'pocket' | { talk: [number, number] }

export interface PlannedClip {
  name: string
  /** The place it was planted in: one scene each. */
  place: Look
  /** When it really happened, in minutes after 08:00 on the shoot day. */
  minute: number
  sec: number
  /** The framing within its place: a different crop and different movement. */
  variant: number
  sound: Sound
  camera: 'iphone' | 'gopro'
  /** False: the file carries no recording time. */
  timed?: boolean
  gps?: Gps
  shake?: 'start' | 'all' | 'lowered'
  blur?: boolean
  pocket?: boolean
  upright?: boolean
  /** The same framing as another clip, recorded moments later. */
  copyOf?: string
  highlight?: boolean
  /** What the story should make of it. */
  expect?: LeftOut | 'used'
}

export interface ShootTruth {
  dir: string
  clips: (PlannedClip & { path: string })[]
  /** The places in the order of the day. */
  places: Look[]
  /** The words said in each talking clip, on the clip's own clock. */
  words: Map<string, { text: string; startSec: number; endSec: number }[]>
}

/** The day the shoot happened, and the action camera's clock error. */
const DAY = Date.UTC(2026, 4, 2, 8, 0, 0)
export const GOPRO_OFF_SEC = -7 * 3600

/** The checked-in talking: 150 words of espeak with their times. */
export function talkWords(): { text: string; startSec: number; endSec: number }[] {
  const json = JSON.parse(readFileSync(join(FIXTURES, 'talk.json'), 'utf8')) as {
    words: { text: string; startSec: number; endSec: number }[]
  }
  return json.words
}

/** The small shoot the unit tests use: six places, eighteen clips, a few seconds each. */
export function smallShoot(): PlannedClip[] {
  const home: Gps = { lat: 51.5072, lon: -0.1276 }
  const venue: Gps = { lat: 51.5155, lon: -0.0922 }
  return [
    {
      name: 'IMG_0101.MOV',
      place: 'home',
      minute: 0,
      sec: 5,
      variant: 0,
      sound: 'room',
      camera: 'iphone',
      gps: home,
      expect: 'used'
    },
    {
      name: 'IMG_0102.MOV',
      place: 'home',
      minute: 0.6,
      sec: 5,
      variant: 0,
      sound: 'room',
      camera: 'iphone',
      gps: home,
      copyOf: 'IMG_0101.MOV',
      expect: 'duplicate'
    },
    {
      name: 'IMG_0103.MOV',
      place: 'home',
      minute: 2,
      sec: 6,
      variant: 1,
      sound: 'room',
      camera: 'iphone',
      shake: 'start',
      expect: 'used'
    },
    {
      name: 'IMG_0104.MOV',
      place: 'home',
      minute: 3,
      sec: 4,
      variant: 2,
      sound: 'room',
      camera: 'iphone',
      blur: true,
      expect: 'blurred'
    },
    {
      name: 'IMG_0110.MOV',
      place: 'street',
      minute: 70,
      sec: 5,
      variant: 0,
      sound: 'street',
      camera: 'iphone',
      expect: 'used'
    },
    {
      name: 'IMG_0111.MOV',
      place: 'street',
      minute: 71,
      sec: 15.6,
      variant: 1,
      sound: { talk: [0, 15.6] },
      camera: 'iphone',
      expect: 'used'
    },
    {
      name: 'IMG_0112.MOV',
      place: 'street',
      minute: 73,
      sec: 6,
      variant: 2,
      sound: 'street',
      camera: 'iphone',
      shake: 'lowered',
      expect: 'used'
    },
    {
      name: 'IMG_0113.MOV',
      place: 'street',
      minute: 74,
      sec: 4,
      variant: 0,
      sound: 'pocket',
      camera: 'iphone',
      pocket: true,
      expect: 'pocket'
    },
    {
      name: 'GX010001.MP4',
      place: 'park',
      minute: 150,
      sec: 6,
      variant: 0,
      sound: 'wind',
      camera: 'gopro',
      expect: 'used'
    },
    {
      name: 'IMG_0120.MOV',
      place: 'park',
      minute: 151,
      sec: 5,
      variant: 1,
      sound: 'wind',
      camera: 'iphone',
      expect: 'used'
    },
    {
      name: 'IMG_0121.MOV',
      place: 'park',
      minute: 153,
      sec: 5,
      variant: 2,
      sound: 'room',
      camera: 'iphone',
      timed: false,
      expect: 'used'
    },
    {
      name: 'IMG_0130.MOV',
      place: 'beach',
      minute: 240,
      sec: 6,
      variant: 0,
      sound: 'wind',
      camera: 'iphone',
      upright: true,
      expect: 'used'
    },
    {
      name: 'GX010002.MP4',
      place: 'beach',
      minute: 242,
      sec: 5,
      variant: 1,
      sound: 'wind',
      camera: 'gopro',
      expect: 'used'
    },
    {
      name: 'IMG_0140.MOV',
      place: 'dinner',
      minute: 600,
      sec: 5,
      variant: 0,
      sound: 'laughter',
      camera: 'iphone',
      expect: 'used'
    },
    {
      name: 'IMG_0141.MOV',
      place: 'dinner',
      minute: 602,
      sec: 5,
      variant: 1,
      sound: 'room',
      camera: 'iphone',
      expect: 'used'
    },
    {
      name: 'IMG_0150.MOV',
      place: 'venue',
      minute: 700,
      sec: 6,
      variant: 0,
      sound: 'music',
      camera: 'iphone',
      gps: venue,
      expect: 'used'
    },
    {
      name: 'IMG_0151.MOV',
      place: 'venue',
      minute: 703,
      sec: 7,
      variant: 1,
      sound: 'crowd',
      camera: 'iphone',
      gps: venue,
      highlight: true,
      expect: 'used'
    },
    {
      name: 'IMG_0152.MOV',
      place: 'venue',
      minute: 706,
      sec: 8.7,
      variant: 2,
      sound: { talk: [75.3, 84.0] },
      camera: 'iphone',
      gps: venue,
      expect: 'used'
    }
  ]
}

/** Static things standing in a place, where they stand depends on the framing: trees, tables, windows. */
function props(color: string, h: number, variant: number, count: number, w: number, tall: number, y: number): string {
  return Array.from({ length: count }, (_, k) => {
    const x = Math.round((80 + 170 * k + 70 * variant) % 760)
    return `drawbox=x=${x}:y=${Math.round(y * h)}:w=${w}:h=${Math.round(tall * h)}:color=${color}:t=fill`
  }).join(',')
}

/** Palette and movement of each place. */
function lookGraph(place: Look, variant: number, sec: number, tall: boolean): string {
  const d = sec.toFixed(2)
  const h = tall ? 900 : 450
  const v = variant
  switch (place) {
    case 'home':
      return `testsrc2=s=800x${h}:r=30:d=${d}`
    case 'street':
      return `mandelbrot=s=800x${h}:r=30,trim=duration=${d},setpts=PTS-STARTPTS`
    case 'park':
      return [
        `color=c=0x3a7d44:s=800x${h}:r=30:d=${d},${props('0x1b4332', h, v, 4, 70, 0.55, 0.1)},${props('0x95d5b2', h, v + 1, 2, 120, 0.08, 0.8)}[bg${v}]`,
        `color=c=0xf1faee:s=140x90:r=30:d=${d}[p1]`,
        `color=c=0xe9c46a:s=70x70:r=30:d=${d}[p2]`,
        `[bg${v}][p1]overlay=x='120+${200 + 40 * v}*(0.5+0.5*sin(t*${(0.9 + 0.2 * v).toFixed(1)}))':y=${140 + 20 * v}[q1]`,
        `[q1][p2]overlay=x=${520 - 30 * v}:y='160+90*sin(t*1.7)'`
      ].join(';')
    case 'beach':
      return [
        `color=c=0x5fa8d3:s=800x${h}:r=30:d=${d},drawbox=x=0:y=${Math.round(h * 0.55)}:w=800:h=${h}:color=0xe9c46a:t=fill,${props('0xe63946', h, v, 3, 50, 0.2, 0.42)},${props('0xffffff', h, v + 2, 2, 90, 0.05, 0.7)}[bg${v}]`,
        `color=c=0xffffff:s=260x24:r=30:d=${d}[w1]`,
        `[bg${v}][w1]overlay=x='mod(t*${120 + 30 * v},800)-130':y=${Math.round(h * 0.52)}`
      ].join(';')
    case 'dinner':
      return [
        `color=c=0x3d2314:s=800x${h}:r=30:d=${d},${props('0x7f5539', h, v, 3, 140, 0.25, 0.6)},${props('0xb08968', h, v + 1, 2, 60, 0.3, 0.1)}[bg${v}]`,
        `color=c=0xffb703:s=60x60:r=30:d=${d}[l1]`,
        `color=c=0xfb8500:s=90x50:r=30:d=${d}[l2]`,
        `[bg${v}][l1]overlay=x='${200 + 60 * v}+80*sin(t*0.8)':y=180[d1]`,
        `[d1][l2]overlay=x='${480 - 40 * v}+60*cos(t*0.6)':y='240+30*sin(t*0.9)'`
      ].join(';')
    case 'venue':
      // A stage under flashing light; the highlight's crowd moves hard and fast.
      return [
        `color=c=0x3c096c:s=800x${h}:r=30:d=${d},drawbox=x=0:y=${Math.round(h * 0.7)}:w=800:h=${h}:color=0x10002b:t=fill,${props('0x7b2cbf', h, v, 4, 40, 0.5, 0.15)}[bg${v}]`,
        `color=c=0xff006e:s=160x160:r=30:d=${d}[s1]`,
        `color=c=0xfee440:s=120x200:r=30:d=${d}[s2]`,
        `color=c=0x00f5d4:s=220x90:r=30:d=${d}[s3]`,
        `[bg${v}][s1]overlay=x='300+260*sin(t*${v === 1 ? 7 : 1.2})':y='150+120*cos(t*${v === 1 ? 9 : 1.1})'[e1]`,
        `[e1][s2]overlay=x='520+200*cos(t*${v === 1 ? 8 : 0.9})':y='120+100*sin(t*${v === 1 ? 6 : 1.3})'[e2]`,
        `[e2][s3]overlay=x='100+250*sin(t*${v === 1 ? 10 : 0.7})':y='300+60*sin(t*${v === 1 ? 7 : 1})'` +
          (v === 1 ? `,eq=brightness='0.12*sin(2*PI*4*t)':eval=frame` : '')
      ].join(';')
  }
}

/** The video of one planted clip, as a filter graph ending in [v]. */
function videoGraph(c: PlannedClip, size: { w: number; h: number }): string {
  const tall = c.shake === 'lowered'
  const look = lookGraph(c.place, c.variant, c.sec, tall)
  // Each framing of a place is a different crop of it.
  const x0 = 40 + 50 * (c.variant % 3)
  const y0 = tall ? 270 : 30 + 20 * (c.variant % 3)
  const amp = 150
  const jitterX =
    c.shake === 'all' ? `(random(1)-0.5)*${amp}` : c.shake === 'start' ? `lt(t,1.6)*(random(1)-0.5)*${amp}` : '0'
  const jitterY =
    c.shake === 'all' ? `(random(2)-0.5)*${amp}` : c.shake === 'start' ? `lt(t,1.6)*(random(2)-0.5)*${amp}` : '0'
  // Lowered: for the last 1.4 s the view sweeps down fast, as a phone does on its way to a pocket.
  const lower = c.shake === 'lowered' ? `+min(260,max(0,t-${(c.sec - 1.4).toFixed(2)})*260)` : ''
  const crop = `crop=640:360:x='max(0,min(160,${x0}+${jitterX}))':y='max(0,min(${tall ? 540 : 90},${y0}${lower}+${jitterY}))'`
  const extra = [c.blur ? 'gblur=sigma=7' : null, c.pocket ? 'eq=brightness=-0.95,noise=alls=6:allf=t' : null].filter(
    Boolean
  )
  const out = c.upright ? `scale=${size.h}:${size.w},setsar=1` : `scale=${size.w}:${size.h},setsar=1`
  const chain = [crop, ...extra, out, 'format=yuv420p'].join(',')
  return `${look}[raw];[raw]${chain}[v]`
}

/** The sound of one planted clip, as ffmpeg inputs and a filter ending in [a]; talking reads the espeak recording. */
function soundGraph(c: PlannedClip, input: number): { inputs: string[]; graph: string } {
  const d = c.sec.toFixed(2)
  const lav = (g: string): { inputs: string[]; graph: string } => ({
    inputs: ['-f', 'lavfi', '-i', g],
    graph: `[${input}:a]anull[a]`
  })
  const s = c.sound
  if (typeof s === 'object') {
    return {
      inputs: ['-ss', s.talk[0].toFixed(3), '-t', d, '-i', join(FIXTURES, 'talk.m4a')],
      graph: `[${input}:a]aresample=48000,apad,atrim=duration=${d}[a]`
    }
  }
  switch (s) {
    case 'room':
      return lav(`anoisesrc=color=pink:amplitude=0.004:duration=${d}:sample_rate=48000`)
    case 'street':
      return lav(`anoisesrc=color=pink:amplitude=0.02:duration=${d}:sample_rate=48000,lowpass=f=1800`)
    case 'pocket':
      return lav(`anoisesrc=color=brown:amplitude=0.01:duration=${d}:sample_rate=48000,lowpass=f=300`)
    case 'wind':
      return lav(
        `anoisesrc=color=brown:amplitude=0.9:duration=${d}:sample_rate=48000,lowpass=f=250,volume='0.5+0.5*sin(2*PI*0.4*t)':eval=frame`
      )
    case 'crowd':
      return lav(
        `anoisesrc=color=pink:amplitude=0.6:duration=${d}:sample_rate=48000,volume='0.65+0.35*sin(2*PI*0.7*t)':eval=frame`
      )
    case 'laughter':
      return lav(
        `aevalsrc='0.5*(sin(2*PI*290*t)+0.5*sin(2*PI*580*t)+0.25*sin(2*PI*870*t))*pow(max(0,sin(2*PI*5*t)),2)*lt(mod(t,2.5),1.6)':s=48000:d=${d}`
      )
    case 'music':
      return lav(
        `aevalsrc='0.2*sin(2*PI*220*t)+0.16*sin(2*PI*277.2*t)+0.16*sin(2*PI*329.6*t)+0.45*sin(2*PI*55*t)*exp(-8*mod(t,0.5))':s=48000:d=${d}`
      )
  }
}

/** The recording time a planted clip's file carries, by its camera's clock, or null. */
export function cameraTime(c: PlannedClip): string | null {
  if (c.timed === false) return null
  const real = DAY + c.minute * 60_000
  return new Date(real + (c.camera === 'gopro' ? GOPRO_OFF_SEC * 1000 : 0)).toISOString()
}

/** The real time of a planted clip, in seconds since 1970. */
export function realTime(c: PlannedClip): number {
  return (DAY + c.minute * 60_000) / 1000
}

async function makeClip(ffmpeg: string, dir: string, c: PlannedClip, size: { w: number; h: number }): Promise<string> {
  const path = join(dir, c.name)
  const sound = soundGraph(c, 0)
  const graph = `${videoGraph(c, size)};${sound.graph}`
  const time = cameraTime(c)
  const meta: string[] = []
  if (time) meta.push('-metadata', `creation_time=${time}`)
  if (c.camera === 'iphone') {
    meta.push('-metadata', 'com.apple.quicktime.make=Apple', '-metadata', 'com.apple.quicktime.model=iPhone 15 Pro')
    if (c.gps) {
      const fmt = (v: number, w: number): string => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(4).padStart(w, '0')}`
      meta.push('-metadata', `com.apple.quicktime.location.ISO6709=${fmt(c.gps.lat, 7)}${fmt(c.gps.lon, 8)}+010.000/`)
    }
    meta.push('-movflags', 'use_metadata_tags')
  } else {
    meta.push('-metadata:s:v:0', 'handler_name=GoPro AVC', '-metadata', 'firmware=HD9.01.01.60.00')
  }
  await run(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...sound.inputs,
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-t',
    c.sec.toFixed(2),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '30',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    ...meta,
    path
  ])
  return path
}

/**
 * Makes a planned shoot in `dir`, a few clips at a time, with the words of
 * its talking clips. A near-identical take is made from the same framing as
 * the clip it copies, so it looks the same.
 */
export async function makeShoot(
  ffmpeg: string,
  dir: string,
  plan: PlannedClip[],
  size = { w: 384, h: 216 }
): Promise<ShootTruth> {
  const words = talkWords()
  const made: (PlannedClip & { path: string })[] = []
  const queue = plan.map((c) => {
    const copy = c.copyOf ? plan.find((p) => p.name === c.copyOf) : undefined
    return copy ? { ...c, place: copy.place, variant: copy.variant } : c
  })
  const workers = Array.from({ length: 4 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      made.push({ ...c, path: await makeClip(ffmpeg, dir, c, size) })
    }
  })
  await Promise.all(workers)
  made.sort((a, b) => plan.findIndex((p) => p.name === a.name) - plan.findIndex((p) => p.name === b.name))
  const said = new Map<string, { text: string; startSec: number; endSec: number }[]>()
  for (const c of made) {
    if (typeof c.sound !== 'object') continue
    const [a, b] = c.sound.talk
    said.set(
      c.name,
      words
        .filter((w) => w.startSec >= a - 0.01 && w.endSec <= Math.min(b, a + c.sec) + 0.01)
        .map((w) => ({
          text: w.text,
          startSec: Math.round((w.startSec - a) * 1000) / 1000,
          endSec: Math.round((w.endSec - a) * 1000) / 1000
        }))
    )
  }
  const places: Look[] = []
  for (const c of [...plan].sort((a, b) => a.minute - b.minute)) if (!places.includes(c.place)) places.push(c.place)
  return { dir, clips: made, places, words: said }
}
