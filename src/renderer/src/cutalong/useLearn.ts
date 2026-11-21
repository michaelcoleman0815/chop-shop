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
 * its own (shared/brands). Every call is for the brand shown when it was
 * made; a run keeps going for it, and what comes back shows only while that
 * brand is still the one shown, so one brand's habits are never offered on
 * another's page. Moving to another brand starts its page afresh.
 */
export function useLearn(
  brand: string,
  /** The sentence that says why nothing can run yet (no working Anthropic key), or null when it can. */
  blocked: (what: 'learn') => Promise<string | null> = async () => null
) {
  const [recordings, setRecordings] = useState<string[]>([])
  const [finished, setFinishedState] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  /** When the current run started, for its stopwatch. */
  const [since, setSince] = useState<number | null>(null)
  /** What has been learned, and the brand it is for. */
  const [held, setHeld] = useState<{ brand: string; state: LearnState }>({ brand, state: EMPTY_LEARN_STATE })
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  /** The brand a check is running for. */
  const [checkingFor, setCheckingFor] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(remembered)
  const busy = useRef(false)
  const shown = useRef(brand)
  shown.current = brand
  /** A state that came back for a brand, kept only while that brand is shown. */
  const take = useCallback((forBrand: string, state: LearnState): void => {
    if (shown.current === forBrand) setHeld({ brand: forBrand, state })
  }, [])
  const state = held.brand === brand ? held.state : EMPTY_LEARN_STATE

  useEffect(() => {
    let live = true
    // Another brand's page: nothing of the last one's stays on it.
    setNotes([])
    setError(null)
    setAdding(false)
    if (!busy.current) {
      setRecordings([])
      setFinishedState(null)
    }
    void api
      .learnState(brand)
      .then((s) => {
        if (live) take(brand, s)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [brand, take])

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
    const stop = await blocked('learn')
    if (stop) {
      setError(stop)
      return
    }
    busy.current = true
    setError(null)
    setNotes([])
    setProgress({ stage: 'Listening', percent: 0 })
    setSince(Date.now())
    const off = api.onLearnProgress((p) => setProgress(p))
    const forBrand = brand
    try {
      const r = await api.learnRun({ recordings, finished, brand: forBrand })
      take(forBrand, r.state)
      // What it says is about that brand's videos: said on its page, not another's.
      if (shown.current === forBrand) {
        if (r.ok) {
          setNotes(r.video.notes)
          setRecordings([])
          setFinishedState(null)
          setAdding(false)
        } else setError(r.message)
      }
    } catch (err) {
      if (shown.current === forBrand) setError(err instanceof Error ? err.message : String(err))
    } finally {
      off()
      setProgress(null)
      setSince(null)
      busy.current = false
    }
  }, [recordings, finished, brand, take, blocked])

  const checkAgain = useCallback(async (): Promise<void> => {
    const forBrand = brand
    const stop = await blocked('learn')
    if (stop) {
      setError(stop)
      return
    }
    setCheckingFor(forBrand)
    try {
      take(forBrand, await api.learnEvaluate(forBrand))
    } finally {
      setCheckingFor((c) => (c === forBrand ? null : c))
    }
  }, [brand, take, blocked])

  const forget = useCallback(
    async (id: string): Promise<void> => {
      const forBrand = brand
      take(forBrand, await api.learnForget(id, forBrand))
    },
    [brand, take]
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
    checking: checkingFor === brand,
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
