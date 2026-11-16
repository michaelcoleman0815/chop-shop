import { useState, type DragEvent } from 'react'
import { habitChanges, habitsKey, habitsUseSentence } from '../../../../shared/learn/habits'
import { api } from '../api'
import { Button, Icon } from '../components/ui'
import { fileName, isVideoFile } from '../format'
import type { Cutalong } from '../useCutalong'

/**
 * Learn from my edits, on the brand page: a recording and the video made
 * from it go in; out comes one sentence on how my cutting compares with
 * theirs, a few facts about how they cut, and a choice to cut that way.
 * Every video learned joins the edits my cutting is checked against.
 */

const AUDIO_EXT = /\.(wav|m4a|mp3|aac|aiff?|flac)$/i

function Drop({
  title,
  hint,
  onFiles,
  onChoose,
  children
}: {
  title: string
  hint: string
  onFiles: (files: File[]) => void
  onChoose: () => void
  children?: JSX.Element | false
}): JSX.Element {
  const [over, setOver] = useState(false)
  const drop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    onFiles([...e.dataTransfer.files])
  }
  return (
    <div className="cl-field">
      <span>{title}</span>
      <div
        className={`cl-drop${over ? ' dropping' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <span>{hint}</span>
        <Button small onClick={onChoose}>
          Choose
        </Button>
      </div>
      {children}
    </div>
  )
}

function Chosen({ paths, onRemove }: { paths: string[]; onRemove: (path: string) => void }): JSX.Element | false {
  if (paths.length === 0) return false
  return (
    <div className="cl-chips">
      {paths.map((p) => (
        <span key={p} className="cl-attachment">
          <span className="mono">{fileName(p)}</span>
          <button type="button" aria-label={`Remove ${fileName(p)}`} onClick={() => onRemove(p)}>
            <Icon.close />
          </button>
        </span>
      ))}
    </div>
  )
}

export function LearnSection({ app }: { app: Cutalong }): JSX.Element {
  const learn = app.learn
  const { state } = learn
  const [details, setDetails] = useState(false)
  const inUse = app.brand.habits
  const fitted = state.habits
  const proposal =
    fitted && (!inUse || habitsKey(inUse) !== habitsKey(fitted)) && learn.dismissed !== habitsKey(fitted)
      ? fitted
      : null
  const changes = proposal && inUse ? habitChanges(inUse, proposal) : []
  const running = learn.progress !== null
  const choosing =
    !running &&
    (state.videos.length === 0 ||
      learn.adding ||
      learn.error !== null ||
      learn.recordings.length > 0 ||
      learn.finished !== null)
  const ready = learn.recordings.length > 0 && learn.finished !== null
  const summary = state.summary

  const media = (files: File[]): string[] =>
    files.filter((f) => isVideoFile(f.name) || AUDIO_EXT.test(f.name)).map((f) => api.pathForFile(f))

  const sentence = summary
    ? summary.sentence
    : "Give me a recording and the video you made from it. I'll line them up by sound and words, and learn how you cut."

  return (
    <section className="cl-section" aria-labelledby="brand-learn">
      <h2 id="brand-learn">Learn from my edits</h2>

      {running ? (
        <div className="cl-progress" aria-live="polite">
          <span>{learn.progress!.stage}</span>
          <span className="cl-progress-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(4, Math.min(100, learn.progress!.percent))}%` }} />
          </span>
        </div>
      ) : learn.error ? (
        <p className="cl-reply" role="alert">
          {learn.error}
        </p>
      ) : (
        <p className="cl-reply">{sentence}</p>
      )}

      {!running && !learn.error && summary && (summary.facts.length > 0 || summary.details.length > 0) && (
        <div className="cl-chips" style={{ alignItems: 'center' }}>
          {summary.facts.map((f) => (
            <span key={f} className="cl-fact">
              {f}
            </span>
          ))}
          {summary.details.length > 0 && (
            <button type="button" className="cl-link" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
              {details ? 'Hide details' : 'Details'}
            </button>
          )}
        </div>
      )}
      {details && summary && !running && !learn.error && (
        <dl className="cl-details">
          {summary.details.map((d) => (
            <div key={d.label} style={{ display: 'contents' }}>
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {!running &&
        !learn.error &&
        [state.aside, ...learn.notes.slice(0, 2)].filter(Boolean).map((t) => (
          <p key={t} className="cl-aside">
            {t}
          </p>
        ))}

      {/* The habits wait while files are being picked, so there is one thing to do at a time. */}
      {!running && !choosing && proposal && (
        <div className="cl-field">
          <p className="cl-aside">
            {changes.length > 0 ? `Your habits would change: ${changes.join('; ')}.` : habitsUseSentence(proposal)}
          </p>
          <div className="cl-actions">
            <Button variant="primary" onClick={() => app.saveBrand({ ...app.brand, habits: proposal })}>
              {inUse ? 'Keep the new habits' : 'Use these habits'}
            </Button>
            <Button variant="text" onClick={() => learn.dismiss(habitsKey(proposal))}>
              {inUse ? 'Keep the ones I have' : 'Discard'}
            </Button>
          </div>
        </div>
      )}
      {!running && !choosing && !proposal && inUse && (
        <div className="cl-row">
          <p className="cl-aside">/tighten and /brand cut the way you do.</p>
          <Button variant="text" onClick={() => app.saveBrand({ ...app.brand, habits: null })}>
            Stop using them
          </Button>
        </div>
      )}

      {choosing && (
        <>
          <Drop
            title="The recording"
            hint="Drop the raw recording, or every part of it."
            onFiles={(files) => learn.addRecordings(media(files))}
            onChoose={() => void learn.chooseRecordings()}
          >
            <Chosen paths={learn.recordings} onRemove={learn.removeRecording} />
          </Drop>
          <Drop
            title="The finished video"
            hint="Drop the video you made from it."
            onFiles={(files) => {
              const [path] = media(files).filter((p) => isVideoFile(p))
              if (path) learn.setFinished(path)
            }}
            onChoose={() => void learn.chooseFinished()}
          >
            <Chosen paths={learn.finished ? [learn.finished] : []} onRemove={() => learn.setFinished(null)} />
          </Drop>
          <div className="cl-actions">
            <Button variant="primary" disabled={!ready} onClick={() => void learn.run()}>
              Line them up
            </Button>
            {state.videos.length > 0 && (
              <Button variant="text" onClick={() => learn.setAdding(false)}>
                Cancel
              </Button>
            )}
          </div>
        </>
      )}

      {!running && state.videos.length > 0 && (
        <>
          <p className="cl-aside">
            {state.videos.length === 1
              ? 'I check my cutting against this edit of yours.'
              : `I check my cutting against these ${state.videos.length} edits of yours.`}
          </p>
          <ul className="cl-list">
            {state.videos.map((v) => (
              <li key={v.id}>
                <span className="cl-list-main">
                  {v.title}
                  <span className="cl-project-meta">
                    <span className="mono">{v.recordings.join(', ')}</span> · {v.kept} kept, {v.cut} cut
                  </span>
                </span>
                <button type="button" aria-label={`Forget ${v.title}`} onClick={() => void learn.forget(v.id)}>
                  <Icon.close />
                </button>
              </li>
            ))}
          </ul>
          {!choosing && (
            <div className="cl-actions">
              <Button onClick={() => learn.setAdding(true)}>Learn from another video</Button>
              <Button variant="text" disabled={learn.checking} onClick={() => void learn.checkAgain()}>
                {learn.checking ? 'Checking' : 'Check the cutting again'}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
