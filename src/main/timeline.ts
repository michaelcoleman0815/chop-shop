import type { Timeline } from '../shared/types'
import { timelineDuration } from '../shared/timeline'

export { timelineDuration }

/**
 * Builds the filter graph that renders a timeline.
 *
 * Each clip is trimmed from its source and placed on the output clock, then the
 * track is assembled by overlaying every clip onto a background of the right
 * size. Overlay with an enable window is used rather than concat because concat
 * demands identical stream parameters across inputs, which media from different
 * cameras and screen recorders almost never has.
 */
export interface TimelineRender {
  inputs: string[]
  filterComplex: string
  videoLabel: string
  audioLabel: string | null
  durationSec: number
}

export function buildTimelineRender(timeline: Timeline): TimelineRender | null {
  const clips = [...timeline.clips].sort(
    (a, b) => a.track - b.track || a.timelineStartSec - b.timelineStartSec
  )
  if (clips.length === 0) return null

  const { width: w, height: h, fps } = timeline
  const duration = timelineDuration(timeline)
  const parts: string[] = []
  const inputs: string[] = []

  // A solid background gives every clip somewhere to land, and covers the gaps
  // between them instead of leaving the graph undefined there.
  parts.push(
    `color=c=black:s=${w}x${h}:r=${fps}:d=${duration.toFixed(3)}[bg]`
  )

  let videoLabel = 'bg'
  const audioLabels: string[] = []

  const transitions = timeline.transitions ?? []

  clips.forEach((clip, i) => {
    const length = Math.max(0.05, clip.sourceOutSec - clip.sourceInSec)
    inputs.push(
      '-ss',
      clip.sourceInSec.toFixed(3),
      '-t',
      length.toFixed(3),
      '-i',
      clip.mediaPath
    )

    const end = clip.timelineStartSec + length
    parts.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `setpts=PTS-STARTPTS+${clip.timelineStartSec.toFixed(3)}/TB,fps=${fps}[cv${i}]`
    )
    const transition = transitions.find((t) => t.toClipId === clip.id)
    if (transition && clip.timelineStartSec > 0) {
      // A dissolve is a fade on the incoming clip over what is already there;
      // a dip goes through black, so the outgoing side fades down first.
      const dur = Math.min(transition.durationSec, length)
      const fadeIn =
        transition.kind === 'dip-to-black'
          ? `fade=t=in:st=${(clip.timelineStartSec + dur / 2).toFixed(3)}:d=${(dur / 2).toFixed(3)}:alpha=1`
          : `fade=t=in:st=${clip.timelineStartSec.toFixed(3)}:d=${dur.toFixed(3)}:alpha=1`
      parts.push(`[cv${i}]format=yuva420p,${fadeIn}[cvf${i}]`)
      parts.push(
        `[${videoLabel}][cvf${i}]overlay=0:0:enable='between(t,${clip.timelineStartSec.toFixed(3)},${end.toFixed(3)})'[vt${i}]`
      )
    } else {
      parts.push(
        `[${videoLabel}][cv${i}]overlay=0:0:enable='between(t,${clip.timelineStartSec.toFixed(3)},${end.toFixed(3)})'[vt${i}]`
      )
    }
    videoLabel = `vt${i}`

    if (!clip.muted) {
      const aTrans = transitions.find((t) => t.toClipId === clip.id)
      const aFade = aTrans
        ? `,afade=t=in:st=0:d=${Math.min(aTrans.durationSec, length).toFixed(3)}`
        : ''
      parts.push(
        `[${i}:a]asetpts=PTS-STARTPTS${aFade},adelay=${Math.round(clip.timelineStartSec * 1000)}|${Math.round(clip.timelineStartSec * 1000)}[ca${i}]`
      )
      audioLabels.push(`ca${i}`)
    }
  })

  let audioLabel: string | null = null
  if (audioLabels.length === 1) {
    audioLabel = audioLabels[0]
  } else if (audioLabels.length > 1) {
    parts.push(
      `${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[amixed]`
    )
    audioLabel = 'amixed'
  }

  return { inputs, filterComplex: parts.join(';'), videoLabel, audioLabel, durationSec: duration }
}
