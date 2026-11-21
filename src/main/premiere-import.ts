import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { currentVersion, type EditDoc, type SfxKind } from '../shared/edit'
import { isImagePath } from '../shared/assets'
import type { PremiereFacts } from '../shared/presets'
import { addToXmeml, parseXmeml, sequenceFiles, type XmemlClip, type XmemlSequence } from '../shared/premiere/xmeml'
import { coverWholeTimeline, movedSentence, timelineMoves } from '../shared/premiere/round-trip'
import { premiereAdditions, premiereMedia, premierePlanFor, writeCaptions, type PremiereMedia } from './premiere-cut'
import { prepareCut, type ProgressFn, type WorkHost } from './cut-work'

/**
 * A Premiere sequence brought into Cutalong, and sent back.
 *
 * Premiere exports a sequence as xmeml (File > Export > Final Cut Pro XML).
 * Cutalong reads it, plays a copy of its picture and sound made with ffmpeg
 * (the proxy), and makes an edit of that copy whose every second is in the
 * cut, so a moment in Cutalong is the same moment in Premiere. What the
 * person asks for in chat (captions, sound effects, music, cutaways) goes
 * back into the sequence as tracks of its own, written into the text
 * Premiere wrote, so every cut, effect and title in it stays as it was.
 */

/** The proxy's longest side: enough to judge an edit by, quick to make. */
const PROXY_LONG_SIDE = 1920
/** Sounds mixed in one pass of ffmpeg; more are mixed in turns. */
const MIX_BATCH = 32

/** A stretch of the proxy's picture: a file's frames from inSec on, or black. */
export interface ProxyPicture {
  startFrame: number
  frames: number
  path: string | null
  inSec: number
  /** Faster than 1 when Premiere plays the clip sped up. */
  speed: number
}

/** A sound in the proxy's mix, on the sequence's clock. */
export interface ProxySound {
  path: string
  startSec: number
  durationSec: number
  inSec: number
}

export interface ProxyPlan {
  fps: number
  /** The rate as ffmpeg reads one: 30000/1001 for 29.97. */
  rate: string
  width: number
  height: number
  frames: number
  durationSec: number
  picture: ProxyPicture[]
  sound: ProxySound[]
  /** Titles, mattes and nested sequences, which Premiere draws and the proxy leaves out. */
  drawn: number
}

/**
 * What the proxy shows and plays. Picture: the topmost enabled clip of a
 * file at every moment, as Premiere shows it, cut in the middle of a
 * transition; black where there is none. Sound: every enabled clip of a file
 * on every track, a stereo pair once.
 */
export function proxyPlan(seq: XmemlSequence, missing: Set<string> = new Set()): ProxyPlan {
  const ends = [...seq.video, ...seq.audio].flatMap((t) => t.clips.map((c) => c.end))
  const frames = Math.max(seq.durationFrames, 0) || Math.max(0, ...ends)
  const long = Math.max(seq.width, seq.height)
  const shrink = long > PROXY_LONG_SIDE ? PROXY_LONG_SIDE / long : 1
  const even = (n: number): number => Math.max(2, Math.round((n * shrink) / 2) * 2)
  const playable = (c: XmemlClip): c is XmemlClip & { file: { path: string } } =>
    c.enabled && c.kind === 'clipitem' && !!c.file?.path

  // Painted bottom track first, so a clip above covers what is under it.
  let spans: { a: number; b: number; clip: XmemlClip | null }[] = [{ a: 0, b: frames, clip: null }]
  const paint = (a: number, b: number, clip: XmemlClip): void => {
    a = Math.max(0, a)
    b = Math.min(frames, b)
    if (b <= a) return
    const next: typeof spans = []
    for (const s of spans) {
      if (s.b <= a || s.a >= b) {
        next.push(s)
        continue
      }
      if (s.a < a) next.push({ ...s, b: a })
      if (s.b > b) next.push({ ...s, a: b })
    }
    next.push({ a, b, clip })
    spans = next.sort((x, y) => x.a - y.a)
  }
  let drawn = 0
  for (const track of seq.video) {
    if (!track.enabled) continue
    for (const c of track.clips) {
      if (!c.enabled) continue
      if (!playable(c)) {
        drawn++
        continue
      }
      paint(c.shownStart, c.shownEnd, c)
    }
  }
  const speedOf = (c: XmemlClip): number => {
    const length = c.end - c.start
    const speed = length > 0 ? (c.out - c.in) / length : 1
    return Number.isFinite(speed) && speed > 0 && Math.abs(speed - 1) > 0.01 ? speed : 1
  }
  const picture: ProxyPicture[] = []
  for (const s of spans) {
    const path = s.clip?.file?.path ?? null
    const usable = path && !missing.has(path) ? path : null
    const prev = picture[picture.length - 1]
    // Neighbouring black, and the same clip carrying on, are one stretch.
    if (!usable && prev && prev.path === null) {
      prev.frames += s.b - s.a
      continue
    }
    const clip = s.clip as XmemlClip
    const speed = usable ? speedOf(clip) : 1
    picture.push({
      startFrame: s.a,
      frames: s.b - s.a,
      path: usable,
      inSec: usable ? (clip.in + (s.a - clip.start) * speed) / seq.fps : 0,
      speed
    })
  }

  const sound: ProxySound[] = []
  const seen = new Set<string>()
  for (const track of seq.audio) {
    if (!track.enabled) continue
    for (const c of track.clips) {
      if (!playable(c) || missing.has(c.file.path)) continue
      const key = `${c.file.path}|${c.shownStart}|${c.shownEnd}|${c.in}`
      if (seen.has(key)) continue
      seen.add(key)
      const a = Math.max(0, c.shownStart)
      const b = Math.min(frames, c.shownEnd)
      if (b <= a) continue
      sound.push({
        path: c.file.path,
        startSec: a / seq.fps,
        durationSec: (b - a) / seq.fps,
        inSec: (c.in + (a - c.start)) / seq.fps
      })
    }
  }

  return {
    fps: seq.fps,
    rate: seq.ntsc ? `${seq.timebase * 1000}/1001` : String(seq.timebase),
    width: even(seq.width),
    height: even(seq.height),
    frames,
    durationSec: frames / seq.fps,
    picture,
    sound: sound.sort((x, y) => x.startSec - y.startSec),
    drawn
  }
}

function run(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args])
    let err = ''
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-6).join('\n') || `ffmpeg exit ${code}`))
    )
  })
}

/**
 * Makes the proxy at `out`: each stretch of picture encoded on its own at
 * the sequence's rate and size and joined end to end, under the sound mixed
 * on the sequence's clock. Every stretch is exactly its frames long, padded
 * with black if its file runs out, so the copy never drifts off Premiere's
 * timeline.
 */
export async function renderProxy(
  ffmpeg: string,
  plan: ProxyPlan,
  out: string,
  progress: (percent: number) => void = () => undefined
): Promise<void> {
  const work = join(dirname(out), `.proxy-${randomUUID()}`)
  await fs.mkdir(work, { recursive: true })
  try {
    const { width: w, height: h, rate } = plan
    const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
    const encode = ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', rate]
    const list: string[] = []
    for (const [i, p] of plan.picture.entries()) {
      const seg = join(work, `${String(i).padStart(5, '0')}.mp4`)
      const frames = ['-frames:v', String(p.frames)]
      if (!p.path) {
        await run(ffmpeg, ['-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${rate}`, ...frames, ...encode, seg])
      } else if (isImagePath(p.path)) {
        await run(ffmpeg, ['-loop', '1', '-framerate', rate, '-i', p.path, '-vf', `${fit},format=yuv420p`, ...frames, ...encode, seg])
      } else {
        const speed = p.speed === 1 ? '' : `setpts=(PTS-STARTPTS)/${p.speed},`
        // Padded past the file's end with black, so a clip that runs out still fills its frames.
        const vf = `${speed}fps=${rate},${fit},tpad=stop=-1:stop_mode=add:color=black,format=yuv420p`
        await run(ffmpeg, ['-ss', p.inSec.toFixed(6), '-i', p.path, '-vf', vf, ...frames, ...encode, seg])
      }
      list.push(`file '${seg.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      progress(Math.round(((i + 1) / plan.picture.length) * 70))
    }
    const listPath = join(work, 'list.txt')
    await fs.writeFile(listPath, list.join('\n') + '\n')
    const picture = join(work, 'picture.mp4')
    await run(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', picture])

    // The sound: every clip at its moment, mixed at the levels it was recorded at.
    const total = plan.durationSec.toFixed(6)
    const mix = async (inputs: { args: string[]; delaySec: number }[], to: string): Promise<void> => {
      if (inputs.length === 0) {
        await run(ffmpeg, ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', total, '-c:a', 'pcm_s16le', to])
        return
      }
      const chains = inputs.map(
        (x, k) =>
          `[${k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,adelay=delays=${Math.round(x.delaySec * 1000)}:all=1[a${k}]`
      )
      const graph = `${chains.join(';')};${inputs.map((_, k) => `[a${k}]`).join('')}amix=inputs=${inputs.length}:normalize=0:dropout_transition=0:duration=longest,apad=whole_dur=${total},atrim=0:${total}[out]`
      await run(ffmpeg, [...inputs.flatMap((x) => x.args), '-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_s16le', to])
    }
    // Only files with sound in them: a picture-only file on a sound track adds nothing.
    const heard = new Map<string, boolean>()
    for (const s of plan.sound) {
      if (!heard.has(s.path)) heard.set(s.path, (await premiereMedia(ffmpeg, s.path).catch(() => null))?.channels ? true : false)
    }
    const sounds = plan.sound.filter((s) => heard.get(s.path))
    const batches: string[] = []
    for (let i = 0; i < Math.max(1, sounds.length); i += MIX_BATCH) {
      const part = sounds.slice(i, i + MIX_BATCH)
      const to = join(work, `sound-${batches.length}.wav`)
      await mix(
        part.map((s) => ({
          args: ['-ss', s.inSec.toFixed(6), '-t', s.durationSec.toFixed(6), '-i', s.path],
          delaySec: s.startSec
        })),
        to
      )
      batches.push(to)
      progress(70 + Math.round(((i + part.length) / Math.max(1, sounds.length)) * 25))
    }
    let sound = batches[0]
    if (batches.length > 1) {
      sound = join(work, 'sound.wav')
      await mix(
        batches.map((b) => ({ args: ['-i', b], delaySec: 0 })),
        sound
      )
    }
    await fs.mkdir(dirname(out), { recursive: true })
    await run(ffmpeg, [
      '-i', picture, '-i', sound,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-t', total, '-movflags', '+faststart', out
    ])
    progress(100)
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** What was read from the sequence, for the reply. */
export interface PremiereRead {
  name: string
  durationSec: number
  clips: number
  files: number
  /** Files the sequence plays that are not on this computer, by name. */
  missing: string[]
  /** Titles, mattes and nested sequences: drawn in Premiere, not shown here. */
  drawn: number
}

const PRPROJ =
  'Premiere keeps its projects in a format of its own. In Premiere, pick the sequence, then File > Export > Final Cut Pro XML, and drop that here.'

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const exists = (path: string): Promise<boolean> =>
  fs.access(path).then(
    () => true,
    () => false
  )

/**
 * A Premiere sequence into a new edit: its xmeml kept in `cacheRoot`, its
 * proxy made beside it and heard as any footage is (prepareCut), and the
 * edit's first version made to cover every second of it.
 */
export async function importPremiere(
  host: WorkHost,
  req: { path: string; brand?: string | null },
  progress: ProgressFn,
  mediaUrlFor: (path: string) => string,
  cacheRoot: string
): Promise<
  | (Extract<Awaited<ReturnType<typeof prepareCut>>, { ok: true }> & { read: PremiereRead })
  | { ok: false; message: string }
> {
  try {
    if (/\.prproj$/i.test(req.path)) return { ok: false, message: PRPROJ }
    progress('Reading the sequence', 0)
    const text = await fs.readFile(req.path, 'utf8').catch(() => {
      throw new Error(`I can't open ${basename(req.path)}.`)
    })
    const seq = parseXmeml(text)
    if (!seq) {
      return {
        ok: false,
        message: `${basename(req.path)} has no Premiere sequence in it. In Premiere, pick the sequence, then File > Export > Final Cut Pro XML, and drop that here.`
      }
    }
    const files = sequenceFiles(seq)
    const missing = new Set<string>()
    for (const f of files) if (!f.path || !(await exists(f.path))) missing.add(f.path ?? f.name)
    const playable = files.filter((f) => f.path && !missing.has(f.path))
    if (playable.length === 0) {
      return {
        ok: false,
        message:
          files.length === 0
            ? `${seq.name} has nothing in it to play yet.`
            : `I can't find any of the files ${seq.name} plays on this computer, so there is nothing to show. Open it in Premiere and relink them, then export it again.`
      }
    }

    const dir = join(cacheRoot, randomUUID())
    await fs.mkdir(dir, { recursive: true })
    const xmlPath = join(dir, 'sequence.xml')
    await fs.writeFile(xmlPath, text)
    const plan = proxyPlan(seq, missing)
    const proxy = join(dir, `${safeFile(seq.name)}.mp4`)
    await renderProxy(host.ffmpeg(), plan, proxy, (p) => progress('Rendering a copy of your sequence to play here', p))

    const r = await prepareCut(host, { paths: [proxy], brand: req.brand ?? null }, progress, mediaUrlFor)
    if (!r.ok) return r
    const clips = [...seq.video, ...seq.audio].reduce((n, t) => n + t.clips.length, 0)
    const covered = coverWholeTimeline(r.doc)
    const source = covered.sources[0]
    const doc: EditDoc = {
      ...covered,
      title: seq.name,
      premiere: {
        xmlPath,
        originalPath: req.path,
        name: seq.name,
        fps: seq.fps,
        width: seq.width,
        height: seq.height,
        durationSec: source.durationSec,
        clips,
        files: files.length
      }
    }
    const byName = new Map(files.map((f) => [f.path ?? f.name, f.name || basename(f.path ?? '')]))
    return {
      ...r,
      doc,
      read: {
        name: seq.name,
        durationSec: plan.durationSec,
        clips,
        files: files.length,
        missing: [...missing].map((p) => byName.get(p) ?? basename(p)),
        drawn: plan.drawn
      }
    }
  } catch (err) {
    progress('Failed', 0)
    return { ok: false, message: message(err) }
  }
}

/** A name safe for a file on any computer. */
const safeFile = (name: string): string => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'Sequence'

/** What going back to Premiere added, for the reply. */
export interface PremiereReturn {
  xmlPath: string
  srtPath: string | null
  facts: PremiereFacts
  /** The sequence it went back onto, as it is named in Premiere. */
  sequence: string
}

/**
 * The current version back onto its Premiere sequence, written at xmlPath:
 * the sequence as Premiere exported it, renamed "<name> (Cutalong)" with a
 * new uuid so it imports beside the original, with the cutaways, music and
 * sound effects on tracks of their own and markers where they are, and the
 * captions beside it as SRT. Refused, with a sentence, when the version has
 * moved anything in the sequence.
 */
export async function writePremiereReturn(
  doc: EditDoc,
  opts: {
    ffmpeg: string
    sfxDir: string
    xmlPath: string
    readMedia?: (path: string) => Promise<PremiereMedia>
    makeSound?: (kind: SfxKind) => Promise<string>
  }
): Promise<PremiereReturn> {
  const origin = doc.premiere
  if (!origin) throw new Error('This edit was not made from a Premiere sequence.')
  const why = timelineMoves(doc)
  if (why) throw new Error(movedSentence(why))
  const text = await fs.readFile(origin.xmlPath, 'utf8').catch(() => {
    throw new Error('I can’t find the copy of your sequence I kept. Drop its XML in again to start over.')
  })
  const seq = parseXmeml(text)
  if (!seq) throw new Error('The copy of your sequence I kept can’t be read. Drop its XML in again to start over.')
  const name = basename(opts.xmlPath, extname(opts.xmlPath))
  const planned = await premierePlanFor(doc, { ...opts, name, frame: { width: seq.width, height: seq.height } })
  // On the sequence's own clock, frame for frame.
  const plan = { ...planned.plan, fps: seq.fps }
  const add = premiereAdditions(plan, planned.media, { videoTracks: seq.video.length, audioTracks: seq.audio.length })
  const written = addToXmeml(text, seq, {
    ...add,
    name: `${seq.name} (Cutalong)`,
    uuid: seq.uuid ? randomUUID() : undefined
  })
  await fs.mkdir(dirname(opts.xmlPath), { recursive: true })
  await fs.writeFile(opts.xmlPath, written)
  // Captions only when they were asked for: the sequence had none of Cutalong's.
  const srtPath = planned.cut.captions.on
    ? await writeCaptions(planned.cut, planned.resolved, dirname(opts.xmlPath), name)
    : null
  const showsCutaway = new Set(planned.resolved.pieces.filter((_, i) => planned.segments[i].broll).map((p) => p.beat))
  return {
    xmlPath: opts.xmlPath,
    srtPath,
    sequence: seq.name,
    facts: {
      cuts: origin.clips,
      recordings: origin.files,
      cutaways: showsCutaway.size,
      music: plan.music.length > 0,
      sounds: plan.sounds.flat().length,
      markers: plan.markers.length,
      leftOut: plan.leftOut
    }
  }
}

/** The name the sequence goes back to Premiere under, for the file: "Interview (Cutalong) v3". */
export function returnName(doc: EditDoc): string {
  return `${safeFile(doc.premiere?.name ?? doc.title)} (Cutalong) v${currentVersion(doc).n}`
}
