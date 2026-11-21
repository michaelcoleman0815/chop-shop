import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { currentCut, type EditDoc, type Op, type Resolved } from '../../../../shared/edit'
import { toggleLabel, toggleOps, trackWords } from '../word-track'
import { PickTools } from './PickTools'

/** How long a finger rests on a word before it marks it rather than jumping to it. */
const HOLD_MS = 450
/** After a finger or a wheel moves the track, it stops following the playhead for this long. */
const LEAVE_BE_MS = 2500

/**
 * The words of the edit as a row of chips over the beat strip, on a phone
 * (or a narrow window), where the script is too far away to edit by.
 * Tap a word to jump to it; hold one (or Shift-click it) to mark it, then
 * tap more; one button cuts the marked words or brings struck ones back.
 * Struck words stay in the row, crossed out in coral, so the cut reads as
 * the transcript does. The row follows the playhead unless it was just moved.
 */
export function WordTrack({
  doc,
  resolved,
  time,
  onSeek,
  onApply,
  onSound,
  onNote
}: {
  doc: EditDoc
  resolved: Resolved
  time: number
  onSeek: (sec: number) => void
  onApply: (ops: Op[], fallback: string) => void
  onSound?: (wordId: string) => void
  onNote?: (text: string, range: { from: string; to: string }) => void
}): JSX.Element | null {
  // Keyed on the cut, not the doc: a note written or a save made leaves the words, and the marks, alone.
  const cut = currentCut(doc)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const words = useMemo(() => trackWords(doc), [cut, doc.words])
  const timing = useMemo(() => new Map(resolved.words.map((w) => [w.id, w])), [resolved])
  const [marked, setMarked] = useState<Set<string>>(new Set())
  // A new version, or another one shown, is a new set of words to mark.
  useEffect(() => setMarked(new Set()), [cut])

  const track = useRef<HTMLDivElement>(null)
  const moved = useRef(0)
  const hold = useRef<{ id: string; timer: number; held: boolean } | null>(null)
  const followed = useRef<string | null>(null)

  const toggle = (id: string): void =>
    setMarked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const down = (id: string) => (e: PointerEvent): void => {
    if (e.button !== 0) return
    const state = { id, timer: 0, held: false }
    state.timer = window.setTimeout(() => {
      state.held = true
      toggle(id)
    }, HOLD_MS)
    hold.current = state
  }
  const up = (): void => {
    if (hold.current) window.clearTimeout(hold.current.timer)
  }
  const click = (id: string, shift: boolean): void => {
    // Only a hold on this very word swallows its click: a key pressed later is a tap.
    const held = hold.current?.id === id && hold.current.held
    hold.current = null
    if (held) return
    const at = timing.get(id)
    // Marking has begun, or the word is struck and has no time to jump to: tapping marks.
    if (shift || marked.size > 0 || !at) toggle(id)
    else onSeek(at.outStart)
  }

  const chips = useMemo(
    () =>
      words.map((w, i) => (
        <button
          key={w.id}
          type="button"
          data-w={w.id}
          className={`cl-wchip${w.struck ? ' struck' : ''}${marked.has(w.id) ? ' marked' : ''}${i > 0 && words[i - 1].beat !== w.beat ? ' beat-start' : ''}`}
          aria-pressed={marked.size > 0 ? marked.has(w.id) : undefined}
          onPointerDown={down(w.id)}
          onPointerUp={up}
          onPointerLeave={up}
          onPointerCancel={up}
          onContextMenu={(e) => e.preventDefault()}
          onClick={(e) => click(w.id, e.shiftKey || e.metaKey)}
        >
          {w.text}
          {w.struck && <span className="sr-only">, cut</span>}
        </button>
      )),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [words, marked, timing, onSeek]
  )

  // The playing word: ringed, and kept in view. Done on the chips themselves,
  // so a long recording's thousands of words are not drawn again each frame.
  const nowId = resolved.words.find((w) => time >= w.outStart && time < w.outEnd)?.id ?? null
  useEffect(() => {
    const box = track.current
    if (!box) return
    box.querySelector('.cl-wchip.now')?.classList.remove('now')
    if (!nowId) return
    const el = box.querySelector<HTMLElement>(`[data-w="${CSS.escape(nowId)}"]`)
    if (!el) return
    el.classList.add('now')
    // Follow only when the playing word changes, not when marks are drawn again (Cut, Clear).
    if (followed.current === nowId) return
    followed.current = nowId
    if (Date.now() - moved.current < LEAVE_BE_MS) return
    const left = el.offsetLeft - box.clientWidth / 2 + el.offsetWidth / 2
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    box.scrollTo({ left, behavior: calm ? 'auto' : 'smooth' })
  }, [nowId, chips])

  if (words.length === 0) return null
  return (
    <section className="cl-wordtrack" aria-label="Words. Tap one to jump to it, hold one to mark it.">
      <div
        ref={track}
        className="cl-wordtrack-words"
        onPointerDown={() => (moved.current = Date.now())}
        onWheel={() => (moved.current = Date.now())}
      >
        {chips}
      </div>
      {marked.size > 0 && (
        <PickTools
          doc={doc}
          resolved={resolved}
          marked={marked}
          onApply={onApply}
          onSound={onSound}
          onNote={onNote}
          onClear={() => setMarked(new Set())}
        />
      )}
    </section>
  )
}
