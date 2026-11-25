import type * as THREE from 'three'
import { fontInfo } from '../../shared/motion/fonts'
import type { Size } from '../../shared/motion/types'
import { fontOutlines, iconPicture, iconShapes, logoPath, parseModel, sceneMarks, setFontBytes, setMarkLookups, wordsPicture } from '../../shared/three/browser'
import type { HostBridge, HostMessage, HostReply } from '../../shared/three/host-protocol'
import { createRenderer, renderScene3D, Scene3DView, SCENE3D_MOMENTS, sceneMoves, type Picture } from '../../shared/three/scene3d'
import { isVideoFile, type Scene3D } from '../../shared/three/spec'
import { loadIconNodes, loadLogoMarks } from './marks'

/**
 * The export's 3D page: an offscreen window (main/three-render.ts) that runs
 * the scene builder the editor's preview runs (shared/three), on one WebGL
 * renderer, and draws each frame it is asked for. The moment comes in every
 * message, never from a clock, so a frame is the same however long it took.
 * A frame goes back as straight RGBA, read off a 2D canvas the WebGL canvas
 * is laid on, which undoes the premultiplied alpha WebGL draws with.
 */

declare global {
  interface Window {
    scene3dHost?: HostBridge
  }
}

interface Clip {
  view: Scene3DView
  scene: Scene3D
  pixels: Size
  pictures: Map<string, Picture>
  models: Map<string, THREE.Object3D>
  /** Each video card's frame, put on a canvas of its own. */
  videos: Map<string, { canvas: HTMLCanvasElement; picture: Picture }>
}

/** Pictures bigger than this on a side are read smaller: a card never needs more. */
const MAX_PICTURE = 4096

const host = window.scene3dHost
const clips = new Map<string, Clip>()
let renderer: THREE.WebGLRenderer | null = null
const readback = document.createElement('canvas')
const back = readback.getContext('2d', { willReadFrequently: true })
let stamp = 0

async function picture(bytes: Uint8Array): Promise<Picture | null> {
  try {
    const blob = new Blob([bytes as BlobPart])
    let bitmap = await createImageBitmap(blob)
    const big = Math.max(bitmap.width, bitmap.height)
    if (big > MAX_PICTURE) {
      const k = MAX_PICTURE / big
      bitmap.close()
      bitmap = await createImageBitmap(blob, { resizeWidth: Math.round(bitmap.width * k), resizeHeight: Math.round(bitmap.height * k), resizeQuality: 'high' })
    }
    // On a canvas, as the editor's preview has its pictures (shared/three/browser): WebGL takes no flip from an
    // ImageBitmap, so a card's picture went on upside down in the export and right way up in the preview.
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    bitmap.close()
    return { image: canvas, width: canvas.width, height: canvas.height, stamp: 0 }
  } catch {
    return null
  }
}

async function handle(m: HostMessage): Promise<HostReply> {
  switch (m.kind) {
    case 'faces': {
      for (const f of m.faces) {
        setFontBytes(f.family, f.bytes)
        // The same face for a card's flat words, set by the 2D engine.
        const [lo, hi] = fontInfo(f.family).weights
        const face = new FontFace(f.family, f.bytes as BufferSource, { weight: lo === hi ? String(lo) : `${lo} ${hi}` })
        try {
          await face.load()
          document.fonts.add(face)
        } catch {
          // The outlines still came in; only a card's flat words fall back.
        }
      }
      return { ok: true }
    }
    case 'clip': {
      // The icons and brand marks it draws, in before its first frame.
      const marks = sceneMarks(m.scene)
      if (marks.icons) setMarkLookups({ icons: await loadIconNodes() })
      if (marks.logos) setMarkLookups({ logos: await loadLogoMarks() })
      const pictures = new Map<string, Picture>()
      for (const p of m.pictures) {
        const pic = await picture(p.bytes)
        if (pic) pictures.set(p.src, pic)
      }
      const models = new Map<string, THREE.Object3D>()
      for (const md of m.models) {
        try {
          const bytes = md.bytes
          models.set(md.src, await parseModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer))
        } catch (err) {
          console.warn(`[3d] could not read ${md.src}:`, err)
        }
      }
      const videos = new Map<string, { canvas: HTMLCanvasElement; picture: Picture }>()
      const view = new Scene3DView(m.design, {
        font: (family) => fontOutlines(fontInfo(family).family) ?? null,
        picture: (o) => (!o.src ? null : isVideoFile(o.src) ? (videos.get(o.id)?.picture ?? null) : (pictures.get(o.src) ?? null)),
        words: (o, w, h) => wordsPicture(o, w, h),
        model: (src) => models.get(src) ?? null,
        logo: (slug) => logoPath(slug),
        icon: (o, w, h) => iconPicture(o, w, h),
        iconNodes: (name) => iconShapes(name)
      })
      clips.get(m.clip)?.view.dispose()
      clips.set(m.clip, { view, scene: m.scene, pixels: m.pixels, pictures, models, videos })
      return { ok: true }
    }
    case 'frame': {
      const clip = clips.get(m.clip)
      if (!clip) return { ok: false, error: `No clip ${m.clip} was set up.` }
      for (const v of m.videos) {
        let held = clip.videos.get(v.object)
        if (!held || held.canvas.width !== v.width || held.canvas.height !== v.height) {
          const canvas = document.createElement('canvas')
          canvas.width = v.width
          canvas.height = v.height
          held = { canvas, picture: { image: canvas, width: v.width, height: v.height, stamp: 0 } }
          clip.videos.set(v.object, held)
        }
        const data = new Uint8ClampedArray(v.data.buffer as ArrayBuffer, v.data.byteOffset, v.data.byteLength)
        held.canvas.getContext('2d')?.putImageData(new ImageData(data, v.width, v.height), 0, 0)
        held.picture = { ...held.picture, stamp: ++stamp }
      }
      renderer ??= createRenderer()
      const { width, height } = clip.pixels
      if (!back) return { ok: false, error: 'This page has no 2D canvas to read the frame from.' }
      if (readback.width !== width || readback.height !== height) {
        readback.width = width
        readback.height = height
      }
      back.clearRect(0, 0, width, height)
      // While the camera or anything in the scene moves, the frame is the average of moments across the shutter,
      // as the 2D graphics are, so a move streaks rather than steps; a still frame is drawn once.
      const shutter = m.shutter ?? 0
      const moments = shutter > 0 && sceneMoves(clip.scene, m.local - shutter / 2, m.local + shutter / 2, m.length) ? SCENE3D_MOMENTS : 1
      if (moments === 1) {
        renderScene3D(renderer, clip.view, clip.scene, m.local, m.length, clip.pixels)
        back.drawImage(renderer.domElement, 0, 0, width, height)
      } else {
        back.globalCompositeOperation = 'lighter'
        back.globalAlpha = 1 / moments
        for (let k = 0; k < moments; k++) {
          renderScene3D(renderer, clip.view, clip.scene, m.local + shutter * (k / (moments - 1) - 0.5), m.length, clip.pixels)
          back.drawImage(renderer.domElement, 0, 0, width, height)
        }
        back.globalCompositeOperation = 'source-over'
        back.globalAlpha = 1
      }
      const pixels = back.getImageData(0, 0, width, height).data
      return { ok: true, data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height }
    }
    case 'drop': {
      const clip = clips.get(m.clip)
      if (clip) {
        clip.view.dispose()
        for (const p of clip.pictures.values()) (p.image as ImageBitmap).close?.()
        clips.delete(m.clip)
      }
      return { ok: true }
    }
  }
}

if (host) {
  host.on((m) => {
    handle(m).then(
      (r) => host.reply(m.id, r),
      (err) => host.reply(m.id, { ok: false, error: err instanceof Error ? err.message : String(err) })
    )
  })
  host.reply(0, { ok: true })
}
