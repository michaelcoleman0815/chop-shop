import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  beatAt,
  beatLabel,
  beatWords,
  CAMERA_INFO,
  cameraClock,
  cameraPlan,
  cameraTransform,
  captionPages,
  currentCut,
  currentVersion,
  cutawayAt,
  cutawayClock,
  indexWords,
  openNotes,
  resolveCut,
  transitionInfo,
  viewAt,
  type Camera,
  type EditDoc,
  type Op,
  type Resolved,
  type Treatment
} from '../../../../shared/edit'
import {
  describeSpeed,
  parseCommand,
  seconds,
  slashQuery,
  suggestCommands,
  type Preset
} from '../../../../shared/presets'
import { isImagePath } from '../../../../shared/assets'
import { mediaUrlFor } from '../api'
import { BeatStrip, type StripBeat } from '../components/BeatStrip'
import { AssistantAvatar, Button, Icon, IconButton } from '../components/ui'
import { deckStyle } from '../deck-style'
import { clock } from '../format'
import { usePlayer, type DeckView } from '../usePlayer'
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
  const deckA = useRef<HTMLVideoElement>(null)
  const deckB = useRef<HTMLVideoElement>(null)
  const decks = useMemo(() => [deckA, deckB], [])
  // The first recording plays from the URL it was opened with; any other from its own path.
  const urlFor = useCallback(
    (id: string): string | null => {
      if (!app.mediaUrl) return null
      const source = doc.sources.find((s) => s.id === id)
      if (!source) return null
      return source.id === doc.sources[0].id ? app.mediaUrl : mediaUrlFor(source.path)
    },
    [app.mediaUrl, doc.sources]
  )
  const player = usePlayer(decks, resolved, urlFor)
  const [script, setScript] = useState(false)

  const beats: StripBeat[] = useMemo(() => {
    const byId = new Map(cut.beats.map((b) => [b.id, b]))
    const into = new Map((resolved.transitions ?? []).map((t) => [t.beat, t.kind]))
    const splits = new Map((resolved.splitEdits ?? []).map((s) => [s.beat, s]))
    return resolved.beats.map((rb) => {
      const beat = byId.get(rb.id)!
      const kind = into.get(rb.id)
      return {
        id: rb.id,
        label: beatLabel(doc, beat),
        start: rb.outStart,
        end: rb.outEnd,
        bw: beat.treatment.bw,
        comesIn: kind ? transitionInfo(kind).label : null,
        splitEdit: splits.has(rb.id)
          ? `${splits.get(rb.id)!.kind === 'j' ? 'a J cut' : 'an L cut'}, ${seconds(splits.get(rb.id)!.sec)}`
          : null,
        plays: playsAs(beat.treatment)
      }
    })
  }, [resolved, cut.beats, doc])

  const nowBeat = beatAt(resolved, player.time) ?? resolved.beats[resolved.beats.length - 1]

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
          className={script ? 'on' : ''}
          aria-pressed={script}
          onClick={() => setScript((s) => !s)}
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
            decks={decks}
            views={player.decks}
            mediaUrl={app.mediaUrl}
          />
          {script ? (
            <ScriptPanel
              doc={doc}
              time={player.time}
              resolved={resolved}
              onSeek={player.seek}
              onApply={app.applyOpsDirect}
            />
          ) : (
            <NotesPanel app={app} doc={doc} nowBeat={nowBeat?.id ?? null} nowTime={player.time} presets={app.presets} />
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
  decks,
  views,
  mediaUrl
}: {
  doc: EditDoc
  resolved: Resolved
  time: number
  playing: boolean
  decks: RefObject<HTMLVideoElement>[]
  views: DeckView[]
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

  const beat = beatAt(resolved, time)
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
          <div className="cl-decks">
            {views.map((view, d) => (
              <Deck
                key={d}
                videoRef={decks[d]}
                view={view}
                doc={doc}
                resolved={resolved}
                time={time}
                playing={playing}
                frameAspect={ratio}
              />
            ))}
          </div>
        ) : (
          <span className="cl-frame-empty" />
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

/** How a beat plays when not as recorded, in a few words: "at 2x", "cutaway backwards". */
function playsAs(t: Treatment): string | null {
  const parts = [
    t.speed !== undefined || t.ramp ? `at ${describeSpeed(t.speed ?? 1, t.ramp)}` : null,
    t.broll && (t.broll.speed !== undefined || t.broll.ramp)
      ? `cutaway at ${describeSpeed(t.broll.speed ?? 1, t.broll.ramp)}`
      : null,
    t.freeze ? `holds ${seconds(t.freeze.sec)} on a frame` : null,
    t.reverse ? 'backwards' : null,
    t.broll?.reverse ? 'cutaway backwards' : null,
    t.camera ? CAMERA_INFO[t.camera.kind].label : null,
    t.broll?.camera ? `cutaway with ${CAMERA_INFO[t.broll.camera.kind].label}` : null
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

/**
 * One of the player's two video elements, drawn with the look of the beat it
 * holds and, inside a transition, its side of it. The element stays mounted
 * whichever piece it holds, so it never reloads between cuts.
 */
function Deck({
  videoRef,
  view,
  doc,
  resolved,
  time,
  playing,
  frameAspect
}: {
  videoRef: RefObject<HTMLVideoElement>
  view: DeckView
  doc: EditDoc
  resolved: Resolved
  time: number
  playing: boolean
  /** The finished frame's width over its height. */
  frameAspect: number
}): JSX.Element {
  const cut = currentCut(doc)
  const piece = view.piece !== null ? resolved.pieces[view.piece] : undefined
  const rb = piece ? resolved.beats.find((b) => b.id === piece.beat) : undefined
  const t = rb ? cut.beats[rb.index]?.treatment : undefined
  const style = deckStyle(view.layer)
  // The cutaway runs on its own clock: its speed, its direction, held by a freeze.
  const runs = rb && t?.broll ? cutawayClock(resolved, rb.id, time) : null
  const at = runs && t?.broll ? cutawayAt(t.broll, runs.length, runs.offset) : null
  // The camera over the speaker, from the plan the export moves by.
  const source = piece ? doc.sources.find((s) => s.id === piece.source) : undefined
  let transform = t && t.zoom > 1.001 ? `scale(${t.zoom})` : undefined
  if (rb && t?.camera && source && source.height > 0) {
    const clock = cameraClock(resolved, rb.id, time, t.camera.word)
    if (clock) {
      const plan = cameraPlan(t.camera, clock.length, clock.wordAt, source.width / source.height, frameAspect)
      transform = cameraTransform(viewAt(plan, clock.t), plan.fw, plan.fh, t.zoom)
    }
  }
  const cutawayCamera =
    rb && t?.broll?.camera && t.frame !== 'card' ? cameraClock(resolved, rb.id, time, t.broll.camera.word) : null
  return (
    <div className="cl-deck" style={style.wrapper} data-dip={style.dip} aria-hidden={!view.layer}>
      <div className="cl-deck-picture" style={style.picture}>
        <video
          ref={videoRef}
          playsInline
          preload="auto"
          style={{ filter: t?.bw ? 'grayscale(1)' : undefined, transform }}
        />
        {view.layer && t?.broll && t.frame !== 'speaker' && at && (
          <Cutaway
            frame={t.frame}
            path={t.broll.path}
            srcSec={at.srcSec}
            rate={at.rate}
            moving={!runs?.held && !t.broll.reverse}
            playing={playing}
            bw={t.bw}
            camera={
              t.broll.camera && cutawayCamera
                ? {
                    move: t.broll.camera,
                    clock: cutawayCamera,
                    // A split shows the cutaway over the top half.
                    frameAspect: t.frame === 'split' ? frameAspect * 2 : frameAspect
                  }
                : null
            }
          />
        )}
      </div>
    </div>
  )
}

/**
 * What a beat cuts to: B-roll over the whole frame, over the top half for a
 * split, or centred on a card. A video cutaway plays at its own speed and
 * follows the playhead, correcting only when it drifts, so playback stays
 * smooth. Held by a freeze, or played backwards, which a video element
 * cannot do, it is put on its frame each moment instead.
 */
function Cutaway({
  frame,
  path,
  srcSec,
  rate,
  moving,
  playing,
  bw,
  camera
}: {
  frame: string
  path: string
  /** Where the cutaway is in its footage now. */
  srcSec: number
  rate: number
  /** False while it holds or plays backwards. */
  moving: boolean
  playing: boolean
  bw: boolean
  /** A camera move over it, where that move is, and the shape of the area it fills. */
  camera: {
    move: Camera
    clock: { t: number; length: number; wordAt: number | null }
    frameAspect: number
  } | null
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const still = isImagePath(path) || path.startsWith('data:image')
  // The footage's own shape, once it has loaded: the move is planned on it.
  const [shape, setShape] = useState<number | null>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const runs = playing && moving
    // Browsers play from a sixteenth to sixteen times, and keep the pitch.
    if (runs) v.playbackRate = Math.min(16, Math.max(0.0625, rate))
    if (Math.abs(v.currentTime - srcSec) > (runs ? 0.3 : 0.02)) v.currentTime = Math.max(0, srcSec)
    if (runs && v.paused) void v.play().catch(() => undefined)
    if (!runs && !v.paused) v.pause()
  }, [srcSec, rate, moving, playing])
  const src = mediaUrlFor(path)
  let transform: string | undefined
  if (camera && shape) {
    const plan = cameraPlan(camera.move, camera.clock.length, camera.clock.wordAt, shape, camera.frameAspect)
    transform = cameraTransform(viewAt(plan, camera.clock.t), plan.fw, plan.fh)
  }
  const style = { filter: bw ? 'grayscale(1)' : undefined, transform }
  return (
    <div className={`cl-cutaway ${frame}`}>
      {still ? (
        <img
          src={src}
          alt=""
          style={style}
          onLoad={(e) => setShape(e.currentTarget.naturalWidth / Math.max(1, e.currentTarget.naturalHeight))}
        />
      ) : (
        <video
          ref={ref}
          src={src}
          muted
          playsInline
          preload="auto"
          style={style}
          onLoadedMetadata={(e) => setShape(e.currentTarget.videoWidth / Math.max(1, e.currentTarget.videoHeight))}
        />
      )}
    </div>
  )
}

function NotesPanel({
  app,
  doc,
  nowBeat,
  nowTime,
  presets
}: {
  app: Cutalong
  doc: EditDoc
  nowBeat: string | null
  /** Where the playhead is, for commands that act on the word under it. */
  nowTime: number
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
              <div className="cl-progress">
                <span>{status.progress.stage}</span>
                <span className="cl-progress-bar" aria-hidden="true">
                  <span style={{ width: `${status.progress.percent}%` }} />
                </span>
              </div>
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
                <button type="button" aria-label={`Remove note ${i + 1}`} onClick={() => app.dropNote(n.id)}>
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
          if (command) void app.runCommand(command.command, 'panel', command.rest, nowBeat, nowTime)
          else app.addNote(text, nowBeat)
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
