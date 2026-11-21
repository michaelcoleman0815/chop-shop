import type { Resolved, ResolvedWord } from '../edit/resolve'
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
  covers?: CaptionCover[]
}

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
  if (position === 'middle') return { x: middle, y: H * 0.45 - height / 2 }
  if (position === 'bottom') return { x: middle, y: lowest }
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

/** A word as a caption shows it: without the full stop or comma it was transcribed with, abbreviations aside. */
const shown = (text: string): string =>
  /\..*\./.test(text) ? text : text.replace(/[.,;:]+(["')\]’”]*)$/, '$1') || text

/** The look of hierarchy pages in a frame: sizes, wrap width, and how long a big line may run. */
export function hierarchyLook(frame: Frame): { big: number; small: number; maxWidth: number; maxBigChars: number } {
  const vertical = frame.shape === 'vertical'
  // Sizes from the look this follows: the big line about a tenth of the frame's short side, the small one two thirds of it.
  const big = (vertical ? 86 : 96) * frame.u
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
  const split = splitPage(page, emphasis, maxBigChars)
  const lines = split.at > 0 && split.at < page.length ? 2 : 1
  return big * 1.04 * (lines === 2 ? 1 + small : 1)
}

/**
 * One hierarchy page as a text layer: its top centred on `at`, on screen from
 * `start` to `end`, each word fading up out of a blur as it is said.
 */
export function hierarchyPage(
  page: ResolvedWord[],
  start: number,
  end: number,
  at: { x: number; y: number },
  opts: { frame: Frame; theme: MotionTheme; uppercase?: boolean; emphasis?: Record<string, number> }
): TextLayer {
  const { frame, theme } = opts
  const u = frame.u
  const { big, small, maxWidth, maxBigChars } = hierarchyLook(frame)
  const split = splitPage(page, opts.emphasis, maxBigChars)
  const isBig = (i: number): boolean => (split.big === 'first' ? i < split.at : i >= split.at)
  // The small line hangs from the big one's start when it leads, and tucks under its end when it trails.
  const smallAlign = split.big === 'first' ? ('right' as const) : ('left' as const)
  const spans: Span[] = page.map((w, i) => ({
    text: `${i === split.at && i > 0 ? '\n' : ''}${shown(w.text)}`,
    t: Math.max(0, w.outStart - start),
    scale: isBig(i) ? 1 : small,
    weight: isBig(i) ? 600 : 500,
    align: isBig(i) ? 'left' : smallAlign
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
    fill: theme.text,
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

/** The look of boxed pages in a frame: the size, the wrap width, and the box that follows the spoken word. */
export function boxedLook(frame: Frame): { size: number; maxWidth: number; lineHeight: number } {
  const vertical = frame.shape === 'vertical'
  const safeWidth = frame.width - frame.safe.left - frame.safe.right
  return {
    size: (vertical ? 76 : 68) * frame.u,
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

/** Captions the graphics draw, as text layers, one a page, on the output clock. Empty unless the cut asks for them. */
export function captionLayers(input: CaptionInput): Layer[] {
  const { spec, resolved, frame, theme } = input
  if (!drawsCaptions(spec) || resolved.words.length === 0) return []
  const boxed = spec.preset === 'boxed'
  const maxWidth = boxed ? boxedLook(frame).maxWidth : hierarchyLook(frame).maxWidth
  const maxWords = boxed
    ? Math.max(2, Math.min(5, spec.wordsPerScreen + 1))
    : Math.max(3, Math.min(8, spec.wordsPerScreen * 2))
  const covers = input.covers ?? []
  const pages = hierarchyPages(resolved.words, maxWords)
  const layers: Layer[] = []

  pages.forEach((page, pi) => {
    const next = pages[pi + 1]
    let start = Math.max(0, page[0].outStart - 0.06)
    const said = page[page.length - 1].outEnd
    let end = Math.min(said + 0.6, next ? next[0].outStart - 0.06 : Infinity, input.duration)
    // A card with its own words holds the screen: the page waits, or stops short.
    for (const c of covers.filter((c) => c.kind === 'card')) {
      if (start >= c.start && start < c.end) start = c.end
      if (start < c.start && end > c.start) end = c.start
    }
    if (end - start < 0.2) return
    const backdrop = covers.some((c) => c.kind === 'backdrop' && start >= c.start - 0.05 && start < c.end)
    const height = boxed
      ? boxedHeight(page, frame, theme, spec.uppercase)
      : pageHeight(page, frame, input.emphasis)
    const at = placePage(frame, spec.position, facesNear(input.faces, start), height, maxWidth / 2, backdrop)
    layers.push(
      boxed
        ? boxedPage(page, start, end, at, { frame, theme, uppercase: spec.uppercase })
        : hierarchyPage(page, start, end, at, { frame, theme, uppercase: spec.uppercase, emphasis: input.emphasis })
    )
  })
  return layers
}
