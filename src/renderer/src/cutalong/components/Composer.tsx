import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { slashQuery, suggestCommands, type Preset } from '../../../../shared/presets'
import { api } from '../api'
import { Poster } from './Poster'
import { Icon, IconButton, Mark } from './ui'

/**
 * The one input. Footage and images are dropped or added with +, a video
 * someone likes is pasted as a link, and "/" opens the presets. Enter sends,
 * Shift+Enter starts a new line.
 */

export interface Attachment {
  path: string
  name: string
}

export function Composer({
  placeholder,
  presets,
  onSubmit,
  seed,
  busy = false,
  autoFocus = false,
  menuBelow = false
}: {
  placeholder: string
  presets: Preset[]
  onSubmit: (text: string, attachments: Attachment[]) => void
  /** Text to put in the composer, e.g. from a preset chip. The nonce makes repeats count. */
  seed?: { text: string; nonce: number } | null
  busy?: boolean
  autoFocus?: boolean
  /** Open the slash menu below the composer instead of above it. */
  menuBelow?: boolean
}): JSX.Element {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dropping, setDropping] = useState(false)
  const [pick, setPick] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!seed) return
    setText(seed.text)
    area.current?.focus()
  }, [seed])

  // Grow with the text, up to the cap in the stylesheet.
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const query = slashQuery(text)
  const matches = useMemo(() => (query === null ? [] : suggestCommands(query, presets)), [query, presets])
  useEffect(() => setPick(0), [query])

  const send = (): void => {
    if (busy) return
    const value = text.trim()
    if (!value && attachments.length === 0) return
    onSubmit(value, attachments)
    setText('')
    setAttachments([])
  }

  const choose = (command: string): void => {
    setText(`/${command} `)
    area.current?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPick((p) => (p + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPick((p) => (p - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        choose(matches[pick].command)
        return
      }
      if (e.key === 'Escape') {
        setText('')
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const add = (files: File[]): void => {
    const next = files.map((f) => ({ path: api.pathForFile(f), name: f.name })).filter((a) => a.path)
    if (next.length) setAttachments((prev) => [...prev, ...next.filter((n) => !prev.some((a) => a.path === n.path))])
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    add([...e.dataTransfer.files])
  }

  const browse = async (): Promise<void> => {
    const picked = await api.openMedia()
    if (picked.length)
      setAttachments((prev) => [...prev, ...picked.filter((p) => !prev.some((a) => a.path === p.path))])
  }

  const canSend = !busy && (text.trim().length > 0 || attachments.length > 0)

  return (
    <div
      className={`cl-composer${dropping ? ' dropping' : ''}${busy ? ' busy' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {matches.length > 0 && (
        <div className={`cl-slash${menuBelow ? ' below' : ''}`} role="listbox" aria-label="Presets">
          {matches.map((p, i) => (
            <button
              key={p.command}
              type="button"
              role="option"
              aria-selected={i === pick}
              className={`cl-slash-item${i === pick ? ' on' : ''}`}
              onMouseEnter={() => setPick(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(p.command)
              }}
            >
              <span className="mono">/{p.command}</span>
              <span className="summary">{p.summary}</span>
            </button>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div
          className="cl-composer-files"
          aria-label={`${attachments.length} ${attachments.length === 1 ? 'file' : 'files'} to send`}
        >
          {attachments.map((a, i) => (
            <span key={`${a.path}-${i}`} className="cl-attachment" title={a.name}>
              <Poster path={a.path} name={a.name} />
              <span>{a.name}</span>
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              >
                <Icon.close />
              </button>
            </span>
          ))}
        </div>
      )}
      <label className="sr-only" htmlFor="cl-ask">
        {placeholder}
      </label>
      <textarea
        id="cl-ask"
        ref={area}
        rows={2}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="cl-composer-row">
        <IconButton label="Add footage, audio or images" onClick={() => void browse()}>
          <Icon.plus />
        </IconButton>
        <span className="spacer" />
        <IconButton label="Send" filled disabled={!canSend} onClick={send}>
          <Icon.send />
          <span className="cl-send-mark" aria-hidden="true">
            <Mark size={22} white />
          </span>
        </IconButton>
      </div>
    </div>
  )
}
