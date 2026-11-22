import { useEffect, useMemo, useRef, useState } from 'react'
import {
  currentCut,
  resolveCut,
  SFX_INFO,
  SFX_KINDS,
  type EditDoc,
  type Op,
  type SfxKind
} from '../../../../shared/edit'
import { api, device, mediaUrlFor } from '../api'
import { clock, fileName, seconds } from '../format'
import { bareWord, kindName, landingSec, soundOp, wordInCut, type SoundPick, type WordInCut } from '../sheets'
import { Sheet } from './Sheet'
import { Button, Icon } from './ui'

/**
 * A sound on one word: the six built in, then the person's own from their
 * sound folders or a file they choose, each with a button to hear it. The
 * foot says where the picked sound lands, worked out as the export works it
 * out, and "Add it" hands back the op /sfx would make. It stays open after,
 * so whoever opened it decides what comes next.
 */
export function SoundSheet({
  doc,
  wordId,
  onAdd,
  onClose
}: {
  doc: EditDoc
  /** The word the sound goes on. */
  wordId: string
  /** The sfx op that adds the sound to the word's beat. */
  onAdd: (op: Op) => void
  onClose: () => void
}): JSX.Element {
  const resolved = useMemo(() => resolveCut(currentCut(doc), doc.words, doc.sources), [doc])
  const place = useMemo(() => wordInCut(resolved, wordId), [resolved, wordId])
  const said = doc.words.find((w) => w.id === wordId)?.text ?? ''
  const word = bareWord(said)

  const [pick, setPick] = useState<SoundPick>({ kind: 'pop' })
  const built = useBuiltSounds()
  const own = useOwnSounds()
  const facts = useSoundFacts()
  const hear = usePreview()

  const pickFile = (s: { path: string; name: string }): void => {
    setPick({ path: s.path, name: s.name })
    facts.read(s.path)
  }
  const choose = async (): Promise<void> => {
    const path = await api.chooseAudio()
    if (!path) return
    const s = { path, name: fileName(path).replace(/\.[^.]+$/, '') }
    own.add(s)
    pickFile(s)
  }

  // The pick as the edit takes it: a file once what it is has been read.
  const read = 'path' in pick ? facts.of[pick.path] : undefined
  const ready: SoundPick | null =
    'kind' in pick
      ? pick
      : read && typeof read === 'object' && 'leadSec' in read
        ? { ...pick, leadSec: read.leadSec, peakDb: read.peakDb }
        : null
  const lands = place && ready ? landingSec(ready, place, resolved) : null

  return (
    <Sheet
      label={word ? `A sound on ${word}` : 'A sound'}
      title={word ? `A sound on “${word}”` : 'A sound'}
      className="cl-sound"
      onClose={onClose}
      foot={
        <>
          <span className="cl-sound-lands" aria-live="polite">
            {place && lands !== null ? landsLine(lands, place, word) : ''}
          </span>
          <Button
            variant="primary"
            disabled={!place || !ready || lands === null}
            onClick={() => ready && place && onAdd(soundOp(ready, place))}
          >
            Add it
          </Button>
        </>
      }
    >
      {place ? (
        <p className="cl-sound-where">
          Beat {place.beatNumber}, at {clock(place.outStart)}.
        </p>
      ) : (
        <p className="cl-field-msg error">
          <Icon.alert />
          <span>
            {said
              ? `“${word}” is cut from this version, so a sound on it would not play. Bring the word back first.`
              : 'That word is not in this edit any more.'}
          </span>
        </p>
      )}

      <section className="cl-sound-group" aria-labelledby="cl-sound-built">
        <h3 id="cl-sound-built" className="cl-sound-h">
          Built in
        </h3>
        <ul className="cl-sound-list">
          {SFX_KINDS.map((kind) => (
            <SoundRow
              key={kind}
              name={kindName(kind)}
              about={builtAbout(kind, place)}
              on={'kind' in pick && pick.kind === kind}
              onPick={() => setPick({ kind })}
              url={built.files?.[kind] ? mediaUrlFor(built.files[kind]) : null}
              hear={hear}
            />
          ))}
        </ul>
        {built.message && <p className="cl-sound-note">{built.message}</p>}
      </section>

      <section className="cl-sound-group" aria-labelledby="cl-sound-own">
        <h3 id="cl-sound-own" className="cl-sound-h">
          Your sounds
        </h3>
        <div className="cl-sound-search">
          <label className="cl-field">
            <span className="sr-only">Search your sound folders</span>
            <input
              type="search"
              value={own.query}
              placeholder="Search your sound folders"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => own.setQuery(e.target.value)}
            />
          </label>
          <Button small onClick={() => void choose()}>
            {device.kind === 'phone' ? 'Choose a file' : 'Choose a file…'}
          </Button>
        </div>
        {own.list.length > 0 ? (
          <ul className="cl-sound-list">
            {own.list.map((s) => {
              const r = facts.of[s.path]
              return (
                <SoundRow
                  key={s.path}
                  name={s.name}
                  about={
                    r === 'reading'
                      ? 'Reading it…'
                      : r && typeof r === 'object' && 'leadSec' in r
                        ? `${seconds(r.durationSec)}, on the word`
                        : 'On the word'
                  }
                  error={r && typeof r === 'object' && 'message' in r ? r.message : undefined}
                  on={'path' in pick && pick.path === s.path}
                  onPick={() => pickFile(s)}
                  url={mediaUrlFor(s.path)}
                  hear={hear}
                />
              )
            })}
          </ul>
        ) : (
          own.searched && (
            <p className="cl-sound-note">
              {own.query.trim()
                ? `No sound called “${own.query.trim()}” in your sound folders.`
                : 'Your sound folders have no sounds in them yet. Choose a file to use one of your own.'}
            </p>
          )
        )}
      </section>
    </Sheet>
  )
}

/** One sound: a button to hear it, and the sound itself to pick. */
function SoundRow({
  name,
  about,
  error,
  on,
  onPick,
  url,
  hear
}: {
  name: string
  about: string
  error?: string
  on: boolean
  onPick: () => void
  /** Where to hear it; null while that is not known. */
  url: string | null
  hear: Preview
}): JSX.Element {
  const playing = url !== null && hear.playing === url
  return (
    <li className="cl-sound-row">
      <button
        type="button"
        className="cl-sound-play"
        aria-label={playing ? `Stop ${name}` : `Play ${name}`}
        disabled={url === null}
        onClick={() => url && hear.toggle(url)}
      >
        {playing ? <Icon.pause /> : <Icon.play />}
      </button>
      <button type="button" className={`cl-sound-pick${on ? ' on' : ''}`} aria-pressed={on} onClick={onPick}>
        <span className="cl-sound-name">{name}</span>
        <span className={`cl-sound-about${error ? ' error' : ''}`}>{error ?? about}</span>
      </button>
    </li>
  )
}

/** Where the cut into a beat is, in words. */
function cutInto(n: number): string {
  return n === 1 ? 'the start' : `the cut into beat ${n}`
}

/** What a built-in sound does and where it sits: "0.7 s, peaks on the cut into beat 2". */
function builtAbout(kind: SfxKind, place: WordInCut | null): string {
  const info = SFX_INFO[kind]
  const len = seconds(info.sec)
  if (info.onWord) return `${len}, on the word`
  const into = place ? cutInto(place.beatNumber) : 'the cut into its beat'
  if (info.lands === 'peak') return `${len}, peaks on ${into}`
  if (info.lands === 'end') return `${len}, rises into ${into}`
  return `${len}, on ${into}`
}

/** Where the picked sound lands, against the word: "On “settings”, at 0:04", "0.4 s before “settings”, at 0:03". */
function landsLine(at: number, place: WordInCut, word: string): string {
  const quoted = word ? `“${word}”` : 'the word'
  const gap = place.outStart - at
  if (Math.abs(gap) < 0.02) return `On ${quoted}, at ${clock(at)}`
  return `${seconds(Math.abs(gap))} ${gap > 0 ? 'before' : 'after'} ${quoted}, at ${clock(at)}`
}

/** The six built-in sounds' files, made on first use (main/sfx), so they can be heard here. */
function useBuiltSounds(): {
  files: Record<string, string> | null
  message: string | null
} {
  const [state, setState] = useState<{
    files: Record<string, string> | null
    message: string | null
  }>({
    files: null,
    message: null
  })
  useEffect(() => {
    let live = true
    api
      .sfxFiles()
      .then((r) => live && setState(r.ok ? { files: r.files, message: null } : { files: null, message: r.message }))
      .catch(
        () =>
          live &&
          setState({
            files: null,
            message: 'I could not make the built-in sounds to play here.'
          })
      )
    return () => {
      live = false
    }
  }, [])
  return state
}

/**
 * The person's own sounds: some from their sound folders when the sheet
 * opens (an empty search matches any), what a search finds as it is typed,
 * and any file chosen here, first.
 */
function useOwnSounds(): {
  query: string
  setQuery: (q: string) => void
  list: { path: string; name: string }[]
  searched: boolean
  add: (s: { path: string; name: string }) => void
} {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ path: string; name: string }[]>([])
  const [searched, setSearched] = useState(false)
  const [chosen, setChosen] = useState<{ path: string; name: string }[]>([])
  useEffect(() => {
    let live = true
    const t = window.setTimeout(
      () => {
        api
          .findSounds(query.trim())
          .then((r) => {
            if (!live) return
            setFound(r)
            setSearched(true)
          })
          .catch(() => {
            if (!live) return
            setFound([])
            setSearched(true)
          })
      },
      query ? 200 : 0
    )
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [query])
  const list = [...chosen, ...found.filter((f) => !chosen.some((c) => c.path === f.path))]
  const add = (s: { path: string; name: string }): void => setChosen((c) => [s, ...c.filter((x) => x.path !== s.path)])
  return { query, setQuery, list, searched, add }
}

type Facts = { leadSec: number; peakDb: number; durationSec: number } | { message: string } | 'reading'

/** What reading each file found (its lead-in silence, peak and length), read once a file, when it is picked. */
function useSoundFacts(): {
  of: Record<string, Facts | undefined>
  read: (path: string) => void
} {
  const [of, setOf] = useState<Record<string, Facts | undefined>>({})
  const asked = useRef(new Set<string>())
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const read = (path: string): void => {
    if (asked.current.has(path)) return
    asked.current.add(path)
    setOf((o) => ({ ...o, [path]: 'reading' }))
    api
      .readSound(path)
      .then((r) => {
        if (!live.current) return
        setOf((o) => ({
          ...o,
          [path]: r.ok
            ? {
                leadSec: r.leadSec,
                peakDb: r.peakDb,
                durationSec: r.durationSec
              }
            : { message: r.message }
        }))
      })
      .catch(() => {
        if (!live.current) return
        setOf((o) => ({
          ...o,
          [path]: { message: 'I could not read that file as a sound.' }
        }))
      })
  }
  return { of, read }
}

interface Preview {
  /** The address playing now, if any. */
  playing: string | null
  toggle: (url: string) => void
}

/** One sound heard at a time: playing another stops the first, and closing the sheet stops it. */
function usePreview(): Preview {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  useEffect(
    () => () => {
      audio.current?.pause()
      audio.current = null
    },
    []
  )
  const toggle = (url: string): void => {
    const el = audio.current ?? (audio.current = new Audio())
    if (playing === url) {
      el.pause()
      setPlaying(null)
      return
    }
    el.pause()
    el.src = url
    el.currentTime = 0
    el.onended = () => setPlaying(null)
    el.onerror = () => setPlaying(null)
    setPlaying(url)
    void el.play().catch(() => setPlaying(null))
  }
  return { playing, toggle }
}
