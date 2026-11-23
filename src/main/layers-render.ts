import type { Resolved } from '../shared/edit/resolve'
import type { Cut, Source, Word } from '../shared/edit/schema'
import { timelineFor } from '../shared/motion/timing'
import type { VideoLayer } from '../shared/motion/types'
import { mediaOf, soundingClips, trackLayers, tracksOf } from '../shared/tracks'
import { baseSpans, withoutSpans } from '../shared/tracks/compositing'
import { baseFrames } from './base-frames'
import { frameRate, frameSize, type ClipSoundOptions, type FrameRange, type OverlaySpan } from './cut-render'
import { clipSounds } from './layer-sounds'
import { overlaySpans, renderMotion, spanFrames } from './motion-render'
import { decodeSize, videoFacts, videoFrames, type VideoFacts } from './video-frames'
import type { CutoutTrack } from '../shared/fx'
import { exportMattes } from './matte-cutouts'

/**
 * The layer tracks for the export: the picture tracks drawn frame by frame by
 * the graphics engine's compositor (the one the editor previews with), video
 * clips' frames decoded by ffmpeg for it, into overlay files the final pass
 * lays over the picture under the captions; and the clips that sound, for the
 * final pass to mix with the voice.
 */

export interface CutLayersInput {
  cut: Cut
  resolved: Resolved
  words: Word[]
  sources: Source[]
  /** The edit's material, for clips that name it by id. */
  assets?: { id: string; path: string; durationSec?: number | null }[]
  quality: 'preview' | 'final'
  ffmpeg: string
  workDir: string
  fontsDir: string | null
  /** The cut-outs made for the clips' person and object mattes (main/matte-cutouts); none off a Mac. */
  cutouts?: CutoutTrack[]
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export interface CutLayers {
  overlays: OverlaySpan[]
  sounds: ClipSoundOptions[]
  /**
   * The stretches where a clip blends with the edit's picture or grades it:
   * drawn by renderCut once its picture is there to draw them over, from the
   * arguments that pipe that picture out (main/base-frames). Null when every
   * clip is plain and the overlays are the whole of it.
   */
  overBase: ((baseArgs: (frames: FrameRange[]) => string[]) => Promise<OverlaySpan[]>) | null
}

export async function renderCutLayers(input: CutLayersInput): Promise<CutLayers> {
  const tracks = tracksOf(input.cut)
  if (tracks.length === 0 || tracks.every((t) => t.clips.length === 0)) return { overlays: [], sounds: [], overBase: null }
  const { cut, resolved } = input
  const tl = timelineFor(cut, resolved, input.words)
  const first = input.sources.find((s) => s.id === resolved.pieces[0]?.source) ?? input.sources[0]
  const design = frameSize(cut.aspect, first)
  const pixels = frameSize(cut.aspect, first, input.quality === 'preview')
  const fps = frameRate(first.fps)

  const media = mediaOf(input.assets ?? [], input.sources)
  // Clips that follow an object in the edit's picture are placed through the cut (shared/tracks/roto-layers).
  const layers = trackLayers(cut, tl, design, media, { cut, resolved, pictures: input.sources })
  const sounding = soundingClips(tracks, tl, media)
  // What each file is: its picture's size, and whether it has sound.
  const facts = new Map<string, VideoFacts | null>()
  const files = new Set<string>([
    ...layers.filter((l): l is VideoLayer => l.kind === 'video').map((l) => l.src),
    ...sounding.filter((p) => p.clip.kind === 'video').map((p) => p.clip.src as string)
  ])
  for (const f of files) facts.set(f, await videoFacts(input.ffmpeg, f))

  const sizes = new Map<string, { width: number; height: number }>()
  for (const [f, fact] of facts) if (fact) sizes.set(f, decodeSize(fact, pixels))

  const common = {
    ffmpeg: input.ffmpeg,
    workDir: input.workDir,
    width: pixels.width,
    height: pixels.height,
    fps,
    design,
    duration: resolved.durationSec,
    fontsDir: input.fontsDir,
    signal: input.signal
  }
  // Where a clip blends with the picture or grades it, the picture goes under the layers (shared/tracks/compositing);
  // everywhere else they are a see-through overlay, which is cheaper.
  const based = baseSpans(layers, resolved.durationSec)
  const plain = withoutSpans(overlaySpans(layers, resolved.durationSec), based)
  // The person and objects as mattes, for clips cut to them (main/matte-cutouts), in either pass.
  const mattes = await exportMattes(cut, resolved, input.sources, input.cutouts)
  // 3D clips are drawn by the scene builder the editor previews with, in a page of their own, opened only for an
  // edit that has one (and so Electron is loaded only then). Each pass opens its own, as each closes it when done.
  const has3d = layers.some((l) => l.kind === '3d')
  const scene3d = async () =>
    has3d ? { scene3d: (await import('./three-render')).scene3dFrames({ ffmpeg: input.ffmpeg, fps, pixels, fontsDir: input.fontsDir, signal: input.signal }) } : {}
  const overlays =
    plain.length > 0
      ? await renderMotion(layers, {
          ...common,
          spans: plain,
          video: videoFrames(input.ffmpeg, fps, sizes),
          mattes,
          ...(await scene3d()),
          prefix: 'layers',
          onProgress: input.onProgress
        })
      : []
  const overBase =
    based.length > 0
      ? async (baseArgs: (frames: FrameRange[]) => string[]): Promise<OverlaySpan[]> => {
          const frames = spanFrames(based, fps)
          const base = baseFrames(input.ffmpeg, baseArgs(frames), pixels, frames, input.signal)
          try {
            return await renderMotion(layers, {
              ...common,
              spans: based,
              base,
              video: videoFrames(input.ffmpeg, fps, sizes),
              mattes,
              ...(await scene3d()),
              prefix: 'layers-base'
            })
          } finally {
            base.close()
          }
        }
      : null

  // Every sounding video's file was read above.
  const sounds = await clipSounds(input, async (path) => facts.get(path)?.hasAudio ?? false)
  return { overlays, sounds, overBase }
}
