import { useState } from 'react'
import { AssistantAvatar, Button } from './ui'
import type { ChatMessage } from '../../../../shared/types'

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
    | 'add-icon'
    | 'sign-in'
    | 'open-settings'
  label: string
  primary?: boolean
  /** A command name for save-style, a path for reveal, JSON for the asset actions. */
  payload?: string
  /** A small picture shown in the button, as a data URL. */
  icon?: string
}

export interface Msg extends Omit<ChatMessage, 'actions'> {
  actions?: Action[]
  /** Set while the work behind a reply is still running. Never saved. */
  progress?: { stage: string; percent: number } | null
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
      {(msg.attachments ?? []).map((a) => (
        <div key={a.path} className="cl-linkcard">
          <span className="cl-linkcard-thumb" aria-hidden="true" />
          <span className="cl-linkcard-text">
            <strong>{a.name}</strong>
            <span>Footage</span>
          </span>
        </div>
      ))}
    </div>
  )
}

export function AssistantMessage({ msg, onAction }: { msg: Msg; onAction: (a: Action) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="cl-msg-assistant" aria-live={msg.progress ? 'polite' : undefined}>
      <AssistantAvatar />
      <div className="cl-msg-body">
        {msg.progress ? (
          <div className="cl-progress">
            <span>{msg.progress.stage}</span>
            <span className="cl-progress-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(4, Math.min(100, msg.progress.percent))}%` }} />
            </span>
          </div>
        ) : (
          msg.text && <p className="cl-reply">{msg.text}</p>
        )}
        {!msg.progress && ((msg.chips?.length ?? 0) > 0 || (msg.details?.length ?? 0) > 0) && (
          <div className="cl-chips" style={{ alignItems: 'center' }}>
            {(msg.chips ?? []).map((c) => (
              <span key={c} className="cl-fact">
                {c}
              </span>
            ))}
            {(msg.details?.length ?? 0) > 0 && (
              <button type="button" className="cl-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                {open ? 'Hide details' : 'Details'}
              </button>
            )}
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
        {!msg.progress && (msg.actions?.length ?? 0) > 0 && (
          <div className="cl-actions">
            {msg.actions!.map((a) => (
              <Button key={a.kind + a.label} variant={a.primary ? 'primary' : 'secondary'} onClick={() => onAction(a)}>
                {a.icon && <img src={a.icon} alt="" width={20} height={20} />}
                {a.kind === 'save-style' && a.payload ? (
                  <>
                    Save as <span className="cmd">/{a.payload}</span>
                  </>
                ) : (
                  a.label
                )}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
