import type { MusicTrack, OverlayClip } from '../shared/types'

/**
 * Builds the filter graph for a multi-track render.
 *
 * A single -vf chain can only describe one stream, so anything with a second
 * layer has to become a filter_complex. Layer order matters and is not
 * negotiable: overlays sit over the picture, captions sit over everything, or
 * B-roll covers the words the clip is about.
 */

export interface ComposeInput {
  /** Filters applied to the source picture before anything is layered on. */
  baseVideo: string[]
  /** Filters applied to the source audio, if any. */
  baseAudio: string | null
  overlays: OverlayClip[]
  music: MusicTrack | null
  outWidth: number
  outHeight: number
  /** Subtitles filter, applied last so captions stay on top. */
  subtitles: string | null
}

export interface ComposeResult {
  /** Extra -i arguments, in the order their stream indexes assume. */
  inputs: string[]
  filterComplex: string
  videoLabel: string
  audioLabel: string | null
}

function placement(fit: OverlayClip['fit'], w: number, h: number): { scale: string; x: string; y: string } {
  switch (fit) {
    case 'top':
      return { scale: `${w}:-2`, x: '0', y: '0' }
    case 'bottom':
      return { scale: `${w}:-2`, x: '0', y: `${h}-h` }
    case 'pip':
      return {
        scale: `${Math.round(w * 0.42)}:-2`,
        x: `${w}-w-${Math.round(w * 0.05)}`,
        y: `${h}-h-${Math.round(h * 0.06)}`
      }
    default:
      // Cover the frame, cropping the excess rather than letterboxing.
      return {
        scale: `${w}:${h}:force_original_aspect_ratio=increase`,
        x: '(W-w)/2',
        y: '(H-h)/2'
      }
  }
}

export function compose(input: ComposeInput): ComposeResult {
  const { outWidth: w, outHeight: h } = input
  const parts: string[] = []
  const inputs: string[] = []

  parts.push(`[0:v]${input.baseVideo.join(',')}[base0]`)

  let videoLabel = 'base0'
  let streamIndex = 1
  const audioMixLabels: string[] = []

  input.overlays.forEach((overlay, i) => {
    if (overlay.kind === 'image') {
      // A still needs an explicit duration or it is a single frame.
      inputs.push('-loop', '1', '-t', overlay.durationSec.toFixed(3), '-i', overlay.path)
    } else {
      inputs.push('-i', overlay.path)
    }

    const place = placement(overlay.fit, w, h)
    const label = `ov${i}`
    const chain = [
      `scale=${place.scale}`,
      overlay.fit === 'full' ? `crop=${w}:${h}` : null,
      // Shift the overlay's own clock so it starts where it was placed.
      `setpts=PTS-STARTPTS+${overlay.atSec.toFixed(3)}/TB`,
      'format=rgba',
      overlay.opacity < 1 ? `colorchannelmixer=aa=${overlay.opacity.toFixed(3)}` : null
    ]
      .filter(Boolean)
      .join(',')

    parts.push(`[${streamIndex}:v]${chain}[${label}]`)

    const end = overlay.atSec + overlay.durationSec
    const next = `v${i}`
    parts.push(
      `[${videoLabel}][${label}]overlay=${place.x}:${place.y}:enable='between(t,${overlay.atSec.toFixed(3)},${end.toFixed(3)})'[${next}]`
    )
    videoLabel = next

    if (overlay.kind === 'video' && !overlay.muted) {
      const aLabel = `ova${i}`
      parts.push(
        `[${streamIndex}:a]asetpts=PTS-STARTPTS+${overlay.atSec.toFixed(3)}/TB,apad[${aLabel}]`
      )
      audioMixLabels.push(aLabel)
    }

    streamIndex++
  })

  if (input.subtitles) {
    parts.push(`[${videoLabel}]${input.subtitles}[vout]`)
    videoLabel = 'vout'
  }

  // Audio -----------------------------------------------------------------

  let audioLabel: string | null = null
  const speechLabel = 'sp'
  parts.push(`[0:a]${input.baseAudio ?? 'anull'}[${speechLabel}]`)
  audioLabel = speechLabel

  if (input.music) {
    inputs.push('-i', input.music.path)
    const musicIn = `${streamIndex}:a`
    streamIndex++

    parts.push(`[${musicIn}]volume=${input.music.gainDb.toFixed(1)}dB[mus0]`)

    if (input.music.duck) {
      // sidechaincompress takes the stream being ducked first and the trigger
      // second, so the music is the main input and the speech is the key.
      parts.push(`[${speechLabel}]asplit=2[spmix][spkey]`)
      parts.push(
        `[mus0][spkey]sidechaincompress=threshold=0.02:ratio=12:attack=20:release=400[musd]`
      )
      parts.push(`[spmix][musd]amix=inputs=2:duration=first:normalize=0[amixed]`)
    } else {
      parts.push(`[${speechLabel}][mus0]amix=inputs=2:duration=first:normalize=0[amixed]`)
    }
    audioLabel = 'amixed'
  }

  if (audioMixLabels.length > 0) {
    const ins = [audioLabel, ...audioMixLabels].map((l) => `[${l}]`).join('')
    parts.push(`${ins}amix=inputs=${audioMixLabels.length + 1}:duration=first:normalize=0[aall]`)
    audioLabel = 'aall'
  }

  return {
    inputs,
    filterComplex: parts.join(';'),
    videoLabel,
    audioLabel
  }
}
