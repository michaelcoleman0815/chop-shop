import type { Layer, Size } from '../motion/types'
import type { Timeline } from '../motion/timing'
import type { ClipMedia } from './media'
import { placeClips, tracksOf, type Placed } from './resolve'
import { matteClipIds, withRoto, type FollowContext } from './roto-layers'
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
  return placed
    .map((p) => {
      const layer = layerFor(p, design)
      return layer ? withRoto(layer, p, design, mattes, follow) : null
    })
    .filter((l): l is Layer => l !== null)
}

/** The files the picture clips show, by kind, for the places that load them. */
export function clipFiles(cut: { tracks?: Track[] }): { videos: string[]; images: string[] } {
  const clips: TrackClip[] = tracksOf(cut).flatMap((t) => (t.kind === 'picture' ? t.clips : []))
  const unique = (kind: TrackClip['kind']): string[] => [...new Set(clips.filter((c) => c.kind === kind && c.src).map((c) => c.src as string))]
  return { videos: unique('video'), images: unique('image') }
}
