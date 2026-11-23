import type * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { onColor } from '../motion/anim'
import { drawFrame } from '../motion/draw'
import { fontInfo } from '../motion/fonts'
import type { TextLayer } from '../motion/types'
import { parseFont, type GlyphFont } from './glyphs'
import { TITLE_3D_FACE, type Picture } from './scene3d'
import type { Object3D, Scene3D } from './spec'

/**
 * What a page that draws 3D clips needs besides three.js itself, the same in
 * the editor's preview and the export's 3D page: the bundled faces as
 * outlines, a card's words drawn by the 2D engine the flat titles use, and
 * glTF models read from their bytes. Pages only: it draws on canvases.
 */

const outlines = new Map<string, GlyphFont | null>()

/** A bundled face's outlines, read from its file's bytes; a face that cannot be read is remembered as missing. */
export function setFontBytes(family: string, bytes: ArrayBuffer | Uint8Array): void {
  try {
    outlines.set(family, parseFont(bytes))
  } catch (err) {
    console.warn(`[3d] could not read ${family}:`, err)
    outlines.set(family, null)
  }
}

/** A face asked for and not in yet: null until its bytes are given. */
export function markFontAsked(family: string): void {
  if (!outlines.has(family)) outlines.set(family, null)
}

/** A face's outlines: undefined until its bytes have been given, null when they could not be read. */
export function fontOutlines(family: string): GlyphFont | null | undefined {
  return outlines.get(family)
}

/** The faces a scene sets words in, as the bundled faces name them. */
export function sceneFaces(scene: Scene3D): string[] {
  const faces = new Set<string>()
  for (const o of scene.objects) {
    if (o.type === 'text' && o.text) faces.add(fontInfo(o.font ?? TITLE_3D_FACE).family)
    if (o.type === 'card' && o.title) faces.add(fontInfo(o.font ?? TITLE_3D_FACE).family)
  }
  return [...faces]
}

/** The family an object's words are set in, as the bundled faces have it. */
export const faceOf = (o: Object3D): string => fontInfo(o.font ?? TITLE_3D_FACE).family

const words = new Map<string, Picture>()
const MAX_WORD_CARDS = 24

/**
 * A card's words, set by the 2D engine (shared/motion) the flat titles use,
 * on the card's colour in the ink that reads on it, w by h pixels. Drawn
 * again once its face has loaded, so it is never left in a fallback.
 */
export function wordsPicture(o: Object3D, w: number, h: number): Picture | null {
  if (!o.title || typeof document === 'undefined' || w < 2 || h < 2) return null
  const family = faceOf(o)
  const ready = typeof document.fonts?.check === 'function' ? document.fonts.check(`64px "${family}"`) : true
  const key = JSON.stringify([o.title, family, o.color ?? '', w, h, ready])
  const hit = words.get(key)
  if (hit) return hit
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const ground = o.color ?? '#FFFFFF'
  ctx.fillStyle = ground
  ctx.fillRect(0, 0, w, h)
  const layer: TextLayer = {
    kind: 'text',
    start: 0,
    end: 1,
    text: o.title,
    font: { family, size: Math.round(h * 0.2), weight: 700 },
    fill: onColor(ground),
    align: 'center',
    valign: 'middle',
    maxWidth: w * 0.84,
    balance: true,
    transform: { x: w / 2, y: h / 2 }
  }
  drawFrame(ctx, 0, [layer], { width: w, height: h })
  const pic: Picture = { image: canvas, width: w, height: h, stamp: key }
  if (words.size >= MAX_WORD_CARDS) words.delete(words.keys().next().value as string)
  words.set(key, pic)
  return pic
}

/** A glTF or GLB model's scene, read from its bytes. Compressed meshes (Draco, meshopt) are not read. */
export async function parseModel(data: ArrayBuffer): Promise<THREE.Object3D> {
  const gltf = await new GLTFLoader().parseAsync(data, '')
  return gltf.scene
}
