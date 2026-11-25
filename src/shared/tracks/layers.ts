import type { Layer, Size } from '../motion/types'
import type { Timeline } from '../motion/timing'
import { bindExprs } from './compositing'
import { particlesLayer } from '../particles/layer'
import type { ClipMedia } from './media'
import { placeClips, tracksOf, type Placed } from './resolve'
import { matteClipIds, withRoto, type FollowContext } from './roto-layers'
import type { ClipText, Track, TrackClip } from './schema'

/**
 * The picture tracks as the graphics engine's layers, lowest track first, so
 * one compositor (shared/motion draw) paints them in the editor and the
 * export alike. A clip's box is the whole frame, centred where its position
 * says (the frame's centre unless set); its picture fits inside the box as
 * its fit says, and moves, turns, fades, crops and blends with its keys.
 */

/** The face a title uses when it names none. */
export const TITLE_FACE = 'Inter ExtraBold'

export function layerFor(p: Placed, design: Size): Layer | null {
  const { clip } = p
  const W = design.width
  const H = design.height
  const transform = {
    x: W / 2,
    y: H / 2,
    ...clip.transform,
    ...(clip.opacity !== undefined ? { opacity: clip.opacity } : {})
  }
  const base = {
    id: clip.id,
    start: p.start,
    end: p.end,
    transform,
    ...(clip.blend !== 'normal' ? { blend: clip.blend } : {})
  }
  switch (clip.kind) {
    case 'video':
      if (!clip.src) return null
      return { ...base, kind: 'video', src: clip.src, in: clip.in, speed: clip.speed, w: W, h: H, fit: clip.fit, crop: clip.crop }
    case 'image':
      if (!clip.src) return null
      // Through the cropped path always, so fill and crop both hold (shared/motion draw drawPicture).
      return { ...base, kind: 'image', file: clip.src, w: W, h: H, fit: clip.fit, crop: clip.crop ?? {} }
    case 'text':
      if (!clip.text) return null
      return textLayer(base, clip.text, W)
    case 'solid':
      return { ...base, kind: 'shape', shape: { type: 'rect', w: W, h: H }, fill: clip.color ?? '#000000' }
    case 'adjustment': {
      // A box the size of the frame that draws nothing and grades what is under it (shared/motion/adjust).
      const { blur, ...look } = clip.grade ?? {}
      return {
        ...base,
        kind: 'shape',
        shape: { type: 'rect', w: W, h: H },
        adjust: { ...look, ...(blur ? { blur } : {}), w: W, h: H, ...(clip.crop ? { crop: clip.crop } : {}) }
      }
    }
    case 'particles':
      return particlesLayer(base, clip, p.end - p.start, design)
    case '3d':
      if (!clip.scene) return null
      // Drawn by three.js over the whole frame (shared/three), then moved and faded like any clip.
      return { ...base, kind: '3d', scene: clip.scene, w: W, h: H }
    case 'sound':
      return null
  }
}

/**
 * Every picture clip that plays, as layers in stacking order, with their
 * masks, mattes, keys and following (tracks/roto-layers). `follow` places an
 * object followed in the edit's picture; without it such a clip stays put.
 */
export function trackLayers(
  cut: { tracks?: Track[] },
  tl: Timeline,
  design: Size,
  media?: Map<string, ClipMedia>,
  follow?: FollowContext
): Layer[] {
  const tracks = tracksOf(cut)
  const placed = placeClips(tracks, tl, 'picture', media)
  const mattes = matteClipIds(placed)
  // A clip that is a matte cuts whether or not its track is shown, as a matte track is often hidden.
  if (mattes.size > 0) {
    const shown = new Set(placed.map((p) => p.clip.id))
    const hidden = placeClips(tracks.map((t) => ({ ...t, hidden: false })), tl, 'picture', media)
    placed.push(...hidden.filter((p) => mattes.has(p.clip.id) && !shown.has(p.clip.id)))
  }
  const pairs = placed.map((p) => ({ p, layer: layerFor(p, design) }))
  // Expressions learn their clip's place and the clips they read (shared/tracks/compositing).
  bindExprs(pairs, design)
  return pairs
    .map(({ p, layer }) => (layer ? withRoto(layer, p, design, mattes, follow) : null))
    .filter((l): l is Layer => l !== null)
}

/** The files the picture clips show, by kind, for the places that load them. */
export function clipFiles(cut: { tracks?: Track[] }): { videos: string[]; images: string[] } {
  const clips: TrackClip[] = tracksOf(cut).flatMap((t) => (t.kind === 'picture' ? t.clips : []))
  const unique = (kind: TrackClip['kind']): string[] => [...new Set(clips.filter((c) => c.kind === kind && c.src).map((c) => c.src as string))]
  return { videos: unique('video'), images: unique('image') }
}

/** A title clip's words as the 2D engine draws them, with their shadow, glow, edge and lean (ClipText). */
function textLayer(base: object, t: ClipText, W: number): Layer {
  const shadow = t.shadow === true ? {} : t.shadow || null
  return {
    ...base,
    kind: 'text',
    text: t.value,
    font: {
      family: t.font ?? TITLE_FACE,
      size: t.size,
      weight: t.weight,
      ...(t.tracking !== undefined ? { tracking: t.tracking } : {}),
      ...(t.lineHeight !== undefined ? { lineHeight: t.lineHeight } : {}),
      ...(t.uppercase ? { uppercase: true } : {}),
      ...(t.slant ? { slant: t.slant === true ? 0.2126 : t.slant } : {})
    },
    fill: t.color,
    ...(t.outline ? { stroke: { color: t.outline.color, width: t.outline.width, join: 'round' as const } } : {}),
    align: t.align,
    valign: 'middle',
    maxWidth: t.maxWidth ?? W * 0.86,
    balance: true,
    ...(shadow || t.glow
      ? {
          effects: {
            ...(shadow ? { shadow: { color: shadow.color ?? 'rgba(0, 0, 0, 0.6)', blur: shadow.blur ?? t.size * 0.18, y: shadow.y ?? t.size * 0.05 } } : {}),
            ...(t.glow ? { glow: { color: t.glow.color, blur: t.glow.blur ?? t.size * 0.3, strength: t.glow.strength ?? 1 } } : {})
          }
        }
      : {})
  } as Layer
}

