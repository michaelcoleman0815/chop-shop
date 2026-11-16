import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { sourceTimeAt, type Piece, type Resolved, type Source } from '../../../shared/edit'
import { steady } from './motion'

/**
 * Plays a cut straight off the source recordings. The video element plays
 * one piece; when it reaches the piece's end the player seeks to the start of
 * the next, switching files when the next piece is from another recording,
 * so every version can be watched the moment it exists, with no render.
 *
 * A recording whose sound comes from another file (a screen or recorder
 * recording with the better microphone) plays muted, with that file in an
 * audio element kept on the same moment: corrected only when it drifts, so
 * the sound stays smooth.
 *
 * Without media to play (the browser mock) the same clock runs on its own.
 */
export interface PlayerMedia {
  sources: Source[]
  urlFor: (path: string) => string
  /** Plays a recording's better sound, when it has one. */
  audio?: RefObject<HTMLAudioElement>
}

/** Past this, the better sound jumps back onto the picture. */
const JUMP_SEC = 0.25
/** Within this, lips and sound read as together, so the sound is left alone. */
const TOGETHER_SEC = 0.015

export function usePlayer(
  video: RefObject<HTMLVideoElement>,
  resolved: Resolved | null,
  media?: PlayerMedia
): {
  time: number
  playing: boolean
  /** The file the video element should show now, when the player knows better than its first one. */
  src: string | null
  play: () => void
  pause: () => void
  toggle: () => void
  seek: (sec: number) => void
} {
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const playingRef = useRef(false)
  const now = useRef(0)
  const piece = useRef(0)
  const frame = useRef(0)
  const last = useRef(0)
  const cut = useRef(resolved)
  cut.current = resolved
  const mediaRef = useRef(media)
  mediaRef.current = media

  const sourceOf = useCallback((p: Piece | undefined): Source | undefined => {
    return p ? mediaRef.current?.sources.find((s) => s.id === p.source) : undefined
  }, [])
  const urlOf = useCallback(
    (p: Piece | undefined): string | null => {
      const s = sourceOf(p)
      return s && mediaRef.current ? mediaRef.current.urlFor(s.path) : null
    },
    [sourceOf]
  )

  const [src, setSrc] = useState<string | null>(() => urlOf(resolved?.pieces[0]))
  const loaded = useRef<string | null>(src)
  /** Where to go once a newly switched file can play. */
  const pending = useRef<{ srcSec: number } | null>(null)

  const hasMedia = useCallback((): boolean => {
    const v = video.current
    return !!v && !!v.currentSrc && !v.error && v.readyState >= 2
  }, [video])

  /** Points the video at the piece's recording; true when it had to change files first. */
  const show = useCallback(
    (p: Piece | undefined, srcSec: number): boolean => {
      const url = urlOf(p)
      if (!url || url === loaded.current) return false
      loaded.current = url
      pending.current = { srcSec }
      setSrc(url)
      return true
    },
    [urlOf]
  )

  /**
   * Keeps the better sound on the picture's moment, or the picture's own sound
   * on. A jump (a seek, or the cut moving to its next piece) moves the sound
   * with the picture at once; between jumps it is only eased.
   */
  const hear = useCallback(
    (p: Piece | undefined, jump = false): void => {
      const v = video.current
      const a = mediaRef.current?.audio?.current
      if (!v) return
      const lined = sourceOf(p)?.audio
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
      const at = v.currentTime + lined.offsetSec
      // Before the better recording starts, or after it ends, there is no sound to hear.
      if (at < 0 || (Number.isFinite(a.duration) && at > a.duration)) {
        if (!a.paused) a.pause()
        return
      }
      // A small drift is eased away by playing the sound a touch faster or
      // slower, which is inaudible; only a large one jumps, which is not.
      const drift = a.currentTime - at
      if (jump || !playingRef.current || Math.abs(drift) > JUMP_SEC) {
        if (Math.abs(drift) > 0.005) a.currentTime = at
        a.playbackRate = 1
      } else if (Math.abs(drift) > TOGETHER_SEC) {
        a.playbackRate = Math.max(0.9, Math.min(1.1, 1 - drift * 2))
      } else a.playbackRate = 1
      if (playingRef.current && a.paused) void a.play().catch(() => undefined)
      if (!playingRef.current && !a.paused) a.pause()
    },
    [sourceOf, video]
  )

  const seek = useCallback(
    (out: number): void => {
      const r = cut.current
      if (!r) return
      const t = Math.min(Math.max(0, out), r.durationSec)
      now.current = t
      setTime(t)
      const hit = sourceTimeAt(r, t)
      if (!hit) return
      piece.current = hit.index
      if (show(hit.piece, hit.srcSec)) return
      const v = video.current
      if (v && v.currentSrc) v.currentTime = hit.srcSec
      hear(hit.piece, true)
    },
    [hear, show, video]
  )

  const pause = useCallback((): void => {
    cancelAnimationFrame(frame.current)
    playingRef.current = false
    video.current?.pause()
    mediaRef.current?.audio?.current?.pause()
    setPlaying(false)
  }, [video])

  const step = useCallback(
    (stamp: number): void => {
      const r = cut.current
      if (!r || r.pieces.length === 0) {
        pause()
        return
      }
      // While another file loads, the clock waits for it.
      if (pending.current) {
        last.current = stamp
        frame.current = requestAnimationFrame(step)
        return
      }
      const v = video.current
      if (hasMedia() && v) {
        let p = r.pieces[Math.min(piece.current, r.pieces.length - 1)]
        if (v.currentTime >= p.srcEnd - 0.02 || v.currentTime < p.srcStart - 0.5) {
          const next = v.currentTime >= p.srcEnd - 0.02 ? piece.current + 1 : piece.current
          if (next >= r.pieces.length) {
            pause()
            now.current = r.durationSec
            setTime(r.durationSec)
            return
          }
          piece.current = next
          p = r.pieces[next]
          if (show(p, p.srcStart)) {
            v.pause()
            last.current = stamp
            frame.current = requestAnimationFrame(step)
            return
          }
          v.currentTime = p.srcStart
          hear(p, true)
        } else hear(p)
        const media = p.outStart + Math.max(0, Math.min(p.srcEnd, v.currentTime) - p.srcStart)
        now.current = steady(now.current, media, (stamp - last.current) / 1000)
      } else {
        now.current = Math.min(r.durationSec, now.current + (stamp - last.current) / 1000)
        const hit = sourceTimeAt(r, now.current)
        if (hit) piece.current = hit.index
        if (now.current >= r.durationSec) {
          pause()
          setTime(r.durationSec)
          return
        }
      }
      last.current = stamp
      setTime(now.current)
      frame.current = requestAnimationFrame(step)
    },
    [hasMedia, hear, pause, show, video]
  )

  const play = useCallback((): void => {
    const r = cut.current
    if (!r || r.pieces.length === 0) return
    if (now.current >= r.durationSec - 0.05) seek(0)
    last.current = performance.now()
    playingRef.current = true
    setPlaying(true)
    const v = video.current
    if (v && v.currentSrc && !pending.current) void v.play().catch(() => undefined)
    hear(r.pieces[Math.min(piece.current, r.pieces.length - 1)], true)
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(step)
  }, [hear, seek, step, video])

  const toggle = useCallback((): void => (playing ? pause() : play()), [playing, pause, play])

  // A new version changes where everything sits; keep the playhead where it
  // was in output time and find the matching source moment again.
  useEffect(() => {
    if (resolved) seek(Math.min(now.current, resolved.durationSec))
  }, [resolved, seek])

  // Once a file can play, put it where the playhead already is, and carry on if it was playing.
  useEffect(() => {
    const v = video.current
    if (!v) return
    const ready = (): void => {
      const waiting = pending.current
      pending.current = null
      if (waiting) v.currentTime = waiting.srcSec
      else seek(now.current)
      const r = cut.current
      hear(r?.pieces[Math.min(piece.current, (r?.pieces.length ?? 1) - 1)], true)
      if (playingRef.current) void v.play().catch(() => undefined)
    }
    v.addEventListener('loadeddata', ready)
    return () => v.removeEventListener('loadeddata', ready)
  }, [video, seek, hear, src])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  return { time, playing, src, play, pause, toggle, seek }
}
