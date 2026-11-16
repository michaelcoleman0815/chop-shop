import { useCallback, useMemo, useRef, type MutableRefObject } from 'react'
import { currentVersion, type EditDoc, type Note, type Op } from '../../../shared/edit'
import { ontoLatest, toldIn } from '../../../shared/vlog/build'
import { storyOnBeats } from '../../../shared/vlog/plan'
import type { VlogReply } from '../../../shared/vlog/reply'
import { parseVlogAsk, wantsVlog } from '../../../shared/vlog/request'
import { api } from './api'
import type { Attachment } from './components/Composer'
import type { Msg } from './components/Message'
import { isAudioFile, isVideoFile } from './format'
import type { PanelStatus } from './useCutalong'

/**
 * Vlogs in the session. A day of clips dropped with "make a vlog" (or /vlog)
 * is watched and told as a story in the main process (main/vlog); asks of the
 * story ("make it shorter", "start with the airport", "more of the dinner",
 * "/vlog 8 min") tell it again as a new version; the next day's clips join it;
 * a music bed put under it gets its shots landed on the beat. useCutalong
 * calls in at a few named places and keeps everything else.
 */

type Where = 'thread' | 'panel'

export interface VlogDeps {
  docRef: MutableRefObject<EditDoc | null>
  pendingCommand: MutableRefObject<string | null>
  setDoc: (next: EditDoc) => void
  setMediaUrl: (url: string | null) => void
  push: (m: Omit<Msg, 'id'>) => string
  patch: (id: string, p: Partial<Msg>) => void
  setPanel: (p: PanelStatus | null) => void
  toThread: () => void
  applyAsVersion: (
    ops: Op[],
    fallback: string,
    preset?: string,
    lead?: { text: string; ops: number }
  ) => { summary: string; n: number } | null
  during: <T>(work: () => Promise<T>) => Promise<T>
  /** The kind of video the creator makes, from their brand. */
  niche: () => string
  /** The chat's brand, by id: the names its talking is listened for with. */
  brand: () => string
}

export interface Vlogs {
  /** Whether recordings dropped with these words are a shoot for a story. */
  wanted: (said: string, command: string | null, files: Attachment[]) => boolean
  /** The vlog of these files, or these files added to the vlog or edit under way. False when it failed. */
  make: (files: Attachment[], said: string) => Promise<boolean>
  /** Words that ask for a vlog with no files: an edit becomes one, a vlog is told again, or the clips are waited for. */
  asked: (text: string) => Promise<boolean>
  /** The story told again for what was asked. Not handled when the words ask nothing a story answers. */
  retell: (text: string, where: Where, always?: boolean) => Promise<{ handled: boolean; n: number | null }>
  /** /vlog: a length or a fresh telling on a vlog, a vlog of another edit's footage, or a wait for clips. */
  command: (rest: string, where: Where) => Promise<void>
  /** A vlog's shots landed on the beats of the music under it. Asked: says why not, when it cannot. */
  onBeats: (where: Where, asked?: boolean) => void
  /** Editor notes that all ask of the story, told as one new version. The ids applied, or null when not theirs. */
  fromNotes: (notes: Note[]) => Promise<string[] | null>
}

const OPEN: NonNullable<Msg['actions']> = [{ kind: 'open-editor', label: 'Open the editor', primary: true }]

/** The reply's version number made the one committed: the edit may have moved on while it was planned. */
const renumber = (text: string, n: number): string => text.replace(/^v\d+\b/, `v${n}`)

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A story's reply as the message that shows it: a sentence or two, three facts, the scenes behind Details. */
const replyOf = (r: VlogReply, n: number): Partial<Msg> => ({
  progress: null,
  text: renumber(r.text, n),
  aside: r.aside,
  chips: r.chips,
  details: r.details,
  actions: OPEN
})

export function useVlog(deps: VlogDeps): Vlogs {
  // The session's setters change identity between renders; these calls read them as they are now.
  const live = useRef(deps)
  live.current = deps
  /** What /vlog was given before there were clips: "/vlog 8 min", then the drop. */
  const waiting = useRef('')

  const wait = useCallback((rest: string, where: Where): void => {
    const { pendingCommand, push, setPanel } = live.current
    pendingCommand.current = 'vlog'
    waiting.current = rest
    const text = "Drop the clips from your day and I'll make them into a vlog."
    if (where === 'panel') setPanel({ text })
    else push({ role: 'assistant', text })
  }, [])

  const wanted = useCallback((said: string, command: string | null, files: Attachment[]): boolean => {
    const { docRef, pendingCommand, niche } = live.current
    const recordings = files.filter((f) => isVideoFile(f.name) || isAudioFile(f.name))
    if (recordings.length === 0) return false
    // Clips, or a track to cut to, dropped into a vlog join its story.
    if (docRef.current?.vlog) return true
    const videos = recordings.filter((f) => isVideoFile(f.name)).length
    if (videos === 0) return false
    if (command === 'vlog' || pendingCommand.current === 'vlog' || wantsVlog(said)) return true
    // Someone who makes vlogs dropping a day of clips into a new chat.
    return !docRef.current && niche() === 'vlog' && videos >= 3
  }, [])

  const make = useCallback(async (files: Attachment[], said: string): Promise<boolean> => {
    const { docRef, pendingCommand, push, patch, setDoc, setMediaUrl, during, brand } = live.current
    const sent = docRef.current
    // What /vlog was given before the clips came, and what was said with them.
    const request = [pendingCommand.current === 'vlog' ? waiting.current : '', said.trim()].filter(Boolean).join('. ')
    if (pendingCommand.current === 'vlog') pendingCommand.current = null
    waiting.current = ''
    const id = push({ role: 'assistant', text: '', progress: { stage: 'Watching your clips', percent: 0 } })
    const off = api.onCutProgress((p) => patch(id, { progress: p }))
    let r: Awaited<ReturnType<typeof api.makeVlog>>
    try {
      r = await during(() => api.makeVlog({ paths: files.map((f) => f.path), request, doc: sent, brand: brand() }))
    } catch (err) {
      r = { ok: false, message: errorText(err) }
    } finally {
      off()
    }
    if (!r.ok) {
      const what = files.length === 1 ? files[0].name : files.length > 1 ? 'those clips' : 'this footage'
      patch(id, { progress: null, text: `I couldn't make a vlog of ${what}. ${r.message}`, error: true })
      return false
    }
    const latest = docRef.current
    // Another edit is open now: the vlog was of the one that was.
    if (sent && latest && latest.id !== sent.id) {
      patch(id, { progress: null, text: 'Another edit is open now, so I left the vlog out of it.', error: true })
      return false
    }
    const next = sent && latest ? ontoLatest(latest, sent, r.doc) : r.doc
    setDoc(next)
    setMediaUrl(r.mediaUrl)
    patch(id, replyOf(r.reply, currentVersion(next).n))
    return true
  }, [])

  const retell = useCallback(
    async (text: string, where: Where, always = false): Promise<{ handled: boolean; n: number | null }> => {
      const { docRef, push, patch, setPanel, setDoc, applyAsVersion, during } = live.current
      const d = docRef.current
      if (!d?.vlog || (!always && !parseVlogAsk(text))) return { handled: false, n: null }
      const stage = { stage: 'Telling the story again', percent: null }
      const id = where === 'thread' ? push({ role: 'assistant', text: '', progress: stage }) : null
      if (where === 'panel') setPanel({ text: '', progress: stage, since: Date.now() })
      const say = (m: Partial<Msg>): void => {
        if (id) patch(id, { progress: null, ...m })
        else setPanel({ text: [m.text, m.aside].filter(Boolean).join(' '), error: m.error })
      }
      let r: Awaited<ReturnType<typeof api.planVlog>>
      try {
        r = await during(() => api.planVlog({ doc: d, request: text }))
      } catch (err) {
        r = { ok: false, message: errorText(err) }
      }
      // The story is about this edit; should another be open by now, it is not applied to that one.
      if (docRef.current?.id !== d.id) return { handled: true, n: null }
      if (!r.ok) {
        say({ text: r.message, error: true })
        return { handled: true, n: null }
      }
      const done = applyAsVersion(r.ops, r.reply.summary, 'vlog', { text: r.reply.summary, ops: r.ops.length })
      if (!done) {
        // Nothing changed: what could not be found is the answer, when something could not.
        say({ text: r.reply.aside ?? 'The story already plays that way.' })
        return { handled: true, n: null }
      }
      const latest = docRef.current
      if (latest) setDoc({ ...latest, vlog: toldIn(r.vlog, done.n) })
      say(replyOf(r.reply, done.n))
      return { handled: true, n: done.n }
    },
    []
  )

  const asked = useCallback(
    async (text: string): Promise<boolean> => {
      if (!wantsVlog(text)) return false
      const d = live.current.docRef.current
      if (!d) {
        wait(text, 'thread')
        return true
      }
      if (d.vlog) return (await retell(text, 'thread', true)).handled
      await make([], text)
      return true
    },
    [make, retell, wait]
  )

  const command = useCallback(
    async (rest: string, where: Where): Promise<void> => {
      const d = live.current.docRef.current
      if (!d) {
        wait(rest, where)
        return
      }
      if (d.vlog) {
        await retell(rest, where, true)
        return
      }
      // Another edit's footage told as a story: its recordings and the footage brought into it.
      if (where === 'panel') live.current.toThread()
      await make([], rest)
    },
    [make, retell, wait]
  )

  const onBeats = useCallback((where: Where, asked = false): void => {
    const { docRef, push, setPanel, setDoc, applyAsVersion } = live.current
    const say = (text: string, open = false): void => {
      if (where === 'panel') setPanel({ text })
      else push({ role: 'assistant', text, actions: open ? OPEN : undefined })
    }
    const d = docRef.current
    if (!d?.vlog) return
    const fit = storyOnBeats(d)
    if (!fit) {
      if (asked) say('Put a music bed in first, so there are beats to cut on: /music.')
      return
    }
    const summary = 'The shots land on the music’s beats.'
    const done = applyAsVersion(fit.ops, summary, 'vlog', { text: summary, ops: fit.ops.length })
    if (!done) {
      if (asked) say('Every shot already lands on a beat, or is too far from one to move.')
      return
    }
    const latest = docRef.current
    if (latest) setDoc({ ...latest, vlog: toldIn(fit.vlog, done.n) })
    say(`v${done.n} is ready. ${summary}`, true)
  }, [])

  const fromNotes = useCallback(
    async (notes: Note[]): Promise<string[] | null> => {
      const d = live.current.docRef.current
      if (!d?.vlog || notes.length === 0 || !notes.every((n) => parseVlogAsk(n.text))) return null
      const told = await retell(notes.map((n) => n.text.trim().replace(/[.!?]+$/, '')).join('. '), 'panel')
      return told.n !== null ? notes.map((n) => n.id) : told.handled ? [] : null
    },
    [retell]
  )

  // One object for the life of the session, so the callbacks that use it keep theirs.
  return useMemo(
    () => ({ wanted, make, asked, retell, command, onBeats, fromNotes }),
    [wanted, make, asked, retell, command, onBeats, fromNotes]
  )
}
