import { useCallback, useEffect, useRef, useState } from 'react'
import { num } from '../../../shared/anim'
import type { Layer, VideoLayer } from '../../../shared/motion'
import type { Placed } from '../../../shared/tracks'
import { MEDIA_CORS, mediaUrlFor } from './api'

/**
 * The layer tracks' video and sound in the preview: one hidden <video> per
 * video clip, whose frames the layer canvas draws (shared/motion, the
 * export's own compositor), and one <audio> per sound clip. Each is kept on
 * the moment the player is at: playing at the clip's speed while the player
 * plays, and set to the exact frame while it is still. A clip's sound plays
 * at its level, the export's dB as a volume (never above 0 dB here).
 */

/** Further apart than this while playing, a clip is set back on its moment. */
const DRIFT_SEC = 0.3
/** Still, a clip sits within this of its moment. */
const STILL_SEC = 1 / 60

interface Media {
  el: HTMLMediaElement
  src: string
}

const gain = (db: number): number => Math.min(1, Math.max(0, Math.pow(10, db / 20)))

function sync(el: HTMLMediaElement, want: number, speed: number, playing: boolean): void {
  if (playing) {
    if (el.playbackRate !== speed) el.playbackRate = speed
    if (el.paused) {
      el.currentTime = want
      void el.play().catch(() => undefined)
    } else if (Math.abs(el.currentTime - want) > DRIFT_SEC) el.currentTime = want
  } else {
    if (!el.paused) el.pause()
    if (Math.abs(el.currentTime - want) > STILL_SEC) el.currentTime = want
  }
}

export function useClipMedia(
  layers: Layer[],
  sounding: Placed[],
  time: number,
  playing: boolean
): { frame: (layer: VideoLayer, local: number) => CanvasImageSource | null; version: number } {
  const media = useRef(new Map<string, Media>())
  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((n) => n + 1), [])

  // The elements the tracks need, made and dropped as clips come and go.
  useEffect(() => {
    const want = new Map<string, { src: string; kind: 'video' | 'audio' }>()
    for (const l of layers) if (l.kind === 'video' && l.id) want.set(l.id, { src: l.src, kind: 'video' })
    for (const p of sounding) if (p.clip.kind === 'sound' && p.clip.src) want.set(p.clip.id, { src: p.clip.src, kind: 'audio' })
    const have = media.current
    for (const [id, m] of have) {
      if (want.get(id)?.src === m.src) continue
      m.el.pause()
      m.el.removeAttribute('src')
      m.el.load()
      have.delete(id)
    }
    for (const [id, w] of want) {
      if (have.has(id)) continue
      const el = document.createElement(w.kind)
      el.preload = 'auto'
      if (el instanceof HTMLVideoElement) el.playsInline = true
      // Read with leave to, as the decks are, so a chroma key can pass over its frames.
      if (MEDIA_CORS) el.crossOrigin = MEDIA_CORS
      el.addEventListener('seeked', bump)
      el.addEventListener('loadeddata', bump)
      el.src = mediaUrlFor(w.src)
      have.set(id, { el, src: w.src })
    }
  }, [layers, sounding, bump])

  // Every clip on its moment, at its level.
  useEffect(() => {
    const heard = new Map(sounding.map((p) => [p.clip.id, p]))
    for (const l of layers) {
      if (l.kind !== 'video' || !l.id) continue
      const m = media.current.get(l.id)
      if (!m) continue
      const on = time >= l.start && time < l.end
      const local = time - l.start
      const sound = heard.get(l.id)
      m.el.muted = !sound
      if (sound) m.el.volume = gain(num(sound.clip.volume, local, l.end - l.start, 0))
      if (on) sync(m.el, l.in + local * (l.speed ?? 1), l.speed ?? 1, playing)
      else if (!m.el.paused) m.el.pause()
    }
    for (const p of sounding) {
      if (p.clip.kind !== 'sound') continue
      const m = media.current.get(p.clip.id)
      if (!m) continue
      const on = time >= p.start && time < p.end
      const local = time - p.start
      m.el.volume = gain(num(p.clip.volume, local, p.end - p.start, 0))
      if (on) sync(m.el, p.clip.in + local * p.clip.speed, p.clip.speed, playing)
      else if (!m.el.paused) m.el.pause()
    }
  }, [layers, sounding, time, playing])

  // Nothing plays on once the editor closes.
  useEffect(() => {
    const have = media.current
    return () => {
      for (const m of have.values()) {
        m.el.pause()
        m.el.removeAttribute('src')
        m.el.load()
      }
      have.clear()
    }
  }, [])

  const frame = useCallback(
    (layer: VideoLayer): CanvasImageSource | null => {
      const el = layer.id ? media.current.get(layer.id)?.el : undefined
      return el instanceof HTMLVideoElement && el.readyState >= 2 ? el : null
    },
    // A new version means a new frame is ready: the canvas draws again with this function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  )
  return { frame, version }
}
