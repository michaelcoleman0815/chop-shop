import { useEffect, useMemo, useRef, useState } from 'react'
import {
  beatLabel,
  beatWords,
  captionPages,
  currentCut,
  currentVersion,
  indexWords,
  openNotes,
  resolveCut,
  type EditDoc,
  type Op,
  type Resolved
} from '../../../../shared/edit'
import { parseCommand, slashQuery, suggestCommands, type Preset } from '../../../../shared/presets'
import { lineName, ordinal, playingTake, takesOf, type TakeGroup } from '../../../../shared/raw'
import { isImagePath } from '../../../../shared/assets'
import { mediaUrlFor } from '../api'
import { BeatStrip, type StripBeat } from '../components/BeatStrip'
import { AssistantAvatar, Button, Icon, IconButton } from '../components/ui'
import { Working } from '../components/Working'
import { clock } from '../format'
import { collapse } from '../motion'
import { usePlayer } from '../usePlayer'
import type { Cutalong, PanelStatus } from '../useCutalong'
import { Header } from './Header'

/**
 * The editor: the preview on the left, the notes on the right, the beats along
 * the bottom. The preview plays the cut straight off the recording, with the
 * captions, black and white, punch-ins and big words drawn live.
 */
export function Editor({ app }: { app: Cutalong }): JSX.Element {
  const doc = app.doc as EditDoc
  const cut = currentCut(doc)
  const version = currentVersion(doc)
  const resolved = useMemo(() => resolveCut(cut, doc.words, doc.sources), [cut, doc.words, doc.sources])
  const video = useRef<HTMLVideoElement>(null)
  const player = usePlayer(video, resolved)
  const [side, setSide] = useState<'notes' | 'script' | 'takes'>('notes')
  const toggle = (which: 'script' | 'takes'): void => setSide((s) => (s === which ? 'notes' : which))

  const beats: StripBeat[] = useMemo(() => {
    const byId = new Map(cut.beats.map((b) => [b.id, b]))
    return resolved.beats.map((rb) => {
      const beat = byId.get(rb.id)!
      return { id: rb.id, label: beatLabel(doc, beat), start: rb.outStart, end: rb.outEnd, bw: beat.treatment.bw }
    })
  }, [resolved, cut.beats, doc])

  const nowBeat =
    resolved.beats.find((b) => player.time >= b.outStart && player.time < b.outEnd) ??
    resolved.beats[resolved.beats.length - 1]

  // Space plays and pauses, unless someone is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement
      if (e.code !== 'Space' || el.closest('input, textarea, [contenteditable]')) return
      e.preventDefault()
      player.toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [player])

  return (
    <>
      <Header>
        <IconButton label="Back" onClick={() => (app.messages.length ? app.setScreen('thread') : app.goStart())}>
          <Icon.back />
        </IconButton>
        <span className="cl-heading">{doc.title}</span>
        <span className="cl-version">v{version.n}</span>
        <span className="spacer" />
        {doc.versions.length > 1 && (
          <Button variant="text" onClick={app.undo}>
            Undo
          </Button>
        )}
        <Button
          variant="text"
          className={side === 'takes' ? 'on' : ''}
          aria-pressed={side === 'takes'}
          onClick={() => toggle('takes')}
        >
          Takes
        </Button>
        <Button
          variant="text"
          className={side === 'script' ? 'on' : ''}
          aria-pressed={side === 'script'}
          onClick={() => toggle('script')}
        >
          Script
        </Button>
        <Button variant="primary" small onClick={() => void app.exportFinal()}>
          Export
        </Button>
      </Header>
      <main className="cl-editor">
        <div className="cl-editor-body">
          <Preview
            doc={doc}
            resolved={resolved}
            time={player.time}
            playing={player.playing}
            video={video}
            mediaUrl={app.mediaUrl}
          />
          {side === 'script' ? (
            <ScriptPanel
              doc={doc}
              time={player.time}
              resolved={resolved}
              onSeek={player.seek}
              onApply={app.applyOpsDirect}
            />
          ) : side === 'takes' ? (
            <TakesPanel app={app} doc={doc} resolved={resolved} onSeek={player.seek} />
          ) : (
            <NotesPanel app={app} doc={doc} nowBeat={nowBeat?.id ?? null} presets={app.presets} />
          )}
        </div>
        <BeatStrip
          beats={beats}
          duration={resolved.durationSec}
          time={player.time}
          playing={player.playing}
          onToggle={player.toggle}
          onSeek={player.seek}
        />
      </main>
    </>
  )
}

const ASPECT: Record<string, number> = { vertical: 9 / 16, square: 1, wide: 16 / 9 }
const CAPTION_TOP: Record<string, number> = { top: 0.22, middle: 0.52, chest: 0.66, bottom: 0.84 }

function Preview({
  doc,
  resolved,
  time,
  playing,
  video,
  mediaUrl
}: {
  doc: EditDoc
  resolved: Resolved
  time: number
  playing: boolean
  video: React.RefObject<HTMLVideoElement>
  mediaUrl: string | null
}): JSX.Element {
  const well = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const cut = currentCut(doc)
  const source = doc.sources[0]
  const ratio = ASPECT[cut.aspect] ?? (source.width > 0 && source.height > 0 ? source.width / source.height : 16 / 9)

  useEffect(() => {
    const el = well.current
    if (!el) return
    const fit = (): void => {
      const pad = 48
      const w = Math.max(0, el.clientWidth - pad)
      const h = Math.max(0, el.clientHeight - pad)
      const width = Math.min(w, h * ratio)
      setBox({ w: width, h: width / ratio })
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ratio])

  const beat = resolved.beats.find((b) => time >= b.outStart && time < b.outEnd)
  const treatment = beat ? cut.beats[beat.index]?.treatment : undefined
  const pages = useMemo(
    () => captionPages(resolved, cut.captions.wordsPerScreen),
    [resolved, cut.captions.wordsPerScreen]
  )
  const page = cut.captions.on
    ? pages.find((p) => time >= p[0].outStart - 0.05 && time <= p[p.length - 1].outEnd + 0.25)
    : undefined
  const big = treatment?.bigWord ? resolved.words.find((w) => w.id === treatment.bigWord) : undefined
  const showBig = big && time >= big.outStart - 0.1 && time <= big.outEnd + 0.7

  return (
    <div className="cl-well" ref={well}>
      <div className="cl-frame" style={{ width: box.w, height: box.h }}>
        {mediaUrl ? (
          <video
            ref={video}
            src={mediaUrl}
            playsInline
            preload="auto"
            style={{
              filter: treatment?.bw ? 'grayscale(1)' : undefined,
              transform: treatment && treatment.zoom > 1.001 ? `scale(${treatment.zoom})` : undefined
            }}
          />
        ) : (
          <span className="cl-frame-empty" />
        )}
        {treatment?.broll && treatment.frame !== 'speaker' && (
          <Cutaway
            frame={treatment.frame}
            path={treatment.broll.path}
            offset={treatment.broll.inSec + (time - (beat?.outStart ?? 0))}
            playing={playing}
            bw={treatment.bw}
          />
        )}
        {showBig && big && (
          <div className="cl-bigword" style={{ fontSize: Math.round(box.h * 0.1) }}>
            {big.text.replace(/[^\p{L}\p{N}'’-]/gu, '')}
          </div>
        )}
        {page && !showBig && (
          <div
            className={`cl-caption${treatment?.frame === 'card' && treatment.broll ? ' on-card' : ''}`}
            style={{
              top: `${CAPTION_TOP[cut.captions.position] * 100}%`,
              fontSize: Math.max(12, Math.round(box.h * 0.042))
            }}
          >
            {page.map((w, i) => (
              <span key={w.id} className={time >= w.outStart ? 'on' : 'off'}>
                {i > 0 ? ' ' : ''}
                {cut.captions.uppercase ? w.text.toUpperCase() : w.text}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * What a beat cuts to: B-roll over the whole frame, over the top half for a
 * split, or centred on a card. Video cutaways follow the playhead, correcting
 * only when they drift, so playback stays smooth.
 */
function Cutaway({
  frame,
  path,
  offset,
  playing,
  bw
}: {
  frame: string
  path: string
  offset: number
  playing: boolean
  bw: boolean
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const still = isImagePath(path) || path.startsWith('data:image')
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (Math.abs(v.currentTime - offset) > 0.3) v.currentTime = Math.max(0, offset)
    if (playing && v.paused) void v.play().catch(() => undefined)
    if (!playing && !v.paused) v.pause()
  }, [offset, playing])
  const src = mediaUrlFor(path)
  const style = bw ? { filter: 'grayscale(1)' } : undefined
  return (
    <div className={`cl-cutaway ${frame}`}>
      {still ? (
        <img src={src} alt="" style={style} />
      ) : (
        <video ref={ref} src={src} muted playsInline preload="auto" style={style} />
      )}
    </div>
  )
}

function NotesPanel({
  app,
  doc,
  nowBeat,
  presets
}: {
  app: Cutalong
  doc: EditDoc
  nowBeat: string | null
  presets: Preset[]
}): JSX.Element {
  const version = currentVersion(doc)
  const notes = openNotes(doc)
  const beats = currentCut(doc).beats
  const status: PanelStatus = app.panel ?? {
    text:
      version.n === 1
        ? `v1 is the recording in ${beats.length} beats. Leave notes as you watch, or type / for a preset.`
        : `v${version.n} is ready. ${version.summary}`
  }
  const position = (id: string | null): string => {
    const i = beats.findIndex((b) => b.id === id)
    return i < 0 ? '' : `Beat ${i + 1}`
  }

  return (
    <aside className="cl-notes" aria-label="Notes">
      <div className="cl-notes-scroll">
        <div className="cl-msg-assistant" aria-live="polite">
          <AssistantAvatar />
          <div className="cl-msg-body">
            {status.progress ? (
              <Working progress={status.progress} since={status.since} />
            ) : (
              <p className="cl-reply">{status.text}</p>
            )}
          </div>
        </div>
        {notes.length > 0 && (
          <ol className="cl-note-list">
            {notes.map((n, i) => (
              <li key={n.id} className="cl-note">
                <span className="cl-note-n">{i + 1}</span>
                <span className="cl-note-text">
                  {n.text}
                  {n.beat && <span className="cl-project-meta">{position(n.beat)}</span>}
                </span>
                <button
                  type="button"
                  aria-label={`Remove note ${i + 1}`}
                  onClick={(e) => collapse(e.currentTarget, () => app.dropNote(n.id))}
                >
                  <Icon.close />
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      {notes.length > 0 && (
        <Button variant="primary" small onClick={() => void app.applyNotes()} disabled={!!status.progress}>
          Apply {notes.length === 1 ? '1 note' : `${notes.length} notes`} as v{version.n + 1}
        </Button>
      )}
      <NoteInput
        presets={presets}
        onNote={(text) => {
          const command = parseCommand(text)
          if (command) void app.runCommand(command.command, 'panel', command.rest)
          else if (!app.answerInPanel(text)) app.addNote(text, nowBeat)
        }}
      />
    </aside>
  )
}

function NoteInput({ presets, onNote }: { presets: Preset[]; onNote: (text: string) => void }): JSX.Element {
  const [text, setText] = useState('')
  const query = slashQuery(text)
  const matches = query === null ? [] : suggestCommands(query, presets, 5)
  const send = (): void => {
    const value = text.trim()
    if (!value) return
    onNote(value)
    setText('')
  }
  return (
    <div className="cl-note-input">
      {matches.length > 0 && (
        <div className="cl-slash" role="listbox" aria-label="Presets">
          {matches.map((p) => (
            <button
              key={p.command}
              type="button"
              role="option"
              aria-selected={false}
              className="cl-slash-item"
              onMouseDown={(e) => {
                e.preventDefault()
                onNote(`/${p.command}`)
                setText('')
              }}
            >
              <span className="mono">/{p.command}</span>
              <span className="summary">{p.summary}</span>
            </button>
          ))}
        </div>
      )}
      <label className="sr-only" htmlFor="cl-note">
        Add a note, or type /
      </label>
      <input
        id="cl-note"
        value={text}
        placeholder="Add a note, or type /"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (matches.length > 0 && query !== null && !text.includes(' ')) {
              onNote(`/${matches[0].command}`)
              setText('')
            } else send()
          }
        }}
      />
      <IconButton label="Add note" filled disabled={!text.trim()} onClick={send}>
        <Icon.send />
      </IconButton>
    </div>
  )
}

/**
 * The words of the cut, beat by beat. Clicking words marks them; the button
 * cuts the marked words, or brings back struck ones, as one new version.
 */
function ScriptPanel({
  doc,
  time,
  resolved,
  onSeek,
  onApply
}: {
  doc: EditDoc
  time: number
  resolved: Resolved
  onSeek: (sec: number) => void
  onApply: (ops: Op[], fallback: string) => void
}): JSX.Element {
  const cut = currentCut(doc)
  const struck = useMemo(() => new Set(cut.removed), [cut.removed])
  const [marked, setMarked] = useState<Set<string>>(new Set())
  const timing = useMemo(() => new Map(resolved.words.map((w) => [w.id, w])), [resolved])
  const nowWord = resolved.words.find((w) => time >= w.outStart && time < w.outEnd)?.id

  useEffect(() => setMarked(new Set()), [cut])

  const toggle = (id: string): void =>
    setMarked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const apply = (): void => {
    const index = indexWords(doc.words)
    const ids = [...marked].sort((a, b) => (index.pos.get(a) ?? 0) - (index.pos.get(b) ?? 0))
    const ops: Op[] = []
    // Contiguous runs of the same kind become one op each.
    let run: string[] = []
    const flush = (): void => {
      if (run.length === 0) return
      ops.push({ op: struck.has(run[0]) ? 'unstrike' : 'strike', from: run[0], to: run[run.length - 1] })
      run = []
    }
    for (const id of ids) {
      const prev = run[run.length - 1]
      const adjacent = prev !== undefined && (index.pos.get(id) ?? -2) === (index.pos.get(prev) ?? -9) + 1
      if (!adjacent || struck.has(id) !== struck.has(prev)) flush()
      run.push(id)
    }
    flush()
    onApply(ops, 'Words changed.')
  }

  const cutting = [...marked].filter((id) => !struck.has(id)).length
  const restoring = marked.size - cutting
  const label =
    cutting && restoring
      ? `Cut ${cutting} and bring back ${restoring} words`
      : cutting
        ? `Cut ${cutting === 1 ? '1 word' : `${cutting} words`}`
        : `Bring back ${restoring === 1 ? '1 word' : `${restoring} words`}`

  return (
    <aside className="cl-notes" aria-label="Script">
      <div className="cl-notes-scroll cl-script">
        {cut.beats.map((beat) => (
          <p key={beat.id}>
            {beatWords(doc, beat).map((w, i) => (
              <span key={w.id}>
                {i > 0 && ' '}
                <button
                  type="button"
                  className={`cl-word${struck.has(w.id) ? ' struck' : ''}${marked.has(w.id) ? ' pending' : ''}${w.id === nowWord ? ' now' : ''}`}
                  onClick={() => toggle(w.id)}
                  onDoubleClick={() => {
                    const t = timing.get(w.id)
                    if (t) onSeek(t.outStart)
                  }}
                >
                  {w.text}
                </button>
              </span>
            ))}
          </p>
        ))}
        {cut.beats.every((b) => b.from === null) && <p className="muted">No words in this edit yet.</p>}
      </div>
      {marked.size > 0 && (
        <Button variant="primary" small onClick={apply}>
          {label}
        </Button>
      )}
      <p className="cl-project-meta">
        Click words to mark them. Double-click a word to jump to it. {clock(resolved.durationSec)} in the cut.
      </p>
    </aside>
  )
}

/**
 * The lines said more than once, each with its takes as a segmented choice.
 * The take that plays is marked; picking another makes it play, as a new
 * version, and jumps there so it can be heard. Uncertain cuts wait below.
 */
function TakesPanel({
  app,
  doc,
  resolved,
  onSeek
}: {
  app: Cutalong
  doc: EditDoc
  resolved: Resolved
  onSeek: (sec: number) => void
}): JSX.Element {
  const cut = currentCut(doc)
  // Takes come from the words and the sound, so they only change when those do.
  const groups = useMemo(() => takesOf(doc).flatMap((a) => a.groups), [doc.words, doc.sources, doc.audio]) // eslint-disable-line react-hooks/exhaustive-deps
  const [jumpTo, setJumpTo] = useState<string | null>(null)

  // After a switch, play from where the new take now sits in the cut.
  useEffect(() => {
    if (!jumpTo) return
    const w = resolved.words.find((x) => x.id === jumpTo)
    if (w) onSeek(w.outStart)
    setJumpTo(null)
  }, [resolved, jumpTo, onSeek])

  const pick = (g: TakeGroup, i: number): void => {
    const done = app.switchTake(g, i)
    app.setPanel(done ? { text: `v${done.n} is ready. ${done.summary}` } : null)
    setJumpTo(g.takes[i].from)
  }

  const status =
    app.panel?.text ??
    (groups.length === 0
      ? 'No line was said more than once in this recording.'
      : `${groups.length === 1 ? 'One line was' : `${groups.length} lines were`} said more than once. The take that plays is marked.`)
  const capital = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1)

  return (
    <aside className="cl-notes" aria-label="Takes">
      <div className="cl-notes-scroll">
        <p className="cl-reply">{status}</p>
        {groups.length > 0 && (
          <ol className="cl-note-list">
            {groups.map((g, k) => {
              const playing = playingTake(g, cut)
              const about =
                playing < 0
                  ? 'None of its takes plays.'
                  : `The ${ordinal(playing + 1)} of ${g.takes.length} plays${playing === g.chosen ? `, ${g.reason}` : ''}.`
              return (
                <li key={g.id} className="cl-note">
                  <span className="cl-note-n">{k + 1}</span>
                  <span className="cl-note-text cl-take">
                    {capital(lineName(g))}
                    <span className="cl-segments" role="radiogroup" aria-label={`Takes of ${lineName(g)}`}>
                      {g.takes.map((t, i) => (
                        <button
                          key={t.from}
                          type="button"
                          role="radio"
                          aria-checked={i === playing}
                          aria-label={`Take ${i + 1}${t.issues.length ? `: ${[...new Set(t.issues)].join(', ')}` : ''}`}
                          title={t.issues.length ? [...new Set(t.issues)].join(', ') : 'Clean'}
                          className={i === playing ? 'on' : ''}
                          onClick={() => (i === playing ? setJumpTo(t.from) : pick(g, i))}
                        >
                          {i + 1}
                        </button>
                      ))}
                    </span>
                    <span className="cl-project-meta">{about}</span>
                  </span>
                </li>
              )
            })}
          </ol>
        )}
        {app.offers.length > 0 && (
          <p className="cl-aside">
            {app.offers.length === 1
              ? `Left in at ${clock(app.offers[0].outSec)}: ${app.offers[0].what}.`
              : `Left in: ${app.offers.map((o) => `${o.what} at ${clock(o.outSec)}`).join('; ')}.`}
          </p>
        )}
      </div>
      {app.offers.length > 0 && (
        <Button
          small
          onClick={() => {
            const done = app.acceptOffers()
            app.setPanel(done ? { text: `v${done.n} is ready. ${done.summary}` } : null)
          }}
        >
          {app.offers.length === 1 ? 'Cut it' : `Cut all ${app.offers.length}`}
        </Button>
      )}
      <p className="cl-project-meta">Pick a take to hear it in the cut. Each change is a version you can undo.</p>
    </aside>
  )
}
