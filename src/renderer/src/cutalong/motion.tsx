import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { currentVersion } from '../../../shared/edit'
import { fileName, isVideoFile } from './format'
import type { Cutalong } from './useCutalong'

/**
 * How Cutalong moves, where it takes script. motion.css does most of it
 * (hover, press, arrivals, the march); this module holds what CSS cannot:
 * screen changes, the rail and new versions as View Transitions, the
 * segmented control's sliding pill, list items that collapse when removed,
 * toasts that fall away, and the progress fill. The rules are in the
 * cutalong-ui skill under Motion; every duration and curve is a token.
 */

// ---------- Reduced motion ----------

const REDUCE = '(prefers-reduced-motion: reduce)'

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCE).matches
}

function onReducedMotionChange(cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(REDUCE)
  query.addEventListener('change', cb)
  return () => query.removeEventListener('change', cb)
}

/** True when the person has asked their system for less motion. Opacity still changes; nothing travels. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(onReducedMotionChange, prefersReducedMotion, () => false)
}

// ---------- Tokens, read from the stylesheet so script and CSS never disagree ----------

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).replace(/\s+/g, ' ').trim()
}

function ms(name: string): number {
  const value = token(name)
  const n = parseFloat(value)
  if (!Number.isFinite(n)) return 0
  return value.endsWith('ms') ? n : value.endsWith('s') ? n * 1000 : n
}

// ---------- View Transitions ----------

/** What a View Transition is moving; motion.css names what travels for each. */
export type Move = 'screen' | 'rail' | 'version'

let latest = 0
const named = new Set<HTMLElement>()

function canTransition(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof document.startViewTransition === 'function' &&
    document.visibilityState === 'visible'
  )
}

/** Gives one element a view-transition-name for the transition in flight. */
function name(el: HTMLElement, value: string): void {
  el.style.viewTransitionName = value
  named.add(el)
}

function unname(): void {
  for (const el of named) el.style.viewTransitionName = ''
  named.clear()
  const root = document.documentElement.style
  for (const end of ['from', 'to']) {
    root.removeProperty(`--cl-footage-${end}-radius`)
    root.removeProperty(`--cl-footage-${end}-shadow`)
  }
}

/**
 * Keeps focus where a person can find it. The composer hands focus to the
 * next screen's composer; focus on something that went away moves to the new
 * screen's composer, or its first control, never to the page itself.
 */
function keepFocus(update: () => void): () => void {
  const before = document.activeElement
  const inComposer = before?.id === 'cl-ask'
  update()
  return () => {
    const now = document.activeElement
    const lost = !now || now === document.body || !now.isConnected
    if (!lost && !(inComposer && now !== document.getElementById('cl-ask'))) return
    const target =
      document.getElementById('cl-ask') ??
      document.querySelector<HTMLElement>(
        '.cl-main :is(button, [href], input, textarea, select, [tabindex]):not([disabled]):not([tabindex="-1"])'
      )
    target?.focus({ preventScroll: true })
  }
}

/**
 * Runs `update` inside a View Transition. `update` must change the DOM before
 * it returns (wrap React state in flushSync). The kind is set on <html> as
 * data-cl-move while the transition runs, so motion.css can name what
 * travels; a screen change also sets data-cl-entering, which staggers lists in
 * and keeps messages already on the new screen still.
 */
export function viewTransition(
  kind: Move,
  update: () => void,
  shared: { before?: () => void; after?: () => void } = {}
): void {
  if (!canTransition()) {
    keepFocus(update)()
    return
  }
  const root = document.documentElement
  const id = ++latest
  unname()
  root.dataset.clMove = kind
  if (kind === 'screen') root.dataset.clEntering = ''
  else delete root.dataset.clEntering
  shared.before?.()
  const done = (): void => {
    if (id !== latest) return
    delete root.dataset.clMove
    delete root.dataset.clEntering
    unname()
  }
  try {
    const t = document.startViewTransition({
      update: () => {
        keepFocus(update)()
        shared.after?.()
      },
      types: [kind]
    })
    // A transition skipped by a newer one still updates the DOM; only its animation is dropped.
    t.ready.catch(() => undefined)
    t.finished.then(done, done)
  } catch {
    done()
    keepFocus(update)()
  }
}

/** Opens or closes the rail: names and chats fade and slide while the main column glides to its new place. */
export function moveRail(update: () => void): void {
  viewTransition('rail', () => flushSync(update))
}

// ---------- Screen changes ----------

/** What the main column shows. A new screen or chat is a screen change; a new version is a version change. */
function sceneOf(app: Cutalong): string {
  const chat = app.messages[0]?.id ?? app.doc?.id ?? ''
  const version = app.screen === 'editor' && app.doc ? currentVersion(app.doc).n : 0
  return `${app.screen}|${chat}|${version}`
}

function moveBetween(from: string, to: string): Move | null {
  if (from === to) return null
  const [a, b] = [from.split('|'), to.split('|')]
  return a[0] !== b[0] || a[1] !== b[1] ? 'screen' : 'version'
}

/** Where a pointer or Enter last landed, so a screen change knows which card opened it. */
let activated: { el: Element; at: number } | null = null

function visibleIn(el: Element): boolean {
  const r = el.getBoundingClientRect()
  const scroller = el.closest('.cl-thread-scroll, .cl-page, .cl-start')
  const v = scroller?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
  return r.width > 0 && r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right
}

/** The footage card in a thread for this edit's recording, when it is on screen. */
function footageCard(app: Cutalong): HTMLElement | null {
  const source = app.doc ? fileName(app.doc.sources[0]?.path ?? '') : ''
  const cards = [...document.querySelectorAll<HTMLElement>('.cl-msg-user .cl-linkcard')].filter((card) =>
    isVideoFile(card.querySelector('strong')?.textContent ?? '')
  )
  const card = cards.find((c) => c.querySelector('strong')?.textContent === source) ?? cards[cards.length - 1]
  const thumb = card?.querySelector<HTMLElement>('.cl-linkcard-thumb') ?? null
  return thumb && visibleIn(thumb) ? thumb : null
}

/**
 * Names the footage for the transition and notes its corners and shadow at
 * this end, so the travelling picture keeps the right shape all the way.
 */
function footage(el: HTMLElement, end: 'from' | 'to'): void {
  const style = getComputedStyle(el)
  const root = document.documentElement.style
  // The far end starts as this one, so footage with nowhere to go keeps its shape while it fades.
  for (const at of end === 'from' ? ['from', 'to'] : ['to']) {
    root.setProperty(`--cl-footage-${at}-radius`, style.borderTopLeftRadius)
    root.setProperty(`--cl-footage-${at}-shadow`, style.boxShadow)
  }
  name(el, 'cl-footage')
}

/**
 * The elements that carry over between two screens: the composer (by CSS)
 * and the footage, which grows from the card that opened it into the editor's
 * preview, and shrinks back into the thread's footage card.
 */
function sharedFootage(from: string, to: string, app: Cutalong): { before: () => void; after: () => void } {
  const [fromScreen, toScreen] = [from.split('|')[0], to.split('|')[0]]
  let travelling = false
  return {
    before: () => {
      if (toScreen === 'editor') {
        const recent = activated && performance.now() - activated.at < 4000 ? activated.el : null
        const card = recent?.closest('.cl-project')?.querySelector<HTMLElement>('.cl-project-thumb')
        const source = card && card.isConnected ? card : fromScreen === 'thread' ? footageCard(app) : null
        if (source) {
          footage(source, 'from')
          travelling = true
        }
      } else if (fromScreen === 'editor' && toScreen === 'thread') {
        const frame = document.querySelector<HTMLElement>('.cl-frame')
        if (frame) {
          footage(frame, 'from')
          travelling = true
        }
      }
    },
    after: () => {
      if (!travelling) return
      const target = toScreen === 'editor' ? document.querySelector<HTMLElement>('.cl-frame') : footageCard(app)
      if (target) footage(target, 'to')
    }
  }
}

let installed = 0

/**
 * The app's motion, wired once at the top: screen changes and new versions
 * become View Transitions, and the segmented controls get their sliding pill.
 * Returns the session to render: while a change waits for its first frame to
 * be captured, the screen keeps showing what it showed, then changes in one
 * step inside the transition.
 */
export function useMotion(live: Cutalong): Cutalong {
  const scene = sceneOf(live)
  const [shown, setShown] = useState(scene)
  const latestScene = useRef(scene)
  latestScene.current = scene
  const latestLive = useRef(live)
  latestLive.current = live
  const held = useRef(live)
  const moving = useRef(false)
  const waiting = scene !== shown && canTransition()
  if (!waiting) held.current = live

  useLayoutEffect(() => {
    if (scene === shown || moving.current) return
    const kind = moveBetween(shown, scene)
    if (!kind || !canTransition()) {
      setShown(scene)
      return
    }
    moving.current = true
    viewTransition(
      kind,
      () => {
        moving.current = false
        flushSync(() => setShown(latestScene.current))
      },
      kind === 'screen' ? sharedFootage(shown, scene, latestLive.current) : {}
    )
  }, [scene, shown])

  useEffect(() => {
    if (installed++ > 0) return () => void installed--
    const root = document.documentElement
    // The first screen staggers in like any other.
    root.dataset.clEntering = ''
    const settle = setTimeout(
      () => {
        if (!root.dataset.clMove) delete root.dataset.clEntering
      },
      ms('duration-calm') * 2
    )
    const remember = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Enter' && e.key !== ' ') return
      if (e.target instanceof Element) activated = { el: e.target, at: performance.now() }
    }
    document.addEventListener('pointerdown', remember, true)
    document.addEventListener('keydown', remember, true)
    const stopPills = watchSegments()
    return () => {
      installed--
      clearTimeout(settle)
      document.removeEventListener('pointerdown', remember, true)
      document.removeEventListener('keydown', remember, true)
      stopPills()
    }
  }, [])

  return waiting ? held.current : live
}

// ---------- Segmented controls ----------

const sliding = new WeakMap<HTMLElement, Animation>()

/**
 * Slides the "on" pill from the old choice to the new one, on the spring. A
 * first choice, with nothing chosen before, grows its pill from its middle.
 */
function slidePill(group: HTMLElement, from: HTMLElement | undefined, to: HTMLElement): void {
  if (prefersReducedMotion() || typeof group.animate !== 'function') return
  const box = group.getBoundingClientRect()
  const round = token('radius-pill') || '999px'
  const inset = (r: DOMRect): string =>
    `inset(${r.top - box.top}px ${box.right - r.right}px ${box.bottom - r.bottom}px ${r.left - box.left}px round ${round})`
  const middle = (r: DOMRect): DOMRect =>
    new DOMRect(r.x + r.width * 0.3, r.y + r.height * 0.2, r.width * 0.4, r.height * 0.6)
  // Start from where the pill is now, so a quick second choice continues the first.
  const running = sliding.get(group)
  const start =
    running && running.playState === 'running'
      ? getComputedStyle(group, '::before').clipPath
      : inset(from ? from.getBoundingClientRect() : middle(to.getBoundingClientRect()))
  running?.cancel()
  group.classList.add('cl-sliding')
  const anim = group.animate(
    { clipPath: [start, inset(to.getBoundingClientRect())] },
    { duration: ms('duration-calm'), easing: token('spring-gentle') || 'ease', pseudoElement: '::before' }
  )
  sliding.set(group, anim)
  const end = (): void => {
    if (sliding.get(group) !== anim) return
    sliding.delete(group)
    group.classList.remove('cl-sliding')
  }
  anim.finished.then(end, end)
}

/** Watches every segmented control for its "on" choice moving, so no screen has to wire it. */
function watchSegments(): () => void {
  if (typeof MutationObserver === 'undefined') return () => undefined
  const observer = new MutationObserver((records) => {
    const off = new Map<HTMLElement, HTMLElement>()
    const on = new Map<HTMLElement, HTMLElement>()
    for (const r of records) {
      const button = r.target as HTMLElement
      const group = button.parentElement
      if (!group || !group.classList.contains('cl-segments')) continue
      const was = (r.oldValue ?? '').split(/\s+/).includes('on')
      const is = button.classList.contains('on')
      if (was && !is) off.set(group, button)
      if (!was && is) on.set(group, button)
    }
    for (const [group, to] of on) slidePill(group, off.get(group), to)
  })
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
    attributeOldValue: true
  })
  return () => observer.disconnect()
}

// ---------- Lists ----------

const collapsing = new Set<() => void>()

function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === 'auto' || y === 'scroll' || p.classList.contains('cl-main')) return p
  }
  return null
}

function hasSurface(el: HTMLElement): boolean {
  const s = getComputedStyle(el)
  return s.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(s.borderBottomWidth) > 0
}

/**
 * Removes a list item so the gap closes rather than the item vanishing: it
 * fades and slides out while everything after it rises into its place and
 * the card around it draws in, all with transforms and a clip. Then `remove`
 * runs and the layout catches up in the same frame, so nothing jumps.
 * `from` is the item, or anything inside it (a click's currentTarget).
 */
export function collapse(from: EventTarget | null, remove: () => unknown): void {
  for (const finish of [...collapsing]) finish()
  const item = from instanceof Element ? from.closest<HTMLElement>('li') : null
  const scroller = item ? scrollerOf(item) : null
  if (!item || !scroller || prefersReducedMotion() || typeof item.animate !== 'function') {
    remove()
    return
  }

  // Everything after the item, at each level up to the scroller, moves; the
  // containers with a visible surface shrink from the bottom.
  const movers: HTMLElement[] = []
  const frames: HTMLElement[] = []
  for (let node: HTMLElement = item; node !== scroller && node.parentElement; node = node.parentElement) {
    for (let s = node.nextElementSibling; s; s = s.nextElementSibling) if (s instanceof HTMLElement) movers.push(s)
    if (node !== item && hasSurface(node)) frames.push(node)
  }
  const top = (el: HTMLElement): number => el.getBoundingClientRect().top
  const bottom = (el: HTMLElement): number => el.getBoundingClientRect().bottom
  const moverTops = movers.map(top)
  const frameBottoms = frames.map(bottom)
  item.style.display = 'none'
  const shifts = movers.map((m, i) => top(m) - moverTops[i])
  const shrinks = frames.map((f, i) => frameBottoms[i] - bottom(f))
  item.style.display = ''

  item.inert = true
  // The item clears the way within duration-fast; the gap starts closing halfway through, so the two never pile up.
  const fast = ms('duration-fast')
  const glide = {
    delay: fast / 2,
    duration: ms('duration-gentle'),
    easing: token('ease-standard'),
    fill: 'forwards' as const
  }
  const animations = [
    item.animate([{ opacity: 1 }, { opacity: 0, translate: `${token('space-4') || '16px'} 0` }], {
      duration: fast,
      easing: token('ease-standard'),
      fill: 'forwards'
    }),
    ...movers.flatMap((m, i) =>
      shifts[i] ? [m.animate([{ translate: '0 0' }, { translate: `0 ${shifts[i]}px` }], glide)] : []
    ),
    ...frames.flatMap((f, i) => {
      if (!shrinks[i]) return []
      const round = getComputedStyle(f).borderTopLeftRadius
      return [
        f.animate(
          [{ clipPath: `inset(0 0 0 0 round ${round})` }, { clipPath: `inset(0 0 ${shrinks[i]}px 0 round ${round})` }],
          glide
        )
      ]
    })
  ]

  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    collapsing.delete(finish)
    const settle = (): void => animations.forEach((a) => a.cancel())
    flushSync(() => void remove())
    if (!item.isConnected) return settle()
    // The removal is asynchronous: hold the end state until the item leaves.
    const parent = item.parentElement
    const watch = new MutationObserver(() => {
      if (item.isConnected) return
      watch.disconnect()
      settle()
    })
    if (parent) watch.observe(parent, { childList: true })
    setTimeout(() => {
      watch.disconnect()
      settle()
    }, 2000)
  }
  collapsing.add(finish)
  Promise.all(animations.map((a) => a.finished)).then(finish, finish)
}

// ---------- Small pieces ----------

/**
 * Keeps the last value on screen for a moment after it goes, marked as
 * leaving, so it can fall away instead of vanishing. Used for the toast.
 */
export function useLingering<T>(value: T | null): { value: T | null; leaving: boolean } {
  const [kept, setKept] = useState<T | null>(value)
  useEffect(() => {
    if (value !== null) {
      setKept(value)
      return
    }
    const t = setTimeout(() => setKept(null), ms('duration-base'))
    return () => clearTimeout(t)
  }, [value])
  return { value: value ?? kept, leaving: value === null && kept !== null }
}

/** A progress bar's fill, moved rather than resized so it eases on the compositor. */
export function grow(percent: number): CSSProperties {
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  return { transform: `translateX(${p - 100}%)` }
}

/**
 * The playhead at a fraction of the strip, as a transform (the strip is a
 * size container, so 100cqw is its width). Moving it costs no layout, so it
 * keeps up with every frame the player's clock gives it.
 */
export function along(fraction: number): CSSProperties {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  return { transform: `translateX(calc(${f} * 100cqw))` }
}
