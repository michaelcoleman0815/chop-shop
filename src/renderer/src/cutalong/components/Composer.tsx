import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { namesCommand, slashQuery, suggestCommands, type Preset } from '../../../../shared/presets'
import { api } from '../api'
import { prefersReducedMotion, viewTransition } from '../motion'
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
  // Where each file stands in the drop it came with: a second drop's stills start at once, then 40 ms apart.
  const inDrop = useRef(new Map<string, number>())
  const [dropping, setDropping] = useState(false)
  const [pick, setPick] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!seed) return
    setText(seed.text)
    area.current?.focus()
  }, [seed])

  // One thin line at rest; it grows with the text, up to the cap in the stylesheet, then scrolls.
  useEffect(() => fitHeight(area.current), [text])
  // A wider or narrower window wraps the words again, so the height follows the width too.
  useEffect(() => {
    const el = area.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let width = el.clientWidth
    const watch = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      fitHeight(el)
    })
    watch.observe(el)
    return () => watch.disconnect()
  }, [])

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
      // Enter runs a command typed in full; it completes one typed in part.
      const runs = e.key === 'Enter' && namesCommand(query, matches)
      if (!runs && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
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

  /**
   * Changes the files waiting to be sent. When the row of stills appears or
   * goes, the composer opens or closes as one box (motion.css, "attach" and "detach")
   * instead of jumping to its new height in a frame, and the stills float up
   * inside it. Files added to a row already there just float in, so a second
   * drop never restarts the first.
   */
  const changeFiles = (change: (prev: Attachment[]) => Attachment[]): void => {
    const opensOrCloses = (attachments.length === 0) !== (change(attachments).length === 0)
    if (!opensOrCloses || prefersReducedMotion()) {
      setAttachments(change)
      return
    }
    viewTransition(attachments.length === 0 ? 'attach' : 'detach', () => flushSync(() => setAttachments(change)))
  }

  /** New files after the ones already waiting, each once. */
  const withNew =
    (fresh: Attachment[]) =>
    (prev: Attachment[]): Attachment[] => {
      const added = fresh.filter((n) => !prev.some((a) => a.path === n.path))
      added.forEach((a, i) => inDrop.current.set(a.path, i))
      return added.length ? [...prev, ...added] : prev
    }

  const add = (files: File[]): void => {
    const next = files.map((f) => ({ path: api.pathForFile(f), name: f.name })).filter((a) => a.path)
    if (next.length) changeFiles(withNew(next))
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    add([...e.dataTransfer.files])
  }

  const browse = async (): Promise<void> => {
    const picked = await api.openMedia()
    if (picked.length) changeFiles(withNew(picked))
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
            // Each file floats up into the composer as a round still of itself, one just after another.
            <span
              key={`${a.path}-${i}`}
              className="cl-attachment"
              title={a.name}
              style={{ '--i': Math.min(inDrop.current.get(a.path) ?? i, 5) } as CSSProperties}
            >
              <Poster path={a.path} name={a.name} />
              <span className="cl-attachment-name">{a.name}</span>
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => changeFiles((prev) => prev.filter((_, j) => j !== i))}
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
      {/* One line: add, the words, send. The buttons stay on the last line as the words grow. */}
      <div className="cl-composer-row">
        <IconButton label="Add footage, audio or images" onClick={() => void browse()}>
          <Icon.plus />
        </IconButton>
        <textarea
          id="cl-ask"
          ref={area}
          rows={1}
          value={text}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
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

/**
 * Sizes a text box to its words: one line when empty, a line more for each
 * line the words take, up to the max-height in the stylesheet, where it scrolls.
 * The height changes at once, never animated (the layout never moves in motion).
 */
export function fitHeight(el: HTMLTextAreaElement | null): void {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
