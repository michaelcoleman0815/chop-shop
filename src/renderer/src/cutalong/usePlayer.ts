import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { continues, layersAt, nextPieceAfter, type Layer, type Resolved } from '../../../shared/edit'

/**
 * Plays a cut straight off the source recordings, with no render.
 *
 * Two video elements take turns. While one plays a piece, the other waits on
 * the next piece's first frame, so a hard cut is a swap rather than a seek and
 * plays without a stall. Inside a transition both play at once, each drawn and
 * mixed the way layersAt says, which is how a dissolve or a whip can be
 * watched the moment it exists. A piece that carries straight on from the one
 * before in the same recording stays on the same element.
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

const IDLE: DeckView[] = [
  { piece: null, layer: null },
  { piece: null, layer: null }
]

/** Further apart than this, a playing deck is put back in step. */
const DRIFT_SEC = 0.2
/** A deck that has just taken a piece is moved only if it is further off than this; a cued one is not. */
const TAKEOVER_SEC = 0.1

export function usePlayer(
  decks: RefObject<HTMLVideoElement>[],
  resolved: Resolved | null,
  urlFor: (source: string) => string | null
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
  const url = useRef(urlFor)
  url.current = urlFor

  const element = useCallback((d: number): HTMLVideoElement | null => decks[d]?.current ?? null, [decks])

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
   * moved when its metadata arrives.
   */
  const place = useCallback(
    (d: number, source: string, srcSec: number, tolerance: number): void => {
      const v = element(d)
      if (!v) return
      want.current[d] = srcSec
      const src = url.current(source)
      if (src && v.getAttribute('src') !== src) {
        v.setAttribute('src', src)
        return
      }
      if (v.readyState < 1) return
      if (Math.abs(v.currentTime - srcSec) > tolerance) v.currentTime = srcSec
    },
    [element]
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
      for (const l of layers) {
        if (owner.has(l.piece)) continue
        // A deck playing the piece this one carries straight on from keeps going.
        let d = held.current.findIndex(
          (p, i) => p !== null && !taken.has(i) && continues(r.pieces[p], r.pieces[l.piece])
        )
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
        place(d, r.pieces[l.piece].source, l.srcSec, run ? (fresh.has(d) ? TAKEOVER_SEC : DRIFT_SEC) : 0.01)
        v.volume = Math.min(1, Math.max(0, l.volume))
        if (run && v.paused) void v.play().catch(() => undefined)
        if (!run && !v.paused) v.pause()
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
          held.current[d] = upcoming
          place(d, r.pieces[upcoming].source, r.pieces[upcoming].srcStart, 0.01)
        }
        next[d] = { piece: held.current[d], layer: null }
      }
      setViews(next)
    },
    [decks.length, element, place]
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
    for (let d = 0; d < decks.length; d++) element(d)?.pause()
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
          if (!v || v.seeking || v.paused || v.readyState < 2) continue
          const piece = r.pieces[l.piece]
          const at = piece.outStart + (v.currentTime - piece.srcStart)
          if (!best || l.volume > best.volume) best = { t: at, volume: l.volume }
        }
        // Never backwards, and never far ahead of the wall clock.
        if (best) t = Math.max(now.current, Math.min(best.t, now.current + 0.25))
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

  // A deck whose media has just loaded goes where it was asked to be.
  useEffect(() => {
    const off: (() => void)[] = []
    decks.forEach((ref, d) => {
      const v = ref.current
      if (!v) return
      const ready = (): void => {
        const at = want.current[d]
        if (at !== null && Math.abs(v.currentTime - at) > 0.01) v.currentTime = at
      }
      v.addEventListener('loadedmetadata', ready)
      off.push(() => v.removeEventListener('loadedmetadata', ready))
    })
    return () => off.forEach((f) => f())
  }, [decks])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  return { time, playing, play, pause, toggle, seek, decks: views }
}
