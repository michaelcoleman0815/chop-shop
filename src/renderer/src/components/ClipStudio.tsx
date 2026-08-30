import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AspectPreset,
  Settings,
  SuggestedClip,
  TranscriptWord,
  VideoMeta,
  ZoomKeyframe
} from '../../../shared/types'
import ClipEditor, { type Segment } from './ClipEditor'
import { CAPTION_PRESETS } from '../../../shared/caption-presets'
import type { Job } from './JobList'
import { bytes, slug, stamp, timecode } from '../lib/format'
import { groupWords } from '../../../shared/words'

interface Props {
  settings: Settings
  patch: (patch: Partial<Settings>) => Promise<void>
  addJob: (job: Job) => void
}

/** The editor works in clip time; exports address the source. */
function rebaseToSource(words: TranscriptWord[], offsetSec: number): TranscriptWord[] {
  return words.map((w) => ({
    text: w.text,
    startSec: w.startSec + offsetSec,
    endSec: w.endSec + offsetSec
  }))
}

export default function ClipStudio({ settings, patch, addJob }: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const pendingSeek = useRef<number | null>(null)

  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [current, setCurrent] = useState(0)
  const [inSec, setInSec] = useState(0)
  const [outSec, setOutSec] = useState(0)
  const [aspect, setAspect] = useState<AspectPreset>(settings.defaultAspect)
  const [name, setName] = useState('')
  const [hot, setHot] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [win, setWin] = useState<{ url: string; start: number; length: number } | null>(null)

  const [words, setWords] = useState<TranscriptWord[]>([])
  const [suggestions, setSuggestions] = useState<SuggestedClip[]>([])
  const [chosen, setChosen] = useState<number | null>(null)
  const [analysis, setAnalysis] = useState<{ stage: string; percent: number } | null>(null)

  const [captions, setCaptions] = useState(true)
  const [autoZoom, setAutoZoom] = useState(true)
  const [tighten, setTighten] = useState(true)
  const [trackSubject, setTrackSubject] = useState(true)
  const [segments, setSegments] = useState<Segment[]>([])
  const [zooms, setZooms] = useState<ZoomKeyframe[]>([])
  const [editedWords, setEditedWords] = useState<TranscriptWord[]>([])
  const [editorOpen, setEditorOpen] = useState(false)
  const [proof, setProof] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  const [luts, setLuts] = useState<{ name: string; path: string }[]>([])
  const [strip, setStrip] = useState<{
    filmstripUrl: string
    waveformUrl: string | null
    frames: number
  } | null>(null)

  const analysed = words.length > 0

  useEffect(() => {
    window.chop.listLuts().then(setLuts)
    return window.chop.onAiProgress((p) => {
      if (p.stage.startsWith('Downloading model')) return
      setAnalysis(p.percent >= 100 || p.stage === 'Failed' ? null : p)
    })
  }, [])

  const openWindow = useCallback(async (path: string, atSec: number): Promise<number> => {
    const w = await window.chop.previewRange(path, Math.max(0, atSec - 2))
    setWin({ url: w.mediaUrl, start: w.startSec, length: w.windowSec })
    return w.startSec
  }, [])

  const load = useCallback(
    (v: VideoMeta | null) => {
      if (!v) return
      setMeta(v)
      setInSec(0)
      setOutSec(Math.min(30, v.durationSec))
      setName(`${slug(v.fileName)}-clip`)
      setError(null)
      setWords([])
      setSuggestions([])
      setChosen(null)
      setWin(null)
      setProof(null)
      setStrip(null)
      void openWindow(v.path, 0)
      // The scrubber for a two hour recording is otherwise a blank bar. A
      // filmstrip across it makes the whole source legible at a glance.
      window.chop
        .mediaPreviews(v.path)
        .then((p) =>
          setStrip({
            filmstripUrl: p.filmstripUrl,
            waveformUrl: p.waveformUrl,
            frames: p.frames
          })
        )
        .catch(() => undefined)
    },
    [openWindow]
  )

  const open = useCallback(async () => {
    try {
      load(await window.chop.openVideo())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [load])

  const seek = useCallback(
    async (t: number) => {
      const target = Math.max(0, t)
      if (!meta) return
      const inWindow = win && target >= win.start && target < win.start + win.length - 1
      if (!inWindow) {
        pendingSeek.current = target
        const start = await openWindow(meta.path, target)
        setCurrent(Math.max(start, target))
        return
      }
      const v = videoRef.current
      if (!v) return
      v.currentTime = Math.max(0, target - win.start)
      setCurrent(target)
    },
    [meta, win, openWindow]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target?.tagName === 'INPUT' || target?.tagName === 'SELECT') return
      const v = videoRef.current
      if (!v || !meta) return
      if (e.code === 'Space') {
        e.preventDefault()
        v.paused ? void v.play() : v.pause()
      } else if (e.key === 'i') setInSec(current)
      else if (e.key === 'o') setOutSec(current)
      else if (e.key === 'ArrowLeft') {
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

  useEffect(() => {
    if (editorOpen || !analysed || outSec <= inSec) return
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
  }, [inSec, outSec, analysed, autoZoom, editorOpen, clipWords])

  const analyze = useCallback(async () => {
    if (!meta) return
    setError(null)
    setAnalysis({ stage: 'Starting', percent: 0 })
    const res = await window.chop.analyze(meta.path)
    setAnalysis(null)
    if (!res.ok) return setError(res.message)
    setWords(res.result.transcript.words)
    setSuggestions(res.result.clips)
  }, [meta])

  const pick = useCallback(
    (clip: SuggestedClip, index: number) => {
      setChosen(index)
      setInSec(clip.startSec)
      setOutSec(clip.endSec)
      setName(slug(clip.title) || 'clip')
      setProof(null)
      void seek(clip.startSec)
    },
    [seek]
  )

  const buildRequest = useCallback(
    (jobId: string, jobName: string) => ({
      jobId,
      sourcePath: meta?.path ?? '',
      startSec: inSec,
      endSec: outSec,
      name: jobName,
      aspect,
      outputDir: settings.outputDir,
      captionWords: editorOpen ? rebaseToSource(editedWords, inSec) : words,
      captions,
      autoZoom,
      tighten,
      trackSubject,
      segments: tighten ? segments : undefined,
      zooms
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
      zooms
    ]
  )

  const previewEdit = useCallback(async () => {
    if (!meta) return
    setRendering(true)
    try {
      const res = await window.chop.previewClip(buildRequest(`preview-${Date.now()}`, 'preview'))
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
      <div className="empty-stage">
        <div
          className={`dropzone ${hot ? 'hot' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setHot(true)
          }}
          onDragLeave={() => setHot(false)}
          onDrop={async (e) => {
            e.preventDefault()
            setHot(false)
            const file = e.dataTransfer.files[0]
            if (!file) return
            try {
              load(await window.chop.describeVideo(window.chop.pathForFile(file)))
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }}
        >
          <p className="title">Drop a video</p>
          <p className="muted">MP4, MOV, MKV, WebM</p>
          <button className="primary" style={{ marginTop: 16 }} onClick={open}>
            Choose a file
          </button>
          {error && (
            <p className="mono muted" style={{ marginTop: 16 }}>
              {error}
            </p>
          )}
        </div>
      </div>
    )
  }

  const duration = Math.max(0, outSec - inSec)
  const pct = (t: number): number => (meta.durationSec ? (t / meta.durationSec) * 100 : 0)

  return (
    <div className="edit">
      <div className="edit-top">
        <section className="panel clips-panel">
          <div className="panel-head">
            <span className="label">Clips</span>
            <div className="spacer" />
            {analysis ? (
              <span className="mono muted">{analysis.percent}%</span>
            ) : (
              <button className={suggestions.length > 0 ? '' : 'primary'} onClick={analyze}>
                {suggestions.length > 0 ? 'Re-analyse' : 'Analyse'}
              </button>
            )}
          </div>

          {analysis && (
            <div className="analysis-strip">
              <span className="muted">{analysis.stage}</span>
              <div className="bar">
                <i style={{ width: `${analysis.percent}%` }} />
              </div>
            </div>
          )}

          <div className="panel-body">
            {suggestions.length === 0 && !analysis && (
              <p className="muted">
                Analyse to find the moments worth clipping, or set in and out points by hand.
              </p>
            )}
            <div className="suggestion-grid">
              {suggestions.map((c, i) => {
                // The filmstrip already holds a frame for every part of the
                // source, so a thumbnail is a window onto it rather than
                // another render.
                const frame =
                  strip && meta.durationSec > 0
                    ? Math.min(
                        strip.frames - 1,
                        Math.floor((c.startSec / meta.durationSec) * strip.frames)
                      )
                    : 0
                const thumb = strip
                  ? {
                      backgroundImage: `url("${strip.filmstripUrl}")`,
                      backgroundSize: `${strip.frames * 100}% 100%`,
                      backgroundPositionX: `${(frame / Math.max(1, strip.frames - 1)) * 100}%`
                    }
                  : undefined
                return (
                  <button
                    key={i}
                    className={`suggestion ${chosen === i ? 'on' : ''}`}
                    onClick={() => pick(c, i)}
                  >
                    <div className="suggestion-thumb" style={thumb}>
                      <span className="suggestion-time mono">
                        {timecode(c.startSec)}
                        <em>{Math.round(c.endSec - c.startSec)}s</em>
                      </span>
                    </div>
                    <div className="suggestion-score">{c.score}</div>
                    <div className="suggestion-title">{c.title}</div>
                    <div className="suggestion-reason">{c.reason}</div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="panel-foot">
            <button className="ghost" onClick={open}>
              Open another
            </button>
            <div className="spacer" />
            <span className="mono muted" title={meta.fileName}>
              {bytes(meta.sizeBytes)}
            </span>
          </div>
        </section>

        <section className="panel monitor">
          <div className="panel-head">
            <span className="label">{proof ? 'Rendered preview' : 'Source'}</span>
            <div className="spacer" />
            <span className="mono muted">
              {meta.width}×{meta.height} · {meta.fps} fps
            </span>
          </div>

          <div className="monitor-stage">
            <video
              ref={videoRef}
              src={proof ?? win?.url ?? undefined}
              controls={!!proof}
              onTimeUpdate={(e) => {
                if (proof) return
                setCurrent((win?.start ?? 0) + e.currentTarget.currentTime)
              }}
              onLoadedMetadata={(e) => {
                const target = pendingSeek.current
                pendingSeek.current = null
                if (target !== null && win) e.currentTarget.currentTime = Math.max(0, target - win.start)
              }}
            />
          </div>

          <div
            className={`scrub ${strip ? 'has-strip' : ''}`}
            style={
              strip
                ? {
                    backgroundImage: strip.waveformUrl
                      ? `url("${strip.filmstripUrl}"), url("${strip.waveformUrl}")`
                      : `url("${strip.filmstripUrl}")`
                  }
                : undefined
            }
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              setScrubbing(true)
              const rect = e.currentTarget.getBoundingClientRect()
              void seek(((e.clientX - rect.left) / rect.width) * meta.durationSec)
            }}
            onPointerMove={(e) => {
              if (!scrubbing) return
              const rect = e.currentTarget.getBoundingClientRect()
              const t = ((e.clientX - rect.left) / rect.width) * meta.durationSec
              // Move the marker with the pointer immediately; fetching a new
              // window for every pixel would stutter, so the picture catches up
              // when the drag settles.
              setCurrent(Math.max(0, Math.min(meta.durationSec, t)))
            }}
            onPointerUp={(e) => {
              if (!scrubbing) return
              setScrubbing(false)
              const rect = e.currentTarget.getBoundingClientRect()
              void seek(((e.clientX - rect.left) / rect.width) * meta.durationSec)
            }}
          >
            <div
              className="scrub-sel"
              style={{ left: `${pct(inSec)}%`, width: `${Math.max(0.4, pct(outSec) - pct(inSec))}%` }}
            />
            <div className="scrub-head" style={{ left: `${pct(current)}%` }} />
          </div>

          <div className="panel-foot">
            <button
              onClick={() =>
                videoRef.current?.paused ? void videoRef.current.play() : videoRef.current?.pause()
              }
            >
              Play
            </button>
            <button onClick={() => setInSec(current)}>Set in</button>
            <button onClick={() => setOutSec(current)}>Set out</button>
            <div className="spacer" />
            <span className="timecode">
              <b>{timecode(current)}</b>
              <span className="timecode-total"> / {timecode(meta.durationSec)}</span>
            </span>
          </div>
        </section>
      </div>

      <section className="panel dock">
        <div className="panel-head">
          <span className="label">Clip</span>
          <span className="mono muted" style={{ marginLeft: 6 }}>
            {timecode(inSec)} &rarr; {timecode(outSec)}
          </span>
          <span className="dock-length mono">{timecode(duration)}</span>
          <div className="spacer" />
          <button
            disabled={!analysed}
            title="Adjust cuts, zooms and captions. Needs a transcript."
            onClick={() => setEditorOpen((v) => !v)}
          >
            {editorOpen ? 'Close editor' : 'Edit'}
          </button>
          <button
            disabled={duration < 0.2 || rendering || !analysed}
            title="Render the edit at half size. Needs a transcript."
            onClick={previewEdit}
          >
            {rendering ? 'Rendering' : 'Preview'}
          </button>
          <button className="primary" disabled={duration < 0.2} onClick={exportClip}>
            Export
          </button>
        </div>

        <div className="panel-body dock-body">
          <div className="dock-left">
          <div className="dock-controls">
            <label className="field" style={{ flex: 1, minWidth: 180 }}>
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
                {settings.exportPreset && (
                  <option value="preset">
                    {settings.exportPreset.name}
                    {settings.exportPreset.width ? ` (${settings.exportPreset.width}×${settings.exportPreset.height})` : ''}
                  </option>
                )}
              </select>
            </label>
            <label className="field">
              <span className="label">Captions</span>
              <select
                value={settings.captionPreset}
                onChange={(e) => patch({ captionPreset: e.target.value })}
                disabled={!analysed}
              >
                {CAPTION_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ minWidth: 160 }}>
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
          </div>

          <div className="chips" style={{ marginTop: 12 }}>
            <button
              className={`chip ${captions && analysed ? 'on' : ''}`}
              disabled={!analysed}
              onClick={() => setCaptions((v) => !v)}
            >
              Captions
            </button>
            <button className={`chip ${autoZoom ? 'on' : ''}`} onClick={() => setAutoZoom((v) => !v)}>
              Zooms
            </button>
            <button
              className={`chip ${tighten && analysed ? 'on' : ''}`}
              disabled={!analysed}
              onClick={() => setTighten((v) => !v)}
            >
              Tighten
            </button>
            <button
              className={`chip ${trackSubject ? 'on' : ''}`}
              onClick={() => setTrackSubject((v) => !v)}
            >
              Track subject
            </button>
            {proof && (
              <button className="chip" onClick={() => setProof(null)}>
                Back to source
              </button>
            )}
          </div>
          </div>

          {analysed && (
            <div className="dock-transcript">
              <div className="label" style={{ marginBottom: 6 }}>
                Transcript
              </div>
              <div className="transcript-lines">
                {groupWords(words, 9)
                  .filter((g) => g[g.length - 1].endSec > inSec - 20 && g[0].startSec < outSec + 20)
                  .slice(0, 40)
                  .map((g, i) => {
                    const inClip = g[0].startSec >= inSec && g[g.length - 1].endSec <= outSec
                    return (
                      <button
                        key={i}
                        className={`transcript-line ${inClip ? 'in-clip' : ''}`}
                        onClick={() => void seek(g[0].startSec)}
                      >
                        <span className="mono transcript-time">{timecode(g[0].startSec)}</span>
                        <span>{g.map((w) => w.text).join(' ')}</span>
                      </button>
                    )
                  })}
              </div>
            </div>
          )}

          {error && (
            <p className="mono muted" style={{ marginTop: 14 }}>
              {error}
            </p>
          )}


          {editorOpen && segments.length > 0 && (
            <div style={{ marginTop: 18 }}>
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
                overlays={[]}
                music={null}
                onOverlays={() => undefined}
                onMusic={() => undefined}
              />
            </div>
          )}
        </div>
      </section>

      <div className="statusbar">
        <span>
          {analysis
            ? `${analysis.stage}. Captions, tightening and the editor unlock when it finishes.`
            : analysed
              ? 'Click a suggestion to load its range. Drag the scrubber to move, I and O to mark in and out.'
              : 'Drag the scrubber to move. I and O mark in and out. Analyse to find clips automatically.'}
        </span>
        <div className="spacer" />
        <span className="mono">
          {suggestions.length > 0 ? `${suggestions.length} clips · ` : ''}
          {words.length > 0 ? `${words.length.toLocaleString()} words` : 'not analysed'}
        </span>
      </div>
    </div>
  )
}
