import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AspectPreset,
  MusicTrack,
  OverlayClip,
  Settings,
  SuggestedClip,
  TranscriptWord,
  VideoMeta,
  ZoomKeyframe
} from '../../../shared/types'
import ClipEditor, { type Segment } from './ClipEditor'
import { CAPTION_PRESETS } from '../../../shared/caption-presets'

/** The editor works in clip time; exports address the source. */
function rebaseToSource(words: TranscriptWord[], offsetSec: number): TranscriptWord[] {
  return words.map((w) => ({
    text: w.text,
    startSec: w.startSec + offsetSec,
    endSec: w.endSec + offsetSec
  }))
}
import type { Job } from './JobList'
import { bytes, slug, stamp, timecode } from '../lib/format'

interface Props {
  settings: Settings
  patch: (patch: Partial<Settings>) => Promise<void>
  addJob: (job: Job) => void
}

export default function ClipStudio({ settings, patch, addJob }: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [current, setCurrent] = useState(0)
  const [inSec, setInSec] = useState(0)
  const [outSec, setOutSec] = useState(0)
  const [aspect, setAspect] = useState<AspectPreset>(settings.defaultAspect)
  const [name, setName] = useState('')
  const [hot, setHot] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [words, setWords] = useState<TranscriptWord[]>([])
  const [suggestions, setSuggestions] = useState<SuggestedClip[]>([])
  const [analysis, setAnalysis] = useState<{ stage: string; percent: number } | null>(null)
  const [captions, setCaptions] = useState(true)
  const [autoZoom, setAutoZoom] = useState(true)
  const [tighten, setTighten] = useState(true)
  const [trackSubject, setTrackSubject] = useState(true)
  // The edit for the current in/out range: which spans survive, and where the
  // punch-ins sit. Planned automatically, then owned by the editor.
  const [segments, setSegments] = useState<Segment[]>([])
  const [zooms, setZooms] = useState<ZoomKeyframe[]>([])
  const [editorOpen, setEditorOpen] = useState(false)
  const [editedWords, setEditedWords] = useState<TranscriptWord[]>([])
  const [overlays, setOverlays] = useState<OverlayClip[]>([])
  const [music, setMusic] = useState<MusicTrack | null>(null)
  // A rendered preview of the edit, distinct from the source window the player
  // otherwise shows.
  const [proof, setProof] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const [luts, setLuts] = useState<{ name: string; path: string }[]>([])
  // The player shows a window cut out of the source, not the source itself.
  const [win, setWin] = useState<{ url: string; start: number; length: number } | null>(null)
  // Where to land once a newly fetched window has loaded, in absolute time.
  const pendingSeek = useRef<number | null>(null)

  const openWindow = useCallback(
    async (path: string, atSec: number): Promise<number> => {
      const w = await window.chop.previewRange(path, Math.max(0, atSec - 2))
      setWin({ url: w.mediaUrl, start: w.startSec, length: w.windowSec })
      return w.startSec
    },
    []
  )

  const load = useCallback((v: VideoMeta | null) => {
    if (!v) return
    setMeta(v)
    setInSec(0)
    setOutSec(Math.min(30, v.durationSec))
    setName(`${slug(v.fileName)}-clip`)
    setError(null)
    setWords([])
    setSuggestions([])
    setWin(null)
    void openWindow(v.path, 0)
  }, [openWindow])

  useEffect(() => {
    window.chop.listLuts().then(setLuts)
  }, [])

  useEffect(() => {
    return window.chop.onAiProgress((p) => {
      if (p.stage === 'Downloading model') return
      setAnalysis(p.percent >= 100 || p.stage === 'Failed' ? null : p)
    })
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

  /**
   * Seeks in absolute source time, fetching a new window when the target falls
   * outside the one currently loaded.
   */
  const seek = useCallback(
    async (t: number) => {
      const target = Math.max(0, t)
      const v = videoRef.current
      if (!meta) return

      const inWindow = win && target >= win.start && target < win.start + win.length - 1
      if (!inWindow) {
        pendingSeek.current = target
        const start = await openWindow(meta.path, target)
        setCurrent(Math.max(start, target))
        return
      }
      if (!v) return
      v.currentTime = Math.max(0, target - win.start)
      setCurrent(target)
    },
    [meta, win, openWindow]
  )

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
        setInSec(current)
        setOutSec((o) => (o <= current ? Math.min(meta.durationSec, current + 5) : o))
      } else if (e.key === 'o') {
        setOutSec(current)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        void seek(current - (e.shiftKey ? 5 : 1 / (meta.fps || 30)))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        void seek(current + (e.shiftKey ? 5 : 1 / (meta.fps || 30)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [meta, seek, current])

  const playSelection = useCallback(async () => {
    await seek(inSec)
    const v = videoRef.current
    if (!v) return
    void v.play()
    const stop = (): void => {
      const absolute = (win?.start ?? 0) + v.currentTime
      if (absolute >= outSec) {
        v.pause()
        v.removeEventListener('timeupdate', stop)
      }
    }
    v.addEventListener('timeupdate', stop)
  }, [inSec, outSec, seek, win])

  const analyze = useCallback(async () => {
    if (!meta) return
    setError(null)
    setAnalysis({ stage: 'Starting', percent: 0 })
    const res = await window.chop.analyze(meta.path)
    setAnalysis(null)
    if (!res.ok) {
      setError(res.message)
      return
    }
    setWords(res.result.transcript.words)
    setSuggestions(res.result.clips)
  }, [meta])

  const useSuggestion = useCallback(
    (clip: SuggestedClip) => {
      setInSec(clip.startSec)
      setOutSec(clip.endSec)
      setName(slug(clip.title) || 'clip')
      void seek(clip.startSec)
    },
    [seek]
  )

  const clipWords = useCallback(
    (): TranscriptWord[] =>
      words
        .filter((w) => w.endSec > inSec && w.startSec < outSec)
        .map((w) => ({
          text: w.text,
          startSec: Math.max(0, w.startSec - inSec),
          endSec: Math.max(0.05, w.endSec - inSec)
        })),
    [words, inSec, outSec]
  )

  // Re-plan whenever the range moves, unless the editor is open, where
  // re-planning would throw away the edit in progress.
  useEffect(() => {
    if (editorOpen || words.length === 0 || outSec <= inSec) return
    const local = clipWords()
    if (local.length === 0) return
    let cancelled = false
    window.chop.planClip({ words: local, durationSec: outSec - inSec }).then((plan) => {
      if (cancelled) return
      setSegments(plan.segments)
      setZooms(autoZoom ? plan.zooms : [])
      setEditedWords(local)
    })
    return () => {
      cancelled = true
    }
  }, [inSec, outSec, words, autoZoom, editorOpen, clipWords])

  const buildRequest = useCallback(
    (jobId: string, name: string) => ({
      jobId,
      sourcePath: meta?.path ?? '',
      startSec: inSec,
      endSec: outSec,
      name,
      aspect,
      outputDir: settings.outputDir,
      captionWords: editorOpen ? rebaseToSource(editedWords, inSec) : words,
      captions,
      autoZoom,
      tighten,
      trackSubject,
      segments: tighten ? segments : undefined,
      zooms,
      overlays,
      music
    }),
    [
      meta,
      inSec,
      outSec,
      aspect,
      settings.outputDir,
      editorOpen,
      editedWords,
      words,
      captions,
      autoZoom,
      tighten,
      trackSubject,
      segments,
      zooms,
      overlays,
      music
    ]
  )

  const previewEdit = useCallback(async () => {
    if (!meta) return
    setRendering(true)
    try {
      const res = await window.chop.previewClip(
        buildRequest(`preview-${Date.now()}`, 'preview')
      )
      if (res.ok) setProof(res.mediaUrl)
      else setError(res.message)
    } finally {
      setRendering(false)
    }
  }, [meta, buildRequest])

  const exportClip = useCallback(async () => {
    if (!meta) return
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const jobName = `${name || slug(meta.fileName)}-${stamp()}`
    addJob({ id: jobId, name: jobName, percent: 0, stage: 'running' })
    await window.chop.exportClip(buildRequest(jobId, jobName))
  }, [meta, name, addJob, buildRequest])

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
          src={proof ?? win?.url ?? undefined}
          controls={false}
          onTimeUpdate={(e) => {
            if (proof) return
            setCurrent((win?.start ?? 0) + e.currentTarget.currentTime)
          }}
          onLoadedMetadata={(e) => {
            const target = pendingSeek.current
            pendingSeek.current = null
            if (target !== null && win) {
              e.currentTarget.currentTime = Math.max(0, target - win.start)
            }
          }}
          onClick={(e) =>
            e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause()
          }
        />

        <div
          className="timeline"
          style={{ marginTop: 16 }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            void seek(((e.clientX - rect.left) / rect.width) * meta.durationSec)
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
          <button onClick={playSelection} disabled={!!proof}>
            Preview selection
          </button>
          {proof && (
            <button className="ghost" onClick={() => setProof(null)}>
              Back to source
            </button>
          )}
          <div className="spacer" />
          <span className="mono">{timecode(current)}</span>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div className="label">Find clips</div>
          <div className="spacer" />
          {analysis ? (
            <>
              <span className="muted">{analysis.stage}</span>
              <span className="mono muted">{analysis.percent}%</span>
            </>
          ) : (
            <button className="primary" onClick={analyze}>
              {suggestions.length > 0 ? 'Analyse again' : 'Analyse'}
            </button>
          )}
        </div>
        {analysis && (
          <div className="bar" style={{ marginTop: 12 }}>
            <i style={{ width: `${analysis.percent}%`, background: 'var(--accent)' }} />
          </div>
        )}
        {suggestions.length > 0 && (
          <div style={{ marginTop: 16 }}>
            {suggestions.map((c, i) => (
              <button
                key={i}
                className="job"
                style={{ display: 'block', width: '100%', textAlign: 'left' }}
                onClick={() => useSuggestion(c)}
              >
                <div className="row">
                  <span style={{ flex: 1, minWidth: 0 }}>{c.title}</span>
                  <span className="mono muted">
                    {timecode(c.startSec)} · {Math.round(c.endSec - c.startSec)}s
                  </span>
                  <span className="mono muted">{c.score}</span>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {c.reason}
                </div>
              </button>
            ))}
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="row" style={{ marginTop: 16 }}>
            <span className="muted" style={{ flex: 1 }}>
              Send every suggestion to Premiere as editable cuts on your original file.
            </span>
            <button
              onClick={async () => {
                if (!meta) return
                const res = await window.chop.exportPremiere({
                  sourcePath: meta.path,
                  clips: suggestions,
                  words,
                  tighten
                })
                if (res.ok) window.chop.reveal(res.xmlPath)
                else setError(res.message)
              }}
            >
              Export for Premiere
            </button>
          </div>
        )}
        {words.length > 0 && suggestions.length === 0 && !analysis && (
          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Nothing in this one stands alone as a clip.
          </p>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="label">Clip</div>
          <div className="spacer" />
          <span className="mono muted">
            {timecode(inSec)} &rarr; {timecode(outSec)}
          </span>
          <span className="mono" style={{ marginLeft: 8 }}>
            {timecode(duration)}
          </span>
        </div>

        <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 1, minWidth: 200 }}>
            <span className="label">Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="label">Aspect</span>
            <select value={aspect} onChange={(e) => setAspect(e.target.value as AspectPreset)}>
              <option value="vertical">9:16 vertical</option>
              <option value="square">1:1 square</option>
              <option value="wide">16:9 wide</option>
              <option value="original">Original</option>
            </select>
          </label>
        </div>

        <div className="label" style={{ marginTop: 20, marginBottom: 8 }}>
          Treatments
        </div>
        <div className="chips">
          <button
            className={`chip ${captions && words.length > 0 ? 'on' : ''}`}
            disabled={words.length === 0}
            title={words.length === 0 ? 'Analyse the video first' : 'Burn word-level captions in'}
            onClick={() => setCaptions((v) => !v)}
          >
            Captions
          </button>
          <button
            className={`chip ${autoZoom ? 'on' : ''}`}
            title="Punch in on emphasis"
            onClick={() => setAutoZoom((v) => !v)}
          >
            Zooms
          </button>
          <button
            className={`chip ${tighten && words.length > 0 ? 'on' : ''}`}
            disabled={words.length === 0}
            title={words.length === 0 ? 'Analyse the video first' : 'Cut pauses and filler words'}
            onClick={() => setTighten((v) => !v)}
          >
            Tighten
          </button>
          <button
            className={`chip ${trackSubject ? 'on' : ''}`}
            title="Keep the speaker in frame"
            onClick={() => setTrackSubject((v) => !v)}
          >
            Track subject
          </button>
        </div>

        <div className="card-actions">
          {words.length === 0 && (
            <span className="muted needs-analysis">
              Captions, tightening and the editor need a transcript. Run Analyse first.
            </span>
          )}
          <button
            disabled={words.length === 0}
            title={words.length === 0 ? 'Analyse the video first' : 'Adjust cuts, zooms and captions'}
            onClick={() => setEditorOpen((v) => !v)}
          >
            {editorOpen ? 'Close editor' : 'Edit'}
          </button>
          <div className="spacer" />
          <button
            disabled={duration < 0.2 || rendering || words.length === 0}
            onClick={previewEdit}
          >
            {rendering ? 'Rendering' : 'Preview'}
          </button>
          <button className="primary" disabled={duration < 0.2} onClick={exportClip}>
            Export clip
          </button>
        </div>
      </div>

      {editorOpen && segments.length > 0 && (
        <ClipEditor
          durationSec={Math.max(0.1, outSec - inSec)}
          segments={segments}
          zooms={zooms}
          words={editedWords}
          currentSec={Math.max(0, Math.min(outSec - inSec, current - inSec))}
          onSeek={(t) => void seek(inSec + t)}
          onSegments={setSegments}
          onZooms={setZooms}
          onWords={setEditedWords}
          overlays={overlays}
          music={music}
          onOverlays={setOverlays}
          onMusic={setMusic}
        />
      )}

      <div className="card">
        <div className="label" style={{ marginBottom: 12 }}>
          Look
        </div>
        <div className="row wrap" style={{ alignItems: 'flex-end', gap: 12 }}>
          <label className="field">
            <span className="label">Caption style</span>
            <select
              value={settings.captionPreset}
              onChange={(e) => patch({ captionPreset: e.target.value })}
              disabled={words.length === 0}
            >
              {CAPTION_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: 1, minWidth: 200 }}>
            <span className="label">Colour</span>
            <select
              value={settings.lutPath ?? ''}
              onChange={(e) => patch({ lutPath: e.target.value || null })}
            >
              <option value="">No grade</option>
              {luts.map((l) => (
                <option key={l.path} value={l.path}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost"
            onClick={async () => {
              const path = await window.chop.chooseLut()
              if (path) await patch({ lutPath: path })
            }}
          >
            Load .cube
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
