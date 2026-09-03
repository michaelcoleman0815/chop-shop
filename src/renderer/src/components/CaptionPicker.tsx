import { useEffect, useRef, useState } from 'react'
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
 * Hovering plays a two second sample, because half of what separates these is
 * when each word lands, which a still cannot show.
 */
export default function CaptionPicker({ value, onPick }: Props): JSX.Element {
  const [stills, setStills] = useState<Record<string, string>>({})
  const [motion, setMotion] = useState<Record<string, string>>({})
  const [hot, setHot] = useState<string | null>(null)
  const wanted = useRef<Set<string>>(new Set())

  useEffect(() => {
    let live = true
    for (const preset of CAPTION_PRESETS) {
      window.chop
        .captionSample(preset.id)
        .then((url) => live && setStills((prev) => ({ ...prev, [preset.id]: url })))
        .catch(() => undefined)
    }
    return () => {
      live = false
    }
  }, [])

  // The moving sample costs a render, so it is made on first hover rather than
  // for every style whether or not anyone looks at it.
  const warm = (id: string): void => {
    setHot(id)
    if (motion[id] || wanted.current.has(id)) return
    wanted.current.add(id)
    window.chop
      .captionSample(id, true)
      .then((url) => setMotion((prev) => ({ ...prev, [id]: url })))
      .catch(() => undefined)
  }

  return (
    <div className="caption-grid">
      {CAPTION_PRESETS.map((preset) => (
        <button
          key={preset.id}
          className={`caption-tile ${value === preset.id ? 'on' : ''}`}
          onClick={() => onPick(preset.id)}
          onMouseEnter={() => warm(preset.id)}
          onMouseLeave={() => setHot((h) => (h === preset.id ? null : h))}
        >
          <span
            className="caption-shot"
            style={stills[preset.id] ? { backgroundImage: `url("${stills[preset.id]}")` } : undefined}
          >
            {hot === preset.id && motion[preset.id] && (
              <video src={motion[preset.id]} autoPlay muted loop playsInline />
            )}
          </span>
          <span className="caption-name">{preset.name}</span>
        </button>
      ))}
    </div>
  )
}
