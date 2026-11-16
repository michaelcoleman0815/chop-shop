import type { Clip, Moment, Role, Scene, StoryBeat } from './schema'
import type { TalkUnit } from './talk'

/**
 * The story of a day, by rules, so a vlog is cut even with nothing to look at
 * the pictures: the strongest moment teased first, then the day in order,
 * each scene opening on a steady establishing shot and running through its
 * action and the talking that explains it to a reaction, building to that
 * strongest moment in full, and closing on a sign-off or a quiet moment.
 *
 * Pace follows the reference the owner gave: the opening runs fast (shots of
 * about a second in the tease, two and a half seconds through the first half
 * minute), the rest settles to three to five seconds a shot, and talking runs
 * as long as its sentences. A length is met by leaving out the weakest
 * moments first, scene by scene against each scene's share, then by trimming
 * shots; with a music bed, each shot ends on a beat.
 */

export interface StoryOptions {
  targetSec: number
  /** 'auto' teases the strongest moment, 'none' starts with the day, or a moment or scene id to open on. */
  hook: string
  /** More or less of a scene, by id. */
  weights: Record<string, number>
  /** The music's beats on the video's clock, when there is a bed. */
  musicBeats?: number[] | null
}

export interface StoryPlan {
  beats: StoryBeat[]
  /** How long it plays, worked out from the shots and sentences. */
  totalSec: number
  /** The moment the hook teases and the payoff plays in full. */
  highlight: string | null
  /** When the footage cannot fill the length asked for. */
  short: boolean
}

/** Pace, from the reference vlog's measured shots. */
export const PACE = {
  hookShot: 1.2,
  hookMin: 0.8,
  hookMax: 9,
  openShot: 2.5,
  shot: 3.5,
  minShot: 2,
  maxShot: 5,
  establish: 3,
  payoffMax: 10,
  close: 4,
  /** The opening runs fast for this long after the hook. */
  openSec: 30
}

/** One thing the story could show, before it is placed. */
interface Item {
  key: string
  scene: string
  role: Role
  clip: string
  /** Its time in the day, for ordering within a scene. */
  at: number
  /** A shot of a moment, or a sentence of talking. */
  moment?: Moment
  unit?: TalkUnit
  /** The longest the shot can run in its moment or stretch. */
  room: [number, number]
  len: number
  minLen: number
  maxLen: number
  /** How much it is worth keeping: higher stays. Protected items are never left out. */
  value: number
  protected: boolean
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
const round3 = (v: number): number => Math.round(v * 1000) / 1000

/** How good a moment is for a story: strong and good-looking. */
export function momentScore(m: Moment): number {
  return m.interest * (0.5 + 0.5 * m.quality)
}

/** The strongest moment of the day, or null when there is none to show. */
export function strongest(moments: Moment[]): Moment | null {
  let best: Moment | null = null
  for (const m of moments) if (!best || momentScore(m) > momentScore(best)) best = m
  return best
}

/** A clip's place in the day; untimed clips keep their order after the timed ones. */
function clipTime(clip: Clip | undefined, fallback: number): number {
  return clip?.at ?? 1e12 + fallback
}

export function planStory(
  input: { clips: Clip[]; moments: Moment[]; scenes: Scene[]; units: TalkUnit[] },
  opts: StoryOptions
): StoryPlan {
  const clipById = new Map(input.clips.map((c) => [c.id, c]))
  const order = new Map(input.clips.map((c, i) => [c.id, i]))
  const usableClip = (id: string): boolean => {
    const c = clipById.get(id)
    return !!c && !c.left
  }
  const sceneOf = (clipId: string): string => clipById.get(clipId)?.scene ?? 'none'
  const weight = (scene: string): number => opts.weights[scene] ?? 1
  // Talking clips whose words were heard are cut on words; their talking moments are not shots.
  const heard = new Set(input.units.map((u) => u.clip))
  const visual = input.moments.filter(
    (m) => usableClip(m.clip) && weight(sceneOf(m.clip)) > 0 && !(m.kind === 'talk' && heard.has(m.clip))
  )
  const units = input.units.filter((u) => usableClip(u.clip) && weight(sceneOf(u.clip)) > 0)
  const at = (clipId: string, sec: number): number => clipTime(clipById.get(clipId), order.get(clipId) ?? 0) + sec

  const highlight = strongest(visual)
  const target = Math.max(5, opts.targetSec)
  const items: Item[] = []
  const shot = (m: Moment, role: Role, len: number, opt: { protected?: boolean; value?: number } = {}): Item => {
    // The payoff plays the strongest moment in full: as much of its usable
    // stretch around the peak as it takes, not only the moment's own piece.
    const stretch = clipById.get(m.clip)?.usable.find(([a, z]) => m.peakSec >= a && m.peakSec <= z)
    const room: [number, number] =
      role === 'payoff' && stretch
        ? [Math.max(stretch[0], m.peakSec - PACE.payoffMax / 2), Math.min(stretch[1], m.peakSec + PACE.payoffMax / 2)]
        : [m.inSec, m.outSec]
    const space = room[1] - room[0]
    const minLen = role === 'hook' ? Math.min(PACE.hookMin, space) : Math.min(PACE.minShot, space)
    const maxLen = Math.min(space, role === 'payoff' ? PACE.payoffMax : role === 'hook' ? 1.6 : PACE.maxShot)
    return {
      key: `${role}:${m.id}`,
      scene: sceneOf(m.clip),
      role,
      clip: m.clip,
      at: at(m.clip, m.inSec),
      moment: m,
      room,
      len: clamp(len, minLen, maxLen),
      minLen,
      maxLen,
      // Every shot is worth something, so asking for more of a scene can bring back even its quiet ones.
      value: opt.value ?? 0.15 + momentScore(m),
      protected: opt.protected ?? false
    }
  }
  const talk = (u: TalkUnit, role: Role, protect = false): Item => ({
    key: `${role}:${u.clip}:${u.from}`,
    scene: sceneOf(u.clip),
    role,
    clip: u.clip,
    at: at(u.clip, u.startSec),
    unit: u,
    room: [u.startSec, u.endSec],
    len: u.sec,
    minLen: u.sec,
    maxLen: u.sec,
    // The first sentence of a clip says what is going on; later ones matter a little less each.
    value: u.index === 0 ? 0.9 : Math.max(0.35, 0.75 - 0.05 * u.index),
    protected: protect
  })

  // The tease: the strongest moment and the best others of its scene, a second or so each.
  const hookItems: Item[] = []
  if (opts.hook !== 'none') {
    const asked = input.moments.find((m) => m.id === opts.hook && usableClip(m.clip))
    const askedScene = input.scenes.find((s) => s.id === opts.hook)
    const sceneMoments = (scene: string): Moment[] =>
      visual.filter((m) => sceneOf(m.clip) === scene && m.outSec - m.inSec >= PACE.hookMin)
    let pick: Moment[] = []
    if (asked) pick = [asked]
    else if (askedScene)
      pick = sceneMoments(askedScene.id)
        .sort((a, b) => momentScore(b) - momentScore(a))
        .slice(0, 3)
    else if (highlight) {
      const near = sceneMoments(sceneOf(highlight.clip))
        .filter((m) => m.id !== highlight.id && momentScore(m) >= 0.5 * momentScore(highlight))
        .sort((a, b) => momentScore(b) - momentScore(a))
      const room = clamp(target * 0.05, 3, PACE.hookMax)
      const count = clamp(Math.round(room / PACE.hookShot), 1, 4)
      pick = [...near.slice(0, count - 1), highlight]
    }
    // In the order they happened, the strongest last: the tease lands on it.
    const lead = pick[pick.length - 1]
    const rest = pick.slice(0, -1).sort((a, b) => at(a.clip, a.inSec) - at(b.clip, b.inSec))
    for (const m of [...rest, lead].filter(Boolean)) {
      const len = asked ? Math.min(3, m.outSec - m.inSec) : PACE.hookShot
      const item = shot(m, 'hook', len, { protected: true })
      // A tease of a moment shows its peak.
      hookItems.push(item)
    }
    if (pick.length === 0 && units.length > 0) {
      // Nothing to show: the hook is a line said, from the strongest scene's talking.
      const line = [...units].filter((u) => u.sec >= 1.5 && u.sec <= 7).sort((a, b) => b.sec - a.sec)[0]
      if (line) hookItems.push(talk(line, 'hook', true))
    }
  }

  // The close: a sign-off in the last scene, or a quiet, steady moment there.
  const sceneOrder = input.scenes.filter((s) => weight(s.id) > 0).map((s) => s.id)
  const lastScene = [...sceneOrder]
    .reverse()
    .find((s) => visual.some((m) => sceneOf(m.clip) === s) || units.some((u) => sceneOf(u.clip) === s))
  let closeItem: Item | null = null
  if (lastScene) {
    const lastTalk = units
      .filter((u) => sceneOf(u.clip) === lastScene)
      .sort((a, b) => at(b.clip, b.startSec) - at(a.clip, a.startSec))[0]
    const lastMoments = visual
      .filter((m) => sceneOf(m.clip) === lastScene && m.id !== highlight?.id && m.outSec - m.inSec >= PACE.minShot)
      .sort((a, b) => at(b.clip, b.inSec) - at(a.clip, a.inSec))
    // A sign-off is talking at the very end of the day.
    const endOfDay = lastMoments[0] ? at(lastMoments[0].clip, lastMoments[0].inSec) : -Infinity
    if (lastTalk && at(lastTalk.clip, lastTalk.startSec) >= endOfDay - 120) closeItem = talk(lastTalk, 'close', true)
    else {
      const quiet = [...lastMoments].sort((a, b) => a.motion + a.loud - a.quality - (b.motion + b.loud - b.quality))[0]
      if (quiet) closeItem = shot(quiet, 'close', PACE.close, { protected: true })
    }
  }

  // Every scene's candidates.
  const used = new Set<string>()
  if (closeItem?.moment) used.add(closeItem.moment.id)
  if (closeItem?.unit) used.add(`${closeItem.unit.clip}:${closeItem.unit.from}`)
  for (const sceneId of sceneOrder) {
    const own = visual.filter((m) => sceneOf(m.clip) === sceneId && !used.has(m.id))
    const ownUnits = units.filter((u) => sceneOf(u.clip) === sceneId && !used.has(`${u.clip}:${u.from}`))
    if (own.length === 0 && ownUnits.length === 0) continue
    // The opening shot: steady, calm, early in the scene, and good-looking.
    const early = [...own].sort((a, b) => at(a.clip, a.inSec) - at(b.clip, b.inSec))
    const firstThird = early.slice(0, Math.max(1, Math.ceil(early.length * 0.4)))
    const establishing = [...firstThird]
      .filter((m) => m.outSec - m.inSec >= PACE.minShot && m.id !== highlight?.id)
      .sort(
        (a, b) =>
          b.steady * (b.kind === 'establishing' ? 1.3 : 1) * b.quality * (1.2 - b.motion) -
          a.steady * (a.kind === 'establishing' ? 1.3 : 1) * a.quality * (1.2 - a.motion)
      )[0]
    if (establishing) items.push(shot(establishing, 'establishing', PACE.establish, { value: 0.95 }))
    for (const m of own) {
      if (m.id === establishing?.id || m.outSec - m.inSec < PACE.minShot) continue
      if (m.id === highlight?.id) {
        items.push(shot(m, 'payoff', PACE.payoffMax, { protected: true, value: 1 }))
        continue
      }
      const role: Role = m.kind === 'reaction' ? 'reaction' : 'action'
      items.push(shot(m, role, PACE.shot, { value: 0.15 + momentScore(m) + (role === 'reaction' ? 0.1 : 0) }))
    }
    for (const u of ownUnits) items.push(talk(u, 'talk'))
  }

  // Shares of the length for each scene: stronger scenes, and those asked for, get more.
  const fixedLen = (list: Item[]): number => list.reduce((s, i) => s + i.len, 0)
  const room = Math.max(0, target - fixedLen(hookItems) - (closeItem?.len ?? 0))
  const strength = new Map<string, number>()
  const available = new Map<string, number>()
  for (const i of items) {
    strength.set(i.scene, Math.max(strength.get(i.scene) ?? 0, i.unit ? 0.4 : i.value))
    available.set(i.scene, (available.get(i.scene) ?? 0) + i.len)
  }
  const raw = new Map<string, number>()
  for (const [scene, avail] of available) {
    const payoff = highlight && sceneOf(highlight.clip) === scene ? 1.4 : 1
    raw.set(scene, weight(scene) * payoff * (0.6 + (strength.get(scene) ?? 0)) * Math.sqrt(Math.max(1, avail)))
  }
  const rawTotal = [...raw.values()].reduce((a, b) => a + b, 0) || 1
  const budget = new Map([...raw].map(([scene, r]) => [scene, (room * r) / rawTotal]))

  // Too short a length for every scene to open and show something: the
  // weakest scenes go whole, rather than every scene shrinking to one shot.
  // The payoff's scene, the closing scene and scenes asked for stay.
  const scenesWith = [...new Set(items.map((i) => i.scene))]
  const minimum = (scene: string): number => {
    const own = items.filter((i) => i.scene === scene)
    const opening =
      own.find((i) => i.role === 'establishing') ?? own.find((i) => i.unit && i.unit.index === 0) ?? own[0]
    const next = own.filter((i) => i !== opening).sort((a, b) => b.value - a.value)[0]
    return (opening ? opening.minLen : 0) + (next ? Math.min(next.len, PACE.openShot) : 0)
  }
  const keepScene = (scene: string): boolean =>
    scene === (highlight ? sceneOf(highlight.clip) : '') ||
    scene === closeItem?.scene ||
    weight(scene) > 1 ||
    scene === opts.hook
  const dropped = new Set<string>()
  const byValue = [...scenesWith].sort(
    (a, b) => weight(a) * (0.5 + (strength.get(a) ?? 0)) - weight(b) * (0.5 + (strength.get(b) ?? 0))
  )
  let needed = scenesWith.reduce((t, sc) => t + minimum(sc), 0)
  for (const scene of byValue) {
    if (needed <= room) break
    if (keepScene(scene)) continue
    dropped.add(scene)
    needed -= minimum(scene)
  }

  // Too long: leave out what is worth least against its scene's share, one at a time.
  let kept = items.filter((i) => !dropped.has(i.scene))
  const total = (): number => fixedLen(hookItems) + fixedLen(kept) + (closeItem?.len ?? 0)
  const sceneLen = (scene: string): number => kept.filter((i) => i.scene === scene).reduce((s, i) => s + i.len, 0)
  while (total() > target * 1.02) {
    let worst: { item: Item; score: number } | null = null
    for (const item of kept) {
      if (item.protected) continue
      // The last sentence of a run of talking goes before the first; the opening shot of a scene goes last.
      const later = item.unit
        ? kept.some((k) => k.unit && k.clip === item.clip && k.unit.index > (item.unit as TalkUnit).index)
        : false
      if (later) continue
      const sceneItems = kept.filter((k) => k.scene === item.scene)
      if (item.role === 'establishing' && sceneItems.length > 1) continue
      const over = sceneLen(item.scene) / Math.max(1, budget.get(item.scene) ?? 1)
      // A scene asked for more of keeps its shots until the others are down to their opening.
      const asked = weight(item.scene) > 1 ? 3 : 1
      const score = (item.value * weight(item.scene) * asked) / Math.max(0.2, over)
      if (!worst || score < worst.score) worst = { item, score }
    }
    if (!worst) break
    // Leaving it out must not undershoot by more than trimming would: past
    // the length, a little trimming is the better cut.
    const over = total() - target
    const trim = kept.filter((i) => !i.unit).reduce((s, i) => s + (i.len - i.minLen), 0)
    if (worst.item.len > over + target * 0.02 && trim >= over) break
    kept = kept.filter((k) => k !== worst?.item)
  }
  // Still too long: trim shots toward their shortest.
  let over = total() - target
  if (over > 0) {
    const give = kept.filter((i) => !i.unit && i.len > i.minLen)
    const slack = give.reduce((s, i) => s + (i.len - i.minLen), 0)
    if (slack > 0) for (const i of give) i.len -= ((i.len - i.minLen) / slack) * Math.min(over, slack)
  }
  // Too short: let shots run longer, up to their longest.
  let under = target - total()
  let short = false
  if (under > 0) {
    const grow = kept.filter((i) => !i.unit && i.maxLen > i.len)
    const slack = grow.reduce((s, i) => s + (i.maxLen - i.len), 0)
    if (slack > 0) for (const i of grow) i.len += ((i.maxLen - i.len) / slack) * Math.min(under, slack)
    under = target - total()
    short = under > target * 0.05
  }
  over = total() - target

  // In order: the tease, then each scene's opening shot and the rest as it happened, its reaction last.
  const ordered: Item[] = [...hookItems]
  for (const sceneId of sceneOrder) {
    const own = kept.filter((i) => i.scene === sceneId)
    if (own.length === 0) continue
    const opening = own.find((i) => i.role === 'establishing')
    const rest = own.filter((i) => i !== opening).sort((a, b) => a.at - b.at)
    const reactions = rest.filter((i) => i.role === 'reaction')
    const last = reactions.length && rest[rest.length - 1].role !== 'reaction' ? [reactions[reactions.length - 1]] : []
    ordered.push(...(opening ? [opening] : []), ...rest.filter((i) => !last.includes(i)), ...last)
  }
  if (closeItem) ordered.push(closeItem)

  if (opts.musicBeats && opts.musicBeats.length > 2) onTheBeat(ordered, opts.musicBeats)

  const beats: StoryBeat[] = ordered.map((i) => toBeat(i, clipById.get(i.clip)))
  const totalSec = round3(ordered.reduce((s, i) => s + i.len, 0))
  return { beats, totalSec, highlight: highlight?.id ?? null, short }
}

/**
 * Each shot made to end on a beat: the beat nearest where it would end if
 * every shot so far had run its planned length, so rounding never piles up.
 * Talking keeps its own length; the shot after it takes up the difference.
 */
export function onTheBeat(
  items: { len: number; minLen: number; maxLen: number; unit?: unknown }[],
  beats: number[]
): void {
  let planned = 0
  let clock = 0
  for (const item of items) {
    planned += item.len
    if (item.unit) {
      clock += item.len
      continue
    }
    const lo = clock + item.minLen
    const hi = clock + item.maxLen
    let best: number | null = null
    for (const b of beats) {
      if (b < lo - 1e-6 || b > hi + 1e-6) continue
      if (best === null || Math.abs(b - planned) < Math.abs(best - planned)) best = b
    }
    if (best !== null) item.len = best - clock
    clock += item.len
  }
}

function toBeat(item: Item, clip: Clip | undefined): StoryBeat {
  if (item.unit) {
    return {
      clip: item.clip,
      role: item.role,
      scene: clip?.scene ?? null,
      moment: null,
      inSec: null,
      outSec: null,
      from: item.unit.from,
      to: item.unit.to
    }
  }
  const m = item.moment as Moment
  const len = item.len
  // An opening shot starts where its moment does, as the place comes into view; any
  // other is cut around its peak, a little more after it than before.
  const from = item.role === 'establishing' ? item.room[0] : m.peakSec - 0.4 * len
  const start = clamp(from, item.room[0], Math.max(item.room[0], item.room[1] - len))
  return {
    clip: item.clip,
    role: item.role,
    scene: clip?.scene ?? null,
    moment: m.id,
    inSec: round3(start),
    outSec: round3(Math.min(item.room[1], start + len)),
    from: null,
    to: null
  }
}

/**
 * A length the footage supports: about a seventh of the usable footage that
 * is not talking, as editors keep 15% of a shoot, plus most of the talking,
 * between half a minute and twelve minutes.
 */
export function naturalLength(moments: Moment[], units: TalkUnit[], clips: Clip[]): number {
  const usable = new Set(clips.filter((c) => !c.left).map((c) => c.id))
  const heard = new Set(units.map((u) => u.clip))
  const visual = moments
    .filter((m) => usable.has(m.clip) && !(m.kind === 'talk' && heard.has(m.clip)))
    .reduce((s, m) => s + (m.outSec - m.inSec), 0)
  const talking = units.filter((u) => usable.has(u.clip)).reduce((s, u) => s + u.sec, 0)
  const sec = 0.15 * visual + 0.7 * talking
  return Math.round(clamp(sec, 30, 720) / 5) * 5
}
