import { useEffect, useState } from 'react'
import type { MapStatus } from '../../../../shared/maps'
import { api } from '../api'
import { Button } from '../components/ui'
import { grow } from '../motion'

/**
 * Settings' maps section: whether the sharper satellite pictures and the
 * plate boundaries are on this computer, a download for them with its
 * progress, and what that download sends, which is nothing about the places
 * anyone maps.
 */
export function MapsSection(): JSX.Element {
  const [status, setStatus] = useState<MapStatus | null>(null)
  const [percent, setPercent] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    void api.mapStatus().then((s) => {
      setStatus(s)
      if (s.downloading) setPercent(0)
    })
    return api.onMapProgress((p) => {
      setPercent(p.percent >= 100 ? null : p.percent)
      if (p.percent >= 100) void api.mapStatus().then(setStatus)
    })
  }, [])

  const download = async (): Promise<void> => {
    setProblem(null)
    setPercent(0)
    try {
      const r = await api.downloadMaps()
      setStatus(r.status)
      if (!r.ok) setProblem(r.message)
    } finally {
      setPercent(null)
    }
  }

  const size = status ? `${status.downloadMb} MB` : 'about 120 MB'
  return (
    <section className="cl-section" aria-labelledby="set-maps">
      <h2 id="set-maps">Maps</h2>
      {percent !== null ? (
        <div className="cl-progress">
          <span>Downloading map pictures</span>
          <span className="cl-progress-bar" aria-hidden="true">
            <span style={grow(Math.max(4, Math.min(100, percent)))} />
          </span>
        </div>
      ) : status?.complete ? (
        <p className="cl-reply">Sharp satellite pictures and the plate boundaries are on this computer.</p>
      ) : (
        <div className="cl-row">
          <p className="cl-reply">
            {problem ??
              `Maps draw from small pictures that come with Cutalong. The sharper ones from NASA, with the plate boundaries, are a ${size} download. I fetch them the first time a map needs them, or now.`}
          </p>
          <Button small disabled={!status} onClick={() => void download()}>
            {problem ? 'Try again' : 'Download now'}
          </Button>
        </div>
      )}
      <p className="cl-aside">
        This download comes from NASA&apos;s and the plate data&apos;s own servers, the same files for everyone, so it
        says nothing about the places you map. Nothing else about your maps leaves this computer.
      </p>
    </section>
  )
}
