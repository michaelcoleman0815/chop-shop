import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as THREE from 'three'
import type { Layer, Scene3DLayer } from '../../../shared/motion'
import { fontInfo } from '../../../shared/motion/fonts'
import { fontOutlines, markFontAsked, parseModel, setFontBytes, wordsPicture } from '../../../shared/three/browser'
import { createRenderer, renderScene3D, Scene3DView, type Picture, type Scene3DSources } from '../../../shared/three/scene3d'
import { isVideoFile, type Object3D } from '../../../shared/three/spec'
import { mediaUrlFor } from './api'
import { motionFontUrl } from './graphics'

/**
 * The layer tracks' 3D clips in the preview: a WebGL canvas for each 3D clip
 * on screen, drawn by the scene builder the export runs (shared/three) at the
 * player's moment, which the layer canvas lays in at the clip's depth like a
 * video's frame. What the scenes show loads here: the bundled faces' outlines
 * for extruded titles, cards' pictures, a hidden <video> per video card kept
 * on its moment, and glTF models. Each arrival draws the frame again.
 */

/** WebGL canvases kept at once; the one used longest ago goes first. */
const MAX_CANVASES = 4
/** Further apart than this while playing, a card's video is set back on its moment. */
const DRIFT_SEC = 0.3

interface Canvas3D {
  view: Scene3DView
  renderer: THREE.WebGLRenderer
  used: number
}

type Loaded<T> = T | 'loading' | null

export function useScene3D(
  layers: Layer[],
  box: { width: number; height: number },
  time: number,
  playing: boolean
): { frame: (layer: Scene3DLayer, local: number) => CanvasImageSource | null; version: number } {
  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((n) => n + 1), [])
  const canvases = useRef(new Map<string, Canvas3D>())
  const pictures = useRef(new Map<string, Loaded<HTMLImageElement>>())
  const models = useRef(new Map<string, Loaded<THREE.Object3D>>())
  const videos = useRef(new Map<string, { el: HTMLVideoElement; src: string }>())
  const tick = useRef(0)
  const solids = useMemo(() => layers.filter((l): l is Scene3DLayer => l.kind === '3d'), [layers])

  /** What one clip's scene shows, loaded on first ask. */
  const sourcesFor = useCallback(
    (layerId: string): Scene3DSources => ({
      font: (family) => {
        const face = fontInfo(family)
        const have = fontOutlines(face.family)
        if (have !== undefined) return have
        // Marked as asked, so it is fetched once.
        markFontAsked(face.family)
        const url = motionFontUrl(face.file)
        if (!url) return null
        void fetch(url)
          .then((r) => r.arrayBuffer())
          .then((bytes) => {
            setFontBytes(face.family, bytes)
            bump()
          })
          .catch(() => undefined)
        return null
      },
      picture: (o: Object3D) => {
        if (!o.src) return null
        if (isVideoFile(o.src)) {
          const v = videos.current.get(`${layerId}:${o.id}`)?.el
          return v && v.readyState >= 2 && v.videoWidth > 0
            ? { image: v, width: v.videoWidth, height: v.videoHeight, stamp: v.currentTime }
            : null
        }
        const hit = pictures.current.get(o.src)
        if (hit === undefined) {
          pictures.current.set(o.src, 'loading')
          const img = new Image()
          // The media server answers any origin, so WebGL may read the picture.
          img.crossOrigin = 'anonymous'
          img.onload = () => {
            pictures.current.set(o.src as string, img)
            bump()
          }
          img.onerror = () => pictures.current.set(o.src as string, null)
          img.src = mediaUrlFor(o.src)
          return null
        }
        return hit && hit !== 'loading' ? ({ image: hit, width: hit.naturalWidth, height: hit.naturalHeight, stamp: 0 } satisfies Picture) : null
      },
      words: (o, w, h) => wordsPicture(o, w, h),
      model: (src) => {
        const hit = models.current.get(src)
        if (hit === undefined) {
          models.current.set(src, 'loading')
          void fetch(mediaUrlFor(src))
            .then((r) => r.arrayBuffer())
            .then(parseModel)
            .then((scene) => {
              models.current.set(src, scene)
              bump()
            })
            .catch((err) => {
              console.warn(`[3d] could not load ${src}:`, err)
              models.current.set(src, null)
            })
          return null
        }
        return hit && hit !== 'loading' ? hit : null
      }
    }),
    [bump]
  )

  // A hidden <video> for each video card, kept on the moment the player is at.
  useEffect(() => {
    const want = new Map<string, { src: string; at: number; on: boolean }>()
    for (const l of solids) {
      const on = time >= l.start && time < l.end
      for (const o of l.scene.objects)
        if (o.type === 'card' && o.src && isVideoFile(o.src)) want.set(`${l.id}:${o.id}`, { src: o.src, at: (o.in ?? 0) + Math.max(0, time - l.start), on })
    }
    const have = videos.current
    for (const [key, v] of have) {
      if (want.get(key)?.src === v.src) continue
      v.el.pause()
      v.el.removeAttribute('src')
      v.el.load()
      have.delete(key)
    }
    for (const [key, w] of want) {
      let v = have.get(key)
      if (!v) {
        const el = document.createElement('video')
        el.crossOrigin = 'anonymous'
        el.muted = true
        el.playsInline = true
        el.preload = 'auto'
        el.addEventListener('seeked', bump)
        el.addEventListener('loadeddata', bump)
        el.src = mediaUrlFor(w.src)
        v = { el, src: w.src }
        have.set(key, v)
      }
      const el = v.el
      if (!w.on) {
        if (!el.paused) el.pause()
        continue
      }
      if (playing) {
        if (el.paused) {
          el.currentTime = w.at
          void el.play().catch(() => undefined)
        } else if (Math.abs(el.currentTime - w.at) > DRIFT_SEC) el.currentTime = w.at
      } else {
        if (!el.paused) el.pause()
        if (Math.abs(el.currentTime - w.at) > 1 / 60) el.currentTime = w.at
      }
    }
  }, [solids, time, playing, bump])

  // Canvases for clips that are gone are let go of.
  useEffect(() => {
    const ids = new Set(solids.map((l) => l.id))
    for (const [id, c] of canvases.current)
      if (!ids.has(id)) {
        release(c)
        canvases.current.delete(id)
      }
  }, [solids])

  // Nothing is kept once the editor closes.
  useEffect(() => {
    const kept = canvases.current
    const playingVideos = videos.current
    return () => {
      for (const c of kept.values()) release(c)
      kept.clear()
      for (const v of playingVideos.values()) {
        v.el.pause()
        v.el.removeAttribute('src')
        v.el.load()
      }
      playingVideos.clear()
    }
  }, [])

  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const pw = Math.max(1, Math.round(box.width * dpr))
  const ph = Math.max(1, Math.round(box.height * dpr))

  const frame = useCallback(
    (layer: Scene3DLayer, local: number): CanvasImageSource | null => {
      const id = layer.id ?? 'scene'
      let c = canvases.current.get(id)
      if (!c) {
        if (canvases.current.size >= MAX_CANVASES) {
          const [oldest] = [...canvases.current.entries()].sort((a, b) => a[1].used - b[1].used)
          release(oldest[1])
          canvases.current.delete(oldest[0])
        }
        try {
          c = { view: new Scene3DView({ width: layer.w, height: layer.h }, sourcesFor(id)), renderer: createRenderer(), used: 0 }
        } catch (err) {
          console.warn('[3d] no WebGL here:', err)
          return null
        }
        canvases.current.set(id, c)
      }
      c.used = ++tick.current
      renderScene3D(c.renderer, c.view, layer.scene, local, layer.end - layer.start, { width: pw, height: ph })
      return c.renderer.domElement
    },
    // A new version means something it shows has loaded: the layer canvas draws again with this function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourcesFor, pw, ph, version]
  )
  return { frame, version }
}

function release(c: Canvas3D): void {
  c.view.dispose()
  c.renderer.dispose()
  c.renderer.forceContextLoss()
}
