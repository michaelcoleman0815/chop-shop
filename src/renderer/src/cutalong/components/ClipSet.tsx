import { useEffect, useState } from 'react'
import { currentCut, resolveCut } from '../../../../shared/edit'
import {
  clipsOfRun,
  exportedNow,
  exportNote,
  keptClips,
  toExport,
  type Clip,
  type ClipSet as ClipSetData
} from '../../../../shared/clipping'
import { api } from '../api'
import { clock } from '../format'
import { grow } from '../motion'
import type { Cutalong } from '../useCutalong'
import { Button } from './ui'
import { Working } from './Working'

/**
 * The clips one /clipping run found, as cards under its reply: each with its
 * poster frame, title, length and opening line, a way into the editor, and a
 * way to keep or drop it. The newest set carries Export all, the one primary
 * button; while it runs, every card shows its own progress.
 */
export function ClipSet({ app, run }: { app: Cutalong; run: number }): JSX.Element | null {
  const { set, jobs, exporting } = app.clipping
  const clips = clipsOfRun(set, run)
  if (clips.length === 0) return null
  // Export all sits on the newest set of clips only, so a chat never shows two.
  const newest = Math.max(...(set?.clips ?? []).map((c) => c.run))
  const kept = keptClips(set).length
  return (
    <div className="cl-clipset">
      <ul className="cl-clips" aria-label={`${clips.length} clips`}>
        {clips.map((clip) => (
          <ClipCard key={clip.id} clip={clip} app={app} job={jobs[clip.id]} busy={!!exporting} />
        ))}
      </ul>
      {run === newest &&
        (exporting ? (
          <Working progress={exporting.progress} since={exporting.since} />
        ) : (
          <div className="cl-actions">
            <Button variant="primary" disabled={kept === 0} onClick={() => void app.clipping.exportAll()}>
              {exportLabel(set)}
            </Button>
          </div>
        ))}
    </div>
  )
}

/** What Export all says it makes: every clip, the ones not out yet as they are now, or all of them again. */
function exportLabel(set: ClipSetData | null): string {
  const kept = keptClips(set)
  const waiting = toExport(set).length
  if (kept.length === 0) return 'Export all'
  if (waiting < kept.length) return `Export ${waiting} more`
  const again = kept.every(exportedNow)
  if (kept.length === 1) return again ? 'Export it again' : 'Export the clip'
  return `Export all ${kept.length}${again ? ' again' : ''}`
}

/** A clip's still: its first moment, framed the way the short is. */
function useClipPoster(clip: Clip): string | null {
  const [src, setSrc] = useState<string | null>(null)
  const at = clip.startSec + Math.min(1.5, (clip.endSec - clip.startSec) / 4)
  useEffect(() => {
    let live = true
    api
      .clipPoster(clip.source, at, 'vertical')
      .then((url) => live && setSrc(url || null))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [clip.source, at])
  return src
}

function ClipCard({
  clip,
  app,
  job,
  busy
}: {
  clip: Clip
  app: Cutalong
  job: { percent: number | null; done?: string; error?: string } | undefined
  busy: boolean
}): JSX.Element {
  const src = useClipPoster(clip)
  const [ready, setReady] = useState(false)
  // Its length now: as it was found, or as it was left in the editor.
  const length = resolveCut(currentCut(clip.doc), clip.doc.words, clip.doc.sources).durationSec
  const running = job && !job.done && !job.error && job.percent !== null
  // Exported only while it is out as it is now: a clip changed since says nothing, as Export all counts it.
  const note = exportNote(clip, job)
  return (
    <li className={`cl-clip${clip.kept ? '' : ' dropped'}`}>
      <button
        type="button"
        className="cl-clip-open"
        onClick={() => app.clipping.open(clip.id)}
        aria-label={`Open ${clip.title} in the editor`}
        disabled={!clip.kept}
      >
        <span className={`cl-poster cl-clip-poster${ready ? ' ready' : ''}`} aria-hidden="true">
          {src && <img src={src} alt="" draggable={false} onLoad={() => setReady(true)} />}
          {running && (
            <span className="cl-clip-bar">
              <span style={grow(Math.max(4, job?.percent ?? 0))} />
            </span>
          )}
        </span>
      </button>
      <div className="cl-clip-text">
        <span className="cl-clip-title">{clip.title}</span>
        <span className="cl-clip-meta">
          <span className="mono">{clock(length)}</span>
          {note && <span>{note}</span>}
          {!clip.kept && <span>Dropped</span>}
        </span>
        <span className="cl-clip-hook">“{clip.hook}”</span>
      </div>
      <div className="cl-clip-actions">
        {clip.kept && (
          <Button small onClick={() => app.clipping.open(clip.id)}>
            Open
          </Button>
        )}
        {clip.kept && note === 'Not exported' && (
          <Button variant="text" small disabled={busy} onClick={() => void app.clipping.exportAll([clip.id])}>
            Try again
          </Button>
        )}
        <Button variant="text" small disabled={busy} onClick={() => app.clipping.keep(clip.id, !clip.kept)}>
          {clip.kept ? 'Drop' : 'Keep'}
        </Button>
      </div>
    </li>
  )
}
