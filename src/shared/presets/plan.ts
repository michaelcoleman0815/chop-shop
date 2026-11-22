import { isFiller } from '../fillers'
import { motionCaptionLook } from '../motion/captions'
import { motionPhrases } from '../motion/describe'
import { fxPhrases } from '../fx/words'
import { trackPhrases } from '../tracks/words'
import { fxStyleOps } from '../fx/style'
import { applyOps } from '../edit/ops'
import { pictureSpan, resolveCut, type Resolved, type ResolvedBeat } from '../edit/resolve'
import { currentCut } from '../edit/doc'
import { sameValue } from '../edit/same'
import type { Cut, EditDoc, Op } from '../edit/schema'
import { beatsOnClock } from '../edit/audio'
import { CAMERA_INFO } from '../edit/camera'
import { describeJumps, jumpJoins } from '../edit/jumps'
import { transitionInfo } from '../edit/transitions'
import { describeLook, mergeLook, NAMED_LOOKS } from '../edit/look'
import { placeChapters } from '../edit/chapters'
import { LAYOUT_INFO } from '../edit/angles'
import { describeFraming } from '../edit/reframe'
import { describeFill } from '../edit/fill'
import { describeBox } from '../edit/box'
import { describeSfx } from './sfx'
import { syncSeconds } from './angles'
import { clock, seconds, type StyleSpec } from './preset'
import { planTakes, type TakesPlan, type TakesPlanOptions } from '../raw/plan'

/**
 * Turns a style into ops on a doc.
 *
 * Everything mechanical happens here, deterministically: tightening, caption
 * settings, splitting long beats to the measured pace, punch-ins, big words,
 * black and white on cutaways. What needs judgment (which line opens, what to
 * drop to fit a minute) comes back as `open` sentences for the planner to
 * take up, rather than being guessed.
 *
 * Ops are worked out against a running copy of the cut, so ids created by
 * one split are the ids the next op refers to, and replaying the list on the
 * original cut gives exactly the same result.
 */

export interface StylePlan {
  ops: Op[]
  /** Judgment calls left for the planner, in the app's voice. */
  open: string[]
  /**
   * The takes, when the style asks for them: their ops come first in ops,
   * their sentence leads the version, and their offers wait for a yes.
   */
  takes: (TakesPlan & { opCount: number }) | null
}

/** The punch-in used when a style sets a pace but no punch-in of its own. */
const DEFAULT_PUNCH = 1.1

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
    'just me my of on or our she so than that the their them then there these they this to was we were what when where which ' +
    "who why will with would you your i'm it's that's don't can't won't you're we're they're i've you've we've " +
    "here's there's what's let's here there very really"
  ).split(' ')
)

export function planStyle(
  doc: EditDoc,
  style: StyleSpec,
  from: Cut = currentCut(doc),
  takesOpts: TakesPlanOptions = {}
): StylePlan {
  const context = { words: doc.words, sources: doc.sources }
  let cut = from
  const ops: Op[] = []
  const open: string[] = []
  let takes: StylePlan['takes'] = null

  const push = (...next: Op[]): void => {
    for (const op of next) {
      const r = applyOps(cut, [op], context)
      if (r.applied.length > 0) {
        cut = r.cut
        ops.push(op)
      }
    }
  }
  const resolve = (): Resolved => resolveCut(cut, doc.words, doc.sources)

  // Takes first: tightening, pace and the rest then work on the kept takes.
  if (style.takes) {
    const t = planTakes(doc, takesOpts, cut)
    push(...t.ops)
    takes = { ...t, opCount: ops.length }
  }

  if (style.aspect && style.aspect !== cut.aspect) push({ op: 'aspect', aspect: style.aspect })
  if (style.tighten) push({ op: 'tighten', set: style.tighten })
  if (style.captions) push({ op: 'captions', set: style.captions })
  if (style.loudness && style.loudness.lufs !== cut.loudness) push({ op: 'loudness', lufs: style.loudness.lufs })
  if (style.fade) {
    const was = cut.fade
    const same =
      was && was.inSec === style.fade.inSec && was.outSec === style.fade.outSec && was.color === style.fade.color
    if (!same) push({ op: 'fade', ...style.fade })
  }
  if (style.look !== undefined) {
    // A look replaces the one there, keeping any LUT; nothing to do when it is already there.
    const next = mergeLook(cut.look, style.look, true)
    if (!sameValue(next, cut.look ?? null)) push({ op: 'look', set: style.look, replace: true })
  }
  if (style.pad) {
    const { inSec, outSec } = style.pad
    for (const beat of cut.beats) {
      if (beat.from === null) continue
      if (Math.abs(beat.padIn - inSec) > 1e-6 || Math.abs(beat.padOut - outSec) > 1e-6) {
        push({ op: 'pad', beat: beat.id, padIn: inSec, padOut: outSec })
      }
    }
  }

  // Pace: long beats are split so something changes about every
  // secondsPerShot. The splits only read as changes because alternate beats
  // are punched in below.
  if (style.pace) {
    const target = style.pace.secondsPerShot
    // By id: a split leaves the head with its id, so ids stay valid while
    // positions shift under each split.
    for (const id of cut.beats.map((b) => b.id)) {
      const resolved = resolve()
      const beat = resolved.beats.find((b) => b.id === id)
      if (!beat) continue
      const length = beat.outEnd - beat.outStart
      if (length < target * 1.5 || beat.words.length < 4) continue
      const parts = Math.max(2, Math.round(length / target))
      const marks = Array.from({ length: parts - 1 }, (_, j) => beat.outStart + ((j + 1) * length) / parts)
      push(...splitsAt(beat, resolved, marks))
    }
  }

  // Hook: the first change lands by firstCutSec.
  if (style.hook) {
    const first = resolve().beats[0]
    if (first && first.outEnd - first.outStart > style.hook.firstCutSec + 0.3) {
      push(...splitsAt(first, resolve(), [style.hook.firstCutSec]))
    }
    if (style.hook.strongestFirst) open.push('Pick the strongest line to open on.')
  }

  // Punch-ins on alternate speaker beats, starting wide.
  if (style.punchIn || style.pace) {
    const scale = style.punchIn?.scale ?? DEFAULT_PUNCH
    const wide: string[] = []
    const tight: string[] = []
    let n = 0
    for (const rb of resolve().beats) {
      const beat = cut.beats[rb.index]
      if (beat.treatment.frame !== 'speaker') continue
      const want = n++ % 2 === 1 ? scale : 1
      if (Math.abs(beat.treatment.zoom - want) > 1e-6) (want === 1 ? wide : tight).push(beat.id)
    }
    if (tight.length) push({ op: 'treat', beats: tight, set: { zoom: scale } })
    if (wide.length) push({ op: 'treat', beats: wide, set: { zoom: 1 } })
  }

  if (style.bigWords?.perBeat) {
    const resolved = resolve()
    const text = new Map(resolved.words.map((w) => [w.id, w.text]))
    for (const rb of resolved.beats) {
      const beat = cut.beats[rb.index]
      if (beat.treatment.frame !== 'speaker' || beat.treatment.bigWord) continue
      const pick = bigWordFor(rb.words, text)
      if (pick) push({ op: 'treat', beats: [beat.id], set: { bigWord: pick } })
    }
  }

  // Scene effects last, on the cut as paced: a scan to open, and speed lines into impacts on a few big cuts.
  if (style.fx) push(...fxStyleOps(cut, resolve(), style.fx))

  if (style.bw) {
    const cutaways = cut.beats.filter((b) => b.treatment.frame === 'broll' || b.treatment.frame === 'split')
    const want = Math.round(style.bw.share * cutaways.length)
    if (cutaways.length === 0 && style.bw.share >= 0.15) {
      open.push(`Add some B-roll and about ${Math.round(style.bw.share * 100)}% of it goes black and white.`)
    } else if (cutaways.length > 0) {
      // Spread evenly rather than bunched at the start.
      const pick = new Set<string>()
      for (let k = 0; k < want; k++) pick.add(cutaways[Math.floor(((k + 0.5) * cutaways.length) / want)].id)
      const on = cutaways.filter((b) => pick.has(b.id) && !b.treatment.bw).map((b) => b.id)
      const off = cutaways.filter((b) => !pick.has(b.id) && b.treatment.bw).map((b) => b.id)
      if (on.length) push({ op: 'treat', beats: on, set: { bw: true } })
      if (off.length) push({ op: 'treat', beats: off, set: { bw: false } })
    }
  }

  if (style.maxLengthSec) {
    const length = resolve().durationSec
    const over = length - style.maxLengthSec
    if (over > 0.5) {
      open.push(
        `It runs ${seconds(length)}, ${seconds(over)} over ${seconds(style.maxLengthSec)}. Say what to drop, or ask me to pick.`
      )
    }
  }

  return { ops, open, takes }
}

/**
 * The beats where the picture changes between the speaker and a cutaway:
 * into a cutaway, back out of one, or either way.
 */
export function cutawayEdges(cut: Cut, way: 'into' | 'out' | 'both' = 'both'): string[] {
  const shows = (i: number): boolean => cut.beats[i].treatment.frame !== 'speaker'
  return cut.beats
    .filter((_, i) => {
      if (i === 0 || shows(i) === shows(i - 1)) return false
      return way === 'both' || (way === 'into') === shows(i)
    })
    .map((b) => b.id)
}

/** The furthest a picture cut moves to land on the music's beat, in seconds. */
const ON_BEAT_REACH_SEC = 0.5

/**
 * Picture cuts moved onto the music's beats, for runs of B-roll and of held
 * shots: wherever the picture changes to or from a cutaway or a shot with no
 * words, the cut moves to the nearest beat of the music within half a second
 * (or half a beat, if that is less), as a J or L cut, so the words stay where
 * they are and only the picture lands on the beat. Cuts already within a
 * frame of a beat, and cuts with a transition, are left alone. Empty when the
 * cut has no music with beats.
 */
export function onBeatOps(doc: EditDoc, cut: Cut = currentCut(doc)): Op[] {
  const music = cut.music
  if (!music?.beats?.length) return []
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const beats = beatsOnClock(music, resolved.durationSec)
  if (beats.length < 2) return []
  const montage = (i: number): boolean => {
    const b = cut.beats[i]
    return (b.treatment.frame !== 'speaker' && b.treatment.broll !== null) || b.from === null
  }
  const ops: Op[] = []
  for (let i = 1; i < cut.beats.length; i++) {
    const beat = cut.beats[i]
    const at = resolved.beats.find((b) => b.id === beat.id)?.outStart
    if (at === undefined || beat.transition || !(montage(i) || montage(i - 1))) continue
    // Where the picture changes now, which an earlier J or L cut may have moved.
    const first = resolved.pieces.find((p) => p.beat === beat.id)
    const cutsAt = first ? pictureSpan(first).outStart : at
    if (beats.some((b) => Math.abs(b - cutsAt) < 1 / 30)) continue
    let k = 0
    while (k < beats.length - 1 && beats[k + 1] <= at) k++
    const nearest = Math.abs(beats[k + 1] - at) < Math.abs(beats[k] - at) ? beats[k + 1] : beats[k]
    const reach = Math.min(ON_BEAT_REACH_SEC, (beats[k + 1] - beats[k]) / 2 || ON_BEAT_REACH_SEC)
    const shift = nearest - at
    if (Math.abs(shift) < 1 / 30 || Math.abs(shift) > reach) continue
    // From the words' cut, so asking twice gives the same J or L cut, not a second one on top.
    // Later: the picture before runs on into the beat (J). Earlier: the next picture comes in under it (L).
    ops.push({ op: shift > 0 ? 'jcut' : 'lcut', beats: [beat.id], sec: Number(Math.abs(shift).toFixed(3)) })
  }
  return ops
}

/** Beats that show a cutaway: the product shots and screen recordings, where speed belongs. */
export function cutawayBeats(cut: Cut): string[] {
  return cut.beats.filter((b) => b.treatment.frame !== 'speaker' && b.treatment.broll).map((b) => b.id)
}

/**
 * Beats that start a new idea: after a sentence ends and the speaker paused
 * at least `pauseSec` in the recording, or anywhere a beat was moved out of
 * recording order. Kept at least `spacingSec` of output apart, so a section
 * change is a change and not a habit. Never the first beat.
 */
export function ideaStarts(doc: EditDoc, cut: Cut = currentCut(doc), pauseSec = 0.9, spacingSec = 6): string[] {
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const at = new Map(resolved.beats.map((b) => [b.id, b.outStart]))
  const words = new Map(doc.words.map((w) => [w.id, w]))
  const starts: string[] = []
  // The video's own start is the first idea.
  let lastAt = 0
  let prevEnd: { source: string; sec: number; text: string } | null = null
  for (const beat of cut.beats) {
    const first = beat.from ? words.get(beat.from) : undefined
    const last = beat.to ? words.get(beat.to) : undefined
    const when = at.get(beat.id)
    if (first && prevEnd && when !== undefined) {
      const moved = first.source !== prevEnd.source || first.startSec < prevEnd.sec
      const paused = /[.!?]["')\]]*$/.test(prevEnd.text) && first.startSec - prevEnd.sec >= pauseSec
      if ((moved || paused) && when - lastAt >= spacingSec) {
        starts.push(beat.id)
        lastAt = when
      }
    }
    if (last) prevEnd = { source: last.source, sec: last.endSec, text: last.text }
  }
  return starts
}

/**
 * Split ops that cut `beat` at the kept words nearest each output time.
 * Splits run last to first, so each one acts on the original beat id, which
 * keeps the head of the beat as the earlier words are split off in turn.
 */
function splitsAt(beat: ResolvedBeat, resolved: Resolved, marks: number[]): Op[] {
  const words = resolved.words.filter((w) => w.beat === beat.id)
  const id = beat.id
  const chosen = new Set<string>()
  for (const t of marks) {
    let best: { id: string; d: number } | null = null
    // Never the first word: a split there would leave an empty head.
    for (let i = 1; i < words.length; i++) {
      const d = Math.abs(words[i].outStart - t)
      if (!best || d < best.d) best = { id: words[i].id, d }
    }
    if (best) chosen.add(best.id)
  }
  const order = words.map((w) => w.id)
  return [...chosen]
    .sort((a, b) => order.indexOf(b) - order.indexOf(a))
    .map((at) => ({ op: 'split' as const, beat: id, at }))
}

/** The word most worth landing big: the longest content word, the later one on a tie. */
function bigWordFor(ids: string[], text: Map<string, string>): string | null {
  let best: { id: string; score: number } | null = null
  for (const id of ids) {
    const word = (text.get(id) ?? '').toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
    if (word.length < 4 || STOPWORDS.has(word) || isFiller(word)) continue
    if (!best || word.length >= best.score) best = { id, score: word.length }
  }
  return best?.id ?? null
}

/**
 * "beat 3 comes in with a dissolve", "four beats cut in hard again". Says so
 * when a transition came out shorter than asked because a longer one would
 * lay words over each other, and when there was no room for one at all.
 */
function describeTransition(o: Extract<Op, { op: 'transition' }>, after: Resolved): string {
  const positions = o.beats
    .map((id) => after.beats.find((b) => b.id === id)?.index)
    .filter((i): i is number => i !== undefined && i > 0)
  const n = positions.length || o.beats.length
  const who = n === 1 && positions.length === 1 ? `beat ${positions[0] + 1}` : count(n, 'beat')
  if (o.kind === 'cut') return `${who} ${n === 1 ? 'cuts' : 'cut'} in hard again`
  // Where the words run right up to the cut on both sides there is no footage
  // to blend, and the cut stays hard.
  const made = new Set((after.transitions ?? []).map((t) => t.beat))
  const none = o.beats.filter((id) => !made.has(id) && (after.beats.find((b) => b.id === id)?.index ?? 0) > 0)
  if (none.length > 0 && none.length === positions.length) {
    return `${who} ${n === 1 ? 'stays a hard cut' : 'stay hard cuts'}: the words run right up to ${n === 1 ? 'it' : 'them'}, with no room for ${transitionInfo(o.kind).label}`
  }
  const got = positions.length - none.length
  const said =
    none.length > 0
      ? `${count(got, 'beat')} ${got === 1 ? 'comes' : 'come'} in with ${transitionInfo(o.kind).label}, and ${count(none.length, 'beat')} ${none.length === 1 ? 'stays a hard cut' : 'stay hard cuts'} where the words run right up to the cut`
      : `${who} ${n === 1 ? 'comes' : 'come'} in with ${transitionInfo(o.kind).label}`
  const short = (after.transitions ?? []).filter((t) => o.beats.includes(t.beat) && t.sec < t.asked - 0.01)
  if (short.length === 0) return said
  const sec = Math.min(...short.map((t) => t.sec))
  return `${said}, ${seconds(sec)} long where more would lay words over each other`
}

/**
 * "beat 5's sound comes in 0.3 s before its picture", "three beats come in on
 * L cuts". Says so when there was less footage, or less beat, than asked.
 */
function describeSplitEdit(o: Extract<Op, { op: 'jcut' | 'lcut' }>, after: Resolved): string {
  const positions = o.beats
    .map((id) => after.beats.find((b) => b.id === id)?.index)
    .filter((i): i is number => i !== undefined && i > 0)
  const n = positions.length || o.beats.length
  const one = n === 1 && positions.length === 1
  const who = one ? `beat ${positions[0] + 1}` : count(n, 'beat')
  if (o.sec === 0) return `${who}${one ? "'s" : ''} picture and sound cut together again`
  const made = (after.splitEdits ?? []).filter((s) => o.beats.includes(s.beat))
  const sec = made.length ? Math.min(...made.map((s) => s.sec)) : o.sec
  const short = made.some((s) => s.sec < s.asked - 0.01)
  const less = short ? ', as far as the footage and the beat allow' : ''
  if (!one) return `${who} come in on ${o.op === 'jcut' ? 'J' : 'L'} cuts${less}`
  return o.op === 'jcut'
    ? `${who}'s sound comes in ${seconds(sec)} before its picture${less}`
    : `${who}'s picture comes in ${seconds(sec)} early, under the sound before it${less}`
}

/** "beat 3" for one beat that plays, "three beats" for more. */
/** A camera as the person counts them: the recording is camera 1, the first other camera of it camera 2. */
function cameraName(cut: Cut | null, source: string): string {
  const angle = cut?.angles?.find((a) => a.source === source)
  if (!cut?.angles || !angle) return 'another camera'
  return `camera ${cut.angles.filter((a) => a.of === angle.of).indexOf(angle) + 2}`
}

function whoOf(ids: string[], after: Resolved): { who: string; one: boolean } {
  const positions = ids
    .map((id) => after.beats.find((b) => b.id === id)?.index)
    .filter((i): i is number => i !== undefined)
  const one = ids.length === 1 && positions.length === 1
  return { who: one ? `beat ${positions[0] + 1}` : count(positions.length || ids.length, 'beat'), one }
}

/** Whether an op on a beat's speed or direction went to the cutaway it shows, by the op's own rule. */
function onCutaway(o: { beats: string[]; of?: 'beat' | 'cutaway' }, cut: Cut | null): boolean {
  if (o.of) return o.of === 'cutaway'
  if (!cut) return false
  return o.beats.every((id) => {
    const t = cut.beats.find((b) => b.id === id)?.treatment
    return !!t?.broll && t.frame !== 'speaker'
  })
}

const SPEED_NAMES: [number, string][] = [
  [2, 'double speed'],
  [0.5, 'half speed'],
  [0.25, 'quarter speed']
]
const speedName = (x: number): string =>
  SPEED_NAMES.find(([v]) => Math.abs(v - x) < 1e-6)?.[1] ?? `${Number(x.toFixed(2))}x`

/**
 * "beat 3's cutaway eases into half speed and back", "two beats play at
 * 1.5x", "beat 3 plays as recorded again".
 */
function describeSpeedOp(o: Extract<Op, { op: 'speed' }>, after: Resolved, cut: Cut | null): string {
  const { who, one } = whoOf(o.beats, after)
  const cutaway = onCutaway(o, cut)
  const subject = cutaway ? (one ? `${who}'s cutaway` : `the cutaways in ${who}`) : who
  const s = one ? 's' : ''
  const eased = !!o.ramp && (o.ramp.inSec > 0 || o.ramp.outSec > 0)
  if (Math.abs(o.speed - 1) < 1e-6 && !eased) return `${subject} play${s} as recorded again`
  if (eased) return `${subject} ease${s} into ${speedName(o.speed)} and back`
  return `${subject} play${s} at ${speedName(o.speed)}`
}

/** "beat 3 holds on “people” for 1.5 s". */
function describeFreeze(o: Extract<Op, { op: 'freeze' }>, after: Resolved): string {
  const { who } = whoOf([o.beat], after)
  if (o.sec === 0) return `${who} no longer holds on a frame`
  const word = after.words.find((w) => w.id === o.word)?.text.replace(/[^\p{L}\p{N}'’-]/gu, '')
  return `${who} holds${word ? ` on “${word}”` : ''} for ${seconds(o.sec)}`
}

/** "beat 3's cutaway plays backwards", "beat 3 plays forwards again". */
function describeReverse(o: Extract<Op, { op: 'reverse' }>, after: Resolved, cut: Cut | null): string {
  const { who, one } = whoOf(o.beats, after)
  const subject = onCutaway(o, cut) ? (one ? `${who}'s cutaway` : `the cutaways in ${who}`) : who
  return `${subject} play${one ? 's' : ''} ${o.on ? 'backwards' : 'forwards again'}`
}

/** "beat 3 gets a push-in", "beat 5's cutaway gets a Ken Burns move", "beat 3 holds still again". */
function describeCameraOp(o: Extract<Op, { op: 'camera' }>, after: Resolved, cut: Cut | null): string {
  const { who, one } = whoOf(o.beats, after)
  const subject = onCutaway(o, cut) ? (one ? `${who}'s cutaway` : `the cutaways in ${who}`) : who
  if (!o.move) return `${subject} ${one ? 'holds' : 'hold'} still again`
  const id = o.move.word
  const word = id ? after.words.find((w) => w.id === id)?.text.replace(/[^\p{L}\p{N}'’-]/gu, '') : undefined
  return `${subject} ${one ? 'gets' : 'get'} ${CAMERA_INFO[o.move.kind].label}${word ? ` on “${word}”` : ''}`
}

/** "the voice is cleaned up", "the bed is Bright pulse, 120 BPM", "the music dips 9 dB under speech". */
function describeSound(o: Extract<Op, { op: 'voice' | 'music' }>, cut: Cut | null): string[] {
  if (o.op === 'voice')
    return [o.polish > 0 ? 'the voice is cleaned up' : o.room ? 'the room under the voice is taken down' : 'the voice is back as recorded']
  if (o.set === null) return ['the music is out']
  const said: string[] = []
  const m = cut?.music
  if (o.set.path) {
    const name =
      o.set.path
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, '') ?? 'the track'
    said.push(`the bed is ${name}${m?.bpm ? `, ${Math.round(m.bpm)} BPM` : ''}`)
  }
  if (o.set.levelDb !== undefined) said.push(`the music sits ${Math.abs(Math.round(o.set.levelDb))} dB under the voice`)
  if (o.set.duckDb !== undefined)
    said.push(
      o.set.duckDb > 0 ? `it dips ${Math.round(o.set.duckDb)} dB under speech` : 'it no longer dips under speech'
    )
  return said
}

/** What a look op did, from the look it left: "the picture has the warm look", "the LUT is off". */
function describeLookOp(o: Extract<Op, { op: 'look' }>, cut: Cut | null): string {
  const look = cut ? (cut.look ?? null) : mergeLook(null, o.set, o.replace)
  if (!look) return 'the picture is back to its recorded colour'
  const keys = o.set ? Object.keys(o.set) : []
  if (keys.length === 1 && keys[0] === 'lut') {
    const lut = o.set?.lut
    if (!lut) return 'the LUT is off'
    const name =
      lut.path
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.cube$/i, '') ?? 'the LUT'
    return `the LUT ${name} is on at ${Math.round(lut.strength * 100)}%`
  }
  if (o.replace && look.name && NAMED_LOOKS[look.name]) {
    return `the picture has the ${look.name} look${look.lut ? ', over the LUT' : ''}`
  }
  return `the look is ${describeLook(look)}`
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const count = (n: number, one: string, many = `${one}s`): string => `${NUMBER_WORDS[n] ?? n} ${n === 1 ? one : many}`

function sentenceList(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

/**
 * What a set of applied ops did, in the app's voice: "Pauses longer than
 * 0.4 s are cut, captions show two words at a time, and alternate shots punch
 * in. It runs 0:52, down from 1:04." Empty when nothing visible changed.
 */
export function describePlan(ops: Op[], before: Resolved, after: Resolved, cut: Cut | null = null): string {
  const said: string[] = []
  const splits = ops.filter((o) => o.op === 'split').length
  const treat = ops.filter((o): o is Extract<Op, { op: 'treat' }> => o.op === 'treat')
  const removed = ops.reduce((n, o) => n + (o.op === 'remove' ? o.beats.length : 0), 0)
  const struck = ops.filter((o) => o.op === 'strike').length

  for (const o of ops) {
    if (o.op === 'tighten') {
      said.push(
        o.set
          ? `pauses longer than ${seconds(o.set.maxGapSec)} are cut${o.set.fillers ? ', ums included' : ''}`
          : 'pauses are back as recorded'
      )
    } else if (o.op === 'captions') {
      const look = o.set.on === false ? null : motionCaptionLook(o.set.preset)
      if (o.set.on === false) said.push('captions are off')
      else if (look) said.push(look.phrase)
      else if (o.set.wordsPerScreen) {
        const n = o.set.wordsPerScreen
        said.push(
          n === 1 ? 'captions show one word at a time' : `captions show ${NUMBER_WORDS[n] ?? n} words at a time`
        )
      } else if (o.set.on) said.push('captions are on')
    } else if (o.op === 'punch-jumps') {
      said.push(describeJumps(o.on, cut ? jumpJoins(cut, after).length : 0))
    } else if (o.op === 'aspect') {
      said.push(
        {
          vertical: "it's vertical now",
          square: "it's square now",
          wide: "it's wide now",
          original: "it's back to the recording's shape"
        }[o.aspect]
      )
    } else if (o.op === 'loudness') {
      said.push(o.lufs === null ? 'the sound is left as recorded' : `the sound is set to ${o.lufs} LUFS`)
    } else if (o.op === 'move' && o.to === 0) {
      said.push('a new line opens it')
    } else if (o.op === 'transition') {
      said.push(describeTransition(o, after))
    } else if (o.op === 'jcut' || o.op === 'lcut') {
      said.push(describeSplitEdit(o, after))
    } else if (o.op === 'speed') {
      said.push(describeSpeedOp(o, after, cut))
    } else if (o.op === 'freeze') {
      said.push(describeFreeze(o, after))
    } else if (o.op === 'reverse') {
      said.push(describeReverse(o, after, cut))
    } else if (o.op === 'camera') {
      said.push(describeCameraOp(o, after, cut))
    } else if (o.op === 'voice' || o.op === 'music') {
      said.push(...describeSound(o, cut))
    } else if (o.op === 'look') {
      said.push(describeLookOp(o, cut))
    } else if (o.op === 'reframe') {
      said.push(o.on ? 'the picture follows you' : 'the picture keeps the middle')
    } else if (o.op === 'fill') {
      said.push(describeFill(o.mode))
    } else if (o.op === 'box') {
      said.push(o.set ? `the picture is ${describeBox(o.set)} on black` : 'the picture fills the frame')
    } else if (o.op === 'framing') {
      const { who, one } = whoOf(o.beats, after)
      said.push(
        o.x === null
          ? `${who} ${one ? 'follows' : 'follow'} you again`
          : `${who} ${one ? 'is' : 'are'} ${describeFraming(o.x)}`
      )
    } else if (o.op === 'angle') {
      const { who, one } = whoOf(o.beats, after)
      if (o.source === null) said.push(`${who} ${one ? 'shows' : 'show'} your recording again`)
      else {
        const layout = o.layout ?? cut?.beats.find((b) => b.id === o.beats[0])?.treatment.angle?.layout ?? 'full'
        const how = layout === 'full' ? '' : ` ${LAYOUT_INFO[layout].label}`
        said.push(`${who} ${one ? 'shows' : 'show'} ${cameraName(cut, o.source)}${how}`)
      }
    } else if (o.op === 'sync') {
      if (o.of === null) said.push('the other camera is out of the edit')
      else {
        const sec = o.offsetSec ?? 0
        const where = `${syncSeconds(sec)} ${sec >= 0 ? 'ahead of' : 'behind'} the recording`
        said.push(`${cameraName(cut, o.source)} is lined up ${where}`)
      }
    } else if (o.op === 'sfx') {
      // Described together below.
    } else if (o.op === 'chapters') {
      const placed = cut
        ? placeChapters(cut.chapters ?? [], new Map(after.beats.map((b) => [b.id, b.outStart])), after.durationSec)
            .chapters.length
        : (o.set?.length ?? 0)
      said.push(placed > 0 ? `the video has ${count(placed, 'chapter')} for YouTube` : 'the chapters are out')
    } else if (o.op === 'fade') {
      const ins = (o.inSec ?? 0) > 0
      const outs = (o.outSec ?? 0) > 0
      const color = o.color ?? 'black'
      if (ins && outs) said.push(`it fades in and out through ${color}`)
      else if (ins) said.push(`it fades in from ${color}`)
      else if (outs) said.push(`it fades out to ${color}`)
      else if (o.inSec === 0 && o.outSec === 0) said.push('it no longer fades in or out')
    }
  }
  said.push(...describeSfx(ops, after))
  if (ops.some((o) => o.op === 'pad')) said.push('every cut lands tight on the words')
  if (splits > 0) said.push(`${count(splits, 'long beat')} ${splits === 1 ? 'is' : 'are'} split to the pace`)
  if (treat.some((o) => (o.set.zoom ?? 1) > 1)) said.push('alternate shots punch in')
  const bigWords = treat.filter((o) => o.set.bigWord).length
  if (bigWords > 0) said.push(bigWords === 1 ? 'one big word lands' : `a big word lands in ${count(bigWords, 'beat')}`)
  const bw = treat.filter((o) => o.set.bw === true).flatMap((o) => o.beats)
  // Cutaways, as a style makes them; beats of someone talking, as a note on a stretch can.
  const bwCutaways =
    !cut ||
    bw.every((id) => {
      const t = cut.beats.find((b) => b.id === id)?.treatment
      return !!t?.broll && t.frame !== 'speaker'
    })
  if (bw.length > 0 && bwCutaways)
    said.push(`${count(bw.length, 'cutaway')} ${bw.length === 1 ? 'goes' : 'go'} black and white`)
  else if (bw.length > 0) {
    const { who, one } = whoOf(bw, after)
    said.push(`${who} ${one ? 'goes' : 'go'} black and white`)
  }
  for (const on of [false, true]) {
    const beats = treat.filter((o) => o.set.captions === on).flatMap((o) => o.beats)
    if (beats.length === 0) continue
    const { who, one } = whoOf(beats, after)
    said.push(
      on ? `${who} ${one ? 'shows' : 'show'} captions again` : `${who} ${one ? 'shows' : 'show'} no captions`
    )
  }
  if (removed > 0) said.push(`${count(removed, 'beat')} ${removed === 1 ? 'is' : 'are'} gone`)
  if (struck > 0) said.push(`${count(struck, 'stretch', 'stretches')} of words ${struck === 1 ? 'is' : 'are'} cut`)
  said.push(...motionPhrases(ops), ...fxPhrases(ops), ...trackPhrases(ops))

  let text = said.length > 0 ? `${sentenceList(said)}.` : ''
  text = text.charAt(0).toUpperCase() + text.slice(1)
  const delta = after.durationSec - before.durationSec
  if (Math.abs(delta) >= 0.5) {
    // Within the same second on the clock, the difference itself says more.
    const same = clock(after.durationSec) === clock(before.durationSec)
    const runs = same
      ? `It runs ${seconds(Math.abs(delta))} ${delta < 0 ? 'shorter' : 'longer'}.`
      : `It runs ${clock(after.durationSec)}, ${delta < 0 ? 'down' : 'up'} from ${clock(before.durationSec)}.`
    text = text ? `${text} ${runs}` : runs
  }
  return text
}
