import { useState, type CSSProperties, type ReactNode } from 'react'
import { isImagePath } from '../../../../shared/assets'
import type { ChatMessage } from '../../../../shared/types'
import { mediaUrlFor, openingFrame } from '../api'
import { isAudioFile } from '../format'
import { Credits } from './Crew'
import { Poster } from './Poster'
import { factParts, MAX_FACTS, tileColours } from '../facts'
import { block } from '../shapes'
import { AssistantAvatar, Button } from './ui'
import { Working, type Progress } from './Working'

/**
 * One turn in a thread. The user's words sit in an ink bubble on the right;
 * the reply sits beside the assistant's avatar: a plain sentence, up to three
 * facts, Details for the numbers, and at most one primary action.
 */

export interface Action {
  kind:
    | 'open-editor'
    | 'use-style'
    | 'save-style'
    | 'reveal'
    | 'retry'
    | 'add-clip'
    /** A B-roll choice the router found (renderer broll.ts BrollPick): fetched, credited and cut to when tapped. */
    | 'add-broll'
    /** Looking on the web too, with its price on the button: the only way a paid search starts. */
    | 'broll-web'
    | 'add-icon'
    | 'sign-in'
    | 'open-settings'
    | 'run-command'
    | 'copy'
    | 'make'
    /** Sends its words as the person's next message: an answer to a question Claude asked. */
    | 'say'
    /** Opens the steps for the Anthropic key, on Start. */
    | 'setup-key'
    | 'strip-never'
  label: string
  /** Words after the label that stay whole when a narrow column shortens the label: " · NASA", where a B-roll choice is from. */
  tail?: string
  primary?: boolean
  /** A command name for save-style and run-command, a path for reveal, the text for copy or say, JSON for the asset actions. */
  payload?: string
  /** A small picture shown in the button, as a data URL. */
  icon?: string
  /** Shown only while the reply's work runs (a Stop), never once it is done. */
  during?: boolean
}

export interface Msg extends Omit<ChatMessage, 'actions'> {
  actions?: Action[]
  /** Set while the work behind a reply is still running. Never saved. */
  progress?: Progress | null
  /** When that work started, for the stopwatch beside it. Never saved. */
  since?: number
}

/** Past this many, the rest of a drop folds into one tile until asked for. */
const FILES_SHOWN = 8

function kindOf(name: string): string {
  if (isImagePath(name)) return 'Image'
  if (isAudioFile(name)) return 'Audio'
  return 'Footage'
}

/** Everything dropped in with a message, each file as a still of itself. */
function Files({ files }: { files: { path: string; name: string }[] }): JSX.Element {
  const [all, setAll] = useState(false)
  const folded = !all && files.length > FILES_SHOWN
  const shown = folded ? files.slice(0, FILES_SHOWN - 1) : files
  return (
    <div className="cl-files" role="list" aria-label={`${files.length} ${files.length === 1 ? 'file' : 'files'}`}>
      {shown.map((a) => (
        <div key={a.path} className="cl-file" role="listitem" title={a.name}>
          <Poster path={a.path} name={a.name} />
          <span className="cl-file-name">{a.name}</span>
          <span className="sr-only">{kindOf(a.name)}</span>
        </div>
      ))}
      {folded && (
        <button type="button" className="cl-file cl-file-more" onClick={() => setAll(true)}>
          <span className="cl-poster">+{files.length - shown.length}</span>
          <span className="cl-file-name">Show all</span>
        </button>
      )}
    </div>
  )
}

/**
 * Up to three facts as tiles, after the sentence: each a pastel block with a
 * big number and a small label, or a short phrase when the fact has no number.
 * The seed keeps a reply's colours the same each time it is drawn.
 */
export function Facts({ facts, seed }: { facts: string[]; seed: string }): JSX.Element | null {
  const shown = facts.slice(0, MAX_FACTS)
  if (shown.length === 0) return null
  const colours = tileColours(seed, shown.length)
  return (
    <div className="cl-facts">
      {shown.map((f, i) => {
        const p = factParts(f)
        return (
          <span
            key={f}
            className={`cl-fact${'phrase' in p ? ' phrase' : ''}`}
            style={{ '--block': block(colours[i]) } as CSSProperties}
          >
            {'phrase' in p ? (
              p.phrase
            ) : (
              <>
                <span className="cl-fact-n">{p.big}</span> <span className="cl-fact-label">{p.label}</span>
              </>
            )}
          </span>
        )
      })}
    </div>
  )
}

/** The tallest an export plays in the chat: a vertical video is framed to this, a wide one to the column. */
const EXPORT_MAX_HEIGHT = 'min(64vh, 560px)'

/**
 * An exported video, played whole in the chat, framed at its own shape so the
 * reply does not jump when it loads. A file moved or deleted since says so.
 */
function ExportedVideo({ video }: { video: NonNullable<Msg['video']> }): JSX.Element {
  const [missing, setMissing] = useState(false)
  const aspect = video.width > 0 && video.height > 0 ? video.width / video.height : 16 / 9
  if (missing) {
    return <p className="cl-aside">{video.name} is no longer where it was exported.</p>
  }
  return (
    // A width of its own, not a share of the reply's: the reply is only as wide as what it holds.
    // The stylesheet's max-width keeps a wide export inside the column.
    <figure className="cl-export" style={{ width: `calc(${EXPORT_MAX_HEIGHT} * ${aspect.toFixed(4)})` }}>
      <div className="cl-frame" style={{ aspectRatio: String(aspect), width: '100%' }}>
        <video
          src={openingFrame(mediaUrlFor(video.path))}
          controls
          playsInline
          preload="auto"
          aria-label={`${video.name}, the export`}
          onError={() => setMissing(true)}
        />
      </div>
      <figcaption className="cl-export-name mono">{video.name}</figcaption>
    </figure>
  )
}

export function UserMessage({ msg }: { msg: Msg }): JSX.Element {
  return (
    <div className="cl-msg-user">
      {msg.text && <div className="cl-bubble">{msg.text}</div>}
      {msg.link && (
        <div className="cl-linkcard">
          <span className="cl-linkcard-thumb" aria-hidden="true" />
          <span className="cl-linkcard-text">
            <strong>{msg.link.title ?? msg.link.url.replace(/^https?:\/\/(www\.)?/, '')}</strong>
            <span>{msg.link.meta ?? 'A video you like'}</span>
          </span>
        </div>
      )}
      {(msg.attachments?.length ?? 0) > 0 && <Files files={msg.attachments ?? []} />}
    </div>
  )
}

/** `children` is what the reply shows under its sentence: the clips a /clipping run found. */
export function AssistantMessage({
  msg,
  onAction,
  children
}: {
  msg: Msg
  onAction: (a: Action) => void
  children?: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="cl-msg-assistant" aria-live={msg.progress ? 'polite' : undefined}>
      <AssistantAvatar working={!!msg.progress} />
      <div className="cl-msg-body">
        {msg.progress ? (
          <Working progress={msg.progress} since={msg.since} big crew={msg.crew} />
        ) : (
          msg.text && <p className="cl-reply">{msg.text}</p>
        )}
        {!msg.progress && msg.video && <ExportedVideo video={msg.video} />}
        {!msg.progress && (msg.chips?.length ?? 0) > 0 && <Facts facts={msg.chips ?? []} seed={msg.id} />}
        {!msg.progress && (msg.details?.length ?? 0) > 0 && (
          <div className="cl-chips">
            <button type="button" className="cl-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? 'Hide details' : 'Details'}
            </button>
          </div>
        )}
        {open && msg.details && (
          <dl className="cl-details">
            {msg.details.map((d) => (
              <div key={d.label} style={{ display: 'contents' }}>
                <dt>{d.label}</dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {!msg.progress && msg.aside && <p className="cl-aside">{msg.aside}</p>}
        {/* Who did the work, then what it made: a clip set reads as what Reel found. */}
        {!msg.progress && <Credits crew={msg.crew} />}
        {!msg.progress && children}
        {(msg.actions ?? []).some((a) => !!a.during === !!msg.progress) && (
          <div className="cl-actions">
            {msg.actions!.filter((a) => !!a.during === !!msg.progress).map((a) => (
              <Button
                key={`${a.kind}|${a.label}|${a.tail ?? ''}|${a.payload ?? ''}`}
                variant={a.primary ? 'primary' : 'secondary'}
                onClick={() => onAction(a)}
              >
                {a.icon && <img src={a.icon} alt="" width={20} height={20} />}
                {a.kind === 'save-style' && a.payload ? (
                  <>
                    Save as <span className="cmd">/{a.payload}</span>
                  </>
                ) : (
                  <>
                    <span className="cl-btn-label">{a.label}</span>
                    {a.tail && <span className="cl-btn-tail">{a.tail}</span>}
                  </>
                )}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
