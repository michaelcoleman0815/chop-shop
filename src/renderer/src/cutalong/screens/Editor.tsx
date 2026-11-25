import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import {
  beatAt,
  beatLabel,
  beatWords,
  CAMERA_INFO,
  cameraClock,
  cameraPlan,
  cameraTransform,
  changesColour,
  currentCut,
  currentVersion,
  undoTarget,
  cutawayAt,
  cutawayClock,
  cutawayFit,
  duckingKeys,
  frameAt,
  grainSpread,
  gridHeard,
  indexWords,
  insetFor,
  jumpZooms,
  levelAt,
  lookMatrix,
  openNotes,
  panelInStep,
  pictureSpan,
  pieceFraming,
  pieceRate,
  pieceTime,
  pictureFit,
  boxRect,
  noteBeats,
  pickedBeats,
  pipBox,
  placeSfx,
  RECORDED_VOICE_LUFS,
  rangeTimes,
  resolveCut,
  SFX_INFO,
  sfxGainDb,
  silenceGrids,
  svgColourMatrix,
  transitionInfo,
  viewAt,
  viewThroughAngles,
  vignetteStops,
  windowShare,
  type BeatPick,
  type Camera,
  type Cut,
  type EditDoc,
  type Fit,
  type Look,
  type Music,
  type Op,
  type Resolved,
  type Source,
  type Treatment
} from '../../../../shared/edit'
import { pageRoom } from '../../../../shared/screen'
import { memberForNote } from '../crew'
import { changedBeats, revisionOf } from '../revisions'
import { toggleLabel, toggleOps } from '../word-track'
import { WordTrack } from '../components/WordTrack'
import {
  describeSpeed,
  parseCommand,
  seconds,
  namesCommand,
  slashQuery,
  suggestCommands,
  type Preset
} from '../../../../shared/presets'
import {
  buildScene,
  designSize,
  drawsCaptions,
  graphicTitle,
  shutterFor,
  template,
  themeFrom,
  type MotionItem,
  type Layer,
  type MotionScene,
  type MotionTheme
} from '../../../../shared/motion'
import { lineName, ordinal, playingTake, takesOf, type TakeGroup } from '../../../../shared/raw'
import { captionSits, captionStyleFor, shownWords, styleCues, subtitleAt, subtitleWords, wordSpeakers } from '../../../../shared/subtitles'
import { isImagePath } from '../../../../shared/assets'
import { api, MEDIA_CORS, mediaUrlFor } from '../api'
import { Backdrop } from '../components/Backdrop'
import { BeatStrip, type StripBeat, type StripMark } from '../components/BeatStrip'
import { fitHeight } from '../components/Composer'
import { GraphicPanel } from '../components/GraphicPanel'
import { boxStyle, GridPanels, gridViewFor } from '../components/GridPanels'
import { MotionCanvas } from '../components/MotionCanvas'
import { clipSpan, drawsBehind, mediaOf, resolveClip, soundingClips, trackLayers, tracksOf, type Placed, type TrackClip } from '../../../../shared/tracks'
import { needsBase } from '../../../../shared/tracks/compositing'
import { particleTitle } from '../../../../shared/particles/presets'
import { isKeyed, type Anim } from '../../../../shared/anim'
import { ClipPanel } from '../components/ClipPanel'
import { Scopes } from '../components/Scopes'
import { MaskDraw } from '../components/MaskDraw'
import type { RotoEdit, RotoProps } from '../components/RotoFields'
import { Lanes, type Lane, type Snap } from '../components/Lanes'
import { timelineFor } from '../../../../shared/motion/timing'
import { useClipMedia } from '../useClipMedia'
import { useMixGraph, type MixGraph } from '../mix-graph'
import { Mixer } from '../components/Mixer'
import { useScene3D } from '../useScene3D'
import { flyInTitle, scene3dLabel, sceneAnims } from '../../../../shared/three/spec'
import { RegionPicker } from '../components/RegionPicker'
import { Subtitles } from '../components/Subtitles'
import { AssistantAvatar, Button, Icon, IconButton } from '../components/ui'
import { Working } from '../components/Working'
import { deckStyle } from '../deck-style'
import { useFxRender, useFxScene } from '../fx-preview'
import { captureLayerBase, useDeckFrames } from '../layer-base'
import { useMattes } from '../mattes-preview'
import { grainTile } from '../grain'
import { FilmOver, filmFps } from '../components/FilmOver'
import { weaveTransform } from '../../../../shared/edit/film'
import { clock } from '../format'
import { collapse } from '../motion'
import { showFrame, usePlayer, type DeckView } from '../usePlayer'
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
  // Beats shown through another camera play its file, heard as the recording is (edit/angle-view);
  // a grid heard from another panel, or none, is silent on its own picture (edit/grid).
  const seen = useMemo(() => {
    const view = viewThroughAngles(cut, resolved, doc.sources)
    return { ...view, resolved: silenceGrids(cut, view.resolved) }
  }, [cut, resolved, doc.sources])
  // The look of the brand this edit is made in, for a grid's ground and labels, as its graphics have.
  const theme = useMemo(() => themeFrom(app.chatBrand), [app.chatBrand])
  const player = usePlayer(decks, seen.resolved, { sources: seen.sources, urlFor: mediaUrlFor, sounds })
  const [side, setSide] = useState<'notes' | 'script' | 'takes' | 'mix'>('notes')
  const toggle = (which: 'script' | 'takes' | 'mix'): void => setSide((s) => (s === which ? 'notes' : which))
  // Captions take the colours of the brand this version is made in, where the export gives them those:
  // when that brand applies itself.
  const captionColors = useMemo(
    () => (app.chatBrand.autoApply ? app.chatBrand.colors : null),
    [app.chatBrand]
  )
  // The cut's graphics on the output clock, in the look of the brand this version is made in: what the export draws.
  const scene = useMemo(
    () =>
      buildScene({
        cut,
        resolved,
        words: doc.words,
        size: designSize(cut.aspect, doc.sources[0]),
        theme: themeFrom(app.chatBrand),
        assets: doc.assets,
        pictures: doc.sources
      }),
    [cut, resolved, doc.words, doc.sources, doc.assets, app.chatBrand]
  )

  // The layer tracks on the output clock: their pictures as the compositor's layers, and what sounds.
  const layers = useMemo(() => {
    if (tracksOf(cut).length === 0) return { scene: null, sounding: [] }
    const tl = timelineFor(cut, resolved, doc.words)
    const media = mediaOf(doc.assets, doc.sources)
    return {
      // Clips and masks that follow an object in the edit's picture are placed through the cut (shared/tracks/roto-layers).
      scene: { ...scene, layers: trackLayers(cut, tl, scene.size, media, { cut, resolved, pictures: doc.sources }), items: [] },
      sounding: soundingClips(tracksOf(cut), tl, media)
    }
  }, [cut, resolved, doc.words, doc.assets, doc.sources, scene])

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

  // The layer tracks in the strip: lanes over and under the beats, a clip picked in them, and the ops they make.
  const tracks = tracksOf(cut)
  const [lanesOn, setLanesOn] = useState(() => tracksOf(currentCut(doc)).length > 0)
  const [clipId, setClipId] = useState<string | null>(null)
  const clock = useMemo(() => timelineFor(cut, resolved, doc.words), [cut, resolved, doc.words])
  const media = useMemo(() => mediaOf(doc.assets, doc.sources), [doc.assets, doc.sources])
  const lanes = useMemo(() => lanesOf(tracks, clock, media, doc.assets), [tracks, clock, media, doc.assets])
  const snaps = useMemo(() => snapsOf(resolved, lanes), [resolved, lanes])
  const pickedClip: TrackClip | null = tracks.flatMap((t) => t.clips).find((c) => c.id === clipId) ?? null
  useEffect(() => {
    if (clipId && !pickedClip) setClipId(null)
  }, [clipId, pickedClip])
  const clipOps = (ops: Op[], said: string): void => app.applyOpsDirect(ops, said)
  // A mask drawn or moved, or a key's colour picked, on the preview for the picked clip (components/MaskDraw).
  const [roto, setRoto] = useState<RotoEdit | null>(null)
  useEffect(() => {
    if (roto && roto.clip !== pickedClip?.id) setRoto(null)
  }, [roto, pickedClip])
  const rotoProps: RotoProps = {
    edit: roto,
    onEdit: setRoto,
    others: tracks
      .filter((t) => t.kind === 'picture')
      .flatMap((t) => t.clips)
      .filter((c) => c.id !== pickedClip?.id)
      .map((c) => ({ id: c.id, label: `${c.name ?? (c.kind === 'text' && c.text ? c.text.value.slice(0, 24) : c.kind)} (${c.id})` })),
    // Followed by Vision with the ops that ask it, applied together as one change (main/clip-follow).
    onFollow: async (ask) => {
      const found = await api.followClips(doc, ask)
      if (found.ops.length === 0) return found.said || 'I could not find what to follow there.'
      clipOps([...ask, ...(found.ops as Op[])], 'It follows what is under it.')
      return found.said
    }
  }
  const moveClip = (id: string, from: string, endSec: number): void => {
    const clip = tracks.flatMap((t) => t.clips).find((c) => c.id === id)
    if (!clip) return
    // A clip that ends on an anchor of its own keeps its length by ending where it now ends; a length stays a length.
    const to = clip.to.trim() && !/^\d+(\.\d+)?\s?s$/.test(clip.to.trim()) ? { to: `start+${endSec.toFixed(2)}` } : {}
    clipOps([{ op: 'clip-move', clip: id, from, ...to } as Op], 'One clip moves.')
  }
  const trimBeat = (beatId: string, edgeName: 'in' | 'out', by: number): void => {
    const op = beatTrim(cut, doc.words, doc.sources, beatId, edgeName, by)
    if (op) clipOps([op], edgeName === 'in' ? 'A beat starts somewhere else.' : 'A beat ends somewhere else.')
  }

  // A stretch picked on the strip: notes and commands act on its beats until it is let go.
  const [pick, setPick] = useState<BeatPick | null>(null)
  const picked = useMemo(() => pickedBeats(cut, pick), [cut, pick])
  const span = useMemo(() => (picked.length ? rangeTimes(resolved, picked) : null), [resolved, picked])
  // It goes when either end leaves the cut, and with the edit.
  useEffect(() => {
    if (pick && picked.length === 0) setPick(null)
  }, [pick, picked])
  useEffect(() => setPick(null), [doc.id])

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
        <Revisions doc={doc} onShow={app.showVersion} />
        <span className="spacer" />
        {undoTarget(doc) !== null && (
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
        <Button variant="text" className={side === 'mix' ? 'on' : ''} aria-pressed={side === 'mix'} onClick={() => toggle('mix')}>
          Mix
        </Button>
        <Button
          variant="text"
          className={side === 'script' ? 'on' : ''}
          aria-pressed={side === 'script'}
          onClick={() => toggle('script')}
        >
          Script
        </Button>
        {/* One filled button a view: while notes wait to be applied, applying them is it. */}
        <Button
          variant={openNotes(doc).length > 0 ? 'secondary' : 'primary'}
          small
          className="cl-export"
          onClick={() => void app.exportFinal()}
        >
          Export
        </Button>
      </Header>
      <main className="cl-editor" style={{ '--rev': revisionOf(version.n).colour } as CSSProperties}>
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
            theme={theme}
            captionColors={captionColors}
            layers={layers}
            roto={
              roto && pickedClip
                ? { edit: roto, clip: pickedClip, span: clipSpan(clock, resolveClip(pickedClip, media)), onOps: clipOps, onEdit: setRoto }
                : null
            }
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
          ) : side === 'mix' ? (
            <Mixer cut={cut} time={player.time} durationSec={resolved.durationSec} onOps={app.applyOpsDirect} onSeek={player.seek} />
          ) : pickedClip ? (
            <ClipPanel
              clip={pickedClip}
              span={clipSpan(clock, resolveClip(pickedClip, media))}
              frame={scene.size}
              time={player.time}
              onOps={clipOps}
              onSeek={player.seek}
              onClose={() => setClipId(null)}
              roto={rotoProps}
            />
          ) : selected ? (
            <GraphicPanel
              item={selected}
              scene={scene}
              onChange={(change) => app.updateGraphic(selected.id, change)}
              onRemove={() => app.removeGraphic(selected.id)}
              onClose={() => app.selectGraphic(null)}
            />
          ) : (
            <NotesPanel
              app={app}
              doc={doc}
              nowBeat={nowBeat?.id ?? null}
              presets={app.presets}
              time={player.time}
              picked={picked}
              span={span}
              onLetGo={() => setPick(null)}
            />
          )}
        </div>
        <WordTrack doc={doc} resolved={resolved} time={player.time} onSeek={player.seek} onApply={app.applyOpsDirect} />
        <BeatStrip
          beats={beats}
          duration={resolved.durationSec}
          time={player.time}
          playing={player.playing}
          onToggle={player.toggle}
          onSeek={player.seek}
          marks={marks}
          selected={selected?.id ?? null}
          pick={pick}
          onPick={setPick}
          onCutPick={() => {
            if (picked.length === 0) return
            // The answer shows in the notes, so they come up.
            setSide('notes')
            if (selected) app.selectGraphic(null)
            app.cutBeats(picked, 'panel')
          }}
          onMark={(id) => {
            setSide('notes')
            setClipId(null)
            app.selectGraphic(id === selected?.id ? null : id)
            const at = scene.items.find((i) => i.id === id)
            if (at && id !== selected?.id) player.seek(Math.min(at.end - 0.05, at.at + 0.4))
          }}
          onTrimBeat={trimBeat}
          layers={{
            on: lanesOn,
            toggle: () => setLanesOn((on) => !on),
            above: (
              <Lanes
                lanes={lanes.filter((l) => l.kind === 'picture').reverse()}
                duration={resolved.durationSec}
                time={player.time}
                selected={clipId}
                snaps={snaps}
                onSelect={(id) => {
                  setClipId(id)
                  if (id) {
                    setSide('notes')
                    app.selectGraphic(null)
                  }
                }}
                onMove={moveClip}
                onTrim={(id, e, to) => clipOps([{ op: 'clip-trim', clip: id, edge: e, to } as Op], 'One clip is trimmed.')}
                onRemove={(id) => clipOps([{ op: 'clip-remove', clips: [id] } as Op], 'One clip is gone.')}
                onSplit={(id, at) => clipOps([{ op: 'clip-split', clip: id, at } as Op], 'One clip is split.')}
              />
            ),
            below: (
              <Lanes
                lanes={lanes.filter((l) => l.kind === 'sound')}
                duration={resolved.durationSec}
                time={player.time}
                selected={clipId}
                snaps={snaps}
                onSelect={(id) => {
                  setClipId(id)
                  if (id) {
                    setSide('notes')
                    app.selectGraphic(null)
                  }
                }}
                onMove={moveClip}
                onTrim={(id, e, to) => clipOps([{ op: 'clip-trim', clip: id, edge: e, to } as Op], 'One clip is trimmed.')}
                onRemove={(id) => clipOps([{ op: 'clip-remove', clips: [id] } as Op], 'One clip is gone.')}
                onSplit={(id, at) => clipOps([{ op: 'clip-split', clip: id, at } as Op], 'One clip is split.')}
              />
            ),
            add: <AddMenu doc={doc} time={player.time} onAdd={clipOps} />
          }}
        />
      </main>
    </>
  )
}

const ASPECT: Record<string, number> = { vertical: 9 / 16, square: 1, wide: 16 / 9 }

/** No layer tracks, kept as one value so the clips' media are not remade each frame. */
const NO_LAYERS: Layer[] = []

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
  onRegion,
  theme,
  captionColors,
  layers,
  roto
}: {
  /** The layer tracks: what they draw over the picture, and what sounds. */
  layers: { scene: MotionScene | null; sounding: Placed[] }
  /** A clip's mask being drawn or moved, or its key's colour picked, over the picture. */
  roto: { edit: RotoEdit; clip: TrackClip; span: { start: number; end: number } | null; onOps: (ops: Op[], said: string) => void; onEdit: (e: RotoEdit | null) => void } | null
  doc: EditDoc
  resolved: Resolved
  /** The cut as the decks play it, with beats shown through other cameras. */
  seen: { resolved: Resolved; sources: Source[] }
  scene: MotionScene
  /** The brand's colours, which the export gives captions when the brand applies itself. */
  captionColors: { text: string; accent: string } | null
  selected: MotionItem | null
  onRegion: (box: number[]) => void
  /** The look graphics wear, for a grid's ground and labels. */
  theme: MotionTheme
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
  // The mixer (mix-graph): the voice, the music and each track through their strips.
  const mixer = useMixGraph(cut, resolved.durationSec, time, playing)
  useEffect(() => {
    for (const d of [...decks, ...sounds]) mixer.route(d.current, 'voice')
  })
  // The layer tracks' videos and sounds, kept on the player's moment.
  const clips = useClipMedia(layers.scene?.layers ?? NO_LAYERS, layers.sounding, time, playing, mixer)
  // The layer tracks' 3D clips, each drawn to a WebGL canvas of its own at the player's moment.
  const solid = useScene3D(layers.scene?.layers ?? NO_LAYERS, { width: box.w, height: box.h }, time, playing)
  // Scene effects, drawn as the export draws them (fx-preview): the picture's inside the decks, the rest over the look.
  const decksBox = useRef<HTMLDivElement>(null)
  const fxPicture = useRef<HTMLCanvasElement>(null)
  const fxOverlay = useRef<HTMLCanvasElement>(null)
  const fx = useFxScene(doc, resolved)
  useFxRender({ ...fx, time, playing, box, decks: decksBox, picture: fxPicture, overlay: fxOverlay })
  // The picture under the layer tracks, for clips that blend with it or grade it (layer-base), and whether it can be read.
  const frameBox = useRef<HTMLDivElement>(null)
  const [unreadable, setUnreadable] = useState(false)
  const onUnreadable = useCallback(() => setUnreadable(true), [])
  const deckFrames = useDeckFrames(decks, (layers.scene?.layers ?? NO_LAYERS).some(needsBase))
  // The person and objects as mattes, for clips cut to them and graphics behind the person (mattes-preview).
  const behind = useMemo(() => drawsBehind(scene.layers), [scene])
  const mattes = useMattes(doc, resolved, behind)
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
  // The captions the export burns in: its words (none from beats with captions off, or while a card
  // is up), its cues, and its look at its own size, in the brand's colours when it has them.
  const captionStyle = useMemo(
    () => captionStyleFor(cut.captions, scene.size.width, captionColors, scene.size.height),
    [cut.captions, scene.size.width, captionColors]
  )
  const cues = useMemo(() => {
    // Captions the graphics draw are on the motion canvas instead.
    if (!cut.captions.on || drawsCaptions(cut.captions)) return []
    const words = subtitleWords(cut, resolved, scene).words
    const seams = captionSits(cut, resolved.words, scene)
    return styleCues(shownWords(words, cut.captions, resolved.words, seams, wordSpeakers(doc.words)), captionStyle)
  }, [cut, resolved, scene, captionStyle, doc.words])
  const cue = subtitleAt(cues, time)
  const big = treatment?.bigWord ? resolved.words.find((w) => w.id === treatment.bigWord) : undefined
  const showBig = big && time >= big.outStart - 0.1 && time <= big.outEnd + 0.7
  // The look's colour, through the same matrix the export uses; a LUT shows in the export only.
  const look = cut.look ?? null
  const grade = useMemo(() => (look && changesColour(look) ? svgColourMatrix(lookMatrix(look)) : null), [look])
  // Another camera beside the picture, or in a box over it, for the piece on screen now.
  const onScreen = resolved.pieces.find((p) => time >= pictureSpan(p).outStart && time < pictureSpan(p).outEnd)
  const inset = onScreen && !onScreen.reverse ? insetFor(cut, onScreen, doc.sources) : null
  const across = ratio > 1
  const layerBase = useCallback((w: number, h: number) => captureLayerBase(frameBox.current, w, h, look), [look])
  const mainBox: CSSProperties | undefined =
    inset?.layout === 'side' ? (across ? { right: '50%' } : { bottom: '50%' }) : undefined

  return (
    <div className="cl-well" ref={well}>
      {cut.music && <Bed music={cut.music} resolved={resolved} time={time} playing={playing} mixer={mixer} />}
      <Effects doc={doc} resolved={resolved} time={time} playing={playing} />
      <div className="cl-frame" ref={frameBox} style={{ width: box.w, height: box.h }}>
        {grade && (
          <svg className="cl-look-defs" aria-hidden="true" focusable="false">
            <filter id="cl-look" colorInterpolationFilters="sRGB">
              <feColorMatrix type="matrix" values={grade} />
            </filter>
          </svg>
        )}
        {mediaUrl ? (
          <div
            className="cl-decks"
            ref={decksBox}
            style={{
              ...(grade ? { filter: 'url(#cl-look)' } : {}),
              // The gate weave moves the graded picture as the export's crop does (shared/edit/film.ts).
              transform: look?.weave ? weaveTransform(look.weave, time, filmFps(doc.sources[0]?.fps ?? 30)) : undefined
            }}
          >
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
                  theme={theme}
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
            {fx.scene && <canvas ref={fxPicture} className="cl-fx-picture" aria-hidden="true" />}
          </div>
        ) : (
          <span className="cl-frame-empty" />
        )}
        {look && <LookOver look={look} playing={playing} />}
        {look && <FilmOver look={look} time={time} fps={filmFps(doc.sources[0]?.fps ?? 30)} width={box.w} height={box.h} />}
        {fx.scene && <canvas ref={fxOverlay} className="cl-fx-overlay" aria-hidden="true" />}
        {showBig && big && (
          <div className="cl-bigword" style={{ fontSize: Math.round(box.h * 0.1) }}>
            {big.text.replace(/[^\p{L}\p{N}'’-]/gu, '')}
          </div>
        )}
        {layers.scene && (
          <MotionCanvas
            className="cl-motion cl-layers"
            scene={layers.scene}
            assets={doc.assets}
            time={time}
            width={box.w}
            height={box.h}
            video={clips.frame}
            scene3d={solid.frame}
            redraw={clips.version + deckFrames + solid.version}
            base={layerBase}
            onUnreadable={onUnreadable}
            mattes={mattes}
            keySize={playing ? 640 : 1280}
            shutter={shutterFor(filmFps(doc.sources[0]?.fps ?? 30))}
          />
        )}
        <Subtitles
          cue={showBig ? null : cue}
          style={captionStyle}
          frame={scene.size}
          time={time}
          width={box.w}
          height={box.h}
        />
        <MotionCanvas
          scene={scene}
          assets={doc.assets}
          time={time}
          width={box.w}
          height={box.h}
          mattes={mattes}
          shutter={shutterFor(filmFps(doc.sources[0]?.fps ?? 30))}
        />
        {roto && (
          <MaskDraw
            {...roto}
            layer={layers.scene?.layers.find((l) => l.id === roto.clip.id)}
            time={time}
            design={scene.size}
            box={box}
            frame={clips.frame}
          />
        )}
        {selected && template(selected.kind)?.fields.some((f) => f.slot === 'box') && (
          <RegionPicker item={selected} onPick={onRegion} />
        )}
      </div>
      {unreadable && (
        <p className="cl-layers-note" role="status">
          The preview cannot read this picture, so adjustment clips show ungraded here. The export grades them.
        </p>
      )}
      {mediaUrl && <Scopes decks={decksBox} look={look} time={time} playing={playing} />}
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
  // Where it should be and whether it plays, for a frame that arrives after this render.
  const wanted = useRef({ at: 0, runs: false })
  wanted.current = { at: Math.max(0, at), runs: playing && rate !== 0 }
  const showAt = (v: HTMLVideoElement): void =>
    showFrame(
      v,
      () => wanted.current.at,
      () => wanted.current.runs
    )
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
      <video
        ref={ref}
        src={url}
        crossOrigin={MEDIA_CORS}
        muted
        playsInline
        preload="auto"
        // Its frame, on an iPhone too, which may show none until it plays (showFrame).
        onLoadedMetadata={(e) => showAt(e.currentTarget)}
        onSuspend={(e) => {
          if (!wanted.current.runs && e.currentTarget.readyState < 2) showAt(e.currentTarget)
        }}
      />
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
  playing,
  mixer
}: {
  music: Music
  resolved: Resolved
  time: number
  playing: boolean
  /** Through the music's strip, or at its fader where the mixer cannot hear it. */
  mixer: MixGraph
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
    const strip = mixer.route(a, 'music') ? 1 : mixer.fallback('music', time)
    a.volume = Math.min(1, Math.max(0, 10 ** (db / 20) * fadeIn * fadeOut * strip))
    if (playing && a.paused) void a.play().catch(() => undefined)
    if (!playing && !a.paused) a.pause()
  }, [music, keys, time, playing, resolved.durationSec, mixer])
  return <audio ref={ref} src={mediaUrlFor(music.path)} crossOrigin={MEDIA_CORS} preload="auto" />
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
  frameAspect: frameWhole,
  theme
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
  theme: MotionTheme
}): JSX.Element {
  const cut = currentCut(doc)
  const piece = view.piece !== null ? resolved.pieces[view.piece] : undefined
  const rb = piece ? resolved.beats.find((b) => b.id === piece.beat) : undefined
  const t = rb ? cut.beats[rb.index]?.treatment : undefined
  // The speaker as a box on black (edit/box), as the export sets it: the picture is the box, its shape the box's.
  const boxed = cut.box && t && t.frame === 'speaker' && !t.camera && !t.broll && !t.grid && !t.angle ? cut.box : null
  const frameAspect = boxed ? boxed.aspect : frameWhole
  const boxAt = useMemo(() => {
    if (!boxed) return null
    const height = 1080 / frameWhole
    const r = boxRect(boxed, { width: 1080, height })
    return { top: `${(r.y / height) * 100}%`, bottom: `${((height - r.y - r.height) / height) * 100}%` }
  }, [boxed, frameWhole])
  // Jump cuts hidden with a punch-in, wide and close in turn, as the export has them (edit/jumps).
  const jumps = useMemo(() => jumpZooms(cut, resolved, sources), [cut, resolved, sources])
  const zoom = (t?.zoom ?? 1) * (view.piece !== null ? (jumps[view.piece] ?? 1) : 1)
  const style = deckStyle(view.layer)
  // A beat shown as a grid (edit/grid): this deck's picture in its own box, the others and the ground over it.
  const grid = rb && t?.grid ? t.grid : null
  const beatSource = rb ? cut.beats[rb.index]?.source : undefined
  const design = designSize(cut.aspect, doc.sources[0])
  const gridView = useMemo(
    () => (grid && beatSource ? gridViewFor(grid, beatSource, doc, design) : null),
    // The frame's shape and the edit's material are what the layout depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid, beatSource, doc.assets, doc.sources, design.width, design.height]
  )
  const gridClock = grid && rb ? cutawayClock(resolved, rb.id, time) : null
  const heard = grid ? gridHeard(grid) : 'own'
  // In a grid the beat's own picture fills its box as recorded, centred, with no camera over it, as the export shows it.
  const ownBox: CSSProperties | undefined = gridView
    ? gridView.own >= 0
      ? { ...boxStyle(gridView.layout.panels[gridView.own], design), right: 'auto', bottom: 'auto' }
      : { opacity: 0 }
    : undefined
  // The cutaway runs on its own clock: its speed, its direction, held by a freeze.
  const runs = rb && t?.broll ? cutawayClock(resolved, rb.id, time) : null
  const at = runs && t?.broll ? cutawayAt(t.broll, runs.length, runs.offset) : null
  // The camera over the speaker, from the plan the export moves by.
  const source = piece ? sources.find((s) => s.id === piece.source) : undefined
  let transform = t && zoom > 1.001 ? `scale(${zoom})` : undefined
  // A punch-in from the top or the foot of the picture, where the beat says (zoomAt), as the export crops it.
  let transformOrigin = transform && t?.zoomAt !== undefined ? `50% ${t.zoomAt * 100}%` : undefined
  // Cropped to the frame, the picture looks where the speaker is, or where it was framed by hand (edit/reframe).
  const framing = piece && t && !t.camera ? pieceFraming(cut, t, piece, source?.subject) : null
  const objectPosition =
    framing && piece && source
      ? `${windowShare(frameAt(framing, time - pictureSpan(piece).outStart), source, frameAspect) * 100}% 50%`
      : undefined
  if (rb && t?.camera && source && source.height > 0) {
    const clock = cameraClock(resolved, rb.id, time, t.camera.word)
    if (clock) {
      // On a screen recording with the speaker in a window, a focus fits the room beside it, as the export's does.
      const cutaway = (t.frame === 'broll' || t.frame === 'split' || t.frame === 'card') && t.broll !== null
      const room = source.screen && piece && !cutaway ? pageRoom(source.screen, piece.srcStart, piece.srcEnd) : null
      const plan = cameraPlan(t.camera, clock.length, clock.wordAt, source.width / source.height, frameAspect, room)
      transform = cameraTransform(viewAt(plan, clock.t), plan.fw, plan.fh, zoom)
      transformOrigin = undefined
    }
  }
  const cutawayCamera =
    rb && t?.broll?.camera && t.frame !== 'card' ? cameraClock(resolved, rb.id, time, t.broll.camera.word) : null
  // A picture of another shape shows whole, on a blurred copy of itself or between bars, as the export has it (edit/fill).
  const beat = rb ? cut.beats[rb.index] : undefined
  const box = { width: frameAspect, height: 1 }
  // In a grid each picture fills its own box, as the export crops it there.
  const fit = !grid && beat && source ? pictureFit(cut, beat, source, box) : 'cover'
  const brollPath = t?.broll?.path
  const brollAsset = brollPath ? doc.assets.find((a) => a.path === brollPath) : undefined
  const cutawayFitFor = (size: { width: number; height: number } | null): Fit =>
    beat
      ? cutawayFit(
          cut,
          beat,
          brollAsset?.width && brollAsset.height ? { width: brollAsset.width, height: brollAsset.height } : size,
          box
        )
      : 'cover'
  return (
    <div
      className="cl-deck"
      style={boxAt ? { ...style.wrapper, background: '#000000' } : style.wrapper}
      data-dip={style.dip}
      aria-hidden={!view.layer}
    >
      <div
        className={`cl-deck-picture${fit === 'black' ? ' bars' : ''}`}
        style={boxAt ? { ...style.picture, ...boxAt } : style.picture}
      >
        {fit === 'blur' && <Backdrop of={videoRef} aspect={frameAspect} bw={!!t?.bw} transform={transform} />}
        <video
          ref={videoRef}
          crossOrigin={MEDIA_CORS}
          playsInline
          preload="auto"
          style={{
            filter: t?.bw ? 'grayscale(1)' : undefined,
            ...(ownBox ?? { transform, transformOrigin, objectPosition, objectFit: fit === 'cover' ? undefined : 'contain' })
          }}
        />
        <audio ref={soundRef} preload="auto" aria-hidden="true" />
        {view.layer && grid && gridView && (
          <GridPanels
            layout={gridView.layout}
            design={design}
            panels={gridView.pictures.map((picture, i) => {
              if (!picture || i === gridView.own) return null
              // Another view of the beat's own recording plays in step with it, through its line-up, as the export has it.
              const inStep = beatSource ? panelInStep(cut.angles, beatSource, grid.panels[i]) : null
              const at =
                inStep !== null && piece
                  ? pieceTime(piece, time) + inStep
                  : (grid.panels[i].inSec ?? 0) + (gridClock?.offset ?? 0)
              return { picture, at }
            })}
            labels={grid.panels.map((p) => p.label)}
            theme={theme}
            since={gridClock?.offset ?? 0}
            playing={playing && !gridClock?.held}
            heard={typeof heard === 'number' ? heard : null}
          />
        )}
        {view.layer && !grid && t?.broll && t.frame !== 'speaker' && at && (
          <Cutaway
            frame={t.frame === 'split' && t.broll.below ? 'split below' : t.frame}
            seam={t.frame === 'split' ? t.broll.seam : undefined}
            path={t.broll.path}
            srcSec={at.srcSec}
            rate={at.rate}
            moving={!runs?.held && !t.broll.reverse}
            playing={playing}
            bw={t.bw}
            fitFor={cutawayFitFor}
            aspect={frameAspect}
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
  camera,
  fitFor,
  aspect,
  seam
}: {
  frame: string
  /** A split's seam line, in its colour. */
  seam?: string
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
  /** How it fills the frame, from its size when the edit knows it, or else the size it loaded at (edit/fill). */
  fitFor: (size: { width: number; height: number } | null) => Fit
  /** The frame's width over its height. */
  aspect: number
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const still = isImagePath(path) || path.startsWith('data:image')
  // The footage's own shape, once it has loaded: the move is planned on it.
  const [shape, setShape] = useState<number | null>(null)
  const fit = fitFor(shape ? { width: shape, height: 1 } : null)
  // Where it should be and whether it plays, for a frame that arrives after this render.
  const wanted = useRef({ at: 0, runs: false })
  wanted.current = { at: Math.max(0, srcSec), runs: playing && moving }
  const showAt = (v: HTMLVideoElement): void =>
    showFrame(
      v,
      () => wanted.current.at,
      () => wanted.current.runs
    )
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
  const style = { filter: bw ? 'grayscale(1)' : undefined, transform, objectFit: fit === 'cover' ? undefined : 'contain' } as const
  return (
    <div className={`cl-cutaway ${frame}${fit === 'black' ? ' bars' : ''}`}>
      {seam && <div className="cl-seam" style={{ background: seam }} />}
      {fit === 'blur' && <Backdrop of={still ? image : ref} aspect={aspect} bw={bw} />}
      {still ? (
        <img
          ref={image}
          src={src}
          crossOrigin={src.startsWith('data:') ? undefined : MEDIA_CORS}
          alt=""
          style={style}
          onLoad={(e) => setShape(e.currentTarget.naturalWidth / Math.max(1, e.currentTarget.naturalHeight))}
        />
      ) : (
        <video
          ref={ref}
          src={src}
          crossOrigin={MEDIA_CORS}
          muted
          playsInline
          preload="auto"
          style={style}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget
            setShape(v.videoWidth / Math.max(1, v.videoHeight))
            // Its frame, on an iPhone too, which may show none until it plays (showFrame).
            showAt(v)
          }}
          onSuspend={(e) => {
            if (!wanted.current.runs && e.currentTarget.readyState < 2) showAt(e.currentTarget)
          }}
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
  time,
  picked,
  span,
  onLetGo
}: {
  app: Cutalong
  doc: EditDoc
  nowBeat: string | null
  presets: Preset[]
  /** The playhead: where a graphic typed here lands, and what the commands that act on a word or beat act on. */
  time: number
  /** The beats of a stretch picked on the strip, and where it plays: a note or a command acts on those. */
  picked: string[]
  span: { start: number; end: number } | null
  onLetGo: () => void
}): JSX.Element {
  const version = currentVersion(doc)
  const notes = openNotes(doc)
  const beats = currentCut(doc).beats
  // A v1 shaped by the words sent with the footage is not the recording as shot: it says what it is.
  const status: PanelStatus = app.panel ?? {
    text:
      version.n === 1 && doc.make
        ? `v1 is the ${doc.make.brief.format} in ${beats.length} shots. Ask for a shot again, or leave notes as you watch.`
        : version.n === 1 && version.ops.length === 0
          ? `v1 is the recording in ${beats.length} beats. Leave notes as you watch, or type / for a preset.`
          : `v${version.n} is ready. ${version.summary}`
  }
  const position = (id: string | null): string => {
    const i = beats.findIndex((b) => b.id === id)
    return i < 0 ? '' : `Beat ${i + 1}`
  }
  // A note left on a stretch says where it played then.
  const resolved = useMemo(() => resolveCut(currentCut(doc), doc.words, doc.sources), [doc])
  const where = (n: (typeof notes)[number]): string => {
    if (!n.range) return position(n.beat)
    const times = rangeTimes(resolved, noteBeats(currentCut(doc), n.range))
    return times ? `${clock(times.start)} to ${clock(times.end)}` : position(n.beat)
  }
  const stretch = span ? `${clock(span.start)} to ${clock(span.end)}` : null
  // Applying notes: each goes to the member whose job it is, and those are the ones at work on it.
  const noteCrew = [...new Set(notes.map((n) => memberForNote(n.text)))]
  // A beat that cuts to B-roll (not an icon on a card) can swap it for other B-roll, offered here.
  const atNow = beats.find((b) => b.id === nowBeat)
  const swappable = !!atNow?.treatment.broll && (atNow.treatment.frame === 'broll' || atNow.treatment.frame === 'split')

  return (
    <aside className="cl-notes" aria-label="Notes">
      <div className="cl-notes-scroll">
        <div className="cl-msg-assistant" aria-live="polite">
          <AssistantAvatar working={!!status.progress} />
          <div className="cl-msg-body">
            {status.progress ? (
              <Working progress={status.progress} since={status.since} big mark={44} helpers={noteCrew} />
            ) : (
              <p className="cl-reply">{status.text}</p>
            )}
            {!status.progress && (status.actions?.length ?? 0) > 0 && (
              <div className="cl-actions">
                {status.actions!.map((a) => (
                  <Button
                    key={`${a.kind}|${a.label}|${a.tail ?? ''}|${a.payload ?? ''}`}
                    variant="secondary"
                    small
                    onClick={() => app.onAction(a)}
                  >
                    <span className="cl-btn-label">{a.label}</span>
                    {a.tail && <span className="cl-btn-tail">{a.tail}</span>}
                  </Button>
                ))}
              </div>
            )}
            {!status.progress && (status.actions?.length ?? 0) === 0 && swappable && nowBeat && (
              <div className="cl-actions">
                <Button variant="secondary" small onClick={() => void app.otherBroll(nowBeat)}>
                  Other B-roll for {position(nowBeat).toLowerCase()}
                </Button>
              </div>
            )}
          </div>
        </div>
        {notes.length > 0 && (
          <ol className="cl-note-list">
            {notes.map((n, i) => {
              return (
                <li key={n.id} className="cl-note">
                  <span className="cl-note-n">{i + 1}</span>
                  <span className="cl-note-text">
                    {n.text}
                    <span className="cl-note-meta">
                      {(n.beat || n.range) && <span className="cl-project-meta">{where(n)}</span>}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove note ${i + 1}`}
                    onClick={(e) => collapse(e.currentTarget, () => app.dropNote(n.id))}
                  >
                    <Icon.close />
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </div>
      {notes.length > 0 && (
        <Button variant="primary" small onClick={() => void app.applyNotes()} disabled={!!status.progress}>
          Apply {notes.length === 1 ? '1 note' : `${notes.length} notes`} as v{version.n + 1}
        </Button>
      )}
      {stretch && (
        <div className="cl-picked">
          <span>
            <span className="mono">{stretch}</span> picked
          </span>
          <Button variant="text" small onClick={onLetGo}>
            Clear
          </Button>
        </div>
      )}
      <NoteInput
        presets={presets}
        placeholder={stretch ? `A note on ${stretch}, or type /` : undefined}
        onNote={(text) => {
          const command = parseCommand(text)
          const range = picked.length ? picked : null
          // A note on a stretch is left on one of its beats: the playhead's, when it is among them.
          const note = (words: string): void =>
            app.addNote(
              words,
              range ? (nowBeat && range.includes(nowBeat) ? nowBeat : range[0]) : nowBeat,
              range ? { from: range[0], to: range[range.length - 1] } : null
            )
          // A slash command runs now; anything else is a note, which Claude reads when the notes are applied.
          if (command) void app.runCommand(command.command, 'panel', command.rest, time, range)
          else note(text)
        }}
      />
    </aside>
  )
}

/**
 * A note, or a command. The slash menu works as the chat's does: the arrows
 * move through it, Tab or Enter puts the command in the box to finish, and
 * Escape closes it. Nothing runs until it is sent.
 */
function NoteInput({
  presets,
  onNote,
  placeholder = 'Add a note, or type /'
}: {
  presets: Preset[]
  onNote: (text: string) => void
  placeholder?: string
}): JSX.Element {
  const [text, setText] = useState('')
  const [pick, setPick] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const query = slashQuery(text)
  const matches = query === null ? [] : suggestCommands(query, presets, 5)
  useEffect(() => setPick(0), [query])
  // One thin line, growing with a longer note as the chat's box does.
  useEffect(() => fitHeight(input.current), [text])
  const send = (): void => {
    const value = text.trim()
    if (!value) return
    onNote(value)
    setText('')
  }
  const choose = (command: string): void => {
    setText(`/${command} `)
    input.current?.focus()
  }
  return (
    <div className="cl-note-input">
      {matches.length > 0 && (
        <div className="cl-slash" role="listbox" aria-label="Presets">
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
      <label className="sr-only" htmlFor="cl-note">
        {placeholder}
      </label>
      <textarea
        id="cl-note"
        ref={input}
        rows={1}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (matches.length > 0) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const step = e.key === 'ArrowDown' ? 1 : -1
              setPick((p) => (p + step + matches.length) % matches.length)
              return
            }
            // Enter runs a command typed in full; it completes one typed in part.
            const runs = e.key === 'Enter' && namesCommand(query, matches)
            if (!runs && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
              e.preventDefault()
              choose(matches[Math.min(pick, matches.length - 1)].command)
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setText('')
              return
            }
          }
          // Enter adds the note; Shift+Enter starts a new line in it.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
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
/**
 * The revision pages: the newest versions as tabs, each in its revision's
 * colour. The one on screen sits forward and keeps the cl-version class; an
 * earlier one comes back as the newest version, the way Undo brings one back.
 */
function Revisions({ doc, onShow }: { doc: EditDoc; onShow: (n: number) => void }): JSX.Element {
  const current = currentVersion(doc).n
  const shown = doc.versions.slice(-5)
  const earlier = doc.versions.length - shown.length
  // A version made while the editor is open wears a "new" sticker; those already here when it opened do not.
  const [known] = useState(() => Math.max(0, ...doc.versions.map((v) => v.n)))
  return (
    <div className="cl-revisions" role="group" aria-label="Versions">
      {earlier > 0 && <span className="cl-rev-more">{earlier} earlier</span>}
      {shown.map((v) => {
        const rev = revisionOf(v.n)
        const on = v.n === current
        const fresh = v.n > known
        return (
          <span key={v.n} className="cl-rev">
            <button
              type="button"
              className={`cl-rev-tab${on ? ' cl-version' : ''}`}
              style={{ '--rev': rev.colour, '--block': rev.block } as CSSProperties}
              aria-current={on ? 'true' : undefined}
              aria-label={`v${v.n}, the ${rev.name} pages${fresh ? ', new' : ''}${on ? ', on screen' : ''}. ${v.summary}`}
              title={v.summary}
              onClick={() => {
                if (!on) onShow(v.n)
              }}
            >
              v{v.n}
            </button>
            {fresh && (
              <span className="cl-rev-new">new</span>
            )}
          </span>
        )
      })}
    </div>
  )
}

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
  const nowLine = beatAt(resolved, time)?.id
  const revision = currentVersion(doc).n
  const changed = useMemo(() => changedBeats(doc), [doc])
  // Open notes, numbered as the notes list numbers them, pencilled beside the line they are on.
  const margin = useMemo(() => {
    const byBeat = new Map<string, { n: number; text: string; id: string }[]>()
    doc.notes
      .filter((note) => note.status === 'open')
      .forEach((note, i) => {
        if (!note.beat) return
        byBeat.set(note.beat, [...(byBeat.get(note.beat) ?? []), { n: i + 1, text: note.text, id: note.id }])
      })
    return byBeat
  }, [doc.notes])

  useEffect(() => setMarked(new Set()), [cut])

  const toggle = (id: string): void =>
    setMarked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const apply = (): void => onApply(toggleOps(doc, marked), 'Words changed.')
  const label = toggleLabel(doc, marked)

  return (
    <aside className="cl-notes" aria-label="Script">
      <p className="cl-script-key">
        v{revision}, the {revisionOf(revision).name} pages.{changed.size > 0 ? ' An asterisk marks a line this revision changed.' : ''}
      </p>
      <div className="cl-notes-scroll cl-script">
        {cut.beats.map((beat, line) => (
          <div key={beat.id} className={`cl-sline${beat.id === nowLine ? ' now' : ''}`}>
            <span className="cl-sline-n" aria-hidden="true">
              {line + 1}
            </span>
            <p>
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
            <span className="cl-sline-star">
              {changed.has(beat.id) && (
                <>
                  <span aria-hidden="true">*</span>
                  <span className="sr-only">Changed in v{revision}</span>
                </>
              )}
            </span>
            {(margin.get(beat.id) ?? []).map((note) => (
              <p key={note.id} className="cl-margin-note">
                <b aria-label={`Note ${note.n}`}>{note.n}</b>
                {note.text}
              </p>
            ))}
          </div>
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

  // What this panel last did, while that version is the one on screen. The
  // editor's shared status line belongs to notes, undo and commands, and
  // would put their words here instead.
  const [said, setSaid] = useState<{ n: number; text: string } | null>(null)
  const pick = (g: TakeGroup, i: number): void => {
    const done = app.switchTake(g, i)
    setSaid(done ? { n: done.n, text: `v${done.n} is ready. ${done.summary}` } : null)
    setJumpTo(g.takes[i].from)
  }

  const status =
    (said && said.n === currentVersion(doc).n ? said.text : null) ??
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

// ---------- Layer tracks in the strip ----------

/** The settings that can carry keys, as a clip holds them. */
function animsOf(c: TrackClip): (Anim<number> | undefined)[] {
  return [
    c.opacity,
    c.volume,
    c.pan,
    c.particles?.rate,
    ...Object.values(c.transform ?? {}),
    ...Object.values(c.crop ?? {}),
    ...sceneAnims(c.scene).map((s) => s.anim)
  ] as (Anim<number> | undefined)[]
}

/** What a clip is called in its lane: its name, a title's words, a file's name. */
function clipLabel(c: TrackClip, assets: EditDoc['assets']): string {
  if (c.name) return c.name
  if (c.kind === 'text') return c.text?.value ?? 'Title'
  if (c.kind === 'solid') return 'Colour'
  if (c.kind === 'adjustment') return 'Adjustment'
  if (c.kind === 'particles') return particleTitle(c.particles)
  if (c.kind === '3d') return scene3dLabel(c.scene)
  const asset = assets.find((a) => a.id === c.src)
  return asset?.title ?? (c.src ?? '').split(/[\\/]/).pop() ?? c.kind
}

/** Every track as a lane, each clip where it plays and its keys along it. */
function lanesOf(tracks: ReturnType<typeof tracksOf>, tl: ReturnType<typeof timelineFor>, media: ReturnType<typeof mediaOf>, assets: EditDoc['assets'] = []): Lane[] {
  return tracks.map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    hidden: t.hidden,
    mute: t.mute,
    locked: t.locked,
    clips: t.clips.flatMap((c) => {
      const span = clipSpan(tl, resolveClip(c, media))
      if (!span) return []
      const keys = new Set<number>()
      for (const a of animsOf(c)) if (isKeyed(a)) for (const k of a.keys) keys.add(span.start + k.t)
      return [{ id: c.id, label: clipLabel(c, assets), kind: c.kind, start: span.start, end: span.end, keys: [...keys].sort((x, y) => x - y) }]
    })
  }))
}

/** Where a move or a trim can land: every word's start and end, every beat's, and the other clips' ends. */
function snapsOf(resolved: Resolved, lanes: Lane[]): Snap[] {
  const out: Snap[] = []
  for (const w of resolved.words) out.push({ t: w.outStart, anchor: w.id }, { t: w.outEnd, anchor: `${w.id}.end` })
  for (const b of resolved.beats) out.push({ t: b.outStart, anchor: b.id }, { t: b.outEnd, anchor: `${b.id}.end` })
  for (const l of lanes) for (const c of l.clips) out.push({ t: c.start, anchor: `start+${c.start.toFixed(2)}` }, { t: c.end, anchor: `start+${c.end.toFixed(2)}` })
  return out
}

/**
 * A beat's edge dragged by seconds, as a trim: onto the word whose start (or
 * end) is nearest where the edge was dragged to, in the beat's recording; a
 * beat that is a stretch of a recording moves its in or out point by the drag.
 */
function beatTrim(cut: Cut, words: EditDoc['words'], sources: EditDoc['sources'], beatId: string, edge: 'in' | 'out', by: number): Op | null {
  const beat = cut.beats.find((b) => b.id === beatId)
  if (!beat) return null
  if (beat.from !== null && beat.to !== null) {
    const ref = words.find((w) => w.id === (edge === 'in' ? beat.from : beat.to))
    if (!ref) return null
    const target = (edge === 'in' ? ref.startSec : ref.endSec) + by
    let best = ref
    for (const w of words) {
      if (w.source !== beat.source) continue
      const d = Math.abs((edge === 'in' ? w.startSec : w.endSec) - target)
      if (d < Math.abs((edge === 'in' ? best.startSec : best.endSec) - target)) best = w
    }
    return best.id === ref.id ? null : ({ op: 'trim', beat: beatId, edge, word: best.id } as Op)
  }
  const length = sources.find((s) => s.id === beat.source)?.durationSec ?? Infinity
  const sec = edge === 'in' ? Math.max(0, (beat.inSec ?? 0) + by) : Math.min(length, (beat.outSec ?? length) + by)
  return { op: 'trim', beat: beatId, edge, sec: Math.round(sec * 1000) / 1000 } as Op
}

/** Adds a title, a colour or a piece of the edit's material to the tracks, at the playhead. */
function AddMenu({ doc, time, onAdd }: { doc: EditDoc; time: number; onAdd: (ops: Op[], said: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const at = time < 0.005 ? 'start' : `start+${time.toFixed(2)}`
  const add = (op: Record<string, unknown>, said: string): void => {
    setOpen(false)
    onAdd([{ op: 'clip-add', from: at, ...op } as Op], said)
  }
  const material = doc.assets.filter((a) => a.kind === 'video' || a.kind === 'image' || a.kind === 'audio')
  return (
    <span className="cl-menu-anchor">
      <button type="button" className="cl-strip-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Add
      </button>
      {open && (
        <div className="cl-menu up" role="menu" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <button type="button" role="menuitem" onClick={() => add({ kind: 'text', text: { value: 'Title' }, to: '3s' }, 'A title goes over the edit.')}>
            A title
            <span className="meta">Words over the picture, at the playhead</span>
          </button>
          <button type="button" role="menuitem" onClick={() => add({ kind: 'solid', color: '#000000', opacity: 0.5, to: '3s' }, 'A colour goes over the edit.')}>
            A colour
            <span className="meta">A tint over the whole frame</span>
          </button>
          <button type="button" role="menuitem" onClick={() => add({ kind: 'adjustment', to: '3s', grade: { contrast: 0.2 } }, 'An adjustment grades what is under it.')}>
            An adjustment
            <span className="meta">Grades everything under it while it plays</span>
          </button>
          <button type="button" role="menuitem" onClick={() => add({ kind: 'particles', particles: { preset: 'snow' }, to: '5s' }, 'Snow falls over the edit.')}>
            Particles
            <span className="meta">Snow, sparks, confetti and more, over the picture</span>
          </button>
          <button type="button" role="menuitem" onClick={() => add({ kind: '3d', scene: flyInTitle('Title'), to: '4s' }, 'A 3D title goes over the edit.')}>
            A 3D title
            <span className="meta">Words in 3D that fly in, at the playhead</span>
          </button>
          {material.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              onClick={() =>
                add(
                  { kind: a.kind === 'audio' ? 'sound' : a.kind, src: a.id, ...(a.kind === 'image' ? { to: '4s' } : {}), ...(a.durationSec ? { fileSec: a.durationSec } : {}) },
                  a.kind === 'audio' ? 'A sound plays under the edit.' : `${a.kind === 'image' ? 'A picture' : 'A video'} goes over the edit.`
                )
              }
            >
              {a.title}
              <span className="meta">{a.kind === 'audio' ? 'Sound' : a.kind === 'image' ? 'Picture' : 'Video'}, on a {a.kind === 'audio' ? 'sound' : 'picture'} track</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
