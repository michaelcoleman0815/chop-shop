import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { sourceTimeAt, type Resolved } from '../../../shared/edit'
import { steady } from './motion'

/**
 * Plays a cut straight off the source recording. The video element plays one
 * piece; when it reaches the piece's end the player seeks to the start of the
 * next, so every version can be watched the moment it exists, with no render.
 * Without media to play (the browser mock) the same clock runs on its own.
 */
export function usePlayer(
  video: RefObject<HTMLVideoElement>,
  resolved: Resolved | null
): {
  time: number
  playing: boolean
  play: () => void
  pause: () => void
  toggle: () => void
  seek: (sec: number) => void
} {
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const now = useRef(0)
  const piece = useRef(0)
  const frame = useRef(0)
  const last = useRef(0)
  const cut = useRef(resolved)
  cut.current = resolved

  const hasMedia = useCallback((): boolean => {
    const v = video.current
    return !!v && !!v.currentSrc && !v.error && v.readyState >= 2
  }, [video])

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
      const v = video.current
      if (v && v.currentSrc) v.currentTime = hit.srcSec
    },
    [video]
  )

  const pause = useCallback((): void => {
    cancelAnimationFrame(frame.current)
    video.current?.pause()
    setPlaying(false)
  }, [video])

  const step = useCallback(
    (stamp: number): void => {
      const r = cut.current
      if (!r || r.pieces.length === 0) {
        pause()
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
          v.currentTime = p.srcStart
        }
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
    [hasMedia, pause, video]
  )

  const play = useCallback((): void => {
    const r = cut.current
    if (!r || r.pieces.length === 0) return
    if (now.current >= r.durationSec - 0.05) seek(0)
    last.current = performance.now()
    setPlaying(true)
    const v = video.current
    if (v && v.currentSrc) void v.play().catch(() => undefined)
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(step)
  }, [seek, step, video])

  const toggle = useCallback((): void => (playing ? pause() : play()), [playing, pause, play])

  // A new version changes where everything sits; keep the playhead where it
  // was in output time and find the matching source moment again.
  useEffect(() => {
    if (resolved) seek(Math.min(now.current, resolved.durationSec))
  }, [resolved, seek])

  // Once the video can play, put it where the playhead already is.
  useEffect(() => {
    const v = video.current
    if (!v) return
    const ready = (): void => seek(now.current)
    v.addEventListener('loadeddata', ready)
    return () => v.removeEventListener('loadeddata', ready)
  }, [video, seek])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  return { time, playing, play, pause, toggle, seek }
}
