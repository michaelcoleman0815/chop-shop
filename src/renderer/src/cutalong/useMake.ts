import { useCallback, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { addAsset, currentVersion, type EditDoc, type Op } from '../../../shared/edit'
import { asNewVersion } from '../../../shared/make/assemble'
import { wantsMake } from '../../../shared/make/brief'
import type { Change, Draft, Reply, ShotChange } from '../../../shared/make/draft'
import { dollars } from '../../../shared/make/quote'
import { api } from './api'
import type { Attachment } from './components/Composer'
import type { Action, Msg } from './components/Message'
import { isAudioFile, isVideoFile } from './format'

/**
 * Videos made from nothing, in the session. "make a 2 minute cinematic
 * documentary about the 1950s oil boom" (or /make, /documentary,
 * /explainer) is read and quoted in the main process (main/make); the quote
 * is a reply with one button, and nothing is spent until it is pressed,
 * unless Settings says to go ahead under an amount and the video costs less.
 * What is said while a quote waits changes it ("make it 3 minutes"). Asks
 * of a made video that make something again ("make shot 4 a close-up of his
 * hands", "use a different voice", "make it an explainer instead") are
 * quoted the same way and land as new versions. useCutalong calls in at a
 * few named places and keeps everything else.
 */

export interface MakeDeps {
  docRef: MutableRefObject<EditDoc | null>
  setDoc: (next: EditDoc) => void
  setMediaUrl: (url: string | null) => void
  push: (m: Omit<Msg, 'id'>) => string
  patch: (id: string, p: Partial<Msg>) => void
  applyAsVersion: (
    ops: Op[],
    fallback: string,
    preset?: string,
    lead?: { text: string; ops: number }
  ) => { summary: string; n: number } | null
  during: <T>(work: () => Promise<T>) => Promise<T>
  /** The B-roll finder (useCutalong), for a shot swapped for real footage. */
  findBroll: (query: string, beat?: string) => Promise<void>
  /** The chat's brand, by id: its voice writes the script. */
  brand: () => string
}

export interface Makes {
  /** A message that asks for a made video, changes a quote waiting, or brings the recording waited for. */
  handle: (text: string, command: { command: string; rest: string } | null, files: Attachment[]) => Promise<boolean>
  /** An ask of a made video that makes something again; false when it is an ordinary edit. */
  asked: (text: string, onScreen?: string | null) => Promise<boolean>
  onAction: (a: Action) => Promise<void>
  /** A quote's draft, for the outline and the script under its reply. */
  draft: (id: string) => Draft | null
  /** The script edited under a quote: read again and quoted again. */
  editScript: (id: string, script: string) => Promise<void>
  /** Whether a quote's script is open under it. */
  scriptOpen: (id: string) => boolean
}

const OPEN: NonNullable<Msg['actions']> = [{ kind: 'open-editor', label: 'Open the editor', primary: true }]

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const MAKE_COMMANDS = new Set(['make', 'documentary', 'explainer'])

/** A reply as the message that shows it. */
const shown = (r: Reply): Partial<Msg> => ({
  progress: null,
  text: r.text,
  aside: r.aside,
  chips: r.chips,
  details: r.details
})

/** The reply's version number made the one committed. */
const renumber = (text: string, n: number): string => text.replace(/^v\d+\b/, `v${n}`)

export function useMake(deps: MakeDeps): Makes {
  const live = useRef(deps)
  live.current = deps
  const drafts = useRef(new Map<string, Draft>())
  const changes = useRef(new Map<string, ShotChange>())
  /** The quote waiting for its button, and the message that shows it. */
  const pending = useRef<{ id: string; msg: string } | null>(null)
  /** A voice-over asked for and not dropped yet. */
  const waitingRecording = useRef(false)
  /** The quote whose script is open under it, and the message that shows it. */
  const [openScript, setOpenScript] = useState<string | null>(null)
  const scriptMsg = useRef<string | null>(null)
  const [, setVersion] = useState(0)

  const keep = useCallback((draft: Draft): void => {
    drafts.current.set(draft.id + (draft.into ? ':into' : ''), draft)
    setVersion((n) => n + 1)
  }, [])

  const keyOf = (draft: Draft): string => draft.id + (draft.into ? ':into' : '')

  /** The quote's message: its sentence, three facts, the lines behind Details, the one button, and the script behind another. */
  const quoteMsg = useCallback((draft: Draft, reply: Reply, scriptShown = false): Partial<Msg> => {
    const q = draft.quote
    const id = keyOf(draft)
    const actions: NonNullable<Msg['actions']> = q.missing.length
      ? [{ kind: 'open-settings', label: 'Open Settings', primary: true }]
      : [
          {
            kind: 'make',
            label: `Make it for ${dollars(q.total)}`,
            primary: true,
            payload: JSON.stringify({ do: 'go', id })
          }
        ]
    if (draft.script.trim())
      actions.push({
        kind: 'make',
        label: scriptShown ? 'Hide the script' : 'Edit the script',
        payload: JSON.stringify({ do: 'script', id })
      })
    return { ...shown(reply), actions, make: id }
  }, [])

  /** A made video in the session: a new edit, or a new version of the one it was made from. */
  const land = useCallback(
    (
      r: {
        doc: EditDoc
        mediaUrl: string
        reply: Reply
        into: Draft['into'] | null
      },
      msg: string
    ): void => {
      const { docRef, setDoc, setMediaUrl, patch } = live.current
      const latest = docRef.current
      if (r.into) {
        if (!latest || latest.id !== r.into.docId) {
          patch(msg, {
            progress: null,
            text: 'Another edit is open now, so I left it out of that one.',
            error: true
          })
          return
        }
        const next = asNewVersion(latest, r.doc, r.into.summary, r.into.carry)
        setDoc(next)
        const n = currentVersion(next).n
        patch(msg, {
          ...shown(r.reply),
          text: renumber(r.reply.text, n),
          actions: OPEN
        })
        return
      }
      setDoc(r.doc)
      setMediaUrl(r.mediaUrl)
      patch(msg, { ...shown(r.reply), actions: OPEN })
    },
    []
  )

  /** Makes a confirmed draft. */
  const go = useCallback(
    async (key: string): Promise<void> => {
      const { push, patch, during } = live.current
      const draft = drafts.current.get(key)
      if (!draft) {
        push({
          role: 'assistant',
          text: 'That quote is from before Cutalong restarted. Ask again and I’ll quote it fresh.'
        })
        return
      }
      if (pending.current?.id === key) {
        patch(pending.current.msg, { actions: [] })
        pending.current = null
      }
      const msg = push({
        role: 'assistant',
        text: '',
        progress: { stage: 'Starting', percent: null }
      })
      const off = api.onCutProgress((p) => patch(msg, { progress: p }))
      let r: Awaited<ReturnType<typeof api.makeGo>>
      try {
        r = await during(() => api.makeGo({ draft, confirmed: draft.quote.total }))
      } catch (err) {
        r = { ok: false, message: errorText(err) }
      } finally {
        off()
      }
      if (!r.ok) {
        // A new price is a new quote, with its own button.
        if (r.draft && r.reply) {
          keep(r.draft)
          pending.current = { id: keyOf(r.draft), msg }
          patch(msg, { ...quoteMsg(r.draft, r.reply), text: r.message })
        } else patch(msg, { progress: null, text: r.message, error: true })
        return
      }
      drafts.current.delete(key)
      land(r, msg)
    },
    [keep, land, quoteMsg]
  )

  const quote = useCallback(
    async (msg: string, draft: Draft, reply: Reply): Promise<void> => {
      keep(draft)
      pending.current = { id: keyOf(draft), msg }
      live.current.patch(msg, quoteMsg(draft, reply))
    },
    [keep, quoteMsg]
  )

  /** A prompt read and quoted, or made straight away under the amount in Settings. */
  const start = useCallback(
    async (text: string, recording: string | null): Promise<void> => {
      const { push, patch, during } = live.current
      const msg = push({
        role: 'assistant',
        text: '',
        progress: { stage: 'Reading what you asked for', percent: null }
      })
      const off = api.onCutProgress((p) => patch(msg, { progress: p }))
      let r: Awaited<ReturnType<typeof api.makeStart>>
      try {
        r = await during(() => api.makeStart({ text, recording, brand: live.current.brand() }))
      } catch (err) {
        r = { ok: false, message: errorText(err) }
      } finally {
        off()
      }
      if (!r.ok) {
        patch(msg, { progress: null, text: r.message, error: true })
        return
      }
      if (r.kind === 'quote') {
        await quote(msg, r.draft, r.reply)
        return
      }
      land(r, msg)
    },
    [land, quote]
  )

  /** One shot made again for its confirmed quote, as a new version. */
  const reshoot = useCallback(async (key: string, quoted?: string): Promise<void> => {
    const { docRef, push, patch, setDoc, applyAsVersion, during } = live.current
    const change = changes.current.get(key)
    const d = docRef.current
    if (!change || !d?.make) {
      push({
        role: 'assistant',
        text: 'That quote is from before Cutalong restarted. Ask again and I’ll quote it fresh.'
      })
      return
    }
    if (quoted) patch(quoted, { actions: [] })
    const msg = push({
      role: 'assistant',
      text: '',
      progress: { stage: 'Making the shot again', percent: null }
    })
    const off = api.onCutProgress((p) => patch(msg, { progress: p }))
    let r: Awaited<ReturnType<typeof api.makeShot>>
    try {
      r = await during(() => api.makeShot({ doc: d, change, confirmed: change.total }))
    } catch (err) {
      r = { ok: false, message: errorText(err) }
    } finally {
      off()
    }
    changes.current.delete(key)
    if (!r.ok) {
      patch(msg, { progress: null, text: r.message, error: true })
      return
    }
    const latest = docRef.current
    if (!latest || latest.id !== d.id) {
      patch(msg, {
        progress: null,
        text: 'Another edit is open now, so I left the shot out of it.',
        error: true
      })
      return
    }
    // The new picture joins the material, the beat shows it as a new version, and the record says so.
    setDoc(addAsset(latest, r.asset).doc)
    const done = applyAsVersion(r.ops, r.summary, undefined, {
      text: r.summary,
      ops: r.ops.length
    })
    const after = docRef.current
    if (after) setDoc({ ...after, make: r.make })
    patch(msg, {
      ...shown(r.reply),
      text: done ? `v${done.n} is ready. ${r.reply.text}` : r.reply.text,
      actions: OPEN
    })
  }, [])

  /** What a change of a made video costs, shown, or done straight away when it costs nothing or is under the amount. */
  const offer = useCallback(
    async (change: Change, msg: string): Promise<void> => {
      const { patch, findBroll, docRef } = live.current
      if (change.kind === 'say') {
        patch(msg, shown(change.reply))
        return
      }
      if (change.kind === 'record') {
        waitingRecording.current = true
        patch(msg, shown(change.reply))
        return
      }
      if (change.kind === 'broll') {
        patch(msg, {
          progress: null,
          text: 'Real footage costs nothing to look for.'
        })
        await findBroll(change.search, change.beat)
        return
      }
      if (change.kind === 'draft') {
        await quote(msg, change.draft, change.reply)
        if (change.draft.quote.auto) await go(keyOf(change.draft))
        return
      }
      const key = `${docRef.current?.id ?? ''}:${change.phrase}:${Date.now()}`
      changes.current.set(key, change)
      const actions: NonNullable<Msg['actions']> = change.missing.length
        ? [{ kind: 'open-settings', label: 'Open Settings', primary: true }]
        : [
            {
              kind: 'make',
              label: `Make it again for ${dollars(change.total)}`,
              primary: true,
              payload: JSON.stringify({ do: 'shot', id: key })
            }
          ]
      patch(msg, { ...shown(change.reply), actions })
      if (change.auto) await reshoot(key, msg)
    },
    [go, quote, reshoot]
  )

  const handle = useCallback(
    async (text: string, command: { command: string; rest: string } | null, files: Attachment[]): Promise<boolean> => {
      const { docRef, push, patch } = live.current
      const audio = files.filter((f) => isAudioFile(f.name))
      const video = files.some((f) => isVideoFile(f.name))
      // The voice-over a made video was waiting for.
      if (waitingRecording.current && docRef.current?.make && audio.length > 0 && !video) {
        waitingRecording.current = false
        const msg = push({
          role: 'assistant',
          text: '',
          progress: { stage: 'Reading your recording', percent: null }
        })
        const r = await api.makeChange({
          doc: docRef.current,
          text: 'use my own recording',
          recording: audio[0].path,
          brand: live.current.brand()
        })
        if (!r.ok || !r.change)
          patch(msg, {
            progress: null,
            text: r.ok ? 'I could not use that recording.' : r.message,
            error: true
          })
        else await offer(r.change, msg)
        return true
      }
      const asked = command && MAKE_COMMANDS.has(command.command)
      const words = asked ? `/${command.command} ${command.rest}` : text
      // A new made video: asked for in a chat with no edit yet, or with /make anywhere.
      if (asked || (!docRef.current && !video && wantsMake(text, { footage: video }))) {
        if (asked && !command.rest.trim() && audio.length === 0) {
          push({
            role: 'assistant',
            text: 'Tell me what the video is about, like /make a 2 minute documentary about the 1950s oil boom, or paste your script.'
          })
          return true
        }
        pending.current = null
        await start(words, audio[0]?.path ?? null)
        return true
      }
      // A quote waiting: what is said next changes it.
      const waiting = pending.current
      if (waiting && files.length === 0 && text.trim()) {
        const draft = drafts.current.get(waiting.id)
        if (!draft) return false
        const msg = push({
          role: 'assistant',
          text: '',
          progress: { stage: 'Quoting it again', percent: null }
        })
        const r = await api.makeRevise({ draft, text })
        if (!r.ok) {
          patch(msg, { progress: null, text: r.message, error: true })
          return true
        }
        if (!r.draft) {
          // Nothing about the quote: an ask of the edit, if there is one.
          patch(msg, {
            progress: null,
            text: 'The quote stands as it was. Press its button to make it, or tell me what to change: its length, its voice, its look.'
          })
          return true
        }
        patch(waiting.msg, { actions: [] })
        await quote(msg, r.draft, r.reply)
        return true
      }
      return false
    },
    [offer, quote, start]
  )

  const asked = useCallback(
    async (text: string, onScreen: string | null = null): Promise<boolean> => {
      const { docRef, push } = live.current
      const d = docRef.current
      if (!d?.make || !text.trim()) return false
      const r = await api.makeChange({ doc: d, text, onScreen, brand: live.current.brand() })
      if (!r.ok) {
        push({ role: 'assistant', text: r.message, error: true })
        return true
      }
      if (!r.change) return false
      const msg = push({
        role: 'assistant',
        text: '',
        progress: { stage: 'Pricing it', percent: null }
      })
      await offer(r.change, msg)
      return true
    },
    [offer]
  )

  /** The script under a quote opened or closed, and the button that does it renamed to match. */
  const toggleScript = useCallback(
    (id: string): void => {
      const draft = drafts.current.get(id)
      const msg = pending.current?.id === id ? pending.current.msg : null
      if (!draft || !msg) return
      const opening = openScript !== id
      setOpenScript(opening ? id : null)
      scriptMsg.current = opening ? msg : null
      live.current.patch(msg, {
        actions: quoteMsg(draft, { text: '', aside: null, chips: [], details: [] }, opening).actions
      })
    },
    [openScript, quoteMsg]
  )

  const onAction = useCallback(
    async (a: Action): Promise<void> => {
      if (a.kind !== 'make' || !a.payload) return
      const p = JSON.parse(a.payload) as {
        do: 'go' | 'shot' | 'script'
        id: string
      }
      if (p.do === 'go') {
        setOpenScript(null)
        await go(p.id)
      } else if (p.do === 'script') toggleScript(p.id)
      else await reshoot(p.id)
    },
    [go, reshoot, toggleScript]
  )

  const editScript = useCallback(
    async (id: string, script: string): Promise<void> => {
      const { push, patch } = live.current
      const draft = drafts.current.get(id)
      if (!draft) return
      const msg = push({
        role: 'assistant',
        text: '',
        progress: { stage: 'Reading the script again', percent: null }
      })
      const r = await api.makeScript({ draft, script })
      if (!r.ok) {
        patch(msg, { progress: null, text: r.message, error: true })
        return
      }
      if (pending.current) patch(pending.current.msg, { actions: [] })
      setOpenScript(null)
      await quote(msg, r.draft, r.reply)
    },
    [quote]
  )

  const draft = useCallback((id: string): Draft | null => drafts.current.get(id) ?? null, [])
  const scriptOpen = useCallback((id: string): boolean => openScript === id, [openScript])

  return useMemo(
    () => ({ handle, asked, onAction, draft, editScript, scriptOpen }),
    [handle, asked, onAction, draft, editScript, scriptOpen]
  )
}
