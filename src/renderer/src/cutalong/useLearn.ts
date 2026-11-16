import { useCallback, useEffect, useRef, useState } from 'react'
import { EMPTY_LEARN_STATE, type LearnState } from '../../../shared/learn/state'
import { api } from './api'
import type { Progress } from './components/Working'

/**
 * Learning from the creator's own edits: the files picked, the run in
 * progress, and what has been learned so far. Held by the session rather
 * than the brand page, so a long run carries on if the page is left.
 */

const DISMISSED_KEY = 'cutalong:habits-dismissed'

function remembered(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

/**
 * `brand` is the brand whose videos are shown: each brand learns only from
 * its own (shared/brands). A run keeps going for the brand it started for,
 * and its result shows only while that brand is still the one shown.
 */
export function useLearn(brand: string) {
  const [recordings, setRecordings] = useState<string[]>([])
  const [finished, setFinishedState] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  /** When the current run started, for its stopwatch. */
  const [since, setSince] = useState<number | null>(null)
  const [state, setState] = useState<LearnState>(EMPTY_LEARN_STATE)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [checking, setChecking] = useState(false)
  const [adding, setAdding] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(remembered)
  const busy = useRef(false)
  const shown = useRef(brand)
  shown.current = brand

  useEffect(() => {
    let live = true
    void api
      .learnState(brand)
      .then((s) => {
        if (live) setState(s)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [brand])

  const addRecordings = useCallback((paths: string[]): void => {
    setError(null)
    setRecordings((list) => [...list, ...paths.filter((p) => !list.includes(p))])
  }, [])

  const removeRecording = useCallback((path: string): void => {
    setRecordings((list) => list.filter((p) => p !== path))
  }, [])

  const setFinished = useCallback((path: string | null): void => {
    setError(null)
    setFinishedState(path)
  }, [])

  const chooseRecordings = useCallback(async (): Promise<void> => {
    const paths = await api.learnChoose('recordings')
    if (paths.length) addRecordings(paths)
  }, [addRecordings])

  const chooseFinished = useCallback(async (): Promise<void> => {
    const [path] = await api.learnChoose('finished')
    if (path) setFinished(path)
  }, [setFinished])

  const run = useCallback(async (): Promise<void> => {
    if (busy.current || recordings.length === 0 || !finished) return
    busy.current = true
    setError(null)
    setNotes([])
    setProgress({ stage: 'Listening', percent: 0 })
    setSince(Date.now())
    const off = api.onLearnProgress((p) => setProgress(p))
    try {
      const forBrand = brand
      const r = await api.learnRun({ recordings, finished, brand: forBrand })
      if (shown.current === forBrand) setState(r.state)
      if (r.ok) {
        setNotes(r.video.notes)
        setRecordings([])
        setFinishedState(null)
        setAdding(false)
      } else setError(r.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      off()
      setProgress(null)
      setSince(null)
      busy.current = false
    }
  }, [recordings, finished, brand])

  const checkAgain = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      setState(await api.learnEvaluate(brand))
    } finally {
      setChecking(false)
    }
  }, [brand])

  const forget = useCallback(
    async (id: string): Promise<void> => {
      setState(await api.learnForget(id, brand))
    },
    [brand]
  )

  /** Not now: this proposal stays hidden until learning comes up with a different one. */
  const dismiss = useCallback((key: string): void => {
    setDismissed(key)
    try {
      localStorage.setItem(DISMISSED_KEY, key)
    } catch {
      // Remembering is a convenience; without storage it shows again next time.
    }
  }, [])

  return {
    recordings,
    finished,
    progress,
    since,
    state,
    error,
    notes,
    checking,
    adding,
    setAdding,
    dismissed,
    dismiss,
    addRecordings,
    removeRecording,
    setFinished,
    chooseRecordings,
    chooseFinished,
    run,
    checkAgain,
    forget
  }
}

export type Learn = ReturnType<typeof useLearn>
