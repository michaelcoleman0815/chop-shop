import { app, ipcMain, type WebContents } from 'electron'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import { readApiKey } from './apikey'
import { OLLAMA_HOST } from './clips'
import { FFMPEG_PATH, FFPROBE_PATH } from './ffmpeg'
import { isLocalUp } from './local-llm'
import { analyzeTrack } from './music'
import { getSettings } from './store'
import { detectFaces } from './track'
import { claudeParse, describeWithClaude, describeWithOllama, visionModel, type Described } from './vlog-describe'
import { claudeStoryCall, renamed, storyLocally, storyWithClaude, type ModelStory } from './vlog-story'
import { cacheKey, stripOf, watchClip, type WatchTools } from './vlog-watch'
import {
  currentCut,
  currentVersion,
  EditDocSchema,
  nextSourceId,
  resolveCut,
  type EditDoc,
  type Op,
  type Source,
  type Word
} from '../shared/edit'
import type { AudioMap } from '../shared/audio/map'
import { aspectFor, extendShoot, shootDoc, talkStrikes, vlogMusic, withStory } from '../shared/vlog/build'
import { emptyStory, finishShoot, mergeTalk, type HeardClip } from '../shared/vlog/compose'
import { carryAsked, carryTold, opsFor, planLocally, reshapeOp, vlogShown, withOps } from '../shared/vlog/plan'
import { leftOutSentence, scenesChanged, shapeSentence, storyReply, type VlogReply } from '../shared/vlog/reply'
import { parseVlogAsk, type VlogAsk } from '../shared/vlog/request'
import type { Moment, Story, Vlog } from '../shared/vlog/schema'
import { assembleShoot, type ShootPart } from '../shared/vlog/shoot'
import type { WatchedClip } from '../shared/vlog/watched'

/**
 * A vlog from a shoot, in the main process: every clip watched and cached,
 * the talking heard word by word the way the talking-head flow hears it, the
 * moments described (by Claude when the person lets it see frames, by a model
 * on this Mac, or by the measurements), and the story told (by Claude, by the
 * model picked to plan edits, or by the rules). The decisions live in
 * shared/vlog; this is the running order and the I/O.
 */

type Send = (sender: WebContents, channel: string, payload: unknown) => void
type ProgressFn = (stage: string, percent: number | null) => void

export interface TalkHeard {
  source: Source
  words: Word[]
  map?: AudioMap
  notes: string[]
}

export interface VlogDeps {
  send: Send
  mediaUrlFor: (path: string) => string
  /**
   * Hears one talking clip word by word, as the talking-head flow does
   * (cutalong.ts readFootage): transcribed, the words snapped to the sound,
   * its sound mapped, the mouth watched. `n` makes its source id s{n}.
   */
  readTalking: (path: string, n: number, progress: (stage: string, percent: number) => void) => Promise<TalkHeard>
}

export type VlogResult = { ok: true; doc: EditDoc; mediaUrl: string; reply: VlogReply } | { ok: false; message: string }

export type PlanResult =
  | { ok: true; ops: Op[]; vlog: Vlog; reply: VlogReply; by: Story['by'] }
  | { ok: false; message: string }

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Where a shoot's measurements, stills and lines are kept. */
const cacheDir = (): string => join(app.getPath('userData'), 'vlog')

/** Clips watched at once: each is a decode, so a few, not dozens. */
const AT_ONCE = 3

export function registerVlogIpc(deps: VlogDeps): void {
  ipcMain.handle('vlog:make', (e, req: { paths: string[]; request: string; doc?: unknown }) =>
    makeVlog(req, deps, (stage, percent) => deps.send(e.sender, 'cut:progress', { stage, percent }))
  )
  ipcMain.handle('vlog:plan', (_e, req: { doc: unknown; request: string }) => planVlog(req))
}

/** Whether Claude may see frames from the footage: a key, and the switch in Settings on (it is unless turned off). */
function claudeSees(): string | null {
  const key = readApiKey()
  return key && getSettings().claudeSeesFrames !== false ? key : null
}

async function watchAll(
  paths: string[],
  tools: WatchTools,
  progress: ProgressFn
): Promise<{ watched: WatchedClip[]; failed: string[] }> {
  const out: WatchedClip[] = new Array(paths.length)
  let done = 0
  const queue = paths.map((p, i) => ({ p, i }))
  const failed: string[] = []
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        out[job.i] = await watchClip(job.p, tools)
      } catch (err) {
        console.warn('[vlog] could not watch', job.p, message(err))
        failed.push(job.p)
      }
      done++
      progress(`Watching your clips (${done} of ${paths.length})`, Math.round((done / paths.length) * 55))
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, paths.length) }, worker))
  return { watched: out.filter(Boolean), failed }
}

/** "I couldn't open IMG_0042.MOV, so it is not in the story." */
function failedSentence(paths: string[]): string {
  if (paths.length === 0) return ''
  const names = paths.map((p) => basename(p))
  return paths.length === 1
    ? `I couldn't open ${names[0]}, so it is not in the story.`
    : `I couldn't open ${paths.length} of the files (${names.slice(0, 3).join(', ')}${paths.length > 3 ? ' and others' : ''}), so they are not in the story.`
}

/**
 * Audio files dropped with the shoot: the first that is music is the bed;
 * someone talking, or another track, is said and left out.
 */
async function bedFrom(watched: WatchedClip[]): Promise<{ op: Op | null; notes: string[] }> {
  const notes: string[] = []
  let op: Op | null = null
  let chosen = ''
  for (const w of watched.filter((x) => !x.hasVideo && x.hasAudio)) {
    const talky = (w.heard?.speechSec ?? 0) > 0.3 * w.durationSec
    if (talky || w.durationSec < 15) {
      notes.push(`${w.name} is a sound recording, not music, so I left it out: each clip keeps its own sound.`)
      continue
    }
    if (op) {
      notes.push(`${w.name} is music too, and ${chosen} is the one under it.`)
      continue
    }
    try {
      const f = await analyzeTrack(FFMPEG_PATH, w.path)
      op = vlogMusic({
        path: w.path,
        durationSec: f.durationSec,
        ...(f.lufs !== null ? { lufs: f.lufs } : {}),
        ...(f.bpm !== null ? { bpm: f.bpm } : {}),
        beats: f.beats
      })
      chosen = w.name
    } catch (err) {
      notes.push(`I couldn't read ${w.name} as music. ${message(err)}`)
    }
  }
  return { op, notes }
}

/** Lines already said about a clip's moments, by whoever said them, kept beside its measurements. */
async function readLines(path: string): Promise<Record<string, Record<string, string>>> {
  try {
    return JSON.parse(await fs.readFile(join(cacheDir(), `${await cacheKey(path)}.lines.json`), 'utf8'))
  } catch {
    return {}
  }
}

async function writeLines(path: string, lines: Record<string, Record<string, string>>): Promise<void> {
  try {
    await fs.mkdir(cacheDir(), { recursive: true })
    await fs.writeFile(join(cacheDir(), `${await cacheKey(path)}.lines.json`), JSON.stringify(lines))
  } catch {
    // A cache that cannot be written must not fail the vlog.
  }
}

const spanKey = (m: Moment): string => `${m.inSec.toFixed(1)}-${m.outSec.toFixed(1)}`

/**
 * Lines for the moments worth describing: from the cache first, then from
 * whoever may look (Claude, a model on this Mac), and none at all when
 * nobody may: the measurements then speak for them.
 */
async function describe(
  shoot: ShootPart,
  heardClips: Set<string>,
  watched: Map<string, WatchedClip>,
  progress: ProgressFn
): Promise<Described & { by: Vlog['described']['by']; model: string | null }> {
  const clipOf = new Map(shoot.clips.map((c) => [c.id, c]))
  const worth = shoot.moments.filter((m) => !clipOf.get(m.clip)?.left && !(m.kind === 'talk' && heardClips.has(m.clip)))
  const key = claudeSees()
  const local = key ? null : (await isLocalUp(OLLAMA_HOST)) ? await visionModel(OLLAMA_HOST) : null
  const who = key ? 'claude' : local ? `ollama:${local}` : null
  const empty = { lines: new Map<string, string>(), kinds: new Map(), stills: 0, note: null }
  if (!who) return { ...empty, by: 'measurements', model: null }

  // What was said before about these clips, by the same describer.
  const cached = new Map<string, Record<string, Record<string, string>>>()
  const lines = new Map<string, string>()
  for (const m of worth) {
    const path = clipOf.get(m.clip)?.path as string
    if (!cached.has(path)) cached.set(path, await readLines(path))
    const line = cached.get(path)?.[who]?.[spanKey(m)]
    if (line) lines.set(m.id, line)
  }
  const todo = worth.filter((m) => !lines.has(m.id))
  const strips = async (m: Moment): Promise<string | null> => {
    const clip = clipOf.get(m.clip)
    if (!clip) return null
    const w = watched.get(clip.path)
    const span = m.outSec - m.inSec
    const times = [m.inSec + span * 0.15, m.peakSec, m.inSec + span * 0.85].map((t) =>
      Math.min(clip.durationSec - 0.05, Math.max(0, t))
    )
    const dir = join(cacheDir(), await cacheKey(clip.path))
    return stripOf(FFMPEG_PATH, clip.path, times, join(dir, `strip-${spanKey(m)}.jpg`), { color: w?.color })
  }
  const say = (done: number, total: number): void =>
    progress(`Looking at your moments (${done} of ${total})`, 75 + Math.round((done / Math.max(1, total)) * 20))
  let got: Described = { ...empty }
  if (todo.length > 0) {
    say(0, todo.length)
    got = key
      ? await describeWithClaude(todo, shoot, strips, claudeParse(key), say)
      : await describeWithOllama(todo, shoot, strips, { host: OLLAMA_HOST, model: local as string }, say)
    // Kept by file, so the same moments are never sent twice.
    for (const [id, line] of got.lines) {
      const m = todo.find((x) => x.id === id) as Moment
      const path = clipOf.get(m.clip)?.path as string
      const all = cached.get(path) ?? {}
      all[who] = { ...(all[who] ?? {}), [spanKey(m)]: line }
      cached.set(path, all)
    }
    for (const path of new Set(todo.map((m) => clipOf.get(m.clip)?.path as string)))
      await writeLines(path, cached.get(path) ?? {})
  }
  for (const [id, line] of got.lines) lines.set(id, line)
  return {
    lines,
    kinds: got.kinds,
    stills: got.stills,
    note: got.note,
    by: key ? 'claude' : 'local',
    model: key ? null : local
  }
}

/** The story by a model when one may tell it, else null and the rules tell it. */
/**
 * The story by a model when one may tell it, else null and the rules tell it.
 * When a model was asked and could not, `note` says so, so the person knows
 * whose story they are looking at.
 */
async function storyByModel(
  doc: EditDoc,
  vlog: Vlog,
  request: string,
  ask: VlogAsk | null
): Promise<{ made: ModelStory | null; note: string | null }> {
  const local = getSettings().localPlanner
  const who = local ? local : 'Claude'
  const failed = `${who} could not tell the story this time, so I told it by its rules.`
  try {
    if (local) {
      if (!(await isLocalUp(OLLAMA_HOST)))
        return { made: null, note: `${local} is not running on this Mac, so I told the story by its rules.` }
      const made = await storyLocally(doc, vlog, request, ask, { host: OLLAMA_HOST, model: local })
      return { made, note: made ? null : failed }
    }
    const key = readApiKey()
    if (!key) return { made: null, note: null }
    const made = await storyWithClaude(doc, vlog, request, ask, claudeStoryCall(key))
    return { made, note: made ? null : failed }
  } catch (err) {
    console.warn('[vlog] the story pass failed; the rules tell it:', message(err))
    return { made: null, note: failed }
  }
}

/** "I couldn't tell which part of the day “the airport” is." */
function unmatchedSentence(words: string[]): string {
  if (words.length === 0) return ''
  const named = words.map((w) => `“${w}”`).join(' or ')
  return `I couldn't tell which part of the day ${named} is. Name it by its number or time from Details, like “start with scene 3”.`
}

export async function makeVlog(
  req: { paths: string[]; request: string; doc?: unknown },
  deps: Pick<VlogDeps, 'readTalking' | 'mediaUrlFor'>,
  progress: ProgressFn
): Promise<VlogResult> {
  try {
    const parsed = req.doc ? EditDocSchema.safeParse(req.doc) : null
    if (parsed && !parsed.success) return { ok: false, message: 'The edit could not be read.' }
    const before = parsed?.success ? parsed.data : null
    const ask = parseVlogAsk(req.request)
    // The shoot so far: a vlog's own clips, or an edit's recordings and footage brought in.
    const earlier = before?.vlog
      ? before.vlog.clips.map((c) => c.path)
      : before
        ? [...before.sources.map((s) => s.path), ...before.assets.filter((a) => a.kind === 'video').map((a) => a.path)]
        : []
    const paths = [...new Set([...earlier, ...req.paths])]
    if (paths.length === 0) return { ok: false, message: 'There is no footage to cut.' }

    progress(`Watching your clips (0 of ${paths.length})`, 0)
    const tools: WatchTools = {
      ffmpeg: FFMPEG_PATH,
      ffprobe: FFPROBE_PATH,
      cacheDir: cacheDir(),
      faces: (p, s, d, r) => detectFaces(p, s, d, r)
    }
    const { watched, failed } = await watchAll(paths, tools, progress)
    const dropped = new Set(req.paths)
    const hasBed = !!before && !!currentCut(before).music
    const bed = hasBed
      ? {
          op: null,
          notes: watched
            .filter((w) => !w.hasVideo && w.hasAudio && dropped.has(w.path))
            .map((w) => `It has music under it already, so ${w.name} is not in it. /music changes the track.`)
        }
      : await bedFrom(watched)
    const pictures = watched.filter((w) => w.hasVideo && w.series)
    if (pictures.length === 0) return { ok: false, message: 'None of those has a picture I could read.' }
    // The story so far as the version on screen tells it, for what was asked of it to carry over.
    const shown = before ? vlogShown(before) : null

    // Ids a doc already gave its recordings stay theirs.
    const ids = new Map<string, string>()
    for (const c of before?.vlog?.clips ?? []) ids.set(c.path, c.id)
    for (const s of before?.sources ?? []) if (!ids.has(s.path)) ids.set(s.path, s.id)
    const nextSource = before ? Number(nextSourceId(before).slice(1)) : 1
    const shoot = assembleShoot(pictures, { ids, nextSource })

    // The talking, heard word by word; words an edit already has are kept.
    const heard = new Map<string, HeardClip>()
    const notes: string[] = [failedSentence(failed), ...bed.notes].filter(Boolean)
    for (const s of before?.sources ?? []) {
      const own = before?.words.filter((w) => w.source === s.id) ?? []
      if (own.length) heard.set(s.id, { source: s, words: own, map: before?.audio?.[s.id] })
    }
    const toHear = shoot.clips.filter((c) => c.talking && !c.left && !heard.has(c.id))
    for (const [k, clip] of toHear.entries()) {
      const at = (stage: string, pct: number): void =>
        progress(
          `Listening to what you said (${k + 1} of ${toHear.length})`,
          55 + Math.round(((k + pct / 100) / toHear.length) * 20)
        )
      at('', 0)
      try {
        const got = await deps.readTalking(clip.path, Number(clip.id.slice(1)), at)
        // No words: the reader's own note is about a talking-head beat; here the clip plays as a shot,
        // and is listened to again when more clips come.
        if (got.words.length === 0) notes.push(`I couldn't hear the words in ${clip.name}, so it plays as a shot.`)
        else {
          heard.set(clip.id, { source: { ...got.source, id: clip.id }, words: got.words, map: got.map })
          notes.push(...got.notes)
        }
      } catch (err) {
        console.warn('[vlog] could not hear', clip.path, message(err))
        notes.push(`I couldn't hear the words in ${clip.name}, so it plays as a shot.`)
      }
    }
    const byPath = new Map(watched.map((w) => [w.path, w]))
    const merged = mergeTalk(shoot, heard, byPath)

    progress('Looking at your moments', 75)
    const seen = await describe({ ...shoot, clips: merged.clips }, new Set(heard.keys()), byPath, progress)
    if (seen.note) notes.push(seen.note)
    const record = finishShoot(shoot, merged.clips, merged.words, {
      by: seen.by,
      model: seen.model,
      stills: seen.stills,
      lines: seen.lines
    })
    const strikes = talkStrikes(merged.sources, merged.words, merged.audio)
    progress('Putting the story together', 96)

    const story0: Story = { ...emptyStory(), ...carryAsked(shown, record) }
    if (shown?.story.lengthAsked) Object.assign(story0, { targetSec: shown.story.targetSec, lengthAsked: true })
    // The stories earlier versions told stay theirs, found again in the shoot as it is now.
    const planning: Vlog = {
      ...record,
      story: story0,
      ...(before?.vlog ? { told: carryTold(before.vlog, record) } : {})
    }
    const fresh = before
      ? null
      : shootDoc({
          id: randomUUID(),
          title: titleFor(req.paths, watched),
          sources: merged.sources,
          words: merged.words,
          audio: merged.audio,
          vlog: planning,
          removed: strikes.removed,
          aspect: ask?.aspect ?? aspectFor(merged.clips),
          music: bed.op
        })
    const known = new Set(before?.sources.map((s) => s.id) ?? [])
    const more = {
      sources: merged.sources.filter((s) => !known.has(s.id)),
      words: merged.words.filter((w) => !known.has(w.source)),
      audio: Object.fromEntries(Object.entries(merged.audio).filter(([id]) => !known.has(id))),
      removed: strikes.removed,
      music: bed.op
    }
    const base = fresh ?? extendShoot(before as EditDoc, more, planning, 'The story, told again.')

    const { made, note: storyNote } = await storyByModel(base, planning, req.request, ask)
    if (storyNote) notes.push(storyNote)
    const planned = made ? null : planLocally(base, planning, ask)
    const story = made?.story ?? (planned as NonNullable<typeof planned>).story
    const vlog: Vlog = { ...planning, scenes: made ? renamed(planning.scenes, made.names) : planning.scenes, story }
    if (planned?.unmatched.length) notes.push(unmatchedSentence(planned.unmatched))

    // The files just dropped that have a picture, and those of them left out, for the reply.
    const earlierSet = new Set(earlier)
    const added = pictures.filter((w) => !earlierSet.has(w.path)).length
    const leftNew = record.clips.filter((c) => c.left && !earlierSet.has(c.path))
    if (before?.vlog && leftNew.length) notes.push(leftOutSentence(leftNew))
    const doc = fresh
      ? withStory(fresh, vlog)
      : extendShoot(
          before as EditDoc,
          more,
          vlog,
          added === 1 ? 'One more clip is in the story.' : `${added} more clips are in the story.`
        )
    const version = currentVersion(doc).n
    const previousSec = before ? resolveCut(currentCut(before), before.words, before.sources).durationSec : null
    const reply = storyReply(doc, vlog, {
      version,
      previousSec,
      first: !before?.vlog,
      added: before?.vlog ? added : undefined,
      notes: [
        ...(before?.vlog ? [] : (record.clockNotes ?? [])),
        // Only the retakes struck now: an edit's own words were struck, or not, before.
        before ? talkStrikes(more.sources, more.words, more.audio).summary : strikes.summary,
        ...notes
      ].filter(Boolean)
    })
    const text = made?.reply ? `${reply.lead} ${made.reply}` : reply.text
    const summary = made?.summary || reply.summary
    const final = {
      ...doc,
      profile: 'vlog',
      versions: [...doc.versions.slice(0, -1), { ...doc.versions[doc.versions.length - 1], summary }]
    }
    progress('Ready', 100)
    return {
      ok: true,
      doc: final,
      mediaUrl: deps.mediaUrlFor(final.sources[0]?.path ?? paths[0]),
      reply: { ...reply, text, summary }
    }
  } catch (err) {
    console.error('[vlog] failed:', message(err))
    return { ok: false, message: message(err) }
  }
}

/** A vlog's title: what its files have in common, else the day it was shot. */
function titleFor(paths: string[], watched: WatchedClip[]): string {
  const first = watched
    .map((w) => w.recordedAt)
    .filter((t): t is string => !!t)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0]
  if (first) {
    const d = new Date(first)
    return `Vlog ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
  }
  return paths.length === 1 ? basename(paths[0], extname(paths[0])) : 'Vlog'
}

/** The story told again for what was asked, as ops for a new version. */
export async function planVlog(req: { doc: unknown; request: string }): Promise<PlanResult> {
  const parsed = EditDocSchema.safeParse(req.doc)
  if (!parsed.success) return { ok: false, message: 'The edit could not be read.' }
  const doc = parsed.data
  const shown = vlogShown(doc)
  if (!shown) return { ok: false, message: 'This edit was not cut from a shoot, so it has no story to change.' }
  try {
    const ask = parseVlogAsk(req.request)
    const { made, note: storyNote } = await storyByModel(doc, shown, req.request, ask)
    const planned = made ? null : planLocally(doc, shown, ask)
    const story = made?.story ?? (planned as NonNullable<typeof planned>).story
    const vlog: Vlog = { ...shown, scenes: made ? renamed(shown.scenes, made.names) : shown.scenes, story }
    const reshape = reshapeOp(doc, ask)
    const ops: Op[] = [...opsFor(doc, story.beats), ...(reshape ? [reshape] : [])]
    const preview = withOps({ ...doc, vlog }, ops)
    const now = resolveCut(currentCut(doc), doc.words, doc.sources).durationSec
    const notes = [storyNote ?? '', planned?.unmatched.length ? unmatchedSentence(planned.unmatched) : ''].filter(
      Boolean
    )
    const reply = storyReply(preview, vlog, { version: currentVersion(doc).n + 1, previousSec: now, notes })
    // Asked for more or less of a part of the day, the reply says what that part runs now.
    const changed =
      ask && ask.more.length + ask.less.length + ask.drop.length > 0
        ? scenesChanged(doc, shown.story.beats, preview, vlog)
        : ''
    // A new shape is said first: "v4 is ready. It is vertical now, 9:16. It opens on ..."
    const lead = [reshape ? `${reply.lead} ${shapeSentence(reshape.aspect)}` : reply.lead, changed]
      .filter(Boolean)
      .join(' ')
    const told = made?.reply || reply.story
    const summary = [reshape ? shapeSentence(reshape.aspect) : '', made?.summary || reply.summary]
      .filter(Boolean)
      .join(' ')
    return {
      ok: true,
      ops,
      vlog,
      by: story.by,
      reply: { ...reply, lead, story: told, text: told ? `${lead} ${told}` : lead, summary }
    }
  } catch (err) {
    return { ok: false, message: message(err) }
  }
}
