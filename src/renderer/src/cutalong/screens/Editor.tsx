import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import {
  beatAt,
  beatLabel,
  beatWords,
  CAMERA_INFO,
  cameraClock,
  cameraPlan,
  cameraTransform,
  captionPages,
  changesColour,
  currentCut,
  currentVersion,
  cutawayAt,
  cutawayClock,
  duckingKeys,
  frameAt,
  grainSpread,
  indexWords,
  insetFor,
  levelAt,
  lookMatrix,
  openNotes,
  pictureSpan,
  pieceFraming,
  pieceRate,
  pieceTime,
  pipBox,
  placeSfx,
  RECORDED_VOICE_LUFS,
  resolveCut,
  SFX_INFO,
  sfxGainDb,
  svgColourMatrix,
  transitionInfo,
  viewAt,
  viewThroughAngles,
  vignetteStops,
  windowShare,
  type Camera,
  type EditDoc,
  type Look,
  type Music,
  type Op,
  type Resolved,
  type Source,
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
import {
  buildScene,
  designSize,
  drawsCaptions,
  graphicTitle,
  template,
  themeFrom,
  type MotionItem,
  type MotionScene
} from '../../../../shared/motion'
import { lineName, ordinal, playingTake, takesOf, type TakeGroup } from '../../../../shared/raw'
import { isImagePath } from '../../../../shared/assets'
import { api, mediaUrlFor } from '../api'
import { BeatStrip, type StripBeat, type StripMark } from '../components/BeatStrip'
import { GraphicPanel } from '../components/GraphicPanel'
import { MotionCanvas } from '../components/MotionCanvas'
import { RegionPicker } from '../components/RegionPicker'
import { AssistantAvatar, Button, Icon, IconButton } from '../components/ui'
import { Working } from '../components/Working'
import { deckStyle } from '../deck-style'
import { grainTile } from '../grain'
import { clock } from '../format'
import { collapse } from '../motion'
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
  const soundA = useRef<HTMLAudioElement>(null)
  const soundB = useRef<HTMLAudioElement>(null)
  const sounds = useMemo(() => [soundA, soundB], [])
  // Beats shown through another camera play its file, heard as the recording is (edit/angle-view).
  const seen = useMemo(() => viewThroughAngles(cut, resolved, doc.sources), [cut, resolved, doc.sources])
  const player = usePlayer(decks, seen.resolved, { sources: seen.sources, urlFor: mediaUrlFor, sounds })
  const [side, setSide] = useState<'notes' | 'script' | 'takes'>('notes')
  const toggle = (which: 'script' | 'takes'): void => setSide((s) => (s === which ? 'notes' : which))
  // The cut's graphics on the output clock, in the brand's look: what the export draws.
  const scene = useMemo(
    () =>
      buildScene({
        cut,
        resolved,
        words: doc.words,
        size: designSize(cut.aspect, doc.sources[0]),
        theme: themeFrom(app.brand),
        assets: doc.assets
      }),
    [cut, resolved, doc.words, doc.sources, doc.assets, app.brand]
  )

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

  // Graphics along the beat strip, stacked in rows where they overlap.
  const marks: StripMark[] = useMemo(() => {
    const rows: number[] = []
    const byId = new Map(cut.motion.map((m) => [m.id, m]))
    return [...scene.items]
      .sort((a, b) => a.start - b.start)
      .map((i) => {
        let row = rows.findIndex((free) => free <= i.start)
        if (row < 0) row = rows.length
        rows[row] = i.end
        const item = byId.get(i.id)
        return { id: i.id, label: item ? graphicTitle(item) : 'Graphic', start: i.start, end: i.end, row }
      })
  }, [scene, cut.motion])
  const selected: MotionItem | null = cut.motion.find((m) => m.id === app.graphic) ?? null

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
            seen={seen}
            scene={scene}
            time={player.time}
            playing={player.playing}
            decks={decks}
            sounds={sounds}
            views={player.decks}
            mediaUrl={app.mediaUrl}
            selected={selected}
            onRegion={(box) => selected && app.updateGraphic(selected.id, { box })}
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
          ) : selected ? (
            <GraphicPanel
              item={selected}
              scene={scene}
              onChange={(change) => app.updateGraphic(selected.id, change)}
              onRemove={() => app.removeGraphic(selected.id)}
              onClose={() => app.selectGraphic(null)}
            />
          ) : (
            <NotesPanel app={app} doc={doc} nowBeat={nowBeat?.id ?? null} presets={app.presets} time={player.time} />
          )}
        </div>
        <BeatStrip
          beats={beats}
          duration={resolved.durationSec}
          time={player.time}
          playing={player.playing}
          onToggle={player.toggle}
          onSeek={player.seek}
          marks={marks}
          selected={selected?.id ?? null}
          onMark={(id) => {
            setSide('notes')
            app.selectGraphic(id === selected?.id ? null : id)
            const at = scene.items.find((i) => i.id === id)
            if (at && id !== selected?.id) player.seek(Math.min(at.end - 0.05, at.at + 0.4))
          }}
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
  seen,
  scene,
  time,
  playing,
  decks,
  sounds,
  views,
  mediaUrl,
  selected,
  onRegion
}: {
  doc: EditDoc
  resolved: Resolved
  /** The cut as the decks play it, with beats shown through other cameras. */
  seen: { resolved: Resolved; sources: Source[] }
  scene: MotionScene
  selected: MotionItem | null
  onRegion: (box: number[]) => void
  time: number
  playing: boolean
  decks: RefObject<HTMLVideoElement>[]
  /** Each deck's better sound, for recordings whose own microphone is not the one heard. */
  sounds: RefObject<HTMLAudioElement>[]
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
  // Captions the graphics draw are on the canvas, not here; and captions wait while a card or title is up.
  const carded = scene.items.some((i) => template(i.kind)?.covers === 'card' && time >= i.start && time < i.end)
  const page =
    cut.captions.on && !drawsCaptions(cut.captions) && !carded
      ? pages.find((p) => time >= p[0].outStart - 0.05 && time <= p[p.length - 1].outEnd + 0.25)
      : undefined
  const big = treatment?.bigWord ? resolved.words.find((w) => w.id === treatment.bigWord) : undefined
  const showBig = big && time >= big.outStart - 0.1 && time <= big.outEnd + 0.7
  // The look's colour, through the same matrix the export uses; a LUT shows in the export only.
  const look = cut.look ?? null
  const grade = useMemo(() => (look && changesColour(look) ? svgColourMatrix(lookMatrix(look)) : null), [look])
  // Another camera beside the picture, or in a box over it, for the piece on screen now.
  const onScreen = resolved.pieces.find((p) => time >= pictureSpan(p).outStart && time < pictureSpan(p).outEnd)
  const inset = onScreen && !onScreen.reverse ? insetFor(cut, onScreen, doc.sources) : null
  const across = ratio > 1
  const mainBox: CSSProperties | undefined =
    inset?.layout === 'side' ? (across ? { right: '50%' } : { bottom: '50%' }) : undefined

  return (
    <div className="cl-well" ref={well}>
      {cut.music && <Bed music={cut.music} resolved={resolved} time={time} playing={playing} />}
      <Effects doc={doc} resolved={resolved} time={time} playing={playing} />
      <div className="cl-frame" style={{ width: box.w, height: box.h }}>
        {grade && (
          <svg className="cl-look-defs" aria-hidden="true" focusable="false">
            <filter id="cl-look" colorInterpolationFilters="sRGB">
              <feColorMatrix type="matrix" values={grade} />
            </filter>
          </svg>
        )}
        {mediaUrl ? (
          <div className="cl-decks" style={grade ? { filter: 'url(#cl-look)' } : undefined}>
            <div className="cl-decks-main" style={mainBox}>
              {views.map((view, d) => (
                <Deck
                  key={d}
                  videoRef={decks[d]}
                  soundRef={sounds[d]}
                  view={view}
                  doc={doc}
                  resolved={seen.resolved}
                  sources={seen.sources}
                  time={time}
                  playing={playing}
                  frameAspect={inset?.layout === 'side' ? (across ? ratio / 2 : ratio * 2) : ratio}
                />
              ))}
            </div>
            {inset && onScreen && (
              <CameraInset
                url={mediaUrlFor(inset.path)}
                at={
                  inset.srcStart +
                  pieceTime(onScreen, time) -
                  (onScreen.hold !== undefined ? onScreen.srcStart : pictureSpan(onScreen).srcStart)
                }
                rate={pieceRate(onScreen, time)}
                playing={playing}
                box={
                  inset.layout === 'side'
                    ? across
                      ? { left: '50%', top: 0, right: 0, bottom: 0 }
                      : { left: 0, top: '50%', right: 0, bottom: 0 }
                    : pipStyle(ratio, inset.size)
                }
              />
            )}
          </div>
        ) : (
          <span className="cl-frame-empty" />
        )}
        {look && <LookOver look={look} playing={playing} />}
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
        <MotionCanvas scene={scene} assets={doc.assets} time={time} width={box.w} height={box.h} />
        {selected && template(selected.kind)?.fields.some((f) => f.slot === 'box') && (
          <RegionPicker item={selected} onPick={onRegion} />
        )}
      </div>
    </div>
  )
}

/** A picture-in-picture box over a frame of this shape, as the export places it, in shares of the frame. */
function pipStyle(ratio: number, camera: { width: number; height: number }): CSSProperties {
  // Any frame of the right shape gives the same shares; the export's own size keeps the rounding alike.
  const frame =
    ratio >= 1 ? { width: 1920, height: Math.round(1920 / ratio) } : { width: Math.round(1920 * ratio), height: 1920 }
  const b = pipBox(frame, camera)
  const pct = (n: number, of: number): string => `${(n / of) * 100}%`
  return {
    left: pct(b.x, frame.width),
    top: pct(b.y, frame.height),
    width: pct(b.width, frame.width),
    height: pct(b.height, frame.height)
  }
}

/**
 * Another camera of the same moment, beside the picture or in a box over it:
 * muted, kept on the moment the recording plays at the camera's offset, moved
 * only when it drifts, as the music and sounds are.
 */
function CameraInset({
  url,
  at,
  rate,
  playing,
  box
}: {
  url: string
  at: number
  rate: number
  playing: boolean
  box: CSSProperties
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const still = rate === 0
    if (Math.abs(v.currentTime - at) > (playing && !still ? 0.15 : 0.02)) v.currentTime = Math.max(0, at)
    if (!still) v.playbackRate = Math.min(16, Math.max(0.0625, rate))
    if (playing && !still && v.paused) void v.play().catch(() => undefined)
    if ((!playing || still) && !v.paused) v.pause()
  }, [at, rate, playing])
  return (
    <div className="cl-inset" style={box}>
      <video ref={ref} src={url} muted playsInline preload="auto" />
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
 * The vignette and grain of a look, over the picture and under the captions:
 * the vignette on the curve ffmpeg draws, the grain a texture as strong as
 * the export's, moving while the video plays.
 */
function LookOver({ look, playing }: { look: Look; playing: boolean }): JSX.Element | null {
  const vignette = look.vignette ?? 0
  const grain = look.grain ?? 0
  const tile = useMemo(() => (grain > 0 ? grainTile(grainSpread(grain)) : null), [grain])
  if (vignette <= 0 && !tile) return null
  return (
    <>
      {vignette > 0 && (
        <div
          className="cl-look-vignette"
          style={{
            background: `radial-gradient(circle farthest-corner at 50% 50%, ${vignetteStops(vignette)
              .map((s) => `rgb(0 0 0 / ${s.alpha.toFixed(3)}) ${(s.at * 100).toFixed(1)}%`)
              .join(', ')})`
          }}
        />
      )}
      {tile && (
        <div
          className="cl-look-grain"
          data-playing={playing ? '' : undefined}
          style={{ backgroundImage: `url(${tile})` }}
        />
      )}
    </>
  )
}

/**
 * The sound effects, each played from the file the export uses, starting
 * where the export starts it. The preview plays the voice as recorded rather
 * than at the loudness target, so the effects are set against a typical
 * recording level, as the bed is; the export sets both exactly.
 */
function Effects({
  doc,
  resolved,
  time,
  playing
}: {
  doc: EditDoc
  resolved: Resolved
  time: number
  playing: boolean
}): JSX.Element | null {
  const cut = currentCut(doc)
  const placed = useMemo(() => placeSfx(cut.beats, resolved), [cut.beats, resolved])
  const [built, setBuilt] = useState<Record<string, string> | null>(null)
  const wanted = placed.some((p) => p.sfx.kind)
  useEffect(() => {
    if (!wanted || built) return
    void api.sfxFiles().then((r) => r.ok && setBuilt(r.files))
  }, [wanted, built])
  if (placed.length === 0) return null
  const offsetDb = RECORDED_VOICE_LUFS - (cut.loudness ?? RECORDED_VOICE_LUFS)
  return (
    <>
      {placed.map((p, i) => {
        const path = p.sfx.kind ? built?.[p.sfx.kind] : p.sfx.path
        if (!path) return null
        return (
          <Effect
            key={`${p.beat}-${p.sfx.kind ?? p.sfx.path}-${p.sfx.word ?? ''}-${i}`}
            url={mediaUrlFor(path)}
            startSec={p.startSec}
            trimSec={p.trimSec}
            lengthSec={p.sfx.kind ? SFX_INFO[p.sfx.kind].sec : null}
            gainDb={sfxGainDb(p.sfx) + offsetDb}
            time={time}
            playing={playing}
          />
        )
      })}
    </>
  )
}

/** One sound effect: playing while the playhead is inside it, put back in step only when it drifts. */
function Effect({
  url,
  startSec,
  trimSec,
  lengthSec,
  gainDb,
  time,
  playing
}: {
  url: string
  startSec: number
  trimSec: number
  lengthSec: number | null
  gainDb: number
  time: number
  playing: boolean
}): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const a = ref.current
    if (!a) return
    const into = time - startSec + trimSec
    const length = lengthSec ?? (Number.isFinite(a.duration) ? a.duration : 5)
    const inside = time >= startSec && into < length
    a.volume = Math.min(1, Math.max(0, 10 ** (gainDb / 20)))
    if (playing && inside) {
      if (Math.abs(a.currentTime - into) > 0.08) a.currentTime = into
      if (a.paused) void a.play().catch(() => undefined)
    } else if (!a.paused) a.pause()
  }, [time, playing, startSec, trimSec, lengthSec, gainDb])
  return <audio ref={ref} src={url} preload="auto" aria-hidden="true" />
}

/**
 * The music bed, played under the preview: looping, at its level against the
 * voice, dipping under the words and fading as the export does. The preview
 * plays the voice as recorded rather than at the loudness target, so the bed
 * is set against a typical recording level; the export sets both exactly.
 */
function Bed({
  music,
  resolved,
  time,
  playing
}: {
  music: Music
  resolved: Resolved
  time: number
  playing: boolean
}): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null)
  const keys = useMemo(() => duckingKeys(resolved.words, music.duckDb, resolved.durationSec), [resolved, music.duckDb])
  useEffect(() => {
    const a = ref.current
    if (!a) return
    const length = music.durationSec ?? (Number.isFinite(a.duration) ? a.duration : Infinity)
    const at = (music.inSec + time) % length
    if (Math.abs(a.currentTime - at) > (playing ? 0.3 : 0.05)) a.currentTime = at
    const db = RECORDED_VOICE_LUFS + music.levelDb + levelAt(keys, time) - (music.lufs ?? -14)
    const fadeIn = music.fadeInSec > 0 ? Math.min(1, time / music.fadeInSec) : 1
    const fadeOut = music.fadeOutSec > 0 ? Math.min(1, Math.max(0, resolved.durationSec - time) / music.fadeOutSec) : 1
    a.volume = Math.min(1, Math.max(0, 10 ** (db / 20) * fadeIn * fadeOut))
    if (playing && a.paused) void a.play().catch(() => undefined)
    if (!playing && !a.paused) a.pause()
  }, [music, keys, time, playing, resolved.durationSec])
  return <audio ref={ref} src={mediaUrlFor(music.path)} preload="auto" />
}

/**
 * One of the player's two video elements, drawn with the look of the beat it
 * holds and, inside a transition, its side of it. The element stays mounted
 * whichever piece it holds, so it never reloads between cuts.
 */
function Deck({
  videoRef,
  soundRef,
  view,
  doc,
  resolved,
  sources,
  time,
  playing,
  frameAspect
}: {
  videoRef: RefObject<HTMLVideoElement>
  /** Plays the better sound of a recording whose own microphone is not the one heard. */
  soundRef: RefObject<HTMLAudioElement>
  view: DeckView
  doc: EditDoc
  resolved: Resolved
  /** The recordings the pieces name, stand-ins for other cameras included. */
  sources: Source[]
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
  const source = piece ? sources.find((s) => s.id === piece.source) : undefined
  let transform = t && t.zoom > 1.001 ? `scale(${t.zoom})` : undefined
  // Cropped to the frame, the picture looks where the speaker is, or where it was framed by hand (edit/reframe).
  const framing = piece && t && !t.camera ? pieceFraming(cut, t, piece, source?.subject) : null
  const objectPosition =
    framing && piece && source
      ? `${windowShare(frameAt(framing, time - pictureSpan(piece).outStart), source, frameAspect) * 100}% 50%`
      : undefined
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
          style={{ filter: t?.bw ? 'grayscale(1)' : undefined, transform, objectPosition }}
        />
        <audio ref={soundRef} preload="auto" aria-hidden="true" />
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
  presets,
  time
}: {
  app: Cutalong
  doc: EditDoc
  nowBeat: string | null
  presets: Preset[]
  /** The playhead: where a graphic typed here lands, and what the commands that act on a word or beat act on. */
  time: number
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
          if (command) void app.runCommand(command.command, 'panel', command.rest, time)
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
