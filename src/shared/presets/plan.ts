import { isFiller } from '../fillers'
import { motionCaptionLook } from '../motion/captions'
import { motionPhrases } from '../motion/describe'
import { applyOps } from '../edit/ops'
import { resolveCut, type Resolved, type ResolvedBeat } from '../edit/resolve'
import { currentCut } from '../edit/doc'
import type { Cut, EditDoc, Op } from '../edit/schema'
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
export function describePlan(ops: Op[], before: Resolved, after: Resolved): string {
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
    }
  }
  if (ops.some((o) => o.op === 'pad')) said.push('every cut lands tight on the words')
  if (splits > 0) said.push(`${count(splits, 'long beat')} ${splits === 1 ? 'is' : 'are'} split to the pace`)
  if (treat.some((o) => (o.set.zoom ?? 1) > 1)) said.push('alternate shots punch in')
  const bigWords = treat.filter((o) => o.set.bigWord).length
  if (bigWords > 0) said.push(bigWords === 1 ? 'one big word lands' : `a big word lands in ${count(bigWords, 'beat')}`)
  const bw = treat.filter((o) => o.set.bw === true).reduce((n, o) => n + o.beats.length, 0)
  if (bw > 0) said.push(`${count(bw, 'cutaway')} ${bw === 1 ? 'goes' : 'go'} black and white`)
  if (removed > 0) said.push(`${count(removed, 'beat')} ${removed === 1 ? 'is' : 'are'} gone`)
  if (struck > 0) said.push(`${count(struck, 'stretch', 'stretches')} of words ${struck === 1 ? 'is' : 'are'} cut`)
  said.push(...motionPhrases(ops))

  let text = said.length > 0 ? `${sentenceList(said)}.` : ''
  text = text.charAt(0).toUpperCase() + text.slice(1)
  const delta = after.durationSec - before.durationSec
  if (Math.abs(delta) >= 0.5) {
    const runs = `It runs ${clock(after.durationSec)}, ${delta < 0 ? 'down' : 'up'} from ${clock(before.durationSec)}.`
    text = text ? `${text} ${runs}` : runs
  }
  return text
}
