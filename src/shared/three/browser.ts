import type * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mixColor, onColor } from '../motion/anim'
import { drawFrame } from '../motion/draw'
import { fontInfo } from '../motion/fonts'
import type { DrawResources, IconNode, ImageLayer, Layer, LogoMark, TextLayer } from '../motion/types'
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
const MAX_WORD_CARDS = 48

/** Lucide's shapes and Simple Icons' marks, once a page has loaded them (setMarkLookups). */
let iconNodes: ((name: string) => IconNode[] | undefined) | null = null
let logoMarks: ((slug: string) => LogoMark | undefined) | null = null

/** The icons and brand marks scenes draw, from the page's own loaders: until they are in, marks and patterns wait. */
export function setMarkLookups(lookups: { icons?: (name: string) => IconNode[] | undefined; logos?: (slug: string) => LogoMark | undefined }): void {
  if (lookups.icons) iconNodes = lookups.icons
  if (lookups.logos) logoMarks = lookups.logos
}

/** What a scene draws from the icons and the brand marks, for a page to load them first. */
export function sceneMarks(scene: Scene3D): { icons: boolean; logos: boolean } {
  return {
    icons: scene.objects.some((o) => (o.type === 'mark' && !!o.icon && !o.logo) || (o.type === 'card' && !!o.pattern?.length)),
    logos: scene.objects.some((o) => o.type === 'mark' && !!o.logo)
  }
}

/** A Lucide icon's shapes by name, for a mark made solid; null until the icons are in, or when there is none. */
export function iconShapes(name: string): IconNode[] | null {
  return iconNodes?.(name) ?? null
}

/** A brand's mark by slug, as a 3D mark extrudes it; null until the marks are in, or when there is none. */
export function logoPath(slug: string): { path: string; hex: string } | null {
  const m = logoMarks?.(slug)
  return m ? { path: m.path, hex: m.hex } : null
}

/** A small number from a string and an index, the same every time: a pattern's icons fall the same on every frame. */
function jitter(seed: string, i: number): number {
  let h = 2166136261
  for (const ch of `${seed}:${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return ((h >>> 0) % 10_000) / 10_000
}

/** How far apart a pattern's icons are, in design pixels: a doodle about a twentieth of a 1080 frame's height. */
const PATTERN_CELL = 150

/**
 * A card's pattern of icons as layers, w by h pixels of a card o.w design pixels wide: rows of them a
 * PATTERN_CELL apart, each nudged and turned a little, faint on its ground.
 */
function patternLayers(o: Object3D, w: number, h: number, ground: string): Layer[] {
  const names = o.pattern ?? []
  if (!names.length) return []
  const cell = Math.max(6, PATTERN_CELL * (o.w ? w / o.w : 1))
  const ink = mixColor(ground, onColor(ground), 0.2)
  const out: ImageLayer[] = []
  let i = 0
  for (let y = cell / 2; y < h + cell / 2; y += cell)
    for (let x = cell / 2; x < w + cell / 2; x += cell, i++) {
      const size = cell * (0.42 + jitter(o.id, i * 3) * 0.2)
      out.push({
        kind: 'image',
        start: 0,
        end: 1,
        icon: names[i % names.length],
        w: size,
        h: size,
        color: ink,
        strokeWidth: 1.6,
        transform: {
          x: x + (jitter(o.id, i * 3 + 1) - 0.5) * cell * 0.4,
          y: y + (jitter(o.id, i * 3 + 2) - 0.5) * cell * 0.4,
          rotation: (jitter(o.id, i * 5) - 0.5) * 50
        }
      })
    }
  return out
}

/**
 * A mark's icon cut out flat: its strokes in the mark's colour (white when it names none) on nothing, w by h
 * pixels. Null until the icons are in.
 */
export function iconPicture(o: Object3D, w: number, h: number): Picture | null {
  if (!o.icon || !iconNodes || typeof document === 'undefined' || !iconNodes(o.icon)) return null
  const key = JSON.stringify(['icon', o.icon, o.color ?? '', w, h])
  const hit = words.get(key)
  if (hit) return hit
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const layer: ImageLayer = {
    kind: 'image',
    start: 0,
    end: 1,
    icon: o.icon,
    w: w * 0.92,
    h: h * 0.92,
    color: o.color ?? '#FFFFFF',
    strokeWidth: 2.2,
    transform: { x: w / 2, y: h / 2 }
  }
  drawFrame(ctx, 0, [layer], { width: w, height: h }, { icons: iconNodes })
  const pic: Picture = { image: canvas, width: w, height: h, stamp: key }
  if (words.size >= MAX_WORD_CARDS) words.delete(words.keys().next().value as string)
  words.set(key, pic)
  return pic
}

/**
 * A card's words, set by the 2D engine (shared/motion) the flat titles use,
 * on the card's colour in the ink that reads on it, w by h pixels. Drawn
 * again once its face has loaded, so it is never left in a fallback.
 */
export function wordsPicture(o: Object3D, w: number, h: number): Picture | null {
  if ((!o.title && !o.pattern?.length) || typeof document === 'undefined' || w < 2 || h < 2) return null
  // A pattern waits for the icons, rather than settling as a bare card.
  if (o.pattern?.length && !iconNodes) return null
  const family = faceOf(o)
  const ready = typeof document.fonts?.check === 'function' ? document.fonts.check(`64px "${family}"`) : true
  const key = JSON.stringify([o.title ?? '', o.pattern ?? [], family, o.color ?? '', o.titleSize ?? 0, o.titleColor ?? '', o.titleWeight ?? 0, w, h, ready])
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
  const resources: DrawResources = iconNodes ? { icons: iconNodes } : {}
  drawFrame(ctx, 0, patternLayers(o, w, h, ground), { width: w, height: h }, resources)
  if (!o.title) {
    const pic: Picture = { image: canvas, width: w, height: h, stamp: key }
    if (words.size >= MAX_WORD_CARDS) words.delete(words.keys().next().value as string)
    words.set(key, pic)
    return pic
  }
  const layer: TextLayer = {
    kind: 'text',
    start: 0,
    end: 1,
    text: o.title,
    // Asked for in design pixels; the picture may be drawn smaller than the card is (a 2048 px cap).
    font: { family, size: Math.round(o.titleSize ? o.titleSize * (o.h ? h / o.h : 1) : h * 0.2), weight: o.titleWeight ?? 700 },
    fill: o.titleColor ?? onColor(ground),
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
