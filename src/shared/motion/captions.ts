import type { Resolved, ResolvedWord } from '../edit/resolve'
import type { KeyLook } from '../edit/schema'
import type { CaptionSpec } from '../edit/schema'
import { onColor, tail } from './anim'
import { textWidth } from './templates/measure'
import type { Frame, MotionTheme } from './theme'
import type { Layer, Span, TextLayer } from './types'

/**
 * Captions the graphics draw, in place of the subtitle pass, when the cut's
 * caption preset is one of these looks.
 *
 * Hierarchy: each page is two lines, a small one and a big one holding the
 * key words. Words fade up out of a slight blur as they are said, white with
 * a soft shadow and no box, in sentence case. A page sits on the speaker's
 * chest, below their face; without face boxes it sits low in the middle.
 */

export interface MotionCaptionLook {
  id: string
  name: string
  /** What turning it on does, in the reply's words. */
  phrase: string
}

export const MOTION_CAPTION_LOOKS: MotionCaptionLook[] = [
  {
    id: 'hierarchy',
    name: 'Hierarchy',
    phrase: 'captions come in word by word, in two lines with the key words big'
  },
  {
    // Boxed: a few words a page, and the word being said in a solid box of the brand's accent.
    id: 'boxed',
    name: 'Boxed',
    phrase: 'captions come a few words at a time, with the word being said in a box of your accent colour'
  },
  {
    // Pop: Impaulsive's slanted captions, moving: each word springs up as it is said and is lit while it is.
    id: 'pop',
    name: 'Pop',
    phrase:
      'captions come a few words at a time in a heavy slanted face, each word popping up as it is said and lit yellow while it is, with the key words kept yellow'
  }
]

export function motionCaptionLook(preset: string | undefined): MotionCaptionLook | null {
  return MOTION_CAPTION_LOOKS.find((l) => l.id === preset) ?? null
}

/** The graphics draw these captions, so the subtitle pass leaves them out. */
export function drawsCaptions(spec: Pick<CaptionSpec, 'on' | 'preset'>): boolean {
  return spec.on && motionCaptionLook(spec.preset) !== null
}

/** A face in the frame, as fractions of its width and height. */
export interface FaceBox {
  x: number
  y: number
  w: number
  h: number
}

/** The faces in frame at a moment of output time. */
export interface FaceSample {
  t: number
  faces: FaceBox[]
}

/** Output time a full-frame graphic holds the screen, and what that means for captions. */
export interface CaptionCover {
  start: number
  end: number
  /** backdrop: the picture is replaced, captions move to the middle. card: the card has its own words, captions wait. */
  kind: 'backdrop' | 'card'
}

/**
 * A stretch of the frame's height, in pixels, a graphic holds over the speaker's picture while it is up (a
 * keyword pop), on the output clock: a page that would run under it moves out of its way, or waits for it.
 */
export interface CaptionBand {
  start: number
  end: number
  top: number
  bottom: number
}

export interface CaptionInput {
  spec: CaptionSpec
  resolved: Resolved
  frame: Frame
  theme: MotionTheme
  duration: number
  /** Faces through the cut, from face tracking. Captions keep off them. */
  faces?: FaceSample[]
  /** How strongly each word is stressed, 0 to 1, by word id. The most stressed run goes big. */
  emphasis?: Record<string, number>
  /** Who says each word, by word id (shared/speakers): another voice than the one heard most is set in OTHER_VOICE. */
  speakers?: Record<string, number>
  covers?: CaptionCover[]
  bands?: CaptionBand[]
  /** Words said over a split, by id, with where their page's foot sits as a share of the height (SEAM_FRAC). */
  sits?: Record<string, number>
}

/**
 * The colour of a page said by someone other than the voice heard most, as The Diary of a CEO sets its
 * host's questions in yellow under the guest's white, so a cut to the other chair reads at once.
 */
export const OTHER_VOICE = '#F6D04D'

const SENTENCE_END = /[.!?…]["')\]’”]*$/
const CLAUSE_END = /[,;:—–]["')\]’”]*$/

/**
 * Pages of at most `maxWords`. Sentences, cuts between beats and pauses
 * always end a page; a longer sentence is shared out over as few pages as
 * fit, as evenly as it can be, breaking after commas and content words
 * rather than after small words like "to" or "the". A page too quick to
 * read joins the next one in the same beat.
 */
export function hierarchyPages(words: ResolvedWord[], maxWords: number): ResolvedWord[][] {
  const runs: ResolvedWord[][] = []
  let run: ResolvedWord[] = []
  words.forEach((w, i) => {
    run.push(w)
    const next = words[i + 1]
    const seam = !next || next.beat !== w.beat || next.outStart - w.outEnd > 0.3
    if (seam || SENTENCE_END.test(w.text)) {
      runs.push(run)
      run = []
    }
  })
  const pages = runs.flatMap((r) => shareOut(r, Math.max(1, maxWords)))
  const out: ResolvedWord[][] = []
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const next = pages[i + 1]
    const quick = next !== undefined && next[0].outStart - page[0].outStart < 0.4
    if (quick && next[0].beat === page[page.length - 1].beat && page.length + next.length <= maxWords + 2) {
      pages[i + 1] = [...page, ...next]
    } else out.push(page)
  }
  return out
}

/** How much a page ending on this word costs: nothing after a comma, most after a small word. */
function breakCost(word: ResolvedWord): number {
  if (CLAUSE_END.test(word.text)) return 0
  return STOP.has(clean(word.text)) ? 3 : 0.5
}

function shareOut(run: ResolvedWord[], maxWords: number): ResolvedWord[][] {
  const n = run.length
  if (n <= maxWords) return [run]
  const count = Math.ceil(n / maxWords)
  const even = n / count
  // cost[k][i]: the cheapest way to put the first i words on k pages.
  const cost = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(Infinity))
  const from = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(-1))
  cost[0][0] = 0
  for (let k = 1; k <= count; k++)
    for (let i = 1; i <= n; i++)
      for (let size = 1; size <= Math.min(maxWords, i); size++) {
        const j = i - size
        if (!Number.isFinite(cost[k - 1][j])) continue
        const c = cost[k - 1][j] + 0.3 * (size - even) ** 2 + (i < n ? breakCost(run[i - 1]) : 0)
        if (c < cost[k][i]) {
          cost[k][i] = c
          from[k][i] = j
        }
      }
  const pages: ResolvedWord[][] = []
  let i = n
  for (let k = count; k > 0; k--) {
    const j = from[k][i]
    pages.unshift(run.slice(j, i))
    i = j
  }
  return pages
}

const STOP = new Set(
  (
    'a an the and or but so to of in on at for with by from as into about is are was were be been being am ' +
    "it it's its this that these those there here i i'm i've i'll you you're you'll your we we're our they " +
    "they're their he she him her his them me my us do does did done have has had will would can could " +
    'should may might must just really very then once than what when where who how if not no oh um uh ' +
    'like gonna wanna kind sort get got let lets'
  ).split(' ')
)

const clean = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'$€£%]/gu, '')

/** How much a word carries on its own: numbers most, then names, then content words; small words least. */
export function importance(text: string, first: boolean): number {
  const w = clean(text)
  if (!w) return 0
  if (/[\d$€£%]/.test(w)) return 1.6
  if (STOP.has(w)) return 0.15
  const name = !first && /^\p{Lu}/u.test(text.trim())
  return (name ? 1.2 : 0.8) + Math.min(0.5, w.length * 0.04)
}

export interface PageSplit {
  /** Words before this index are the first line. Equal to the page's length for one line. */
  at: number
  /** Which line is big. */
  big: 'first' | 'second'
}

/**
 * Which run of a page goes big: the start or the end of the page, whichever
 * carries most per word, short enough to stay one line. Stress from the voice
 * decides when it is known; otherwise the words themselves do.
 */
export function splitPage(
  words: Pick<ResolvedWord, 'id' | 'text'>[],
  emphasis?: Record<string, number>,
  maxBigChars = 16
): PageSplit {
  const n = words.length
  if (n <= 1) return { at: n, big: 'first' }
  const score = words.map((w, i) => {
    const heard = emphasis?.[w.id]
    const own = importance(w.text, i === 0)
    return heard === undefined ? own : 2 * Math.max(0, Math.min(1, heard)) + 0.25 * own
  })
  let best: (PageSplit & { score: number }) | null = null
  for (let at = 1; at < n; at++) {
    for (const big of ['second', 'first'] as const) {
      const [a, b] = big === 'first' ? [0, at] : [at, n]
      const run = words.slice(a, b)
      const chars = run.reduce((s, w) => s + w.text.length, 0) + run.length - 1
      const carried = score.slice(a, b).reduce((s, x) => s + x, 0)
      let total = carried / (run.length + 0.6) - 0.06 * Math.max(0, n - run.length - 3)
      // The big line reads after a lead-in by default.
      if (big === 'second') total += 0.02
      if (chars > maxBigChars) total -= 1 + (chars - maxBigChars) * 0.05
      if (!best || total > best.score) best = { at, big, score: total }
    }
  }
  return { at: best!.at, big: best!.big }
}

/** The faces nearest a moment, within two seconds. */
export function facesNear(samples: FaceSample[] | undefined, t: number): FaceBox[] {
  if (!samples || samples.length === 0) return []
  let best: FaceSample | null = null
  for (const s of samples) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s
  return best && Math.abs(best.t - t) <= 2 ? best.faces.filter((f) => f.w > 0 && f.h > 0) : []
}

/**
 * Where a page's block goes: centred on x, its top at y. On the chest it sits
 * under the biggest face, the speaker's, and below any face it would cross.
 */
function placePage(
  frame: Frame,
  position: CaptionSpec['position'],
  faces: FaceBox[],
  height: number,
  halfWidth: number,
  backdrop: boolean
): { x: number; y: number } {
  const W = frame.width
  const H = frame.height
  const lowest = H - frame.safe.bottom - height
  const middle = W / 2
  if (backdrop) return { x: middle, y: H * 0.5 - height / 2 }
  if (position === 'top') return { x: middle, y: frame.safe.top + H * 0.02 }
  // On a wide frame, along the foot and nowhere higher: the chest is the middle of the picture there.
  if (position === 'bottom' || frame.shape === 'wide') return { x: middle, y: lowest }
  if (position === 'middle') return { x: middle, y: H * 0.45 - height / 2 }
  const resting = H * (frame.shape === 'vertical' ? 0.6 : 0.62)
  if (faces.length === 0) return { x: middle, y: Math.min(resting, lowest) }
  const speaker = faces.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a))
  const minX = frame.safe.left + halfWidth
  const maxX = Math.max(minX, W - frame.safe.right - halfWidth)
  const x = Math.min(maxX, Math.max(minX, (speaker.x + speaker.w / 2) * W))
  let y = (speaker.y + speaker.h + speaker.h * 0.35) * H
  for (const f of faces) {
    const crossesX = (f.x + f.w) * W > x - halfWidth && f.x * W < x + halfWidth
    const crossesY = (f.y + f.h) * H > y && f.y * H < y + height
    if (crossesX && crossesY) y = (f.y + f.h * 1.1) * H
  }
  return { x, y: Math.min(y, lowest) }
}

/** Room kept between a page and a graphic it steps aside for, as a share of the frame's height. */
const BAND_GAP = 0.015

/** The graphics up while a page is, across where it would sit (CaptionBand). */
function crossing(bands: CaptionBand[], start: number, end: number, y: number, height: number, frame: Frame): CaptionBand[] {
  const gap = frame.height * BAND_GAP
  return bands.filter((b) => b.start < end && b.end > start && b.top - gap < y + height && b.bottom + gap > y)
}

/**
 * Where a page goes to keep out of the graphics across its place: just under them, inside the safe area, or
 * just over them, where the faces are known and it keeps off every one (where they are not known, over a
 * graphic low in the frame may be over the speaker's mouth). The nearer of the two to where it was; null when
 * neither is clear.
 */
function stepAside(
  bands: CaptionBand[],
  start: number,
  end: number,
  at: { x: number; y: number },
  height: number,
  halfWidth: number,
  frame: Frame,
  faces: FaceBox[]
): number | null {
  const H = frame.height
  const W = frame.width
  const gap = H * BAND_GAP
  const under = crossing(bands, start, end, at.y, height, frame)
  const offFaces = (y: number): boolean =>
    faces.every((f) => (f.y + f.h) * H <= y || f.y * H >= y + height || (f.x + f.w) * W <= at.x - halfWidth || f.x * W >= at.x + halfWidth)
  const clear = (y: number): boolean =>
    y >= frame.safe.top && y + height <= H - frame.safe.bottom && crossing(bands, start, end, y, height, frame).length === 0 && offFaces(y)
  const below = Math.max(...under.map((b) => b.bottom)) + gap
  const above = Math.min(...under.map((b) => b.top)) - gap - height
  // A wide frame's captions wait for a graphic along the foot rather than climbing over it.
  const options = [below, ...(faces.length > 0 && frame.shape !== 'wide' ? [above] : [])].filter(clear)
  if (options.length === 0) return null
  return options.reduce((a, b) => (Math.abs(b - at.y) < Math.abs(a - at.y) ? b : a))
}

/** A word as a caption shows it: without the full stop or comma it was transcribed with, abbreviations aside. */
const shown = (text: string): string =>
  /\..*\./.test(text) ? text : text.replace(/[.,;:]+(["')\]’”]*)$/, '$1') || text

/** The look of hierarchy pages in a frame: sizes, wrap width, and how long a big line may run. */
export function hierarchyLook(frame: Frame): { big: number; small: number; maxWidth: number; maxBigChars: number } {
  const vertical = frame.shape === 'vertical'
  // Sizes from the look this follows: the big line about a tenth of the frame's short side, the small one two thirds of it.
  const big = (vertical ? 86 : 96) * frame.u * sized(frame)
  const safeWidth = frame.width - frame.safe.left - frame.safe.right
  const maxWidth = vertical ? safeWidth * 0.94 : frame.shape === 'wide' ? frame.width * 0.46 : safeWidth * 0.8
  return { big, small: 0.68, maxWidth, maxBigChars: Math.max(8, Math.floor(maxWidth / (big * 0.58))) }
}

/** One page's height, for placing it before it is laid out. */
export function pageHeight(
  page: Pick<ResolvedWord, 'id' | 'text'>[],
  frame: Frame,
  emphasis?: Record<string, number>
): number {
  const { big, small, maxBigChars } = hierarchyLook(frame)
  if (plainPage(page, emphasis)) return big * 1.04 * PLAIN
  const split = splitPage(page, emphasis, maxBigChars)
  const lines = split.at > 0 && split.at < page.length ? 2 : 1
  return big * 1.04 * (lines === 2 ? 1 + small : 1)
}

/** A plain page's words, as a share of the big line's size. */
const PLAIN = 0.6

/**
 * Whether a page carries none of the words the edit chose to set big: with key words chosen (a score of
 * exactly 1 against 0 for the rest), a page without one is one small centred line, as The Diary of a CEO sets
 * the lines between its big words.
 */
function plainPage(page: Pick<ResolvedWord, 'id'>[], emphasis?: Record<string, number>): boolean {
  return emphasis?.[CHOSEN] === 1 && !page.some((w) => emphasis[w.id] === 1)
}

/**
 * A key word's look on the big line, as The Diary of a CEO sets its big words: a condensed serif, larger to stand as tall, for
 * the tender and the grave ("Sanders", "horrible"), the same serif in red for horror or contempt ("insanity",
 * "narcissist"), heavy capitals for a word that hits ("CORRUPT", "THE USA").
 */
export const KEY_LOOK_STYLE: Record<KeyLook, Pick<Span, 'family' | 'color' | 'uppercase' | 'scale' | 'weight'>> = {
  serif: { family: 'Instrument Serif', scale: 1.6, weight: 400 },
  dark: { family: 'Instrument Serif', scale: 1.6, weight: 400, color: '#E5322D' },
  punch: { family: 'Inter ExtraBold', uppercase: true, scale: 0.92, weight: 800 }
}

function lookOf(look: KeyLook | undefined): Partial<Span> {
  return look ? KEY_LOOK_STYLE[look] : {}
}

/** Marks an emphasis map made from chosen key words rather than heard stress. */
const CHOSEN = '#chosen'

/**
 * One hierarchy page as a text layer: its top centred on `at`, on screen from
 * `start` to `end`, each word fading up out of a blur as it is said.
 */
export function hierarchyPage(
  page: ResolvedWord[],
  start: number,
  end: number,
  at: { x: number; y: number },
  opts: {
    frame: Frame
    theme: MotionTheme
    uppercase?: boolean
    emphasis?: Record<string, number>
    fill?: string
    looks?: Partial<Record<string, KeyLook>>
    /** The page opens the video: its first word is already in when the page starts (captionLayers). */
    landed?: boolean
  }
): TextLayer {
  const { frame, theme } = opts
  const u = frame.u
  const { big, small, maxWidth, maxBigChars } = hierarchyLook(frame)
  const plain = plainPage(page, opts.emphasis)
  const split = plain ? { at: 0, big: 'second' as const } : splitPage(page, opts.emphasis, maxBigChars)
  const isBig = (i: number): boolean => !plain && (split.big === 'first' ? i < split.at : i >= split.at)
  // The small line hangs from the big one's start when it leads, and tucks under its end when it trails.
  const smallAlign = plain ? ('center' as const) : split.big === 'first' ? ('right' as const) : ('left' as const)
  const spans: Span[] = page.map((w, i) => ({
    text: `${i === split.at && i > 0 ? '\n' : ''}${shown(w.text)}`,
    t: opts.landed && i === 0 ? 0 : Math.max(0, w.outStart - start),
    scale: isBig(i) ? 1 : plain ? PLAIN : small,
    weight: isBig(i) ? 600 : 500,
    align: isBig(i) ? 'left' : smallAlign,
    ...(isBig(i) ? lookOf(opts.looks?.[w.id]) : {})
  }))
  return {
    kind: 'text',
    start,
    end,
    text: '',
    spans,
    font: {
      family: theme.body,
      size: big,
      weight: 600,
      lineHeight: 1.04,
      tracking: -0.03 * big,
      uppercase: opts.uppercase
    },
    fill: opts.fill ?? theme.text,
    align: 'center',
    valign: 'top',
    maxWidth,
    effects: { shadow: { color: 'rgba(0, 0, 0, 0.5)', blur: 18 * u, y: 3 * u } },
    animators: [
      {
        by: 'word',
        timing: 'spoken',
        delay: -0.03,
        duration: 0.32,
        ease: 'ease-out',
        from: { opacity: 0, blur: 8 * u, y: 14 * u }
      }
    ],
    transform: { x: at.x, y: at.y, opacity: { keys: [{ t: 0, v: 1 }, ...tail([0.12, 1, 'ease-in'], [0, 0])] } }
  }
}

/**
 * A wide frame's drawn captions against a Short's: long-form captions are small, low and still, whatever look they
 * wear and wherever they were asked to stand (the owner, 2026-11-24: "never that high"). Only the top is another place.
 */
export const WIDE_DRAWN_SCALE = 0.72
const sized = (frame: Frame): number => (frame.shape === 'wide' ? WIDE_DRAWN_SCALE : 1)

/** The look of boxed pages in a frame: the size, the wrap width, and the box that follows the spoken word. */
export function boxedLook(frame: Frame): { size: number; maxWidth: number; lineHeight: number } {
  const vertical = frame.shape === 'vertical'
  const safeWidth = frame.width - frame.safe.left - frame.safe.right
  return {
    size: (vertical ? 76 : 68) * frame.u * sized(frame),
    maxWidth: vertical ? safeWidth * 0.92 : frame.shape === 'wide' ? frame.width * 0.5 : safeWidth * 0.84,
    lineHeight: 1.24
  }
}

/** A boxed page's height, near enough to place it by: one line, or two when it wraps. */
export function boxedHeight(
  page: Pick<ResolvedWord, 'text'>[],
  frame: Frame,
  theme: MotionTheme,
  uppercase = false
): number {
  const { size, maxWidth, lineHeight } = boxedLook(frame)
  const wide = textWidth(page.map((w) => shown(w.text)).join(' '), theme.display, size, uppercase)
  const lines = Math.min(3, Math.max(1, Math.ceil(wide / maxWidth)))
  return lines * size * lineHeight
}

/**
 * One boxed page as a text layer: its top centred on `at`. The page pops in
 * whole, every word white with a soft shadow, and the word being said sits
 * in a solid box of the accent that slides to the next word as it is said.
 */
export function boxedPage(
  page: ResolvedWord[],
  start: number,
  end: number,
  at: { x: number; y: number },
  opts: { frame: Frame; theme: MotionTheme; uppercase?: boolean }
): TextLayer {
  const { frame, theme } = opts
  const u = frame.u
  const { size, maxWidth, lineHeight } = boxedLook(frame)
  const height = boxedHeight(page, frame, theme, opts.uppercase)
  return {
    kind: 'text',
    start,
    end,
    text: '',
    spans: page.map((w) => ({ text: shown(w.text), t: Math.max(0, w.outStart - start), end: w.outEnd - start })),
    font: { family: theme.display, size, lineHeight, uppercase: opts.uppercase },
    fill: theme.text,
    align: 'center',
    valign: 'top',
    maxWidth,
    balance: true,
    effects: { shadow: { color: 'rgba(0, 0, 0, 0.55)', blur: 14 * u, y: 4 * u } },
    active: {
      color: onColor(theme.accent, theme.ink, '#FFFFFF'),
      box: {
        color: theme.accent,
        radius: size * 0.18,
        padX: size * 0.16,
        // Room for descenders when the words are not in capitals.
        padY: size * (opts.uppercase ? 0.14 : 0.2),
        move: 0.1
      }
    },
    transform: {
      x: at.x,
      y: at.y,
      anchorY: height / 2,
      scale: { keys: [{ t: 0, v: 0.9, ease: 'snap' }, { t: 0.18, v: 1 }] },
      opacity: { keys: [{ t: 0, v: 0 }, { t: 0.08, v: 1 }, ...tail([0.12, 1, 'ease-in'], [0, 0])] }
    }
  }
}

/**
 * Where a caption's foot sits over a split (b-roll stacked with the speaker): just above the seam between the
 * two, as Impaulsive sets its captions on the line between Logan and the match. Burned-in and drawn alike.
 */
export const SEAM_FRAC = 0.488

/** A page said quicker than this is folded into the one before it, or after, in the same beat: shown alone it would blink. */
const QUICK_PAGE_SEC = 0.3

/**
 * Pages said too quickly to read alone joined to a neighbour in the same beat, when they follow on with no
 * pause: a key word ending its page ("I did / save") had left "save" a page of 0.16 s, which never showed.
 */
export function joinQuickPages<W extends Pick<ResolvedWord, 'beat' | 'outStart' | 'outEnd'>>(pages: W[][], most = Infinity): W[][] {
  const out: W[][] = []
  for (const page of pages) {
    const quick = page[page.length - 1].outEnd - page[0].outStart < QUICK_PAGE_SEC
    const prev = out[out.length - 1]
    const fits = prev && prev.length + page.length <= most
    if (quick && prev && fits && prev[0].beat === page[0].beat && page[0].outStart - prev[prev.length - 1].outEnd < 0.3) {
      out[out.length - 1] = [...prev, ...page]
      continue
    }
    out.push(page)
  }
  // A quick page left at a beat's start goes on to the page after it instead.
  for (let i = out.length - 2; i >= 0; i--) {
    const page = out[i]
    const next = out[i + 1]
    const quick = page[page.length - 1].outEnd - page[0].outStart < QUICK_PAGE_SEC
    if (quick && page.length + next.length <= most && next[0].beat === page[0].beat && next[0].outStart - page[page.length - 1].outEnd < 0.3) {
      out.splice(i, 2, [...page, ...next])
    }
  }
  return out
}

/** The pop look's yellow, Impaulsive's: the word being said, and the key words. */
export const POP_LIT = '#FFE81A'

/** How far a slanted face leans: libass's oblique for a look set italic (FreeType's), so the two agree. */
export const OBLIQUE = 0.2126

/** The pop look in a frame: Inter ExtraBold, about the size Impaulsive sets its captions. */
export function popLook(frame: Frame): { size: number; maxWidth: number; lineHeight: number; family: string } {
  const vertical = frame.shape === 'vertical'
  const safeWidth = frame.width - frame.safe.left - frame.safe.right
  return {
    size: (vertical ? 84 : 72) * frame.u * sized(frame),
    maxWidth: vertical ? safeWidth * 0.9 : frame.shape === 'wide' ? frame.width * 0.5 : safeWidth * 0.84,
    lineHeight: 1.12,
    family: 'Inter ExtraBold'
  }
}

/** A pop page's height, near enough to place it by: one line, or two when it wraps. */
export function popHeight(page: Pick<ResolvedWord, 'text'>[], frame: Frame, uppercase = false): number {
  const { size, maxWidth, lineHeight, family } = popLook(frame)
  // The lit word is set a little bigger, and the lean runs past the last letter.
  const wide = textWidth(page.map((w) => shown(w.text)).join(' '), family, size, uppercase) * 1.08
  const lines = Math.min(3, Math.max(1, Math.ceil(wide / maxWidth)))
  return lines * size * lineHeight
}

/**
 * One pop page as a text layer, its top centred on `at`: white heavy slanted words with a thin dark edge and
 * a shadow, each springing up from small as it is said, the word being said lit yellow and a touch bigger,
 * and the key words yellow throughout.
 */
export function popPage(
  page: ResolvedWord[],
  start: number,
  end: number,
  at: { x: number; y: number },
  opts: { frame: Frame; uppercase?: boolean; keys?: Set<string>; landed?: boolean }
): TextLayer {
  const { frame } = opts
  const u = frame.u
  const { size, maxWidth, lineHeight, family } = popLook(frame)
  const height = popHeight(page, frame, opts.uppercase)
  return {
    kind: 'text',
    start,
    end,
    text: '',
    spans: page.map((w, i) => ({
      text: shown(w.text),
      t: opts.landed && i === 0 ? 0 : Math.max(0, w.outStart - start),
      end: w.outEnd - start,
      ...(opts.keys?.has(w.id) ? { color: POP_LIT } : {})
    })),
    // The lean carries a word's top into the space after it, and the lit word grows into both: room for both.
    font: { family, size, weight: 800, lineHeight, slant: OBLIQUE, wordSpacing: size * 0.14, uppercase: opts.uppercase },
    fill: '#FFFFFF',
    stroke: { color: 'rgba(0, 0, 0, 0.8)', width: 2.5 * u, join: 'round' },
    align: 'center',
    valign: 'top',
    maxWidth,
    balance: true,
    effects: { shadow: { color: 'rgba(0, 0, 0, 0.55)', blur: 10 * u, y: 5 * u } },
    active: { color: POP_LIT, scale: 1.06 },
    animators: [
      {
        by: 'word',
        timing: 'spoken',
        delay: -0.04,
        duration: 0.22,
        // A light spring: a bigger one swings a slanted word into its neighbour as it lands.
        ease: { spring: 0.3 },
        from: { opacity: 0, scale: 0.55, y: 16 * u }
      }
    ],
    transform: {
      x: at.x,
      y: at.y,
      anchorY: height / 2,
      opacity: { keys: [{ t: 0, v: 1 }, ...tail([0.1, 1, 'ease-in'], [0, 0])] }
    }
  }
}

/** Captions the graphics draw, as text layers, one a page, on the output clock. Empty unless the cut asks for them. */
/**
 * A first word said this soon after the video starts has its caption up from the first frame, drawn or burned
 * in (shared/subtitles styleCues). That frame is the video's face in a feed and the still it is shared with,
 * and the top Shorts never open on a bare picture; a caption appearing a few frames in also reads as a
 * flicker. Kept short: words said under an opening card are not captioned, so a first caption this early
 * means nothing covers the start.
 */
export const OPEN_SEC = 0.6

/** How long before the video starts an opening page starts: longer than a word takes to land (0.32 s less 0.03). */
const LANDED_SEC = 0.35

export function captionLayers(input: CaptionInput): Layer[] {
  const { spec, resolved, theme } = input
  // A size asked for scales every size the look takes from the frame (CaptionSpec.size); widths and places stay.
  const frame = spec.size && spec.size !== 1 ? { ...input.frame, u: input.frame.u * spec.size } : input.frame
  if (!drawsCaptions(spec) || resolved.words.length === 0) return []
  const boxed = spec.preset === 'boxed'
  const pop = spec.preset === 'pop'
  const maxWidth = boxed ? boxedLook(frame).maxWidth : pop ? popLook(frame).maxWidth : hierarchyLook(frame).maxWidth
  const maxWords = boxed
    ? Math.max(2, Math.min(5, spec.wordsPerScreen + 1))
    : pop
      ? Math.max(2, Math.min(5, spec.wordsPerScreen))
      : Math.max(3, Math.min(8, spec.wordsPerScreen * 2))
  const covers = input.covers ?? []
  // Key words the edit chose go big, and only they; otherwise the stress heard, or each word's own weight.
  const chosen = [...(spec.keys ?? []), ...Object.keys(spec.keyLooks ?? {})]
  const pages = joinQuickPages(endOnKeys(hierarchyPages(resolved.words, maxWords), new Set(chosen)), maxWords)
  const emphasis = chosen.length ? chosenEmphasis(resolved.words, chosen) : input.emphasis
  const other = otherVoice(resolved.words, input.speakers)
  const layers: Layer[] = []

  // The first page is up on the first frame when its first word is said that soon and no card holds the
  // opening (OPEN_SEC): started early enough that its first word has landed by then.
  const opens =
    pages.length > 0 &&
    pages[0][0].outStart <= OPEN_SEC &&
    !covers.some((c) => c.kind === 'card' && c.start <= OPEN_SEC)
  pages.forEach((page, pi) => {
    const next = pages[pi + 1]
    const landed = opens && pi === 0
    let start = landed ? -LANDED_SEC : Math.max(0, page[0].outStart - 0.06)
    const said = page[page.length - 1].outEnd
    let end = Math.min(said + 0.6, next ? next[0].outStart - 0.06 : Infinity, input.duration)
    // A card with its own words holds the screen: the page waits, or stops short.
    for (const c of covers.filter((c) => c.kind === 'card')) {
      if (start >= c.start && start < c.end) start = c.end
      if (start < c.start && end > c.start) end = c.start
    }
    if (end - start < 0.2) return
    const height = boxed
      ? boxedHeight(page, frame, theme, spec.uppercase)
      : pop
        ? popHeight(page, frame, spec.uppercase)
        : pageHeight(page, frame, emphasis)
    // Where it shows from: an opening page starts before the video does.
    const placed = (): { at: { x: number; y: number }; backdrop: boolean; faces: FaceBox[] } => {
      const shows = Math.max(0, start)
      const backdrop = covers.some((c) => c.kind === 'backdrop' && shows >= c.start - 0.05 && shows < c.end)
      const faces = facesNear(input.faces, shows)
      // Over a split, on its seam, as the burned-in captions sit there too.
      const sit = page.map((w) => input.sits?.[w.id]).find((s) => s !== undefined)
      if (sit !== undefined && !backdrop) return { at: { x: frame.width / 2, y: sit * frame.height - height }, backdrop, faces: [] }
      return { at: placePage(frame, spec.position, faces, height, maxWidth / 2, backdrop), backdrop, faces }
    }
    let { at, backdrop, faces } = placed()
    // A graphic across the picture (a keyword pop) where the page would sit: the page steps out of its way, or
    // waits for it to go, or stops short as it comes.
    const under = crossing(input.bands ?? [], start, end, at.y, height, frame)
    if (under.length > 0 && !backdrop) {
      const aside = stepAside(input.bands ?? [], start, end, at, height, maxWidth / 2, frame, faces)
      if (aside !== null) at = { ...at, y: aside }
      else {
        for (const b of under) {
          if (start >= b.start) start = Math.max(start, b.end)
          else end = Math.min(end, b.start)
        }
        if (end - start < 0.2) return
        ;({ at, backdrop, faces } = placed())
      }
    }
    const seated = page.map((w) => input.sits?.[w.id]).find((s) => s !== undefined)
    const footed = (l: TextLayer): TextLayer =>
      seated === undefined || backdrop
        ? l
        : {
            ...l,
            valign: 'bottom',
            transform: {
              ...l.transform,
              y: seated * frame.height,
              ...(typeof l.transform?.anchorY === 'number' ? { anchorY: -l.transform.anchorY } : {})
            }
          }
    layers.push(
      footed(boxed
        ? boxedPage(page, start, end, at, { frame, theme, uppercase: spec.uppercase })
        : pop
          ? popPage(page, start, end, at, { frame, uppercase: spec.uppercase, keys: new Set(chosen), landed })
          : hierarchyPage(page, start, end, at, {
            frame,
            theme,
            uppercase: spec.uppercase,
            emphasis,
            looks: spec.keyLooks,
            fill: other !== null && voiceOf(page, input.speakers) === other ? OTHER_VOICE : undefined,
            landed
          }))
    )
  })
  return layers
}

/** The chosen key words as emphasis: 1 for each, 0 for the rest, marked as chosen. */
function chosenEmphasis(words: Pick<ResolvedWord, 'id'>[], keys: string[]): Record<string, number> {
  const chosen = new Set(keys)
  return Object.fromEntries([[CHOSEN, 1], ...words.map((w) => [w.id, chosen.has(w.id) ? 1 : 0])])
}

/** How many of the cut's words a second voice must say to be set apart: fewer is a slip of the voice finder. */
const OTHER_SHARE = 0.08

/** How many words each voice says, most first. */
function voices(words: Pick<ResolvedWord, 'id'>[], speakers?: Record<string, number>): [number, number][] {
  const count = new Map<number, number>()
  for (const w of words) {
    const s = speakers?.[w.id]
    if (s !== undefined) count.set(s, (count.get(s) ?? 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])
}

/**
 * The voice set apart: the one heard second most, when it says at least OTHER_SHARE of the words. A voice
 * heard less (the finder splitting one person in a few raised words) stays in the text colour.
 */
function otherVoice(words: Pick<ResolvedWord, 'id'>[], speakers?: Record<string, number>): number | null {
  const [, second] = voices(words, speakers)
  return second && second[1] >= OTHER_SHARE * words.length ? second[0] : null
}

/** Who says most of a page, or null when nobody is known. */
function voiceOf(page: Pick<ResolvedWord, 'id'>[], speakers?: Record<string, number>): number | null {
  return voices(page, speakers)[0]?.[0] ?? null
}

/**
 * Pages broken after each chosen key word that falls mid-page, so the word can close its page on the big
 * line ("certainly had a big / impact"), rather than a page whose big line must run on past it ("impact on my
 * life.", too long for one line) setting other words big instead.
 */
function endOnKeys(pages: ResolvedWord[][], chosen: Set<string>): ResolvedWord[][] {
  if (chosen.size === 0) return pages
  return pages.flatMap((page) => {
    const out: ResolvedWord[][] = []
    let from = 0
    page.forEach((w, i) => {
      // After the last of a run of key words ("truck driver"), never inside it.
      if (chosen.has(w.id) && !chosen.has(page[i + 1]?.id) && i > from && i < page.length - 1) {
        out.push(page.slice(from, i + 1))
        from = i + 1
      }
    })
    out.push(page.slice(from))
    return out
  })
}
