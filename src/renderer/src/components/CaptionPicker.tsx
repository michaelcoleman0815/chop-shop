import { useEffect, useState } from 'react'
import { CAPTION_PRESETS } from '../../../shared/caption-presets'

interface Props {
  value: string
  onPick: (id: string) => void
}

/**
 * Caption styles shown as themselves.
 *
 * Each tile is a frame rendered by the same engine that burns the captions
 * into the export, so choosing is looking rather than guessing from a name.
 * They arrive one at a time, since the first render of each costs an ffmpeg
 * pass and the rest are cache hits.
 */
export default function CaptionPicker({ value, onPick }: Props): JSX.Element {
  const [samples, setSamples] = useState<Record<string, string>>({})

  useEffect(() => {
    let live = true
    for (const preset of CAPTION_PRESETS) {
      window.chop
        .captionSample(preset.id)
        .then((url) => live && setSamples((prev) => ({ ...prev, [preset.id]: url })))
        .catch(() => undefined)
    }
    return () => {
      live = false
    }
  }, [])

  return (
    <div className="caption-grid">
      {CAPTION_PRESETS.map((preset) => (
        <button
          key={preset.id}
          className={`caption-tile ${value === preset.id ? 'on' : ''}`}
          onClick={() => onPick(preset.id)}
        >
          <span
            className="caption-shot"
            style={samples[preset.id] ? { backgroundImage: `url("${samples[preset.id]}")` } : undefined}
          />
          <span className="caption-name">{preset.name}</span>
        </button>
      ))}
    </div>
  )
}
