import { useEffect, type RefObject } from 'react'

/**
 * Plays a recording's sound offset from its picture, so the preview hears
 * what the export will: when the sound runs `offsetSec` behind the mouth,
 * the picture plays muted and a companion audio element plays the same file
 * that much further on. It follows the video element's own events, so the
 * player that drives the video (usePlayer) needs no change.
 *
 * At a cut the picture seeks and stalls for a moment; the sound stalls with
 * it, already moved to where it will be needed, and starts again when the
 * picture does, so the two leave the cut together. Drift between cuts is
 * closed by nudging the companion's rate, which is never heard. With no
 * offset it does nothing.
 */
export function useAudioOffset(
  video: RefObject<HTMLVideoElement>,
  offsetSec: number,
  /** The media being played: a new one means a new element to follow. */
  src: string | null = null
): void {
  useEffect(() => {
    const v = video.current
    if (!v || Math.abs(offsetSec) < 0.001 || typeof Audio === 'undefined') return
    const sound = new Audio()
    sound.preload = 'auto'
    const wasMuted = v.muted
    v.muted = true
    let frame = 0
    // A seek of the sound takes a moment (about a tenth of a second); one
    // made while the picture plays aims that far ahead.
    let seekStarted = 0
    let seekSec = 0.1
    let chases = 0

    const target = (): number => v.currentTime + offsetSec
    const ready = (): boolean => {
      if (!sound.src && v.currentSrc) sound.src = v.currentSrc
      return !!sound.src
    }
    const seekTo = (t: number): void => {
      seekStarted = performance.now()
      sound.currentTime = Math.max(0, t)
    }
    /** The picture is seeking, buffering or paused: hold the sound where it will be needed. */
    const hold = (): void => {
      if (!ready()) return
      sound.pause()
      chases = 0
      const t = target()
      if (t >= 0 && Math.abs(sound.currentTime - t) > 0.004) seekTo(t)
    }
    /** The picture plays: play the sound with it. */
    const go = (): void => {
      if (!ready() || v.paused || v.seeking) return
      const t = target()
      // Before the recording's first sound: wait silently for the picture to reach it.
      if (t < 0) return
      if (!sound.seeking && Math.abs(sound.currentTime - t) > 0.02) seekTo(t + (sound.paused ? 0 : seekSec))
      sound.playbackRate = v.playbackRate
      sound.volume = v.volume
      if (sound.paused) void sound.play().catch(() => undefined)
    }
    // A seek that finished while the picture played on has landed late: once more, ahead.
    const landed = (): void => {
      seekSec = 0.5 * seekSec + 0.5 * Math.min(0.5, (performance.now() - seekStarted) / 1000)
      if (v.paused || v.seeking || sound.paused || chases >= 2) return
      if (Math.abs(sound.currentTime - target()) <= 0.025) return
      chases++
      seekTo(target() + seekSec * v.playbackRate)
    }
    const watch = (): void => {
      frame = requestAnimationFrame(watch)
      if (!ready() || v.paused || v.seeking || v.readyState < 3 || sound.seeking) return
      if (sound.paused) {
        go()
        return
      }
      const ahead = sound.currentTime - target()
      if (Math.abs(ahead) > 0.25) seekTo(target() + seekSec * v.playbackRate)
      else {
        const nudge = Math.abs(ahead) > 0.006 ? Math.max(-0.05, Math.min(0.05, ahead)) : 0
        sound.playbackRate = v.playbackRate * (1 - nudge)
      }
    }
    const level = (): void => {
      sound.volume = v.volume
      sound.playbackRate = v.playbackRate
    }
    const stops = ['seeking', 'waiting', 'pause', 'emptied'] as const
    const starts = ['playing', 'loadeddata'] as const
    for (const e of stops) v.addEventListener(e, hold)
    for (const e of starts) v.addEventListener(e, go)
    v.addEventListener('ratechange', level)
    v.addEventListener('volumechange', level)
    sound.addEventListener('seeked', landed)
    frame = requestAnimationFrame(watch)
    if (!v.paused) go()

    return () => {
      cancelAnimationFrame(frame)
      for (const e of stops) v.removeEventListener(e, hold)
      for (const e of starts) v.removeEventListener(e, go)
      v.removeEventListener('ratechange', level)
      v.removeEventListener('volumechange', level)
      sound.removeEventListener('seeked', landed)
      sound.pause()
      sound.removeAttribute('src')
      sound.load()
      v.muted = wasMuted
    }
  }, [video, offsetSec, src])
}
