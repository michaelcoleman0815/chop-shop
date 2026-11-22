import { useEffect, useState } from 'react'
import { api, device } from '../api'
import { clock } from '../format'
import type { Attachment } from './Composer'
import { Poster } from './Poster'
import { Sheet } from './Sheet'
import { Button } from './ui'

/**
 * Adding a shoot: the clips just picked, as stills numbered in the order they
 * were picked, each with its length, and a tray with how many and how long in
 * all. Tapping a clip leaves it out (the rest renumber) or takes it back at the
 * end. "Add 3" puts them in the composer in that order. Talking clips are put
 * in the order they were shot when the edit is made (main/session.ts), so the
 * numbers are what goes in, not the edit's order, and the sheet says so.
 */
export function AddShoot({
  files,
  onAdd,
  onMore,
  onClose
}: {
  files: Attachment[]
  onAdd: (chosen: Attachment[]) => void
  /** Picks more, which the composer adds to these. */
  onMore: () => void
  onClose: () => void
}): JSX.Element {
  const [order, setOrder] = useState<string[]>(() => files.map((f) => f.path))
  const lengths = useLengths(files)
  // Clips picked again from "Add more" join the end, chosen.
  useEffect(() => {
    setOrder((o) => [...o, ...files.map((f) => f.path).filter((p) => !o.includes(p))])
  }, [files])

  const chosen = order.map((p) => files.find((f) => f.path === p)).filter((f): f is Attachment => !!f)
  const known = chosen.every((f) => lengths[f.path] !== undefined)
  const total = chosen.reduce((sum, f) => sum + (lengths[f.path] ?? 0), 0)
  const toggle = (path: string): void =>
    setOrder((o) => (o.includes(path) ? o.filter((p) => p !== path) : [...o, path]))

  return (
    <Sheet
      label="Add a shoot"
      title="Add a shoot"
      className="cl-shoot"
      onClose={onClose}
      foot={
        <>
          <span className="cl-shoot-tray" aria-hidden="true">
            {chosen.slice(0, 3).map((f) => (
              <Poster key={f.path} path={f.path} name={f.name} />
            ))}
          </span>
          <span className="cl-shoot-sum" aria-live="polite">
            <span className="cl-shoot-count">
              {chosen.length} {chosen.length === 1 ? 'clip' : 'clips'}
            </span>
            <span className="cl-shoot-len">{chosen.length && known ? `${clock(total)} in all` : ' '}</span>
          </span>
          <Button variant="primary" disabled={chosen.length === 0} onClick={() => onAdd(chosen)}>
            Add {chosen.length || ''}
          </Button>
        </>
      }
    >
      <div className="cl-shoot-bar">
        <p className="cl-shoot-hint">
          Tap a clip to leave it out. I put talking clips in the order you shot them.
        </p>
        <Button small onClick={onMore}>
          {device.kind === 'phone' ? 'Add more' : 'Add more files…'}
        </Button>
      </div>
      <ul className="cl-shoot-grid" aria-label="The clips you picked">
        {files.map((f) => {
          const n = order.indexOf(f.path)
          const sec = lengths[f.path]
          return (
            <li key={f.path}>
              <button
                type="button"
                className={`cl-shoot-clip${n >= 0 ? ' on' : ''}`}
                aria-pressed={n >= 0}
                aria-label={`${f.name}${sec !== undefined ? `, ${clock(sec)}` : ''}${n >= 0 ? `, number ${n + 1}` : ', left out'}`}
                onClick={() => toggle(f.path)}
              >
                <Poster path={f.path} name={f.name} />
                <span className="cl-shoot-n" aria-hidden="true">
                  {n >= 0 ? n + 1 : ''}
                </span>
                {sec !== undefined && sec > 0 && (
                  <span className="cl-shoot-clip-len" aria-hidden="true">
                    {clock(sec)}
                  </span>
                )}
                <span className="cl-shoot-clip-name" aria-hidden="true">
                  {f.name}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}

/** Each clip's length, as the host measures it (ffprobe on a Mac or a phone). */
function useLengths(files: Attachment[]): Record<string, number> {
  const [lengths, setLengths] = useState<Record<string, number>>({})
  useEffect(() => {
    let live = true
    for (const f of files) {
      if (lengths[f.path] !== undefined) continue
      api
        .mediaPreviews(f.path)
        .then((p) => live && setLengths((l) => ({ ...l, [f.path]: p.durationSec })))
        .catch(() => live && setLengths((l) => ({ ...l, [f.path]: 0 })))
    }
    return () => {
      live = false
    }
    // Measured once a file; a file already measured keeps its length.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files])
  return lengths
}
