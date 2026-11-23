import type { Resolved } from '../shared/edit/resolve'
import type { Cut, Source, Word } from '../shared/edit/schema'
import { timelineFor } from '../shared/motion/timing'
import type { VideoLayer } from '../shared/motion/types'
import { mediaOf, soundingClips, trackLayers, tracksOf } from '../shared/tracks'
import { frameRate, frameSize, type ClipSoundOptions, type OverlaySpan } from './cut-render'
import { clipSounds } from './layer-sounds'
import { renderMotion } from './motion-render'
import { decodeSize, videoFacts, videoFrames, type VideoFacts } from './video-frames'

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
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export async function renderCutLayers(input: CutLayersInput): Promise<{ overlays: OverlaySpan[]; sounds: ClipSoundOptions[] }> {
  const tracks = tracksOf(input.cut)
  if (tracks.length === 0 || tracks.every((t) => t.clips.length === 0)) return { overlays: [], sounds: [] }
  const { cut, resolved } = input
  const tl = timelineFor(cut, resolved, input.words)
  const first = input.sources.find((s) => s.id === resolved.pieces[0]?.source) ?? input.sources[0]
  const design = frameSize(cut.aspect, first)
  const pixels = frameSize(cut.aspect, first, input.quality === 'preview')
  const fps = frameRate(first.fps)

  const media = mediaOf(input.assets ?? [], input.sources)
  const layers = trackLayers(cut, tl, design, media)
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

  // 3D clips are drawn by the scene builder the editor previews with, in a page of their own, opened only for an
  // edit that has one (and so Electron is loaded only then).
  const scene3d = layers.some((l) => l.kind === '3d')
    ? (await import('./three-render')).scene3dFrames({ ffmpeg: input.ffmpeg, fps, pixels, fontsDir: input.fontsDir, signal: input.signal })
    : undefined
  const overlays =
    layers.length > 0
      ? await renderMotion(layers, {
          ffmpeg: input.ffmpeg,
          workDir: input.workDir,
          width: pixels.width,
          height: pixels.height,
          fps,
          design,
          duration: resolved.durationSec,
          fontsDir: input.fontsDir,
          video: videoFrames(input.ffmpeg, fps, sizes),
          ...(scene3d ? { scene3d } : {}),
          prefix: 'layers',
          onProgress: input.onProgress,
          signal: input.signal
        })
      : []

  // Every sounding video's file was read above.
  const sounds = await clipSounds(input, async (path) => facts.get(path)?.hasAudio ?? false)
  return { overlays, sounds }
}
