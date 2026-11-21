import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  continues,
  layersAt,
  nextPieceAfter,
  pictureSpan,
  pieceTime,
  srcToOut,
  type Layer,
  type Resolved,
  type Source
} from '../../../shared/edit'
import { heardFrom } from '../../../shared/vision/offset'
import { loadAsTouch } from './api'
import { steady } from './motion'

/**
 * Plays a cut straight off the source recordings, with no render.
 *
 * Two video elements take turns. While one plays a piece, the other waits on
 * the next piece's first frame, so a hard cut is a swap rather than a seek and
 * plays without a stall. Inside a transition both play at once, each drawn and
 * mixed the way layersAt says, which is how a dissolve or a whip can be
 * watched the moment it exists. A piece that carries straight on from the one
 * before in the same recording stays on the same element. Each element loads
 * the recording of the piece it holds, so a cut between recordings is a swap
 * too.
 *
 * A piece plays at its speed through playbackRate, which keeps the pitch the
 * way the export's atempo does. A freeze frame is a paused element on its
 * frame; a piece played backwards, which no video element can do, is stepped
 * a frame at a time with its sound off.
 *
 * A recording whose sound comes from another file (a screen or recorder
 * recording with the better microphone) plays muted, with that file in the
 * element's own audio element kept on the same moment: corrected only when it
 * drifts, so the sound stays smooth. So does one whose own sound was lined up
 * with the mouth: its own file, a moment later (vision/offset heardFrom), as
 * the export plays it.
 *
 * The clock follows the element that is loudest, so picture and sound never
 * part; while that element is seeking, or with no media at all (the browser
 * mock), the same clock runs on its own.
 */

export interface DeckView {
  /** The piece this deck holds, or null when it is idle. */
  piece: number | null
  /** How it plays right now; null while it waits for its turn. */
  layer: Layer | null
}

export interface Player {
  time: number
  playing: boolean
  play: () => void
  pause: () => void
  toggle: () => void
  seek: (sec: number) => void
  decks: DeckView[]
}

export interface PlayerMedia {
  sources: Source[]
  urlFor: (path: string) => string
  /** Each deck's better sound, for recordings whose own microphone is not the one heard. */
  sounds?: RefObject<HTMLAudioElement>[]
}

const IDLE: DeckView[] = [
  { piece: null, layer: null },
  { piece: null, layer: null }
]

/** Further apart than this, a playing deck is put back in step. */
const DRIFT_SEC = 0.2
/** A deck that has just taken a piece is moved only if it is further off than this; a cued one is not. */
const TAKEOVER_SEC = 0.1
/** Held or stepped backwards, a deck is moved whenever it is further off than this: under a frame. */
const STEP_SEC = 0.02
/** Past this, the better sound jumps back onto the picture. */
const JUMP_SEC = 0.25
/** Within this, lips and sound read as together, so the sound is left alone. */
const TOGETHER_SEC = 0.015

/** Browsers play from a sixteenth to sixteen times as fast. */
const playbackRate = (rate: number): number => Math.min(16, Math.max(0.0625, rate))

/**
 * Whether a paused element has read only its recording's length, with no
 * picture yet. An iPhone's web view never preloads: it reads the length and
 * stops until it is asked for a moment, so such an element is asked for one,
 * even the moment it is already at, and then shows that frame.
 */
export const needsFrame = (v: HTMLMediaElement): boolean => v.paused && !v.seeking && v.readyState === 1

/**
 * Whether a paused element read its recording's length and stopped loading
 * there for good. An iPhone's web view does that with a recording the app
 * loads by itself rather than for a touch, as when a project opens from Start:
 * a moment asked of it then never arrives, and holds up its playing too, so
 * its picture stays dark.
 */
const stalled = (v: HTMLMediaElement): boolean =>
  v.paused && v.readyState === v.HAVE_METADATA && v.networkState === v.NETWORK_IDLE

/** Elements playing silently to load their frames. */
const waking = new WeakSet<HTMLMediaElement>()
/** A wake that has not started playing by then gives up. */
const WAKE_MS = 4000
/** The recording each element was last loaded again for, as a touch would. */
const reloaded = new WeakMap<HTMLMediaElement, string>()

/**
 * Shows a paused element's frame at `at()`. Asking for the moment is enough
 * where the frames load. A stalled element is not asked: it plays silently
 * until they have loaded, then stops on the moment. Where it cannot play, or
 * its play never starts, it is loaded again as a touch would load it, where
 * the host can do that (an iPhone's), and then asked. While `running()` the
 * player has taken the element over, and it is left playing.
 */
export function showFrame(v: HTMLVideoElement, at: () => number | null, running: () => boolean): void {
  if (waking.has(v)) return
  if (stalled(v)) {
    if (!running()) wake(v, at, running)
    return
  }
  const t = at()
  if (t !== null && (Math.abs(v.currentTime - t) > 0.01 || needsFrame(v))) v.currentTime = t
}

/** Plays a stalled element silently until its frames load, then stops it on its moment again. */
function wake(v: HTMLVideoElement, at: () => number | null, running: () => boolean): void {
  if (!v.isConnected || waking.has(v)) return
  waking.add(v)
  const muted = v.muted
  let late = false
  v.muted = true
  const wait = setTimeout(() => {
    if (!waking.has(v) || running()) return
    late = true
    v.pause()
  }, WAKE_MS)
  v.play().then(
    () => {
      clearTimeout(wait)
      waking.delete(v)
      if (running()) return
      v.pause()
      v.muted = muted
      const back = at()
      if (back !== null) v.currentTime = back
    },
    (err: unknown) => {
      clearTimeout(wait)
      waking.delete(v)
      // Paused or given another recording meanwhile, the player has set its sound since.
      if (!late && err instanceof DOMException && err.name === 'AbortError') return
      v.muted = muted
      reload(v)
    }
  )
}

/** Loads a paused element with no frame again as a touch would, where the host can: once for each recording. */
function reload(v: HTMLVideoElement): void {
  const src = v.getAttribute('src')
  if (!loadAsTouch || !src || reloaded.get(v) === src || !v.paused || v.readyState >= v.HAVE_CURRENT_DATA) return
  reloaded.set(v, src)
  loadAsTouch(v)
}

export function usePlayer(
  decks: RefObject<HTMLVideoElement>[],
  resolved: Resolved | null,
  media?: PlayerMedia
): Player {
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [views, setViews] = useState<DeckView[]>(IDLE)
  const now = useRef(0)
  const playingRef = useRef(false)
  const frame = useRef(0)
  const last = useRef(0)
  /** The piece each deck holds. */
  const held = useRef<(number | null)[]>([null, null])
  /** Where each deck should be in its recording, applied again once it can seek. */
  const want = useRef<(number | null)[]>([null, null])
  const cut = useRef(resolved)
  cut.current = resolved
  const mediaRef = useRef(media)
  mediaRef.current = media

  const element = useCallback((d: number): HTMLVideoElement | null => decks[d]?.current ?? null, [decks])

  const sourceOf = useCallback(
    (id: string): Source | undefined => mediaRef.current?.sources.find((s) => s.id === id),
    []
  )

  /** True when at least one deck has media it can show. */
  const hasMedia = useCallback((): boolean => {
    for (let d = 0; d < decks.length; d++) {
      const v = element(d)
      if (v && v.currentSrc && !v.error) return true
    }
    return false
  }, [decks, element])

  /**
   * Loads a deck's recording when it changes and moves the deck to a moment
   * of it, if it is further off than `tolerance`. A deck still loading is
   * moved when its metadata arrives. True when the deck was moved or loads.
   */
  const place = useCallback(
    (d: number, source: string, srcSec: number, tolerance: number): boolean => {
      const v = element(d)
      if (!v) return false
      want.current[d] = srcSec
      const s = sourceOf(source)
      const src = s && mediaRef.current ? mediaRef.current.urlFor(s.path) : null
      if (src && v.getAttribute('src') !== src) {
        v.setAttribute('src', src)
        return true
      }
      if (v.readyState < 1) return false
      // A stalled deck is woken rather than moved, and goes to its moment once it can (showFrame).
      if (stalled(v)) {
        showFrame(
          v,
          () => want.current[d],
          () => playingRef.current
        )
        return false
      }
      if (Math.abs(v.currentTime - srcSec) <= tolerance && !needsFrame(v)) return false
      v.currentTime = srcSec
      return true
    },
    [element, sourceOf]
  )

  /**
   * Keeps a deck's better sound on its picture's moment, or the picture's own
   * sound on. A jump (a seek, or the deck taking a new piece) moves the sound
   * with the picture at once; between jumps a small drift is eased away by
   * playing the sound a touch faster or slower, which is inaudible.
   */
  const hear = useCallback(
    (d: number, source: string, volume: number, rate: number, runs: boolean, jump: boolean): void => {
      const v = element(d)
      if (!v) return
      const a = mediaRef.current?.sounds?.[d]?.current ?? null
      const heard = sourceOf(source)
      const lined = heard ? heardFrom(heard) : null
      if (!lined || !a || !mediaRef.current) {
        v.muted = false
        if (a && !a.paused) a.pause()
        return
      }
      v.muted = true
      const url = mediaRef.current.urlFor(lined.path)
      if (a.dataset.src !== url) {
        a.dataset.src = url
        a.src = url
      }
      a.volume = Math.min(1, Math.max(0, volume))
      const at = v.currentTime + lined.offsetSec
      // Before the better recording starts, or after it ends, there is no sound to hear.
      const outside = at < 0 || (Number.isFinite(a.duration) && at > a.duration)
      if (!runs || outside) {
        if (!a.paused) a.pause()
        // Waiting, it sits on the picture's moment, ready to play.
        if (!outside && Math.abs(a.currentTime - at) > 0.005) a.currentTime = at
        return
      }
      const drift = a.currentTime - at
      if (jump || Math.abs(drift) > JUMP_SEC) {
        if (Math.abs(drift) > 0.005) a.currentTime = at
        a.playbackRate = rate
      } else if (Math.abs(drift) > TOGETHER_SEC) {
        a.playbackRate = playbackRate(rate * Math.max(0.9, Math.min(1.1, 1 - drift * 2)))
      } else a.playbackRate = rate
      if (a.paused) void a.play().catch(() => undefined)
    },
    [element, sourceOf]
  )

  /**
   * Gives each layer a deck, keeps decks already holding their piece, puts the
   * rest in step, and readies the idle deck with whatever comes next.
   */
  const apply = useCallback(
    (layers: Layer[], t: number, run: boolean): void => {
      const r = cut.current
      if (!r) return
      const owner = new Map<number, number>()
      held.current.forEach((p, d) => {
        if (p !== null && layers.some((l) => l.piece === p)) owner.set(p, d)
      })
      const taken = new Set(owner.values())
      const fresh = new Set<number>()
      /** Decks whose new piece carries straight on from the one they were playing: no jump at all. */
      const carriedOn = new Set<number>()
      for (const l of layers) {
        if (owner.has(l.piece)) continue
        // A deck playing the piece this one carries straight on from keeps going.
        let d = held.current.findIndex(
          (p, i) => p !== null && !taken.has(i) && continues(r.pieces[p], r.pieces[l.piece])
        )
        if (d >= 0) carriedOn.add(d)
        // Otherwise the deck cued for it, otherwise whichever is free.
        if (d < 0) d = held.current.findIndex((p, i) => p === l.piece && !taken.has(i))
        if (d < 0) d = [0, 1].find((i) => !taken.has(i)) ?? 0
        owner.set(l.piece, d)
        taken.add(d)
        fresh.add(d)
        held.current[d] = l.piece
      }

      const next: DeckView[] = [
        { piece: held.current[0], layer: null },
        { piece: held.current[1], layer: null }
      ]
      for (const l of layers) {
        const d = owner.get(l.piece) as number
        next[d] = { piece: l.piece, layer: l }
        const v = element(d)
        if (!v) continue
        // Paused, every deck shows exactly its moment. Playing, a deck is only
        // moved when it has drifted, so a correction never stutters the picture.
        // A freeze and a piece played backwards are put on their frame each time.
        const still = l.rate === 0 || !!l.reverse
        const tolerance = still ? STEP_SEC : run ? (fresh.has(d) ? TAKEOVER_SEC : DRIFT_SEC) : 0.01
        const source = r.pieces[l.piece].source
        const moved = place(d, source, l.srcSec, tolerance)
        const volume = still ? 0 : Math.min(1, Math.max(0, l.volume))
        const rate = playbackRate(l.rate ?? 1)
        v.volume = volume
        if (!still) v.playbackRate = rate
        const runs = run && !still
        if (runs && v.paused) void v.play().catch(() => undefined)
        if (!runs && !v.paused) v.pause()
        // The better sound jumps only when the picture did. A piece that carries
        // straight on is the same moment of the same recording: seeking the sound
        // there would only stall it, at every beat, and leave it behind.
        hear(d, source, volume, rate, runs, moved || (fresh.has(d) && !carriedOn.has(d)))
      }

      // The idle deck stops, falls silent, and waits on the next piece.
      const upcoming = nextPieceAfter(r, t)
      const playingNow = layers[layers.length - 1]?.piece
      const carried =
        upcoming !== null && playingNow !== undefined && continues(r.pieces[playingNow], r.pieces[upcoming])
      for (let d = 0; d < decks.length; d++) {
        if (taken.has(d)) continue
        const v = element(d)
        if (v && !v.paused) v.pause()
        if (v) v.volume = 0
        if (upcoming !== null && !carried) {
          // Cued on the first frame it shows: backwards, that is its last.
          const piece = r.pieces[upcoming]
          held.current[d] = upcoming
          place(d, piece.source, pieceTime(piece, pictureSpan(piece).outStart), 0.01)
          hear(d, piece.source, 0, 1, false, true)
        } else {
          const a = mediaRef.current?.sounds?.[d]?.current
          if (a && !a.paused) a.pause()
        }
        next[d] = { piece: held.current[d], layer: null }
      }
      setViews(next)
    },
    [decks.length, element, hear, place]
  )

  const seek = useCallback(
    (out: number): void => {
      const r = cut.current
      if (!r) return
      const t = Math.min(Math.max(0, out), r.durationSec)
      now.current = t
      setTime(t)
      apply(layersAt(r, t), t, playingRef.current)
    },
    [apply]
  )

  const pause = useCallback((): void => {
    cancelAnimationFrame(frame.current)
    playingRef.current = false
    for (let d = 0; d < decks.length; d++) {
      element(d)?.pause()
      mediaRef.current?.sounds?.[d]?.current?.pause()
    }
    setPlaying(false)
  }, [decks.length, element])

  const step = useCallback(
    (stamp: number): void => {
      const r = cut.current
      if (!r || r.pieces.length === 0) {
        pause()
        return
      }
      const dt = Math.max(0, (stamp - last.current) / 1000)
      last.current = stamp
      let t = now.current + dt
      if (hasMedia()) {
        // Follow the loudest deck that is actually playing its piece.
        let best: { t: number; volume: number } | null = null
        for (const l of layersAt(r, now.current)) {
          const d = held.current.findIndex((p) => p === l.piece)
          const v = d >= 0 ? element(d) : null
          if (!v || v.seeking || v.paused || v.readyState < 2 || l.rate === 0 || l.reverse) continue
          // From where the recording is back to output time, through the piece's speed.
          const piece = r.pieces[l.piece]
          const along = v.currentTime - piece.srcStart
          const at = piece.outStart + (piece.steps ? srcToOut(piece.steps, along) : along)
          if (!best || l.volume > best.volume) best = { t: at, volume: l.volume }
        }
        // Gliding evenly toward it; never backwards, and never far ahead of the wall clock.
        if (best) t = Math.max(now.current, Math.min(steady(now.current, best.t, dt), now.current + 0.25))
      }
      if (t >= r.durationSec) {
        now.current = r.durationSec
        setTime(r.durationSec)
        pause()
        return
      }
      now.current = t
      apply(layersAt(r, t), t, true)
      setTime(t)
      frame.current = requestAnimationFrame(step)
    },
    [apply, element, hasMedia, pause]
  )

  const play = useCallback((): void => {
    const r = cut.current
    if (!r || r.pieces.length === 0) return
    if (now.current >= r.durationSec - 0.05) now.current = 0
    playingRef.current = true
    setPlaying(true)
    apply(layersAt(r, now.current), now.current, true)
    last.current = performance.now()
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(step)
  }, [apply, step])

  const toggle = useCallback((): void => (playingRef.current ? pause() : play()), [pause, play])

  // A new version changes where everything sits; keep the playhead where it
  // was in output time and find the matching source moments again.
  useEffect(() => {
    held.current = [null, null]
    if (resolved) seek(Math.min(now.current, resolved.durationSec))
  }, [resolved, seek])

  // Each deck's element, from the first render it is there: the editor draws the decks once the
  // media is known, which can be after the player starts, as when a project opens from Start. From
  // then on, media that has just loaded, or stopped loading, shows the frame it was asked for
  // (showFrame), which on an iPhone can take a moment of silent play. A deck drawn after the
  // playhead was put somewhere is put there now.
  const watched = useRef<(HTMLVideoElement | null)[]>([])
  useEffect(() => {
    let late = false
    decks.forEach((ref, d) => {
      const v = ref.current
      if (!v || watched.current[d] === v) return
      watched.current[d] = v
      const frame = (): void =>
        showFrame(
          v,
          () => want.current[d],
          () => playingRef.current
        )
      v.addEventListener('loadedmetadata', frame)
      // A deck that stops loading before its first frame; playing, one that stops has all it needs.
      v.addEventListener('suspend', () => {
        if (!playingRef.current && v.readyState < 2) frame()
      })
      if (!v.getAttribute('src')) late = true
    })
    if (late && !playingRef.current) seek(now.current)
  })

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  return { time, playing, play, pause, toggle, seek, decks: views }
}
