import { useEffect, useState } from 'react'
import { isImagePath } from '../../../../shared/assets'
import { api, mediaUrlFor } from '../api'
import { isAudioFile } from '../format'
import { Icon } from './ui'

/**
 * A still of a file, so a dropped clip looks like itself: the frame ten
 * percent in for footage, the picture for an image, a waveform for sound.
 * Until the still is ready the tile is a calm grey, never a broken image.
 */
export function Poster({ path, name, className }: { path: string; name: string; className?: string }): JSX.Element {
  const image = isImagePath(name)
  const audio = isAudioFile(name)
  const [src, setSrc] = useState<string | null>(image ? mediaUrlFor(path) : null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (image || audio) return
    let live = true
    api
      .mediaPoster(path)
      .then((url) => live && setSrc(url))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [path, image, audio])

  return (
    <span className={`cl-poster${ready ? ' ready' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      {audio ? (
        <Icon.wave />
      ) : (
        src &&
        !failed && (
          <img src={src} alt="" draggable={false} onLoad={() => setReady(true)} onError={() => setFailed(true)} />
        )
      )}
    </span>
  )
}
