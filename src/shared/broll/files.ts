import { stem, words } from './text'

/**
 * What each file in the person's own folder is, from its name alone: media
 * Cutalong can use, a look, a font, a Lottie animation, something it knows
 * but cannot use (a Premiere template, an After Effects project), or
 * nothing to do with editing. The indexer opens only what this says is worth
 * opening, so a Documents folder full of spreadsheets costs a directory
 * listing and no more.
 */

export type LibraryKind =
  | 'video'
  | 'image'
  | 'overlay'
  | 'sequence'
  | 'sfx'
  | 'music'
  | 'lut'
  | 'font'
  | 'lottie'

/** What a name says a file is, before it is opened. */
export type FileClass =
  | { is: 'video' | 'image' | 'audio' | 'lut' | 'font' | 'json' }
  | { is: 'unsupported'; what: string; why: string }
  | { is: 'other' }

const VIDEO = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mts', 'm2ts', 'mxf', 'mpg', 'mpeg', 'ts', 'wmv', 'flv', '3gp'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'tga', 'exr', 'dpx', 'avif'])
const AUDIO = new Set(['wav', 'mp3', 'm4a', 'aac', 'aif', 'aiff', 'flac', 'ogg', 'opus', 'caf', 'wma'])
const LUT = new Set(['cube', '3dl'])
const FONT = new Set(['ttf', 'otf', 'ttc'])

/** Files Cutalong knows and cannot use directly, said plainly, with what to do instead. */
export const UNSUPPORTED: Record<string, { what: string; why: string }> = {
  mogrt: {
    what: 'Premiere motion graphics templates',
    why: 'They only run inside Premiere Pro. Render one to a ProRes 4444 or WebM file with transparency and I can use that.'
  },
  aep: {
    what: 'After Effects projects',
    why: 'They only open in After Effects. Render the comp to ProRes 4444 with alpha and I can lay it over footage.'
  },
  aet: { what: 'After Effects templates', why: 'They only open in After Effects.' },
  ffx: { what: 'After Effects presets', why: 'They are settings for After Effects, not pictures or sounds.' },
  aex: { what: 'After Effects plugins', why: 'Plugins run inside After Effects only.' },
  prproj: {
    what: 'Premiere Pro projects',
    why: 'Projects only open in Premiere. Export the sequence as a video and I can use it.'
  },
  prfpset: { what: 'Premiere presets', why: 'They are settings for Premiere, not pictures or sounds.' },
  prtl: { what: 'Premiere titles', why: 'Legacy titles only open in Premiere.' },
  epr: { what: 'export presets', why: 'They describe how to export, not footage to use.' },
  drfx: {
    what: 'DaVinci Resolve effect bundles',
    why: 'They install into Resolve. Render the effect to a file with transparency and I can use that.'
  },
  drp: { what: 'DaVinci Resolve projects', why: 'They only open in Resolve.' },
  setting: { what: 'Fusion macros', why: 'They only run inside Fusion or Resolve.' },
  motn: { what: 'Apple Motion projects', why: 'They only open in Motion. Export the project as a movie with alpha.' },
  moef: { what: 'Apple Motion effects', why: 'They only run inside Final Cut Pro and Motion.' },
  motr: { what: 'Apple Motion transitions', why: 'They only run inside Final Cut Pro and Motion.' },
  moti: { what: 'Apple Motion titles', why: 'They only run inside Final Cut Pro and Motion.' },
  fcpxml: { what: 'Final Cut Pro timelines', why: 'They describe an edit, not footage to use.' },
  plugin: { what: 'plugins', why: 'Plugins run inside other editing apps only.' },
  vst3: { what: 'audio plugins', why: 'Plugins run inside other audio apps only.' },
  component: { what: 'audio plugins', why: 'Plugins run inside other audio apps only.' },
  psd: { what: 'Photoshop files', why: 'Their layers only open in Photoshop. Export a PNG and I can use it.' },
  ai: { what: 'Illustrator files', why: 'Export a PNG or an SVG drawn as a PNG and I can use it.' },
  eps: { what: 'EPS drawings', why: 'Export a PNG and I can use it.' },
  svg: { what: 'SVG drawings', why: 'I cannot read SVG files yet. Export a PNG and I can use it.' },
  heic: { what: 'HEIC photos', why: 'I cannot read HEIC yet. Export them as JPEG and I can use them.' },
  heif: { what: 'HEIF photos', why: 'I cannot read HEIF yet. Export them as JPEG and I can use them.' },
  braw: { what: 'Blackmagic RAW clips', why: 'Only Resolve reads Blackmagic RAW. Export a ProRes copy.' },
  r3d: { what: 'RED RAW clips', why: 'Only RED’s own tools read them. Export a ProRes copy.' },
  lottie: { what: 'dotLottie files', why: 'They are zipped. The .json inside is the animation I can read.' },
  woff: { what: 'web fonts', why: 'Use the .ttf or .otf version of the font.' },
  woff2: { what: 'web fonts', why: 'Use the .ttf or .otf version of the font.' },
  sesx: { what: 'Audition sessions', why: 'They only open in Audition. Export the mix as WAV.' },
  als: { what: 'Ableton Live sets', why: 'They only open in Live. Export the track as WAV.' },
  band: { what: 'GarageBand projects', why: 'They only open in GarageBand. Share the song as a file.' },
  logicx: { what: 'Logic Pro projects', why: 'They only open in Logic. Bounce the track to WAV.' },
  fcpbundle: { what: 'Final Cut Pro libraries', why: 'Their media is managed by Final Cut. Export the clips you want.' },
  photoslibrary: { what: 'Photos libraries', why: 'Photos manages what is inside. Export the pictures you want.' }
}

/** Folders that are an app's package or a library of its own, never walked into. */
export const PACKAGE_DIRS =
  /\.(app|photoslibrary|fcpbundle|fcpcache|logicx|band|rcproject|imovielibrary|tvlibrary|musiclibrary|bundle|framework|plugin|component|vst3|lrdata)$/i

/** Folders that hold nothing worth indexing: caches, version control, previews an editor made. */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '__MACOSX',
  '.Trash',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  'Adobe Premiere Pro Auto-Save',
  'Adobe Premiere Pro Video Previews',
  'Adobe Premiere Pro Audio Previews',
  'Media Cache',
  'Media Cache Files',
  'CacheClip',
  'ProxyMedia',
  'Render Files',
  'Transcoded Media',
  'Proxy Media'
])

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** What a file is from its name. */
export function classify(name: string): FileClass {
  const ext = extOf(name)
  if (!ext || name.startsWith('._')) return { is: 'other' }
  if (VIDEO.has(ext)) return { is: 'video' }
  if (IMAGE.has(ext)) return { is: 'image' }
  if (AUDIO.has(ext)) return { is: 'audio' }
  if (LUT.has(ext)) return { is: 'lut' }
  if (FONT.has(ext)) return { is: 'font' }
  if (ext === 'json') return { is: 'json' }
  const known = UNSUPPORTED[ext]
  return known ? { is: 'unsupported', ...known } : { is: 'other' }
}

/** Folder words that say what everything inside is. */
const SFX_WORDS = new Set(
  'sfx sound effect effects foley whoosh swoosh swish impact hit riser rise boom click pop ui transition stinger glitch ding notification'
    .split(' ')
    .map(stem)
)
const MUSIC_WORDS = new Set('music song songs track tracks bed beds score soundtrack instrumental loop loops beat beats lofi'.split(' ').map(stem))
const OVERLAY_WORDS = new Set(
  'overlay overlays alpha transparent keyed matte light leak leaks film burn burns dust grain scratch scratches flare flares bokeh smoke particles lower third thirds title titles callout'
    .split(' ')
    .map(stem)
)

/**
 * The words a file is filed under: its folders below the library's root and
 * its own name, without the noise names carry ("final", "v2", "copy",
 * "IMG_0042"), each once.
 */
export function tagsFor(relPath: string): string[] {
  const parts = relPath.split(/[\\/]+/).filter(Boolean)
  const name = parts.pop() ?? ''
  const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
  const out: string[] = []
  for (const w of [...parts.flatMap((p) => words(p, { file: true })), ...words(base, { file: true })])
    if (!out.includes(w)) out.push(w)
  return out
}

/** Whether a sound is an effect or music: what its folders and name say, then how long it runs. */
export function audioRole(tags: string[], durationSec: number | null): 'sfx' | 'music' {
  const s = tags.map(stem)
  const sfx = s.some((t) => SFX_WORDS.has(t))
  const music = s.some((t) => MUSIC_WORDS.has(t))
  if (sfx && !music) return 'sfx'
  if (music && !sfx) return 'music'
  if (durationSec !== null) return durationSec <= 20 ? 'sfx' : 'music'
  return sfx ? 'sfx' : 'music'
}

/** Whether a file's folders or name say it is laid over footage. */
export function overlayWords(tags: string[]): boolean {
  return tags.map(stem).some((t) => OVERLAY_WORDS.has(t))
}

/** A numbered frame of an image sequence: "glow_0042.png" is frame 42 of "glow_####.png". */
export interface FrameName {
  /** What every frame of the sequence shares before the number. */
  prefix: string
  frame: number
  digits: number
  ext: string
}

const FRAME = /^(.*?)(\d{3,8})\.(png|tif|tiff|exr|dpx|tga)$/i

export function frameName(name: string): FrameName | null {
  const m = FRAME.exec(name)
  if (!m) return null
  return { prefix: m[1], frame: Number(m[2]), digits: m[2].length, ext: m[3].toLowerCase() }
}

/** Frames in a row it takes to be a sequence rather than a few numbered pictures. */
export const MIN_SEQUENCE_FRAMES = 10

/** The ffmpeg pattern that reads a whole sequence: glow_%04d.png. */
export function sequencePattern(f: FrameName): string {
  return `${f.prefix}%0${f.digits}d.${f.ext}`
}

/** A Lottie animation's size and timing, read from the start of its JSON, or null for any other JSON. */
export function lottieHead(head: string): { width: number; height: number; fps: number; frames: number } | null {
  const num = (key: string): number | null => {
    const m = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(head)
    return m ? Number(m[1]) : null
  }
  if (!/"v"\s*:\s*"\d+\.\d+/.test(head) || !/"(layers|assets)"\s*:/.test(head)) return null
  const fps = num('fr')
  const ip = num('ip')
  const op = num('op')
  const width = num('w')
  const height = num('h')
  if (fps === null || op === null || width === null || height === null || fps <= 0) return null
  return { width, height, fps, frames: Math.max(0, op - (ip ?? 0)) }
}

/** A .cube LUT's size and title, from its header, or null when it is not one. */
export function cubeHead(head: string): { size: number; title: string | null } | null {
  const size = /^\s*LUT_3D_SIZE\s+(\d+)/m.exec(head)
  if (!size) return null
  const title = /^\s*TITLE\s+"([^"]*)"/m.exec(head)
  return { size: Number(size[1]), title: title ? title[1] : null }
}
