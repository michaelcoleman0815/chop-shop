import { useCallback, useEffect, useRef, useState } from 'react'
import type { AspectPreset, Settings, VideoMeta } from '../../../shared/types'
import type { Job } from './JobList'
import { bytes, slug, stamp, timecode } from '../lib/format'

interface Props {
  settings: Settings
  addJob: (job: Job) => void
}

export default function ClipStudio({ settings, addJob }: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [current, setCurrent] = useState(0)
  const [inSec, setInSec] = useState(0)
  const [outSec, setOutSec] = useState(0)
  const [aspect, setAspect] = useState<AspectPreset>(settings.defaultAspect)
  const [name, setName] = useState('')
  const [hot, setHot] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((v: VideoMeta | null) => {
    if (!v) return
    setMeta(v)
    setInSec(0)
    setOutSec(Math.min(30, v.durationSec))
    setName(`${slug(v.fileName)}-clip`)
    setError(null)
  }, [])

  const open = useCallback(async () => {
    try {
      load(await window.chop.openVideo())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [load])

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setHot(false)
      const file = e.dataTransfer.files[0]
      if (!file) return
      try {
        load(await window.chop.describeVideo(window.chop.pathForFile(file)))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [load]
  )

  const seek = useCallback((t: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, t)
    setCurrent(v.currentTime)
  }, [])

  // Keyboard shortcuts stay out of the way of text fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target?.tagName === 'INPUT' || target?.tagName === 'SELECT') return
      const v = videoRef.current
      if (!v || !meta) return
      if (e.code === 'Space') {
        e.preventDefault()
        v.paused ? void v.play() : v.pause()
      } else if (e.key === 'i') {
        setInSec(v.currentTime)
        setOutSec((o) => (o <= v.currentTime ? Math.min(meta.durationSec, v.currentTime + 5) : o))
      } else if (e.key === 'o') {
        setOutSec(v.currentTime)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        seek(v.currentTime - (e.shiftKey ? 5 : 1 / (meta.fps || 30)))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        seek(v.currentTime + (e.shiftKey ? 5 : 1 / (meta.fps || 30)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [meta, seek])

  const playSelection = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = inSec
    void v.play()
    const stop = (): void => {
      if (v.currentTime >= outSec) {
        v.pause()
        v.removeEventListener('timeupdate', stop)
      }
    }
    v.addEventListener('timeupdate', stop)
  }, [inSec, outSec])

  const exportClip = useCallback(async () => {
    if (!meta) return
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const jobName = `${name || slug(meta.fileName)}-${stamp()}`
    addJob({ id: jobId, name: jobName, percent: 0, stage: 'running' })
    await window.chop.exportClip({
      jobId,
      sourcePath: meta.path,
      startSec: inSec,
      endSec: outSec,
      name: jobName,
      aspect,
      outputDir: settings.outputDir
    })
  }, [meta, name, inSec, outSec, aspect, settings.outputDir, addJob])

  if (!meta) {
    return (
      <div>
        {error && (
          <div className="card">
            <div className="label">Import failed</div>
            <p className="mono muted">{error}</p>
          </div>
        )}
        <div
          className={`dropzone ${hot ? 'hot' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setHot(true)
          }}
          onDragLeave={() => setHot(false)}
          onDrop={onDrop}
        >
          <p className="title">Drop a video</p>
          <p className="muted">MP4, MOV, MKV, WebM</p>
          <button className="primary" style={{ marginTop: 16 }} onClick={open}>
            Choose a file
          </button>
        </div>
      </div>
    )
  }

  const pct = (t: number): number => (meta.durationSec ? (t / meta.durationSec) * 100 : 0)
  const duration = Math.max(0, outSec - inSec)

  return (
    <div>
      <div className="card">
        <video
          ref={videoRef}
          className="player"
          src={meta.mediaUrl}
          controls={false}
          onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
          onClick={(e) =>
            e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause()
          }
        />

        <div
          className="timeline"
          style={{ marginTop: 16 }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            seek(((e.clientX - rect.left) / rect.width) * meta.durationSec)
          }}
        >
          <div
            className="sel"
            style={{ left: `${pct(inSec)}%`, width: `${Math.max(0.4, pct(outSec) - pct(inSec))}%` }}
          />
          <div className="head" style={{ left: `${pct(current)}%` }} />
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <button
            onClick={() =>
              videoRef.current?.paused ? void videoRef.current.play() : videoRef.current?.pause()
            }
          >
            Play
          </button>
          <button onClick={() => setInSec(current)}>
            Set in <kbd>I</kbd>
          </button>
          <button onClick={() => setOutSec(current)}>
            Set out <kbd>O</kbd>
          </button>
          <button onClick={playSelection}>Preview selection</button>
          <div className="spacer" />
          <span className="mono">{timecode(current)}</span>
        </div>
      </div>

      <div className="card">
        <div className="label" style={{ marginBottom: 12 }}>
          Clip
        </div>
        <div className="row wrap" style={{ alignItems: 'flex-end', gap: 12 }}>
          <label className="field">
            <span className="label">In</span>
            <input
              type="text"
              className="mono"
              style={{ width: 104 }}
              value={timecode(inSec)}
              readOnly
              onClick={() => seek(inSec)}
            />
          </label>
          <label className="field">
            <span className="label">Out</span>
            <input
              type="text"
              className="mono"
              style={{ width: 104 }}
              value={timecode(outSec)}
              readOnly
              onClick={() => seek(outSec)}
            />
          </label>
          <label className="field">
            <span className="label">Length</span>
            <input
              type="text"
              className="mono"
              style={{ width: 104 }}
              value={timecode(duration)}
              readOnly
            />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 180 }}>
            <span className="label">Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="label">Aspect</span>
            <select value={aspect} onChange={(e) => setAspect(e.target.value as AspectPreset)}>
              <option value="vertical">9:16 vertical</option>
              <option value="square">1:1 square</option>
              <option value="original">Original</option>
            </select>
          </label>
          <button className="primary" disabled={duration < 0.2} onClick={exportClip}>
            Export clip
          </button>
        </div>
      </div>

      <div className="card">
        <div className="label" style={{ marginBottom: 12 }}>
          Source
        </div>
        <p className="mono muted" style={{ fontSize: 12 }}>
          {meta.fileName} · {meta.width}×{meta.height} · {meta.fps} fps ·{' '}
          {timecode(meta.durationSec)} · {bytes(meta.sizeBytes)}
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={open}>Open another video</button>
          <button className="ghost" onClick={() => setMeta(null)}>
            Clear
          </button>
        </div>
      </div>
    </div>
  )
}
