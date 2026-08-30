import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, Timeline, TimelineClip } from '../../../shared/types'
import { clipAt, timelineDuration } from '../../../shared/timeline'
import type { Job } from './JobList'
import { timecode } from '../lib/format'

interface Props {
  project: Project
  onProject: (p: Project) => void
  addJob: (job: Job) => void
}

interface MediaInfo {
  path: string
  durationSec: number
  width: number
  height: number
  fps: number
}

interface Previews {
  filmstripUrl: string
  posterUrl: string
  waveformUrl: string | null
  durationSec: number
  frames: number
}

type Drag =
  | { kind: 'move'; id: string; grabOffsetSec: number }
  | { kind: 'trim'; id: string; side: 'in' | 'out' }
  | null

const TRACKS = [1, 0]

interface TrackState {
  muted: boolean
  locked: boolean
  hidden: boolean
}
const PX_PER_SEC_BASE = 40

export default function EditWorkspace({ project, onProject, addJob }: Props): JSX.Element {
  const timeline: Timeline = project.timeline ?? { clips: [], width: 1920, height: 1080, fps: 30 }
  const videoRef = useRef<HTMLVideoElement>(null)
  const laneRef = useRef<HTMLDivElement>(null)

  const [media, setMedia] = useState<MediaInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [drag, setDrag] = useState<Drag>(null)
  const [zoom, setZoom] = useState(1)
  const [trackState, setTrackState] = useState<Record<number, TrackState>>({
    0: { muted: false, locked: false, hidden: false },
    1: { muted: false, locked: false, hidden: false }
  })
  const [playing, setPlaying] = useState(false)
  const [proof, setProof] = useState<string | null>(null)
  // Filmstrips and waveforms are generated once per file and cached on disk, so
  // this map only ever holds URLs.
  const [previews, setPreviews] = useState<Record<string, Previews>>({})

  const duration = Math.max(10, timelineDuration(timeline))
  const pxPerSec = PX_PER_SEC_BASE * zoom

  const setTimeline = useCallback(
    (next: Timeline) => {
      const updated = { ...project, timeline: next }
      onProject(updated)
      void window.chop.saveProject(updated)
    },
    [project, onProject]
  )

  // Media the project already knows about needs probing once for durations.
  useEffect(() => {
    let cancelled = false
    Promise.all(project.media.map((p) => window.chop.probeMedia(p).catch(() => null))).then(
      (infos) => {
        if (!cancelled) setMedia(infos.filter(Boolean) as MediaInfo[])
      }
    )
    return () => {
      cancelled = true
    }
  }, [project.media])

  // Ask for previews of anything on the timeline or in the bin that lacks them.
  useEffect(() => {
    const wanted = new Set([...project.media, ...timeline.clips.map((c) => c.mediaPath)])
    for (const path of wanted) {
      if (previews[path]) continue
      window.chop
        .mediaPreviews(path)
        .then((p) => setPreviews((prev) => ({ ...prev, [path]: p })))
        .catch(() => undefined)
    }
  }, [project.media, timeline.clips, previews])

  const importMedia = useCallback(async () => {
    const chosen = await window.chop.chooseMedia()
    if (!chosen) return
    if (project.media.includes(chosen.path)) return
    const updated = { ...project, media: [...project.media, chosen.path] }
    onProject(updated)
    void window.chop.saveProject(updated)
  }, [project, onProject])

  const addToTimeline = useCallback(
    (info: MediaInfo, track: number) => {
      const onTrack = timeline.clips.filter((c) => c.track === track)
      const start = onTrack.reduce(
        (end, c) => Math.max(end, c.timelineStartSec + (c.sourceOutSec - c.sourceInSec)),
        0
      )
      const clip: TimelineClip = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        mediaPath: info.path,
        track,
        timelineStartSec: start,
        sourceInSec: 0,
        sourceOutSec: info.durationSec,
        muted: false
      }
      setTimeline({ ...timeline, clips: [...timeline.clips, clip] })
    },
    [timeline, setTimeline]
  )

  const timeAt = useCallback(
    (clientX: number): number => {
      const rect = laneRef.current?.getBoundingClientRect()
      if (!rect) return 0
      return Math.max(0, (clientX - rect.left + (laneRef.current?.scrollLeft ?? 0)) / pxPerSec)
    },
    [pxPerSec]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return
      const t = timeAt(e.clientX)
      const clips = timeline.clips.map((c) => {
        if (c.id !== drag.id) return c
        // A locked track refuses edits, which is the whole point of locking it.
        if (trackState[c.track]?.locked) return c
        if (drag.kind === 'move') {
          return { ...c, timelineStartSec: Math.max(0, t - drag.grabOffsetSec) }
        }
        const length = c.sourceOutSec - c.sourceInSec
        if (drag.side === 'in') {
          const delta = Math.min(length - 0.2, Math.max(-c.sourceInSec, t - c.timelineStartSec))
          return {
            ...c,
            sourceInSec: c.sourceInSec + delta,
            timelineStartSec: c.timelineStartSec + delta
          }
        }
        const wanted = t - c.timelineStartSec
        return { ...c, sourceOutSec: Math.max(c.sourceInSec + 0.2, c.sourceInSec + wanted) }
      })
      setTimeline({ ...timeline, clips })
    },
    [drag, timeline, timeAt, setTimeline, trackState]
  )

  // The monitor plays whichever clip covers the playhead, seeking into it.
  const active = useMemo(() => clipAt(timeline, playhead), [timeline, playhead])
  const activeRef = useRef<string | null>(null)

  useEffect(() => {
    const v = videoRef.current
    if (!v || proof) return
    if (!active) {
      activeRef.current = null
      return
    }
    const wantSrc = `media://local/${encodeURIComponent(active.mediaPath)}`
    if (activeRef.current !== active.id) {
      activeRef.current = active.id
      v.src = wantSrc
    }
    const into = active.sourceInSec + (playhead - active.timelineStartSec)
    if (Math.abs(v.currentTime - into) > 0.35) v.currentTime = into
  }, [active, playhead, proof])

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v || !playing || !active || proof) return
    const at = active.timelineStartSec + (v.currentTime - active.sourceInSec)
    setPlayhead(at)
    if (v.currentTime >= active.sourceOutSec - 0.02) {
      // Roll onto whatever comes next rather than stopping at a clip boundary.
      const next = clipAt(timeline, at + 0.05)
      if (!next) {
        v.pause()
        setPlaying(false)
      }
    }
  }, [playing, active, timeline, proof])

  const render = useCallback(
    async (preview: boolean) => {
      const jobId = `${Date.now()}`
      if (!preview) addJob({ id: jobId, name: project.name, percent: 0, stage: 'running' })
      const visible = {
        ...timeline,
        clips: timeline.clips
          .filter((c) => !trackState[c.track]?.hidden)
          .map((c) => ({ ...c, muted: c.muted || !!trackState[c.track]?.muted }))
      }
      const res = await window.chop.renderTimeline({
        jobId,
        timeline: visible,
        name: project.name,
        preview
      })
      if (res.ok && preview) setProof(res.mediaUrl)
    },
    [timeline, project.name, addJob, trackState]
  )

  return (
    <div className="edit">
      <div className="edit-top">
        <section className="panel bin">
          <div className="panel-head">
            <span className="label">Project</span>
            <div className="spacer" />
            <button className="ghost" onClick={importMedia}>
              Import
            </button>
          </div>
          <div className="panel-body">
            {media.length === 0 && <p className="muted">Import media to begin.</p>}
            {media.map((m) => (
              <div key={m.path} className="bin-item">
                {previews[m.path] && (
                  <div
                    className="bin-poster"
                    style={{ backgroundImage: `url("${previews[m.path].posterUrl}")` }}
                  />
                )}
                <div className="bin-name">{m.path.split('/').pop()}</div>
                <div className="mono muted" style={{ fontSize: 11 }}>
                  {m.width}×{m.height} · {timecode(m.durationSec)}
                </div>
                <div className="row" style={{ marginTop: 6, gap: 6 }}>
                  <button className="ghost" onClick={() => addToTimeline(m, 0)}>
                    To V1
                  </button>
                  <button className="ghost" onClick={() => addToTimeline(m, 1)}>
                    To V2
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel monitor">
          <div className="panel-head">
            <span className="label">{proof ? 'Rendered preview' : 'Program'}</span>
            <div className="spacer" />
            <span className="mono muted">{timecode(playhead)}</span>
          </div>
          <div className="monitor-stage">
            <video
              ref={videoRef}
              src={proof ?? undefined}
              onTimeUpdate={onTimeUpdate}
              controls={!!proof}
            />
          </div>
          <div className="panel-foot">
            <button
              onClick={() => {
                const v = videoRef.current
                if (!v) return
                if (playing) {
                  v.pause()
                  setPlaying(false)
                } else {
                  void v.play()
                  setPlaying(true)
                }
              }}
              disabled={!active && !proof}
            >
              {playing ? 'Pause' : 'Play'}
            </button>
            <button onClick={() => setPlayhead(0)}>Start</button>
            <div className="spacer" />
            {proof && (
              <button className="ghost" onClick={() => setProof(null)}>
                Back to timeline
              </button>
            )}
            <button disabled={timeline.clips.length === 0} onClick={() => render(true)}>
              Preview render
            </button>
            <button
              className="primary"
              disabled={timeline.clips.length === 0}
              onClick={() => render(false)}
            >
              Export
            </button>
          </div>
        </section>
      </div>

      <section className="panel timeline-panel">
        <div className="panel-head">
          <span className="label">Timeline</span>
          <div className="spacer" />
          <button className="ghost" onClick={() => setZoom((z) => Math.max(0.25, z / 1.5))}>
            −
          </button>
          <button className="ghost" onClick={() => setZoom((z) => Math.min(8, z * 1.5))}>
            +
          </button>
          <button
            className="ghost"
            disabled={!selected}
            onClick={() => {
              setTimeline({ ...timeline, clips: timeline.clips.filter((c) => c.id !== selected) })
              setSelected(null)
            }}
          >
            Delete
          </button>
        </div>

        <div className="timeline-body">
          <div className="track-headers">
            <div className="track-headers-spacer" />
            {TRACKS.map((track) => {
              const st = trackState[track]
              const set = (patch: Partial<TrackState>): void =>
                setTrackState((prev) => ({ ...prev, [track]: { ...prev[track], ...patch } }))
              return (
                <div key={track} className={`track-header ${st.locked ? 'locked' : ''}`}>
                  <span className="track-name">{track === 0 ? 'V1' : 'V2'}</span>
                  <div className="spacer" />
                  <button
                    className={`glyph ${st.hidden ? '' : 'active'}`}
                    title={st.hidden ? 'Show track' : 'Hide track'}
                    onClick={() => set({ hidden: !st.hidden })}
                  >
                    {st.hidden ? '◌' : '◉'}
                  </button>
                  <button
                    className={`glyph ${st.muted ? 'mute' : ''}`}
                    title={st.muted ? 'Unmute' : 'Mute'}
                    onClick={() => set({ muted: !st.muted })}
                  >
                    M
                  </button>
                  <button
                    className={`glyph ${st.locked ? 'lock' : ''}`}
                    title={st.locked ? 'Unlock track' : 'Lock track'}
                    onClick={() => set({ locked: !st.locked })}
                  >
                    {st.locked ? '🔒' : '🔓'}
                  </button>
                </div>
              )
            })}
          </div>

        <div
          className="lanes"
          ref={laneRef}
          onPointerMove={onPointerMove}
          onPointerUp={() => setDrag(null)}
          onPointerLeave={() => setDrag(null)}
        >
          <div className="lane-inner" style={{ width: duration * pxPerSec + 200 }}>
            <div
              className="ruler"
              onClick={(e) => {
                setPlayhead(timeAt(e.clientX))
                setPlaying(false)
              }}
            >
              {Array.from({ length: Math.ceil(duration / 5) + 1 }, (_, i) => (
                <span key={i} className="tick" style={{ left: i * 5 * pxPerSec }}>
                  {timecode(i * 5)}
                </span>
              ))}
            </div>

            {TRACKS.map((track) => (
              <div
                key={track}
                className={`lane ${trackState[track]?.locked ? 'locked' : ''} ${
                  trackState[track]?.hidden ? 'hidden' : ''
                }`}
              >
                {timeline.clips
                  .filter((c) => c.track === track)
                  .map((c) => {
                    const length = c.sourceOutSec - c.sourceInSec
                    const pv = previews[c.mediaPath]
                    // The filmstrip covers the whole source, so it is scaled to
                    // the full duration and shifted by the clip's in point.
                    const stripStyle = pv
                      ? {
                          backgroundImage: `url("${pv.filmstripUrl}")`,
                          backgroundSize: `${pv.durationSec * pxPerSec}px 100%`,
                          backgroundPositionX: `${-c.sourceInSec * pxPerSec}px`
                        }
                      : undefined
                    return (
                      <div
                        key={c.id}
                        className={`tl-clip ${selected === c.id ? 'on' : ''}`}
                        style={{
                          left: c.timelineStartSec * pxPerSec,
                          width: Math.max(8, length * pxPerSec)
                        }}
                        onPointerDown={(e) => {
                          setSelected(c.id)
                          setDrag({
                            kind: 'move',
                            id: c.id,
                            grabOffsetSec: timeAt(e.clientX) - c.timelineStartSec
                          })
                        }}
                      >
                        <span
                          className="tl-handle left"
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            setSelected(c.id)
                            setDrag({ kind: 'trim', id: c.id, side: 'in' })
                          }}
                        />
                        <div className="tl-body">
                          <div className="tl-strip" style={stripStyle} />
                          {pv?.waveformUrl && (
                            <div
                              className="tl-wave"
                              style={{
                                backgroundImage: `url("${pv.waveformUrl}")`,
                                backgroundSize: `${pv.durationSec * pxPerSec}px 100%`,
                                backgroundPositionX: `${-c.sourceInSec * pxPerSec}px`
                              }}
                            />
                          )}
                          <span className="tl-name">{c.mediaPath.split('/').pop()}</span>
                        </div>
                        <span
                          className="tl-handle right"
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            setSelected(c.id)
                            setDrag({ kind: 'trim', id: c.id, side: 'out' })
                          }}
                        />
                      </div>
                    )
                  })}
              </div>
            ))}

            <div className="tl-head" style={{ left: playhead * pxPerSec }} />
          </div>
        </div>
        </div>
      </section>
    </div>
  )
}
