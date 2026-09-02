import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AspectPreset,
  ClipGenre,
  ClipGraphic,
  Project,
  Settings,
  SuggestedClip,
  TranscriptWord,
  VideoMeta,
  ZoomKeyframe
} from '../../../shared/types'
import ClipEditor, { type Segment } from './ClipEditor'
import { CAPTION_PRESETS } from '../../../shared/caption-presets'
import CaptionPicker from './CaptionPicker'
import type { Job } from './JobList'
import { bytes, slug, stamp, timecode } from '../lib/format'
import { groupWords } from '../../../shared/words'

interface Props {
  settings: Settings
  patch: (patch: Partial<Settings>) => Promise<void>
  addJob: (job: Job) => void
  project: Project
  onProject: (p: Project) => void
}

const GENRES: { id: ClipGenre; name: string }[] = [
  { id: 'auto', name: 'Auto' },
  { id: 'sermon', name: 'Sermon' },
  { id: 'podcast', name: 'Podcast' },
  { id: 'talk', name: 'Talk' },
  { id: 'comedy', name: 'Comedy' }
]

const LENGTHS = {
  auto: { min: 15, max: 90, label: 'Auto' },
  short: { min: 15, max: 30, label: '15\u201330s' },
  mid: { min: 30, max: 60, label: '30\u201360s' },
  long: { min: 60, max: 90, label: '60\u201390s' }
} as const

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}

/** The editor works in clip time; exports address the source. */
function rebaseToSource(words: TranscriptWord[], offsetSec: number): TranscriptWord[] {
  return words.map((w) => ({
    text: w.text,
    startSec: w.startSec + offsetSec,
    endSec: w.endSec + offsetSec
  }))
}

export default function ClipStudio({ settings, patch, addJob, project, onProject }: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const pendingSeek = useRef<number | null>(null)

  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [current, setCurrent] = useState(0)
  const [inSec, setInSec] = useState(0)
  const [outSec, setOutSec] = useState(0)
  const [aspect, setAspect] = useState<AspectPreset>(settings.defaultAspect)
  const [name, setName] = useState('')
  const [hot, setHot] = useState(false)
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState<{ percent: number; stage: string } | null>(null)
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

  // What the setup screen asks before a run.
  const [rangeStart, setRangeStart] = useState(0)
  const [rangeEnd, setRangeEnd] = useState(0)
  const [maxClips, setMaxClips] = useState(settings.maxSuggestedClips)
  const [clipLength, setClipLength] = useState<'auto' | 'short' | 'mid' | 'long'>('auto')
  const [genre, setGenre] = useState<ClipGenre>('auto')
  const [lookFor, setLookFor] = useState('')
  // The clips are the screen once there are any; the editor is where you go to
  // change one, not where you land.
  const [view, setView] = useState<'grid' | 'studio' | 'editor'>('grid')
  // A cut made by hand outlives the tighten toggle: turning automatic
  // tightening off must not silently discard words you struck yourself.
  const [handCut, setHandCut] = useState(false)
  const [graphics, setGraphics] = useState<ClipGraphic[]>([])
  const [tool, setTool] = useState<'captions' | 'graphics' | 'zooms' | 'subject' | 'broll' | 'music' | 'look'>('captions')
  const [detail, setDetail] = useState<number | null>(null)
  // One cropped still per clip, in the shape the clip will be exported in.
  const [shots, setShots] = useState<Record<string, string>>({})

  const analysed = words.length > 0

  useEffect(
    () =>
      window.chop.onFetchProgress((p) => {
        setFetching(p.stage === 'Done' || p.stage === 'Failed' ? null : p)
        if (p.stage === 'Failed' && p.message) setError(p.message)
      }),
    []
  )

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
      // If this file has been analysed before, its results come straight back.
      setRangeStart(0)
      setRangeEnd(v.durationSec)
      window.chop
        .cachedAnalysis(v.path)
        .then((cached) => {
          if (!cached) return
          setWords(cached.transcript.words)
          setSuggestions(cached.clips)
          // Show the run that produced these clips, not the defaults.
          if (cached.options) {
            setGenre(cached.options.genre ?? 'auto')
            setRangeStart(cached.options.startSec)
            setRangeEnd(cached.options.endSec)
            setMaxClips(cached.options.maxClips)
            setLookFor(cached.options.lookFor)
          }
        })
        .catch(() => undefined)
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

  const fetchUrl = useCallback(async () => {
    const target = url.trim()
    if (!target) return
    setError(null)
    setFetching({ percent: 0, stage: 'Starting' })
    const res = await window.chop.fetchVideo(target)
    setFetching(null)
    if (!res.ok) return setError(res.message)
    setUrl('')
    load(res.meta)
  }, [url, load])

  const open = useCallback(async () => {
    try {
      const v = await window.chop.openVideo()
      load(v)
      if (v && !project.media.includes(v.path)) {
        const saved = { ...project, media: [...project.media, v.path] }
        onProject(saved)
        void window.chop.saveProject(saved)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [load, project, onProject])

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
    const res = await window.chop.analyze(meta.path, suggestions.length > 0, {
      genre,
      startSec: rangeStart,
      endSec: rangeEnd > rangeStart ? rangeEnd : meta.durationSec,
      maxClips,
      minClipSec: LENGTHS[clipLength].min,
      maxClipSec: LENGTHS[clipLength].max,
      lookFor
    })
    setAnalysis(null)
    if (!res.ok) return setError(res.message)
    setWords(res.result.transcript.words)
    setSuggestions(res.result.clips)

    const saved = {
      ...project,
      media: project.media.includes(meta.path) ? project.media : [...project.media, meta.path],
      transcript: res.result.transcript,
      clips: res.result.clips
    }
    onProject(saved)
    void window.chop.saveProject(saved)
    setView('grid')
  }, [
    meta,
    project,
    onProject,
    suggestions.length,
    rangeStart,
    rangeEnd,
    maxClips,
    clipLength,
    lookFor,
    genre
  ])

  // Reopening a project brings back its analysis rather than asking for it
  // again: it costs minutes of transcription and a paid call to redo.
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || meta) return
    const path = project.media[0]
    if (!path) return
    restored.current = true
    window.chop
      .describeVideo(path)
      .then((v) => {
        load(v)
        if (project.transcript) setWords(project.transcript.words)
        if (project.clips.length > 0) setSuggestions(project.clips)
      })
      .catch(() => undefined)
  }, [project, meta, load])

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
      graphics: graphics.length > 0 ? graphics : undefined,
      segments: handCut || tighten ? segments : undefined,
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
      graphics,
      segments,
      handCut,
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

  /**
   * Kept ranges are the source of truth; a struck word is a hole in them. No
   * ranges means nothing has been cut yet, not that everything has: an empty
   * list has to read as the whole clip, or the first click would keep one word
   * and throw away the rest.
   */
  const ranges = useCallback(
    (): Segment[] => (segments.length > 0 ? segments : [{ start: 0, end: Math.max(0.1, outSec - inSec) }]),
    [segments, inSec, outSec]
  )

  const isKept = useCallback(
    (w: TranscriptWord): boolean =>
      ranges().some((seg) => w.startSec >= seg.start - 0.01 && w.endSec <= seg.end + 0.01),
    [ranges]
  )

  const toggleWord = useCallback(
    (w: TranscriptWord) => {
      const cut = { start: w.startSec, end: w.endSec }
      setHandCut(true)
      if (isKept(w)) {
        // Remove the word's span, splitting whichever segment held it.
        const next: Segment[] = []
        for (const seg of ranges()) {
          if (cut.end <= seg.start || cut.start >= seg.end) {
            next.push(seg)
            continue
          }
          if (cut.start > seg.start) next.push({ start: seg.start, end: cut.start })
          if (cut.end < seg.end) next.push({ start: cut.end, end: seg.end })
        }
        setSegments(next)
      } else {
        // Put it back, then merge anything it now touches.
        const merged: Segment[] = []
        for (const seg of [...ranges(), cut].sort((a, b) => a.start - b.start)) {
          const last = merged[merged.length - 1]
          if (last && seg.start <= last.end + 0.02) last.end = Math.max(last.end, seg.end)
          else merged.push({ ...seg })
        }
        setSegments(merged)
      }
    },
    [ranges, isKept]
  )

  useEffect(() => {
    setHandCut(false)
  }, [chosen, inSec, outSec])

  const addGraphic = useCallback(
    (kind: ClipGraphic['kind']) => {
      const title = suggestions[chosen ?? -1]?.title ?? ''
      setGraphics((prev) => [
        ...prev,
        kind === 'title'
          ? {
              id: `${Date.now()}`,
              kind,
              text: title || 'Your title here',
              startSec: 0,
              // Long enough to read, short enough not to sit on the whole clip.
              endSec: 3,
              position: 'top',
              textColor: '#16151a',
              boxColor: '#f2f1ee',
              fontFamily: 'Sora',
              fontSizePx: 54,
              uppercase: false
            }
          : {
              id: `${Date.now()}`,
              kind,
              text: '20 HOURS  56 MINUTES  16 SECONDS',
              startSec: 0,
              endSec: null,
              position: 'top',
              textColor: '#ffffff',
              boxColor: null,
              fontFamily: 'Sora',
              fontSizePx: 40,
              uppercase: true
            }
      ])
    },
    [suggestions, chosen]
  )

  const patchGraphic = useCallback((id: string, patch: Partial<ClipGraphic>) => {
    setGraphics((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)))
  }, [])

  const exportSuggestion = useCallback(
    async (clip: SuggestedClip) => {
      if (!meta) return
      const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const jobName = `${slug(clip.title) || 'clip'}-${stamp()}`
      addJob({ id: jobId, name: jobName, percent: 0, stage: 'running' })
      await window.chop.exportClip({
        ...buildRequest(jobId, jobName),
        startSec: clip.startSec,
        endSec: clip.endSec,
        name: jobName
      })
    },
    [meta, addJob, buildRequest]
  )

  useEffect(() => {
    if (!meta) return
    for (const c of suggestions) {
      const key = `${c.startSec.toFixed(2)}-${aspect}`
      if (shots[key]) continue
      window.chop
        .clipPoster(meta.path, c.startSec + Math.min(1.5, (c.endSec - c.startSec) / 4), aspect)
        .then((url) => setShots((prev) => (prev[key] ? prev : { ...prev, [key]: url })))
        .catch(() => undefined)
    }
  }, [meta, suggestions, aspect, shots])

  const shotOf = useCallback(
    (c: SuggestedClip): string | undefined => shots[`${c.startSec.toFixed(2)}-${aspect}`],
    [shots, aspect]
  )

  const thumbOf = useCallback(
    (atSec: number): { backgroundImage: string; backgroundSize: string; backgroundPositionX: string } | undefined => {
      if (!strip || !meta || meta.durationSec <= 0) return undefined
      const frame = Math.min(
        strip.frames - 1,
        Math.floor((atSec / meta.durationSec) * strip.frames)
      )
      return {
        backgroundImage: `url("${strip.filmstripUrl}")`,
        backgroundSize: `${strip.frames * 100}% 100%`,
        backgroundPositionX: `${(frame / Math.max(1, strip.frames - 1)) * 100}%`
      }
    },
    [strip, meta]
  )

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
          <svg className="drop-mark" width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 15.5V3.5" />
            <path d="M7.5 8 12 3.5 16.5 8" />
            <path d="M3.5 15.5v3a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-3" />
          </svg>
          <p className="drop-title">Drop a recording</p>
          <p className="drop-sub muted">
            A service, a podcast, a talk. Chop Shop reads it, finds the moments worth cutting, and
            captions them.
          </p>
          <div className="drop-actions">
            <button className="primary" onClick={open} disabled={!!fetching}>
              Choose a file
            </button>
          </div>

          <div className="drop-or">
            <i />
            <span>or paste a link</span>
            <i />
          </div>

          <div className="drop-url">
            <input
              type="text"
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              disabled={!!fetching}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void fetchUrl()
              }}
            />
            <button onClick={() => void fetchUrl()} disabled={!url.trim() || !!fetching}>
              {fetching ? `${fetching.percent}%` : 'Fetch'}
            </button>
          </div>

          {fetching && (
            <div className="analysis-strip" style={{ width: 'min(520px, 100%)' }}>
              <span className="mono">{fetching.stage}</span>
              <div className="bar">
                <i style={{ width: `${fetching.percent}%` }} />
              </div>
              <span className="mono muted">{fetching.percent}%</span>
            </div>
          )}
          <div className="drop-facts">
            <span>MP4, MOV, MKV, WebM</span>
            <i />
            <span>up to 90 minutes analysed at a time</span>
            <i />
            <span>audio never leaves this Mac</span>
          </div>
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

  const windowSec = Math.max(0, (rangeEnd || meta.durationSec) - rangeStart)
  // Measured on this machine: small.en runs about seventeen times faster than
  // real time, so a two hour service is roughly eight minutes.
  const transcribeMins = Math.max(1, Math.round(windowSec / 60 / 17))

  if (!analysed) {
    return (
      <div className="setup">
        <div className="setup-inner">
          <div className="setup-head">
            <div className="setup-thumb" style={thumbOf(0)} />
            <div className="setup-ident">
              <div className="home-title" style={{ fontSize: 20 }}>{project.name}</div>
              <div className="mono muted">
                {meta.fileName} · {clock(meta.durationSec)} · {meta.width}×{meta.height} {Math.round(meta.fps)} fps
              </div>
            </div>
            <div className="spacer" />
            <button className="primary" style={{ padding: '11px 22px', fontSize: 14 }} disabled={!!analysis} onClick={analyze}>
              {analysis ? 'Working…' : 'Find clips'}
            </button>
          </div>

          {analysis && (
            <div className="analysis-strip">
              <span className="mono">{analysis.stage}</span>
              <div className="bar"><i style={{ width: `${analysis.percent}%` }} /></div>
              <span className="mono muted">{analysis.percent}%</span>
            </div>
          )}
          {error && <p className="error-text">{error}</p>}

          <div className="setup-rule" />

          <div className="field">
            <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
              <span className="label">Analyse</span>
              <span className="muted" style={{ fontSize: 12 }}>
                Only this stretch is transcribed, so a shorter range is a shorter wait.
              </span>
            </div>
            <div className="range-card">
              <div className="range">
                <div className="range-track" />
                <div
                  className="range-fill"
                  style={{
                    left: `${(rangeStart / meta.durationSec) * 100}%`,
                    right: `${100 - ((rangeEnd || meta.durationSec) / meta.durationSec) * 100}%`
                  }}
                />
                <input
                  type="range"
                  min={0}
                  max={Math.floor(meta.durationSec)}
                  value={Math.floor(rangeStart)}
                  onChange={(e) => setRangeStart(Math.min(Number(e.target.value), (rangeEnd || meta.durationSec) - 30))}
                />
                <input
                  type="range"
                  min={0}
                  max={Math.floor(meta.durationSec)}
                  value={Math.floor(rangeEnd || meta.durationSec)}
                  onChange={(e) => setRangeEnd(Math.max(Number(e.target.value), rangeStart + 30))}
                />
              </div>
              <div className="row" style={{ gap: 10 }}>
                <span className="range-time mono">{clock(rangeStart)}</span>
                <span className="muted">→</span>
                <span className="range-time mono">{clock(rangeEnd || meta.durationSec)}</span>
                <div className="spacer" />
                <span className="muted" style={{ fontSize: 12 }}>
                  {clock(windowSec)} selected · about {transcribeMins} min to transcribe
                </span>
              </div>
            </div>
          </div>

          <div className="field">
            <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
              <span className="label">Genre</span>
              <span className="muted" style={{ fontSize: 12 }}>
                A sermon and an interview fail in different ways, so this changes what Claude looks for.
              </span>
            </div>
            <div className="segs">
              {GENRES.map((g) => (
                <button
                  key={g.id}
                  className={`seg ${genre === g.id ? 'on' : ''}`}
                  onClick={() => setGenre(g.id)}
                >
                  {g.name}
                </button>
              ))}
            </div>
          </div>

          <div className="setup-two">
            <div className="field">
              <span className="label">Clip length</span>
              <div className="segs">
                {(Object.keys(LENGTHS) as (keyof typeof LENGTHS)[]).map((k) => (
                  <button
                    key={k}
                    className={`seg ${clipLength === k ? 'on' : ''}`}
                    onClick={() => setClipLength(k)}
                  >
                    {LENGTHS[k].label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="label">How many</span>
              <div className="segs">
                {[4, 8, 12, 16].map((n) => (
                  <button key={n} className={`seg ${maxClips === n ? 'on' : ''}`} onClick={() => setMaxClips(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="field">
            <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
              <span className="label">Look for</span>
              <span className="muted" style={{ fontSize: 12 }}>
                Optional. Goes to Claude alongside the transcript.
              </span>
            </div>
            <textarea
              rows={2}
              placeholder="Stories with a clear beginning and end, not the announcements"
              value={lookFor}
              onChange={(e) => setLookFor(e.target.value)}
            />
          </div>

          <div className="setup-two">
            <div className="field">
              <span className="label">Captions</span>
              <CaptionPicker
                value={settings.captionPreset}
                onPick={(id) => void patch({ captionPreset: id })}
              />
            </div>
            <div className="field">
              <span className="label">Aspect</span>
              <div className="segs">
                {(['vertical', 'square', 'wide'] as AspectPreset[]).map((a) => (
                  <button key={a} className={`seg ${aspect === a ? 'on' : ''}`} onClick={() => setAspect(a)}>
                    {a === 'vertical' ? '9:16' : a === 'square' ? '1:1' : '16:9'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (view === 'editor') {
    const clipLen = Math.max(0.1, outSec - inSec)
    const kept = ranges().reduce((n, sg) => n + (sg.end - sg.start), 0)
    const cutCount = Math.max(0, ranges().length - 1)
    const pctOf = (t: number): number => Math.min(100, Math.max(0, (t / clipLen) * 100))
    const localCurrent = Math.min(clipLen, Math.max(0, current - inSec))

    const TOOLS: { id: typeof tool; name: string }[] = [
      { id: 'captions', name: 'Captions' },
      { id: 'graphics', name: 'Graphics' },
      { id: 'zooms', name: 'Zooms' },
      { id: 'subject', name: 'Subject' },
      { id: 'broll', name: 'B-roll' },
      { id: 'music', name: 'Music' },
      { id: 'look', name: 'Look' }
    ]

    return (
      <div className="clipedit">
        <div className="clipedit-head">
          <button className="ghost" onClick={() => setView('grid')}>← Clips</button>
          <div className="clipedit-title">{name || 'clip'}</div>
          <span className="mono muted">
            {timecode(inSec)} → {timecode(outSec)} · {Math.round(kept || clipLen)}s
          </span>
          <div className="spacer" />
          <button onClick={() => void previewEdit()} disabled={rendering}>
            {rendering ? 'Rendering…' : 'Preview'}
          </button>
          <button className="primary" onClick={exportClip} disabled={rendering}>
            Export
          </button>
        </div>

        <div className="clipedit-body">
          <div className="clipedit-script">
            <div className="clipedit-panelhead">
              <span className="label">Transcript</span>
              <div className="spacer" />
              <button className={`seg ${tighten ? 'on' : ''}`} onClick={() => setTighten(!tighten)}>
                Tighten
              </button>
            </div>
            <div className="script-words">
              {editedWords.map((w, i) => (
                <button
                  key={i}
                  className={`sw ${isKept(w) ? '' : 'cut'} ${
                    localCurrent >= w.startSec && localCurrent < w.endSec ? 'now' : ''
                  }`}
                  onClick={() => toggleWord(w)}
                >
                  {w.text}
                </button>
              ))}
            </div>
            <div className="clipedit-foot muted">
              Click a word to cut it, click again to keep it. {cutCount} cut
              {cutCount === 1 ? '' : 's'}.
            </div>
          </div>

          <div className="clipedit-stage">
            <div className={`stage-frame ${aspect}`}>
              <video
                ref={videoRef}
                src={proof ?? win?.url ?? undefined}
                controls={!!proof}
                onTimeUpdate={(e) => {
                  if (proof) return
                  setCurrent((win?.start ?? 0) + e.currentTarget.currentTime)
                }}
              />
            </div>
          </div>

          <div className="clipedit-tools">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`tool ${tool === t.id ? 'on' : ''}`}
                onClick={() => setTool(t.id)}
              >
                <span>{t.name}</span>
              </button>
            ))}
          </div>

          <div className="clipedit-panel">
            {tool === 'captions' && (
              <>
                <div className="row">
                  <span className="label">Captions</span>
                  <div className="spacer" />
                  <button className={`seg ${captions ? 'on' : ''}`} onClick={() => setCaptions(!captions)}>
                    {captions ? 'On' : 'Off'}
                  </button>
                </div>
                <CaptionPicker
                  value={settings.captionPreset}
                  onPick={(id) => void patch({ captionPreset: id })}
                />
              </>
            )}
            {tool === 'graphics' && (
              <>
                <div className="row">
                  <span className="label">On screen</span>
                  <div className="spacer" />
                  <button className="seg" onClick={() => addGraphic('title')}>
                    Title
                  </button>
                  <button className="seg" onClick={() => addGraphic('bar')}>
                    Bar
                  </button>
                </div>

                {graphics.length === 0 && (
                  <p className="muted" style={{ fontSize: 12 }}>
                    A title card over the opening, or a bar held across the top. Both burn into the
                    export.
                  </p>
                )}

                {graphics.map((g) => (
                  <div key={g.id} className="graphic-row">
                    <div className="row" style={{ gap: 6 }}>
                      <span className="label">{g.kind === 'title' ? 'Title' : 'Bar'}</span>
                      <div className="spacer" />
                      <button
                        className="ghost"
                        onClick={() => setGraphics((prev) => prev.filter((x) => x.id !== g.id))}
                      >
                        Remove
                      </button>
                    </div>
                    <textarea
                      rows={2}
                      value={g.text}
                      onChange={(e) => patchGraphic(g.id, { text: e.target.value })}
                    />
                    <div className="segs">
                      {(['top', 'middle', 'bottom'] as ClipGraphic['position'][]).map((pos) => (
                        <button
                          key={pos}
                          className={`seg ${g.position === pos ? 'on' : ''}`}
                          onClick={() => patchGraphic(g.id, { position: pos })}
                        >
                          {pos}
                        </button>
                      ))}
                      <button
                        className={`seg ${g.boxColor ? 'on' : ''}`}
                        onClick={() =>
                          patchGraphic(
                            g.id,
                            g.boxColor
                              ? { boxColor: null, textColor: '#ffffff' }
                              : { boxColor: '#f2f1ee', textColor: '#16151a' }
                          )
                        }
                      >
                        Plate
                      </button>
                      <button
                        className={`seg ${g.endSec === null ? 'on' : ''}`}
                        onClick={() => patchGraphic(g.id, { endSec: g.endSec === null ? 3 : null })}
                      >
                        {g.endSec === null ? 'Whole clip' : 'First 3s'}
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}

            {tool === 'zooms' && (
              <>
                <div className="row">
                  <span className="label">Punch-ins</span>
                  <div className="spacer" />
                  <button className={`seg ${autoZoom ? 'on' : ''}`} onClick={() => setAutoZoom(!autoZoom)}>
                    {autoZoom ? 'On' : 'Off'}
                  </button>
                </div>
                <p className="muted" style={{ fontSize: 12 }}>
                  {zooms.length} keyframe{zooms.length === 1 ? '' : 's'} across this clip.
                </p>
              </>
            )}
            {tool === 'subject' && (
              <>
                <div className="row">
                  <span className="label">Track subject</span>
                  <div className="spacer" />
                  <button
                    className={`seg ${trackSubject ? 'on' : ''}`}
                    onClick={() => setTrackSubject(!trackSubject)}
                  >
                    {trackSubject ? 'On' : 'Off'}
                  </button>
                </div>
                <p className="muted" style={{ fontSize: 12 }}>
                  Keeps the speaker centred as the crop moves. Falls back to a centred crop when no
                  face is found, and says so.
                </p>
              </>
            )}
            {tool === 'look' && (
              <>
                <span className="label">Look</span>
                <select
                  value={settings.lutPath ?? ''}
                  onChange={(e) => void patch({ lutPath: e.target.value || null })}
                >
                  <option value="">No grade</option>
                  {luts.map((l) => (
                    <option key={l.path} value={l.path}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            {(tool === 'broll' || tool === 'music') && (
              <p className="muted" style={{ fontSize: 12 }}>
                {tool === 'broll' ? 'B-roll' : 'Music'} lives in the timeline editor for now.
              </p>
            )}
          </div>
        </div>

        <div className="clipedit-timeline">
          <div className="tl-row">
            <span className="tl-label mono">Video</span>
            <div className="tl-lane video">
              {strip && (
                <div
                  className="tl-film"
                  style={{
                    backgroundImage: `url("${strip.filmstripUrl}")`,
                    backgroundSize: `${(meta.durationSec / clipLen) * 100}% 100%`,
                    backgroundPositionX: `${(inSec / Math.max(0.1, meta.durationSec - clipLen)) * 100}%`
                  }}
                />
              )}
              {ranges().map((sg, i) => (
                <span
                  key={i}
                  className="tl-keep"
                  style={{ left: `${pctOf(sg.start)}%`, width: `${pctOf(sg.end - sg.start)}%` }}
                />
              ))}
            </div>
          </div>

          <div className="tl-row">
            <span className="tl-label mono">Zoom</span>
            <div className="tl-lane">
              {zooms.map((z, i) => (
                <span key={i} className="tl-zoom" style={{ left: `${pctOf(z.atSec)}%` }} />
              ))}
            </div>
          </div>

          <div className="tl-row">
            <span className="tl-label mono">Captions</span>
            <div className="tl-lane">
              {editedWords.map((w, i) => (
                <span
                  key={i}
                  className={`tl-word ${isKept(w) ? '' : 'cut'}`}
                  style={{
                    left: `${pctOf(w.startSec)}%`,
                    width: `${Math.max(0.4, pctOf(w.endSec - w.startSec))}%`
                  }}
                />
              ))}
            </div>
          </div>

          <div className="tl-play" style={{ left: `calc(64px + ${pctOf(localCurrent)}% * 0.995)` }} />
        </div>
      </div>
    )
  }

  if (view === 'grid') {
    const clip = detail !== null ? suggestions[detail] : null
    return (
      <div className="results">
        <div className="results-head">
          <div className="home-title" style={{ fontSize: 22 }}>Clips</div>
          <div className="spacer" />
          <span className="mono muted">
            {suggestions.length} clips from {words.length.toLocaleString()} words
          </span>
          <button onClick={() => setView('studio')}>Open editor</button>
          <button onClick={() => { setWords([]); setSuggestions([]) }}>Set up a run</button>
        </div>

        <div className="clip-grid">
          {suggestions.map((c, i) => (
            <div key={i} className="clip-card">
              <button
                className={`clip-shot ${aspect}`}
                style={
                  shotOf(c)
                    ? { backgroundImage: `url("${shotOf(c)}")` }
                    : thumbOf(c.startSec)
                }
                onClick={() => setDetail(i)}
              >
                <span className="clip-hook">{c.title}</span>
                <span className="clip-play">
                  <svg width="16" height="16" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                    <path d="M3 1.6 10 6l-7 4.4Z" />
                  </svg>
                </span>
                <span className="clip-dur mono">{Math.round(c.endSec - c.startSec)}s</span>
              </button>
              <div className="clip-meta">
                <span className="clip-score-big">{c.score}</span>
                <div className="clip-title">{c.title}</div>
              </div>
              <div className="clip-actions">
                <button onClick={() => setDetail(i)}>Details</button>
                <button onClick={() => { pick(c, i); setView('editor') }}>Edit</button>
                <button className="primary" onClick={() => void exportSuggestion(c)}>Export</button>
              </div>
            </div>
          ))}
        </div>

        {clip && (
          <div className="scrim" onClick={() => setDetail(null)}>
            <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
              <div className="dialog-head row">
                <div>
                  <div className="home-title" style={{ fontSize: 18 }}>{clip.title}</div>
                  <div className="mono muted" style={{ marginTop: 4 }}>
                    {timecode(clip.startSec)} → {timecode(clip.endSec)} · {Math.round(clip.endSec - clip.startSec)}s
                  </div>
                </div>
                <div className="spacer" />
                <span className="clip-score static">{clip.score}</span>
              </div>
              <div className="dialog-scroll">
                <div className="detail-body">
                  <div className="detail-shot" style={thumbOf(clip.startSec)} />
                  <div className="detail-text">
                    <span className="label">Why Claude picked it</span>
                    <p className="detail-reason">{clip.reason}</p>
                    <span className="label" style={{ marginTop: 14 }}>Transcript</span>
                    <div className="detail-lines">
                      {words
                        .filter((w) => w.endSec > clip.startSec && w.startSec < clip.endSec)
                        .slice(0, 60)
                        .map((w, n) => (
                          <span key={n}>{w.text} </span>
                        ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="dialog-foot">
                <button onClick={() => { pick(clip, detail ?? 0); setDetail(null); setView('editor') }}>
                  Open in editor
                </button>
                <div className="spacer" />
                <button onClick={() => setDetail(null)}>Close</button>
                <button className="primary" onClick={() => { void exportSuggestion(clip); setDetail(null) }}>
                  Export
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

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
              onClick={() => {
                const v = videoRef.current
                if (!v) return
                if (!v.paused) {
                  v.pause()
                  return
                }
                // Play the range that was picked, and stop where it ends, so a
                // suggestion can be judged without watching past it.
                void (async () => {
                  if (current < inSec - 0.1 || current > outSec) await seek(inSec)
                  const el = videoRef.current
                  if (!el) return
                  const stop = (): void => {
                    if ((win?.start ?? 0) + el.currentTime >= outSec) {
                      el.pause()
                      el.removeEventListener('timeupdate', stop)
                    }
                  }
                  el.addEventListener('timeupdate', stop)
                  void el.play().catch(() => undefined)
                })()
              }}
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
