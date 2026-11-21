import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CAPTION_PRESETS } from '../../../../shared/caption-presets'
import { currentCut, resolveCut, type CaptionSpec, type EditDoc, type Op } from '../../../../shared/edit'
import { designSize } from '../../../../shared/motion'
import { captionStyleFor, type SubtitleCue } from '../../../../shared/subtitles'
import type { CaptionStyle } from '../../../../shared/types'
import {
  alwaysCapitals,
  captionCueAt,
  captionsOp,
  describeCaptions,
  sameCaptions,
  wordChoices,
  type CaptionPick
} from '../sheets'
import { Sheet } from './Sheet'
import { Subtitles } from './Subtitles'
import { Button } from './ui'

type Tab = 'look' | 'where' | 'words'

const TABS: { id: Tab; label: string }[] = [
  { id: 'look', label: 'Look' },
  { id: 'where', label: 'Where' },
  { id: 'words', label: 'Words' }
]

const PLACES: { id: CaptionSpec['position']; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'middle', label: 'Middle' },
  { id: 'chest', label: 'Chest' },
  { id: 'bottom', label: 'Bottom' }
]

/**
 * Captions in the person's own words: each choice is a card of the still at
 * the playhead with the caption the export would burn over it, drawn by the
 * editor's own Subtitles at the export's size and scaled down. Look, Where
 * and Words are tabs; the card ringed in ink is the pick and "Now" marks what
 * the edit has. The foot says the pick in a few words, and "Use these
 * captions" hands back the captions op, which turns them on as well.
 */
export function CaptionSheet({
  doc,
  atSec,
  still,
  colors,
  onUse,
  onClose
}: {
  doc: EditDoc
  /** The playhead, in output seconds: whose words the cards show. */
  atSec: number
  /** The picture at the playhead, as an image address; null draws the cards on the stage alone. */
  still: string | null
  /** The brand's caption colours, where the export uses them (as the editor's preview passes them). */
  colors: { text: string; accent: string } | null
  onUse: (op: Op) => void
  onClose: () => void
}): JSX.Element {
  const cut = useMemo(() => currentCut(doc), [doc])
  const resolved = useMemo(() => resolveCut(cut, doc.words, doc.sources), [cut, doc.words, doc.sources])
  const spec = cut.captions
  const frame = useMemo(
    () => designSize(cut.aspect, doc.sources[0] ?? { width: 1080, height: 1920 }),
    [cut.aspect, doc.sources]
  )
  const [tab, setTab] = useState<Tab>('look')
  const [pick, setPick] = useState<CaptionPick>(() => ({
    preset: spec.preset,
    position: spec.position,
    wordsPerScreen: spec.wordsPerScreen,
    uppercase: spec.uppercase
  }))

  // The words on the cards, grouped as each card would group them.
  const cueFor = useMemo(() => {
    const cache = new Map<number, SubtitleCue | null>()
    return (perScreen: number): SubtitleCue | null => {
      if (!cache.has(perScreen)) cache.set(perScreen, captionCueAt(cut, resolved, perScreen, atSec))
      return cache.get(perScreen) ?? null
    }
  }, [cut, resolved, atSec])
  const captioned = cueFor(pick.wordsPerScreen) !== null

  const cards: {
    key: string
    label: string
    pick: CaptionPick
    now: boolean
  }[] =
    tab === 'look'
      ? CAPTION_PRESETS.map((p) => ({
          key: p.id,
          label: p.name,
          pick: { ...pick, preset: p.id },
          now: spec.on && spec.preset === p.id
        }))
      : tab === 'where'
        ? PLACES.map((p) => ({
            key: p.id,
            label: p.label,
            pick: { ...pick, position: p.id },
            now: spec.on && spec.position === p.id
          }))
        : wordChoices(spec.wordsPerScreen).map((n) => ({
            key: String(n),
            label: `${n} ${n === 1 ? 'word' : 'words'}`,
            pick: { ...pick, wordsPerScreen: n },
            now: spec.on && spec.wordsPerScreen === n
          }))

  const capsFixed = alwaysCapitals(pick.preset)
  const same = sameCaptions(spec, pick)
  const shape = frame.width / Math.max(1, frame.height)

  return (
    <Sheet
      label="Captions"
      title="Captions"
      className="wide cl-capsheet"
      onClose={onClose}
      foot={
        <>
          <span className="cl-capsheet-sum" aria-live="polite">
            {describeCaptions(pick)}
          </span>
          <Button variant="primary" disabled={same} onClick={() => onUse(captionsOp(pick))}>
            {spec.on ? 'Use these captions' : 'Turn captions on'}
          </Button>
        </>
      }
    >
      <div className="cl-segments cl-capsheet-tabs" role="tablist" aria-label="What to change">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`cl-captab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="cl-capsheet-panel"
            className={tab === t.id ? 'on' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id="cl-capsheet-panel" role="tabpanel" aria-labelledby={`cl-captab-${tab}`} className="cl-capsheet-panel">
        {!captioned && (
          <p className="cl-capsheet-note">Every beat has its captions off, so there are no words to show on these.</p>
        )}
        <ul
          className={`cl-capgrid ${shape < 0.85 ? 'tall' : shape > 1.2 ? 'across' : 'even'}`}
          aria-label={tab === 'look' ? 'Looks' : tab === 'where' ? 'Places' : 'Words a screen'}
        >
          {cards.map((c) => (
            <li key={`${tab}-${c.key}`}>
              <CaptionCard
                label={c.label}
                now={c.now}
                on={sameCard(c.pick, pick, tab)}
                still={still}
                cue={cueFor(c.pick.wordsPerScreen)}
                style={captionStyleFor({ ...spec, ...c.pick, on: true }, frame.width, colors)}
                frame={frame}
                onPick={() => setPick(c.pick)}
              />
            </li>
          ))}
        </ul>
        {tab === 'words' && (
          <div className="cl-capsheet-caps">
            <span className="cl-capsheet-caps-label" id="cl-capsheet-caps">
              Capitals
            </span>
            <div className="cl-segments" role="group" aria-labelledby="cl-capsheet-caps">
              <button
                type="button"
                className={!pick.uppercase && !capsFixed ? 'on' : ''}
                aria-pressed={!pick.uppercase && !capsFixed}
                disabled={capsFixed}
                onClick={() => setPick((p) => ({ ...p, uppercase: false }))}
              >
                As said
              </button>
              <button
                type="button"
                className={pick.uppercase || capsFixed ? 'on' : ''}
                aria-pressed={pick.uppercase || capsFixed}
                disabled={capsFixed}
                onClick={() => setPick((p) => ({ ...p, uppercase: true }))}
              >
                All capitals
              </button>
            </div>
            {capsFixed && (
              <span className="cl-capsheet-caps-hint">
                {CAPTION_PRESETS.find((p) => p.id === pick.preset)?.name ?? 'This look'} is always in capitals.
              </span>
            )}
          </div>
        )}
      </div>
    </Sheet>
  )
}

/** True when a card is the pick: only what its tab changes is compared, so the rest of the pick carries over. */
function sameCard(card: CaptionPick, pick: CaptionPick, tab: Tab): boolean {
  if (tab === 'look') return card.preset === pick.preset
  if (tab === 'where') return card.position === pick.position
  return card.wordsPerScreen === pick.wordsPerScreen
}

/** One choice: the still with its caption over it, as the export would burn it, and its name under. */
function CaptionCard({
  label,
  now,
  on,
  still,
  cue,
  style,
  frame,
  onPick
}: {
  label: string
  now: boolean
  on: boolean
  still: string | null
  cue: SubtitleCue | null
  style: CaptionStyle
  frame: { width: number; height: number }
  onPick: () => void
}): JSX.Element {
  const box = useRef<HTMLSpanElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = (): void => setSize({ w: el.clientWidth, h: el.clientHeight })
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <button
      type="button"
      className={`cl-capcard${on ? ' on' : ''}`}
      aria-pressed={on}
      aria-label={now ? `${label}, now` : label}
      onClick={onPick}
    >
      <span ref={box} className="cl-capcard-frame" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
        {still && <img src={still} alt="" draggable={false} />}
        <Subtitles cue={cue} style={style} frame={frame} time={cue?.start ?? 0} width={size.w} height={size.h} />
      </span>
      <span className="cl-capcard-label" aria-hidden="true">
        <span className="cl-capcard-name">{label}</span>
        {now && <span className="cl-capcard-now">Now</span>}
      </span>
    </button>
  )
}
