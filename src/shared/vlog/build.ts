import { commit, createDoc, currentCut, currentVersion } from '../edit/doc'
import { applyOps } from '../edit/ops'
import type { AudioMap } from '../audio/map'
import type { Cut, EditDoc, Op, Source, Word } from '../edit/schema'
import type { Music } from '../edit/audio'
import { planTakes, strikeOps } from '../raw/plan'
import { profileById } from '../raw/profiles'
import { baseCut } from './talk'
import type { Clip, StoryBeat, Vlog } from './schema'
import type { WatchedClip } from './watched'

/**
 * A story as an edit: every beat inserted in order into a cut that already
 * strikes the retakes and tightens the talking, so the talking is cut on
 * words the way a talking head is, and every other shot is a stretch of its
 * clip with its own sound.
 */

/** The ops that put a story's beats in place of whatever the cut plays now. */
export function storyOps(beats: StoryBeat[], cut: Cut | null): Op[] {
  const ops: Op[] = []
  if (cut && cut.beats.length > 0) ops.push({ op: 'remove', beats: cut.beats.map((b) => b.id) })
  beats.forEach((b, i) => {
    if (b.from && b.to) ops.push({ op: 'insert', to: i, beat: { source: b.clip, from: b.from, to: b.to } })
    else if (b.inSec !== null && b.outSec !== null)
      ops.push({ op: 'insert', to: i, beat: { source: b.clip, inSec: b.inSec, outSec: b.outSec } })
  })
  return ops
}

/** Wide unless most of the footage was shot upright. */
export function aspectFor(clips: Clip[]): 'wide' | 'vertical' {
  const used = clips.filter((c) => !c.left && c.width > 0 && c.height > 0)
  const upright = used.filter((c) => c.height > c.width).length
  return upright > used.length / 2 ? 'vertical' : 'wide'
}

/** The bed a vlog gets: up front between the talking, and well under it when anyone speaks. */
export function vlogMusic(bed: Pick<Music, 'path'> & Partial<Music>): Op {
  return { op: 'music', set: { ...bed, levelDb: -6, duckDb: 10, fadeInSec: 0.5, fadeOutSec: 2 } }
}

/** A recording for a clip that is not talking: its file, length, shape and colour as watched. */
export function sourceFor(clip: Clip, watched: Pick<WatchedClip, 'fps' | 'color'>): Source {
  return {
    id: clip.id,
    path: clip.path,
    durationSec: clip.durationSec,
    width: clip.width,
    height: clip.height,
    fps: watched.fps > 0 ? watched.fps : 30,
    audio: null,
    ...(watched.color !== 'sdr' ? { color: watched.color } : {})
  }
}

/**
 * The retakes in the talking clips, struck: the last complete take of each
 * line said more than once, and the false starts, as /tighten cuts them.
 * Returns the words struck and the sentence saying so.
 */
export function talkStrikes(
  sources: Source[],
  words: Word[],
  audio: Record<string, AudioMap> | undefined
): { removed: string[]; summary: string } {
  if (words.length === 0) return { removed: [], summary: '' }
  const talking = new Set(words.map((w) => w.source))
  const temp = createDoc({ id: 'takes', title: 'takes', sources: sources.filter((s) => talking.has(s.id)), words })
  const withAudio = audio ? { ...temp, audio } : temp
  const plan = planTakes(withAudio, { thresholds: profileById('vlog')?.takes ?? undefined })
  const strikes = plan.ops.filter((o) => o.op === 'strike')
  const applied = applyOps(currentCut(withAudio), strikes, { words, sources })
  return { removed: applied.cut.removed, summary: applied.cut.removed.length > 0 ? plan.summary : '' }
}

export interface ShootDocInput {
  id: string
  title: string
  sources: Source[]
  words: Word[]
  audio?: Record<string, AudioMap>
  vlog: Vlog
  /** Words struck as retakes. */
  removed: string[]
  aspect: 'wide' | 'vertical'
  music?: Op | null
  at?: string
}

/**
 * The edit a shoot starts as: every usable clip a recording, the talking's
 * words, the retakes struck, the talking tightened, the music under it, and
 * no beats yet. The story goes in with `withStory`.
 */
export function shootDoc(input: ShootDocInput): EditDoc {
  const created = createDoc({
    id: input.id,
    title: input.title,
    sources: input.sources,
    words: input.words,
    at: input.at
  })
  const context = { words: created.words, sources: created.sources }
  const ops: Op[] = [...(input.music ? [input.music] : []), { op: 'fade', outSec: 1.5 }]
  const cut = applyOps(baseCut(input.removed, input.aspect), ops, context).cut
  const first = created.versions[0]
  return {
    ...created,
    ...(input.audio && Object.keys(input.audio).length ? { audio: input.audio } : {}),
    profile: 'vlog',
    vlog: input.vlog,
    versions: [{ ...first, summary: 'The day as a story, cut from your clips.', cut }]
  }
}

/** The vlog with its story kept as the one version `n` tells. */
export function toldIn(vlog: Vlog, n: number): Vlog {
  return { ...vlog, told: [...(vlog.told ?? []).filter((t) => t.n !== n), { n, story: vlog.story }] }
}

/** The doc with its first version playing the story, and the story kept with it. */
export function withStory(doc: EditDoc, vlog: Vlog, summary?: string): EditDoc {
  const first = doc.versions[0]
  const cut = applyOps(first.cut, storyOps(vlog.story.beats, first.cut), {
    words: doc.words,
    sources: doc.sources
  }).cut
  return {
    ...doc,
    vlog: toldIn(vlog, first.n),
    versions: [{ ...first, ...(summary ? { summary } : {}), cut }, ...doc.versions.slice(1)]
  }
}

/**
 * More footage for a vlog under way: its clips join as recordings, its words
 * and sounds with them, its retakes struck, a music bed dropped with them put
 * under it, and the story told again over the whole shoot as one new version.
 */
export function extendShoot(
  doc: EditDoc,
  more: { sources: Source[]; words: Word[]; audio?: Record<string, AudioMap>; removed: string[]; music?: Op | null },
  vlog: Vlog,
  summary: string
): EditDoc {
  const known = new Set(doc.sources.map((s) => s.id))
  const fresh = more.sources.filter((s) => !known.has(s.id))
  const ids = new Set(fresh.map((s) => s.id))
  const added = more.words.filter((w) => ids.has(w.source))
  const all = [...doc.sources, ...fresh]
  const order = new Map(all.map((s, i) => [s.id, i]))
  const grown: EditDoc = {
    ...doc,
    sources: all,
    words: [...doc.words, ...added].sort((a, b) =>
      a.source === b.source ? a.startSec - b.startSec : (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0)
    ),
    ...(more.audio && Object.keys(more.audio).length ? { audio: { ...(doc.audio ?? {}), ...more.audio } } : {}),
    vlog
  }
  const struck = new Set(more.removed)
  const strikes = strikeOps(
    grown,
    added.filter((w) => struck.has(w.id)).map((w) => ({ from: w.id, to: w.id })),
    currentCut(grown)
  )
  const context = { words: grown.words, sources: grown.sources }
  const before = [...(more.music ? [more.music] : []), ...strikes]
  const cut = applyOps(currentCut(grown), before, context).cut
  const ops = [...before, ...storyOps(vlog.story.beats, cut)]
  const next = commit(grown, ops, summary, { preset: 'vlog' }).doc
  return { ...next, vlog: toldIn(vlog, currentVersion(next).n) }
}

/**
 * A vlog made from the edit as it was sent (`sent`) put onto the edit as it
 * is now (`latest`): versions made while the clips were watched stay, and
 * the new clips, their words and the story go on as the newest version.
 */
export function ontoLatest(latest: EditDoc, sent: EditDoc, made: EditDoc): EditDoc {
  if (latest === sent || !made.vlog) return made
  const known = new Set(latest.sources.map((s) => s.id))
  const fresh = (id: string): boolean => !known.has(id)
  const grown: EditDoc = {
    ...latest,
    sources: [...latest.sources, ...made.sources.filter((s) => fresh(s.id))],
    words: [...latest.words, ...made.words.filter((w) => fresh(w.source))],
    audio: {
      ...(latest.audio ?? {}),
      ...Object.fromEntries(Object.entries(made.audio ?? {}).filter(([id]) => fresh(id)))
    },
    profile: made.profile,
    vlog: made.vlog
  }
  const last = currentVersion(made)
  // The music and the strikes it made, then the story in place of whatever the cut plays now.
  const before = last.ops.filter((o) => o.op !== 'remove' && o.op !== 'insert')
  const cut = applyOps(currentCut(grown), before, { words: grown.words, sources: grown.sources }).cut
  const ops = [...before, ...storyOps(made.vlog.story.beats, cut)]
  const next = commit(grown, ops, last.summary, { preset: 'vlog' }).doc
  return { ...next, vlog: toldIn(made.vlog, currentVersion(next).n) }
}
