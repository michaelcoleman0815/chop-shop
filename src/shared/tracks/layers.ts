import type { Layer, Size } from '../motion/types'
import type { Timeline } from '../motion/timing'
import { particlesLayer } from '../particles/layer'
import type { ClipMedia } from './media'
import { placeClips, tracksOf, type Placed } from './resolve'
import type { Track, TrackClip } from './schema'

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
      return {
        ...base,
        kind: 'text',
        text: clip.text.value,
        font: { family: clip.text.font ?? TITLE_FACE, size: clip.text.size, weight: clip.text.weight },
        fill: clip.text.color,
        align: clip.text.align,
        valign: 'middle',
        maxWidth: clip.text.maxWidth ?? W * 0.86,
        balance: true
      }
    case 'solid':
      return { ...base, kind: 'shape', shape: { type: 'rect', w: W, h: H }, fill: clip.color ?? '#000000' }
    case 'particles':
      return particlesLayer(base, clip, p.end - p.start, design)
    case 'sound':
      return null
  }
}

/** Every picture clip that plays, as layers in stacking order. */
export function trackLayers(cut: { tracks?: Track[] }, tl: Timeline, design: Size, media?: Map<string, ClipMedia>): Layer[] {
  return placeClips(tracksOf(cut), tl, 'picture', media)
    .map((p) => layerFor(p, design))
    .filter((l): l is Layer => l !== null)
}

/** The files the picture clips show, by kind, for the places that load them. */
export function clipFiles(cut: { tracks?: Track[] }): { videos: string[]; images: string[] } {
  const clips: TrackClip[] = tracksOf(cut).flatMap((t) => (t.kind === 'picture' ? t.clips : []))
  const unique = (kind: TrackClip['kind']): string[] => [...new Set(clips.filter((c) => c.kind === kind && c.src).map((c) => c.src as string))]
  return { videos: unique('video'), images: unique('image') }
}
