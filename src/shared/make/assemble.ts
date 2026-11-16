import { applyOps } from '../edit/ops'
import { resolveCut } from '../edit/resolve'
import { wordsFromTranscript } from '../edit/doc'
import { NAMED_LOOKS, type Look } from '../edit/look'
import type { Camera } from '../edit/camera'
import type { Music } from '../edit/audio'
import {
  DEFAULT_CAPTIONS,
  DEFAULT_LOUDNESS,
  DEFAULT_TREATMENT,
  type Asset,
  type Beat,
  type Cut,
  type EditDoc,
  type Source,
  type Treatment,
  type Word
} from '../edit/schema'
import type { MotionCallInput } from '../motion/schema'
import { MAP_PUSH } from './map'
import { phraseRanges } from './script'
import type { Make, MakeFormat, MakeLook, MadeShot, StillMove } from './schema'

/**
 * A made video as an ordinary edit: the narration is the one recording, its
 * words are the edit's words and its phrases are the beats, and every beat
 * shows its shot as a full-frame cutaway, stills moving under the camera.
 * Titles and callouts are graphics on the beats; the look, the dissolves at
 * each section, the fades and the music are the same ops the chat uses, so
 * everything Cutalong does to an edit works on this one, and Undo, notes and
 * versions work from the first version on.
 */

/** The frame rate a made video is cut at: film's for a documentary, video's for an explainer. */
export const MAKE_FPS: Record<MakeFormat, number> = { documentary: 24, explainer: 30 }

/** The look each choice wears, from the named looks (edit/look.ts). */
export function lookFor(look: MakeLook): Look {
  switch (look) {
    case 'archival':
      return NAMED_LOOKS.archival.look
    case 'sepia':
      return { ...NAMED_LOOKS.archival.look, sepia: 0.9, saturation: -0.35 }
    case 'black-and-white':
      return NAMED_LOOKS.newsreel.look
    case 'color-film':
      return NAMED_LOOKS.kodachrome.look
    case 'clean':
      return NAMED_LOOKS.cinematic.look
    case 'bright':
      return NAMED_LOOKS.explainer.look
  }
}

/** How each still move is played: gentle, as a documentary editor keys them, and varied in where they aim. */
export function cameraFor(move: StillMove, i: number): Camera {
  const aims = [
    { x: 0.46, y: 0.44 },
    { x: 0.55, y: 0.48 },
    { x: 0.5, y: 0.4 },
    { x: 0.44, y: 0.52 }
  ]
  const to = aims[i % aims.length]
  switch (move) {
    case 'push-in':
      return { kind: 'push-in', zoom: 1.12, to }
    case 'pull-out':
      return { kind: 'pull-out', zoom: 1.12, from: to }
    case 'drift':
      return { kind: 'drift', zoom: 1.07, to }
    case 'ken-burns':
      return { kind: 'ken-burns', zoom: 1.18 }
    default:
      return { kind: move, zoom: 1.15 }
  }
}

export interface MadeFile {
  width: number
  height: number
  /** Seconds, for a clip; null for a still. */
  durationSec: number | null
}

export interface AssembleInput {
  id: string
  make: Make
  /** The narration's words with their times, as the voice timed them or as they were heard. */
  words: { text: string; startSec: number; endSec: number }[]
  /** The plain ground graphics and cards sit on, made on this Mac. */
  ground: string
  /** Sizes and lengths of the files the shots made. */
  files?: Map<string, MadeFile>
  /** Map shots that came back as graphics (shared/make/map.ts), by phrase. */
  mapGraphics?: Map<number, Omit<MotionCallInput, 'from'>>
  music?: Music | null
  at?: string
  /** The narration's recording id: s1 for a first narration, the next free id when it is read again. */
  sourceId?: string
  /** The narration's words as the edit already has them, when the narration is kept: the same ids. */
  docWords?: Word[]
}

export interface Assembled {
  doc: EditDoc
  /** The phrases no words were heard for, so no beat shows them. */
  unheard: number[]
  /** Ops that did not apply, for whoever reads the log; empty when all is well. */
  rejected: string[]
}

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** An asset for each made file, so the planner and the beat strip know what each picture is. */
function assetsFor(make: Make, files: Map<string, MadeFile>): Asset[] {
  const seen = new Set<string>()
  const assets: Asset[] = []
  for (const s of make.shots) {
    if (!s.file || seen.has(s.file)) continue
    seen.add(s.file)
    const f = files.get(s.file)
    const v = s.visual
    const title =
      v.kind === 'still' || v.kind === 'clip'
        ? short(v.prompt, 70)
        : v.kind === 'map'
          ? `Map of ${v.place}`
          : v.kind === 'card'
            ? `Title card: ${v.big}`
            : v.kind === 'broll'
              ? short(v.search, 70)
              : `Ground for a ${v.graphic}`
    assets.push({
      id: `a${assets.length + 1}`,
      kind: v.kind === 'clip' || v.kind === 'broll' ? 'video' : 'image',
      path: s.file,
      title,
      durationSec: f?.durationSec ?? null,
      width: f?.width ?? null,
      height: f?.height ?? null,
      origin: {
        type: 'file',
        url: null,
        author: s.maker === 'google' ? 'Google' : s.maker === 'fal' ? 'fal.ai' : s.maker === 'broll' ? null : 'Cutalong',
        license: s.model ? `Made with ${s.model}` : null,
        range: null
      }
    })
  }
  return assets
}

/** The treatment a shot gives its beat: its file full frame, a still moving under the camera. */
function treatmentFor(shot: MadeShot, i: number, ground: string): Partial<Treatment> {
  const v = shot.visual
  const path = shot.file ?? ground
  if (v.kind === 'still') return { frame: 'broll', broll: { path, inSec: 0, muted: true, camera: cameraFor(v.move, i) } }
  if (v.kind === 'map' && shot.file) return { frame: 'broll', broll: { path, inSec: 0, muted: true, camera: MAP_PUSH } }
  if (v.kind === 'clip' || v.kind === 'broll') return { frame: 'broll', broll: { path, inSec: 0, muted: true } }
  // Cards and graphics sit on the plain ground, drifting just enough to stay alive.
  return { frame: 'broll', broll: { path, inSec: 0, muted: true, camera: { kind: 'drift', zoom: 1.04 } } }
}

/** The graphic a graphic shot shows over its beat. */
function graphicCall(shot: MadeShot, beat: string): MotionCallInput | null {
  const v = shot.visual
  if (v.kind !== 'graphic') return null
  return {
    kind: v.graphic,
    from: beat,
    to: `${beat}.end`,
    text: v.text,
    values: v.values,
    items: v.items.map((it) => ({ label: it.label, value: it.value }))
  }
}

/** Builds the edit for a made video. */
export function assembleDoc(input: AssembleInput): Assembled {
  const { make } = input
  const brief = make.brief
  const at = input.at ?? new Date().toISOString()
  const files = input.files ?? new Map<string, MadeFile>()
  const sid = input.sourceId ?? 's1'
  const source: Source = {
    id: sid,
    path: make.narration.path,
    durationSec: make.narration.durationSec,
    width: 0,
    height: 0,
    fps: MAKE_FPS[brief.format]
  }
  const words = input.docWords ?? wordsFromTranscript(input.words, sid, sid === 's1' ? 'w' : `${sid}w`)
  const ranges = phraseRanges(
    make.phrases,
    words.map((w) => w.text)
  )
  const beats: Beat[] = []
  const unheard: number[] = []
  const beatOfPhrase = new Map<number, string>()
  make.phrases.forEach((_, i) => {
    const [a, b] = ranges[i] ?? [0, -1]
    if (b < a || !words[a] || !words[b]) {
      unheard.push(i)
      return
    }
    const id = `b${beats.length + 1}`
    beatOfPhrase.set(i, id)
    const shot = make.shots.find((s) => s.phrase === i)
    beats.push({
      id,
      source: sid,
      from: words[a].id,
      to: words[b].id,
      inSec: null,
      outSec: null,
      // Room to the next phrase is kept, up to a second: the narration's own pauses are the film's breaths.
      padIn: 0.08,
      padOut: 1,
      treatment: { ...DEFAULT_TREATMENT, ...(shot ? treatmentFor(shot, i, input.ground) : {}) } as Treatment
    })
  })
  if (beats.length === 0) throw new Error('No words were heard in the narration, so there is nothing to cut to.')
  const base: Cut = {
    beats,
    removed: [],
    tighten: null,
    captions: { ...DEFAULT_CAPTIONS, on: false },
    aspect: brief.aspect,
    loudness: DEFAULT_LOUDNESS,
    motion: []
  }

  // Unknown until applyOps reads them against the op schema, which fills each graphic's defaults.
  const ops: unknown[] = []
  // The look over everything, the archival film or the explainer's clean colour.
  ops.push({ op: 'look', set: lookFor(brief.look), replace: true })
  // Dissolves where each section begins; hard cuts inside a section.
  const sectionBeats = make.sections
    .filter((p) => p > 0)
    .map((p) => beatOfPhrase.get(p))
    .filter((b): b is string => !!b && b !== beats[0].id)
  if (sectionBeats.length)
    ops.push({
      op: 'transition',
      beats: [...new Set(sectionBeats)],
      kind: 'dissolve',
      sec: brief.format === 'documentary' ? 0.8 : 0.4
    })
  ops.push({ op: 'fade', inSec: 1, outSec: 1.5, color: 'black' })

  // Titles, cards, graphics and labels as graphics on their beats.
  make.shots.forEach((shot) => {
    const beat = beatOfPhrase.get(shot.phrase)
    if (!beat) return
    const v = shot.visual
    if (v.kind === 'card') {
      ops.push({ op: 'motion-add', kind: 'title', style: 'engraved', from: beat, to: `${beat}.end`, text: v.small ? [v.small, v.big] : [v.big] })
    } else if (shot.title) {
      const lines = shot.title.small ? [shot.title.small, shot.title.big] : [shot.title.big]
      ops.push({ op: 'motion-add', kind: 'title', style: 'engraved', from: beat, to: '4s', text: lines })
    }
    const graphic = graphicCall(shot, beat)
    if (graphic) ops.push({ op: 'motion-add', ...graphic })
    const mapGraphic = v.kind === 'map' ? input.mapGraphics?.get(shot.phrase) : undefined
    if (mapGraphic) ops.push({ op: 'motion-add', ...mapGraphic, from: beat })
    shot.callouts.forEach((c, k) =>
      ops.push({
        op: 'motion-add',
        kind: 'callout',
        style: 'label',
        from: `${beat}+${(0.3 + k * 0.6).toFixed(1)}`,
        to: `${beat}.end`,
        text: c.value ? [c.label, c.value] : [c.label],
        box: [c.x, c.y]
      })
    )
  })
  // An explainer's labels land with a pop.
  if (brief.format === 'explainer') {
    const popped = make.shots.filter((s) => s.callouts.length > 0).map((s) => beatOfPhrase.get(s.phrase))
    const ids = popped.filter((b): b is string => !!b)
    if (ids.length) ops.push({ op: 'sfx', beats: ids, add: { kind: 'pop', gainDb: -4 } })
  }
  if (input.music) ops.push({ op: 'music', set: input.music })
  // YouTube chapters from the outline, when there are enough sections for them.
  const chapters = make.sections
    .map((p, k) => ({ beat: beatOfPhrase.get(p), title: make.outline[k] ?? '' }))
    .filter((c): c is { beat: string; title: string } => !!c.beat && !!c.title.trim())
  if (chapters.length >= 3) ops.push({ op: 'chapters', set: chapters.map((c) => ({ beat: c.beat, title: c.title.slice(0, 100) })) })

  const assets = assetsFor(make, files)
  const ctx = { words, sources: [source], assets }
  const first = applyOps(base, ops, ctx)
  // A clip shorter than its beat slows to fill it, down to half speed, rather than freezing on its last frame.
  const resolved = resolveCut(first.cut, words, [source])
  const slow: unknown[] = []
  for (const rb of resolved.beats) {
    const beat = first.cut.beats.find((b) => b.id === rb.id)
    const shot = make.shots.find((s) => beatOfPhrase.get(s.phrase) === rb.id)
    if (!beat?.treatment.broll || !shot?.file || shot.visual.kind !== 'clip') continue
    const length = files.get(shot.file)?.durationSec
    const shows = rb.outEnd - rb.outStart
    if (!length || length >= shows) continue
    const speed = Math.max(0.5, Math.min(1, Math.floor((length / shows) * 100) / 100))
    if (speed < 0.995) slow.push({ op: 'speed', beats: [rb.id], speed, of: 'cutaway' })
  }
  const done = slow.length ? applyOps(first.cut, slow, ctx) : first
  const rejected = [...first.rejected, ...(slow.length ? done.rejected : [])].map((r) => r.reason)

  const kind = brief.format === 'documentary' ? 'documentary' : 'explainer'
  const doc: EditDoc = {
    v: 1,
    id: input.id,
    title: make.title || brief.topic,
    createdAt: at,
    sources: [source],
    words,
    versions: [
      {
        n: 1,
        at,
        summary: `The ${kind} about ${brief.topic}: ${beats.length} shots over the narration.`,
        ops: [],
        cut: done.cut
      }
    ],
    notes: [],
    assets,
    preset: null,
    make
  }
  return { doc, unheard, rejected }
}

/** What a remade cut keeps of the cut it replaces: everything the person set for the whole video. */
export interface Carry {
  captions: boolean
  look: boolean
  music: boolean
}

/**
 * A remade video (a new narration, a new style, a new length) as the next
 * version of the edit it was made from: its recording and words join the
 * edit's, its files join the material, and its cut becomes the new version,
 * keeping what the person had set for the whole video. The versions before
 * stay as they were, so Undo goes back to them.
 */
export function asNewVersion(
  current: EditDoc,
  made: EditDoc,
  summary: string,
  carry: Carry,
  at = new Date().toISOString()
): EditDoc {
  const known = new Set(current.sources.map((s) => s.id))
  const sources = [...current.sources, ...made.sources.filter((s) => !known.has(s.id))]
  const words = [...current.words, ...made.words.filter((w) => !known.has(w.source))]
  const paths = new Set(current.assets.map((a) => a.path))
  let n = current.assets.reduce((m, a) => Math.max(m, Number(/^a(\d+)$/.exec(a.id)?.[1] ?? 0)), 0)
  const assets = [
    ...current.assets,
    ...made.assets.filter((a) => !paths.has(a.path)).map((a) => ({ ...a, id: `a${++n}` }))
  ]
  const was = current.versions[current.versions.length - 1]
  const cut = made.versions[made.versions.length - 1].cut
  const kept: Cut = {
    ...cut,
    aspect: was.cut.aspect,
    loudness: was.cut.loudness,
    ...(carry.captions ? { captions: was.cut.captions } : {}),
    ...(carry.look && was.cut.look !== undefined ? { look: was.cut.look } : {}),
    ...(carry.music && was.cut.music !== undefined ? { music: was.cut.music } : {}),
    ...(was.cut.voice !== undefined ? { voice: was.cut.voice } : {})
  }
  const spent = Math.round(((current.make?.spent ?? 0) + (made.make?.spent ?? 0)) * 10000) / 10000
  return {
    ...current,
    sources,
    words,
    assets,
    versions: [...current.versions, { n: was.n + 1, at, summary, ops: [], cut: kept }],
    ...(made.make ? { make: { ...made.make, spent } } : {})
  }
}
