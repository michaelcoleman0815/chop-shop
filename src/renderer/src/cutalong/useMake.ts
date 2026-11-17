import { useCallback, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { addAsset, currentVersion, type EditDoc, type Op } from '../../../shared/edit'
import { asNewVersion } from '../../../shared/make/assemble'
import { cleanTopic, readAsk, reviseBrief, reviseSteps, rewritesScript, wantsMake } from '../../../shared/make/brief'
import {
  answered as answeredPrompt,
  isAcceptance,
  isYes,
  mergeReads,
  namesEditPart,
  NO_EDIT,
  quoteWords,
  readAnswer,
  readBack,
  readCard,
  TAP_TO_GO,
  UNREAD,
  waitReply,
  type MakeQuestion,
  type Read
} from '../../../shared/make/questions'
import { draftFingerprint } from '../../../shared/make/fingerprint'
import { readMakeAsk } from '../../../shared/make/edits'
import type { Change, Consent, Draft, Reply, ShotChange } from '../../../shared/make/draft'
import { dollars, listOf, scriptCost } from '../../../shared/make/quote'
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
 * quoted the same way, never made without their button, and land as new
 * versions. useCutalong calls in at a few named places and keeps everything
 * else.
 *
 * Each quote has its own key, and only the newest has a button: a new quote
 * takes the older one's away. Pressed, it sends main the price it showed and
 * a fingerprint of its draft, so it can only make what it said, for what it
 * said. Anything that spends (writing the script, making the video, making
 * a shot again) shows Stop while it runs.
 *
 * A typed reply to the questions or to a quote is never sent anywhere on its
 * own: it is read here and read back ("Make it about “Lisbon”: a cinematic
 * documentary, 5:00 long?", "Change it to 2:00 long?"), and only that
 * read-back's Yes, tapped, asks Claude for anything. A reply it cannot read
 * is answered here too. Taps of the questions' own options go straight on.
 *
 * Every call that may spend says why it may (shared/make/draft Consent), and
 * main refuses it otherwise: `tap` for a button tapped, `command` for a new
 * video asked for with nothing else waiting. A new ask typed while anything
 * waits is read back too, with a tap to start it and, with a quote waiting,
 * one to change that quote to it instead. While a quote waits, a reply that
 * neither changes it nor is plainly an edit ("yes", "ship it", "that works")
 * stays here, pointed at its button.
 *
 * What waits belongs to the chat it was asked in (`chat`): another chat, a
 * new one or the same one opened again starts with nothing of it, and a chat
 * opened from disk has its make buttons expired (`restore`). A chat whose
 * questions, read-back or quote were left waiting counts as waiting still, so
 * a new ask typed in it is read back before anything is written.
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
  /** Which chat is open: what waits is that chat's, and nothing of another chat's can be tapped or changed from it. */
  chat?: () => string
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
  /** The questions waiting under a reply, if they are still waiting. */
  questions: (id: string) => MakeQuestion[] | null
  /** Answers to them, one for each question in order: a tap's words go straight on; words typed in a field are read back first. */
  answer: (id: string, answers: string[]) => Promise<void>
  /**
   * A chat opened (after a restart, or from another chat): its messages with their make buttons and questions
   * expired, since nothing behind them is here any more; any left waiting make the chat count as waiting.
   */
  restore: (messages: Msg[]) => Msg[]
}

const OPEN: NonNullable<Msg['actions']> = [{ kind: 'open-editor', label: 'Open the editor', primary: true }]

/** While a video is made (and spends money), a way to stop it: shown on the progress, gone once it is done. */
const STOP: NonNullable<Msg['actions']> = [{ kind: 'make', label: 'Stop', payload: JSON.stringify({ do: 'stop', id: '' }), during: true }]

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const MAKE_COMMANDS = new Set(['make', 'documentary', 'explainer'])

/** What a reply that changes nothing about a quote, or a Not now to a change read back, is answered with. */
const QUOTE_STANDS = 'The quote stands as it was. Press its button to make it, or tell me what to change: its length, its voice, its look.'

/** What any other reply to a waiting quote is answered with: only its button makes it. */
const QUOTE_WAITS = 'Tap the button above to go ahead, or tell me what to change. Nothing is spent until you tap it; say “not now” to set it aside.'

/** A no, or "not now", to a waiting quote. */
const QUOTE_ASIDE = 'All right, I’ve set that quote aside. Nothing was spent.'

/** What is typed in a chat whose make questions, read-back or quote expired when it was opened again. */
const EXPIRED_WAITS = 'What was waiting above has expired, so nothing is written or made from it. Ask again for a fresh quote, or say “never mind”.'

/** "Not now" and its kin, to a quote: set it aside. */
const NOT_NOW = /^\s*(?:not now|not right now|not today|maybe later|later|another time|not yet)\b[\s.!]*$/i

/** Each make message left waiting in a chat opened again, and what it says once expired. */
const EXPIRED = {
  questions: 'These questions have expired. Ask again and I’ll ask them fresh.',
  quote: 'This quote has expired. Ask again and I’ll quote it fresh.',
  back: 'This has expired. Say it again and I’ll read it back fresh.'
}

/** An edit's words, with no edit open and a quote waiting. */
const NO_EDIT_QUOTE = 'There’s no video open to edit yet, only this quote. Press its button to make it, or tell me what to change.'

/** A file sent with words while questions or a quote wait: nothing is read from it until what waits is settled. */
const FILE_WITH_QUESTIONS = 'Answer the questions above first, or say “never mind” to set them aside. Then send that again.'
const FILE_WITH_QUOTE = 'The quote above is still waiting. Press its button, or tell me what to change. Then send that again.'

/** Questions waiting to be answered before anything is written, and what was asked. */
interface Asking {
  id: string
  msg: string
  text: string
  recording: string | null
  questions: MakeQuestion[]
}

/**
 * A typed reply read back and waiting for its Yes: answers to the questions
 * (the prompt Claude is given, and the words its brief is read from), or
 * changes to a quote, each as said, in turn. Only its button sends it.
 */
type Back =
  | { kind: 'ask'; key: string; id: string; msg: string; read: Read; prompt: string; reading: string }
  | { kind: 'quote'; key: string; id: string; msg: string; steps: string[] }
  /** A new ask typed while something waited: started, or (with a quote waiting) made that quote's change, only on its tap. */
  | { kind: 'new'; key: string; msg: string; text: string; recording: string | null; quoteId: string | null; steps: string[] | null }

/** What a read-back's button picks: Yes or Not now, or, for a new ask, changing the quote waiting or starting anew. */
type BackPick = 'yes' | 'no' | 'change' | 'new'

/** A read-back's button. */
const pickAction = (key: string, label: string, pick: BackPick, primary = false): NonNullable<Msg['actions']>[number] => ({
  kind: 'make',
  label,
  primary,
  payload: JSON.stringify({ do: 'back', id: key, pick })
})

/** A read-back's buttons: Yes sends it; Not now leaves everything as it was. */
const backActions = (key: string): NonNullable<Msg['actions']> => [pickAction(key, 'Yes', 'yes', true), pickAction(key, 'Not now', 'no')]

let quoteCount = 0
/** A key no other quote in this session has. */
const newKey = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${++quoteCount}`

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
  /** Every quote shown, by its own key: its draft, the price its button showed, and its fingerprint. */
  const drafts = useRef(new Map<string, { draft: Draft; total: number; fingerprint: string }>())
  const changes = useRef(new Map<string, ShotChange>())
  /** The newest quote, the only one with a button, and the message that shows it. */
  const pending = useRef<{ id: string; msg: string } | null>(null)
  /** A voice-over asked for and not dropped yet. */
  const waitingRecording = useRef(false)
  /** Questions waiting to be answered before anything is written. */
  const asking = useRef<Asking | null>(null)
  /** The typed reply read back last, waiting for its Yes. */
  const back = useRef<Back | null>(null)
  /** The quote being worked out again: its button waits for the new one. */
  const requoting = useRef<string | null>(null)
  /** The quote whose script is open under it, and the message that shows it. */
  const [openScript, setOpenScript] = useState<string | null>(null)
  const scriptMsg = useRef<string | null>(null)
  const [, setVersion] = useState(0)
  /** Make messages left waiting in a chat opened again: expired, and the chat counts as waiting until settled. */
  const restored = useRef(false)
  /** The chat all of this belongs to. */
  const owner = useRef(deps.chat?.() ?? '')

  /**
   * Another chat open than the one this state was made in: none of it carries over. Every way in calls it
   * first, so nothing of one chat can be tapped, changed or waited on from another.
   */
  const sync = useCallback((reading = false): void => {
    const now = live.current.chat?.() ?? ''
    if (now === owner.current) return
    owner.current = now
    drafts.current.clear()
    changes.current.clear()
    pending.current = null
    waitingRecording.current = false
    asking.current = null
    back.current = null
    requoting.current = null
    restored.current = false
    scriptMsg.current = null
    // Read while a chat draws: the refs are enough, and nothing is set while it draws.
    if (reading) return
    setOpenScript(null)
    setVersion((n) => n + 1)
  }, [])

  /** Still the chat `mine` was taken in: what a piece of work brings back lands only in the chat that asked for it. */
  const still = useCallback((mine: string): boolean => (live.current.chat?.() ?? '') === mine, [])

  /** A quote shown: kept under a key of its own, with the price its button shows. */
  const keep = useCallback((draft: Draft): string => {
    const key = newKey('quote')
    drafts.current.set(key, { draft, total: draft.quote.total, fingerprint: draftFingerprint(draft) })
    setVersion((n) => n + 1)
    return key
  }, [])

  /** The newest quote is this one: the button of the one before it goes, so only one quote can be made at a time. */
  const showing = useCallback((key: string, msg: string): void => {
    const was = pending.current
    if (was && was.msg !== msg) live.current.patch(was.msg, { actions: [] })
    if (was && was.id !== key) changes.current.delete(was.id)
    pending.current = { id: key, msg }
  }, [])

  /** The quote's message: its sentence, three facts, the lines behind Details, the one button, and the script behind another. */
  const quoteMsg = useCallback((key: string, draft: Draft, reply: Reply, scriptShown = false): Partial<Msg> => {
    const q = draft.quote
    const actions: NonNullable<Msg['actions']> = q.missing.length
      ? [{ kind: 'open-settings', label: 'Open Settings', primary: true }]
      : [
          {
            kind: 'make',
            label: `Make it for ${dollars(q.total)}`,
            primary: true,
            payload: JSON.stringify({ do: 'go', id: key })
          }
        ]
    if (draft.script.trim())
      actions.push({
        kind: 'make',
        label: scriptShown ? 'Hide the script' : 'Read the script',
        payload: JSON.stringify({ do: 'script', id: key })
      })
    return { ...shown(reply), actions, make: key }
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

  /** Makes a confirmed draft: the one its button showed, for the price it showed. */
  const go = useCallback(
    async (key: string): Promise<void> => {
      const { push, patch, during } = live.current
      const entry = drafts.current.get(key)
      if (!entry) {
        push({
          role: 'assistant',
          text: 'That quote is from another chat, or from before Cutalong restarted. Ask again and I’ll quote it fresh.'
        })
        return
      }
      // Only the newest quote's button makes anything; an older one was replaced.
      if (pending.current?.id !== key) {
        push({ role: 'assistant', text: 'A newer quote replaced that one. Press the newest quote’s button, or ask again.' })
        return
      }
      // Being quoted again: its button waits for the new quote, which may be another price.
      if (requoting.current === key) {
        push({ role: 'assistant', text: 'That quote is being worked out again. Press the new quote’s button when it shows, or stop it first.' })
        return
      }
      // What was read back and not confirmed goes: the quote is made as it was quoted.
      if (back.current) {
        patch(back.current.msg, { actions: [] })
        back.current = null
      }
      patch(pending.current.msg, { actions: [] })
      pending.current = null
      const msg = push({
        role: 'assistant',
        text: '',
        progress: { stage: 'Starting', percent: null },
        actions: STOP
      })
      const off = api.onCutProgress((p) => patch(msg, { progress: p }))
      let r: Awaited<ReturnType<typeof api.makeGo>>
      try {
        r = await during(() => api.makeGo({ draft: entry.draft, confirmed: entry.total, fingerprint: entry.fingerprint, consent: 'tap' }))
      } catch (err) {
        r = { ok: false, message: errorText(err) }
      } finally {
        off()
      }
      if (!r.ok) {
        // A new price, another service, or the rest after a Stop: a new quote, with its own button.
        if (r.draft && r.reply) {
          const next = keep(r.draft)
          showing(next, msg)
          patch(msg, { ...quoteMsg(next, r.draft, r.reply), text: r.message })
        } else patch(msg, { progress: null, text: r.message, error: true })
        return
      }
      drafts.current.delete(key)
      land(r, msg)
    },
    [keep, land, quoteMsg, showing]
  )

  const quote = useCallback(
    async (msg: string, draft: Draft, reply: Reply): Promise<string> => {
      const key = keep(draft)
      showing(key, msg)
      live.current.patch(msg, quoteMsg(key, draft, reply))
      return key
    },
    [keep, quoteMsg, showing]
  )

  /**
   * A prompt read and quoted, or made straight away under the amount in Settings; asked about first when it must be.
   * Typed answers confirmed on their read-back are quoted first, and their brief is read from `reading`, as it was read back.
   * `consent` says why main may write its script: a tap, or a new ask typed with nothing else waiting.
   */
  const start = useCallback(
    async (
      text: string,
      recording: string | null,
      opts: { answered?: boolean; quoteFirst?: boolean; reading?: string; consent: Consent }
    ): Promise<void> => {
      const { answered = false, quoteFirst = false, reading, consent } = opts
      if (consent === 'tap') restored.current = false
      const { push, patch, during } = live.current
      // Writing the script spends, and Settings may make the video straight after: Stop stays in reach.
      const msg = push({
        role: 'assistant',
        text: '',
        progress: { stage: 'Reading what you asked for', percent: null },
        actions: STOP
      })
      const off = api.onCutProgress((p) => patch(msg, { progress: p }))
      let r: Awaited<ReturnType<typeof api.makeStart>>
      try {
        r = await during(() =>
          api.makeStart({ text, recording, brand: live.current.brand(), answered, quoteFirst, consent, ...(reading ? { reading } : {}) })
        )
      } catch (err) {
        r = { ok: false, message: errorText(err) }
      } finally {
        off()
      }
      if (!r.ok) {
        // Made straight away and stopped: what was spent, and a quote for the rest, with its own button.
        if (r.draft && r.reply) {
          await quote(msg, r.draft, r.reply)
          patch(msg, { text: r.message })
        } else patch(msg, { progress: null, text: r.message, error: true, actions: [] })
        return
      }
      if (r.kind === 'ask') {
        // Nothing is written yet: the questions wait under this reply, and so does what was asked.
        const id = `ask-${Date.now()}`
        asking.current = { id, msg, text, recording, questions: r.questions }
        setVersion((n) => n + 1)
        patch(msg, {
          progress: null,
          text:
            r.questions.length === 1
              ? 'One thing first, so I write the right video.'
              : `${r.questions.length === 2 ? 'Two' : 'Three'} things first, so I write the right video.`,
          makeAsk: id,
          actions: []
        })
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

  /** The read-back waiting goes, and its buttons with it. */
  const dropBack = useCallback((): void => {
    if (back.current) live.current.patch(back.current.msg, { actions: [] })
    back.current = null
  }, [])

  /** Typed answers read back with what will be asked for, and Yes and Not now; nothing is sent until Yes is tapped. */
  const askBack = useCallback(
    (open: Asking, read: Read): void => {
      // Said again on a read-back still waiting: the two as one, what was said last winning.
      const was = back.current?.kind === 'ask' && back.current.id === open.id ? back.current : null
      const merged = was ? mergeReads(was.read, read) : read
      dropBack()
      const b = readBack(open.text, open.questions, merged)
      const key = newKey('back')
      const msg = live.current.push({ role: 'assistant', text: b.line, aside: b.aside, actions: backActions(key) })
      back.current = { kind: 'ask', key, id: open.id, msg, read: merged, prompt: b.prompt, reading: b.reading }
    },
    [dropBack]
  )

  /** The questions answered on their card: taps go straight on, and words typed in a field are read back first. */
  const answer = useCallback(
    async (id: string, answers: string[]): Promise<void> => {
      sync()
      const a = asking.current
      if (!a || a.id !== id) return
      const card = readCard(answers, a.questions)
      if (card?.kind === 'unread') {
        live.current.push({ role: 'assistant', text: UNREAD })
        return
      }
      if (card) {
        askBack(a, card)
        return
      }
      asking.current = null
      dropBack()
      setVersion((n) => n + 1)
      live.current.patch(a.msg, { makeAsk: undefined, aside: answers.filter(Boolean).join(', ') })
      await start(answeredPrompt(a.text, answers), a.recording, { answered: true, consent: 'tap' })
    },
    [askBack, dropBack, start, sync]
  )

  /**
   * A new ask typed while something waits: read back with a tap to start it instead and, with a quote waiting
   * that the words would change, a tap to change that quote to them. Neither runs until tapped.
   */
  const newAskBack = useCallback(
    (text: string, recording: string | null): void => {
      const brief = readAsk(text, { recording })
      const topic = brief?.from === 'topic' ? cleanTopic(brief.topic) : ''
      const waiting = pending.current
      const q = waiting ? drafts.current.get(waiting.id) : undefined
      const steps = [quoteWords(text)]
      const change = q ? reviseSteps(q.draft.brief, steps) : null
      dropBack()
      const key = newKey('back')
      const about = topic && topic !== 'what you asked for' ? `a new video about “${topic}”` : 'a new video'
      const again = change && q ? rewritesScript(q.draft.brief, change.brief, !!q.draft.into) : false
      const aside = [
        change
          ? again
            ? `Changing this one asks Claude to write its script again, which may cost up to ${dollars(scriptCost(change.brief.seconds))}.`
            : 'Changing this one quotes it again, for nothing.'
          : '',
        brief?.from === 'topic' ? `A new video asks Claude to write its script, which may cost up to ${dollars(scriptCost(brief.seconds))}.` : '',
        'Nothing else is spent until you press a quote’s button.'
      ]
        .filter(Boolean)
        .join(' ')
      const msg = live.current.push({
        role: 'assistant',
        text: change ? `Change this one to ${listOf(change.changed)}, or start ${about} instead?` : `Start ${about} instead?`,
        aside,
        actions: [
          ...(change ? [pickAction(key, 'Change this one', 'change', true)] : []),
          pickAction(key, 'Start a new video', 'new', !change),
          pickAction(key, 'Not now', 'no')
        ]
      })
      back.current = { kind: 'new', key, msg, text, recording, quoteId: change && waiting ? waiting.id : null, steps: change ? steps : null }
    },
    [dropBack]
  )

  /** A quote's changes, read back and confirmed: quoted again, by Claude writing the script again when they need it. */
  const requote = useCallback(
    async (b: Extract<Back, { kind: 'quote' }>): Promise<void> => {
      const { push, patch, during } = live.current
      const draft = drafts.current.get(b.id)?.draft
      if (!draft || pending.current?.id !== b.id) {
        push({ role: 'assistant', text: 'A newer quote replaced that one. Tell me the change again and I’ll read it back.' })
        return
      }
      requoting.current = b.id
      // A script written again is paid for: Stop stays in reach.
      const msg = push({ role: 'assistant', text: '', progress: { stage: 'Quoting it again', percent: null }, actions: STOP })
      let r: Awaited<ReturnType<typeof api.makeRevise>>
      try {
        r = await during(() => api.makeRevise({ draft, steps: b.steps, consent: 'tap' }))
      } catch (err) {
        r = { ok: false, message: errorText(err) }
      } finally {
        if (requoting.current === b.id) requoting.current = null
      }
      if (!r.ok && r.draft && r.reply) {
        // Stopped or failed after Claude began: the same script, quoted with what that may have cost.
        await quote(msg, r.draft, r.reply)
        patch(msg, { text: r.message })
        return
      }
      if (!r.ok || !r.draft) {
        patch(msg, { progress: null, text: r.ok ? 'I could not quote that again.' : r.message, error: true, actions: [] })
        return
      }
      await quote(msg, r.draft, r.reply)
    },
    [quote]
  )

  /** A read-back's button, tapped: Yes sends exactly what it read back; Not now leaves everything as it was. */
  const onBack = useCallback(
    async (key: string, pick: BackPick): Promise<void> => {
      const b = back.current
      // An older read-back's button: a newer one replaced it.
      if (!b || b.key !== key) return
      dropBack()
      const yes = pick === 'yes'
      if (b.kind === 'new') {
        const { push, patch } = live.current
        if (pick === 'change' && b.quoteId && b.steps) {
          await requote({ kind: 'quote', key: b.key, id: b.quoteId, msg: b.msg, steps: b.steps })
          return
        }
        if (pick === 'new') {
          // The new video takes the place of what was waiting, as a new ask always has; it is quoted before anything more.
          if (pending.current) patch(pending.current.msg, { actions: [] })
          pending.current = null
          if (asking.current) {
            patch(asking.current.msg, { makeAsk: undefined, aside: 'Left unanswered, so nothing was written.' })
            asking.current = null
            setVersion((n) => n + 1)
          }
          await start(b.text, b.recording, { consent: 'tap', quoteFirst: true })
          return
        }
        push({
          role: 'assistant',
          text: pending.current ? QUOTE_STANDS : asking.current ? waitReply(asking.current.questions, false) : 'All right. Nothing was written or spent.'
        })
        return
      }
      if (b.kind === 'quote') {
        if (yes) await requote(b)
        else live.current.push({ role: 'assistant', text: QUOTE_STANDS })
        return
      }
      const open = asking.current
      if (!open || open.id !== b.id) return
      if (!yes) {
        live.current.push({ role: 'assistant', text: waitReply(open.questions, false) })
        return
      }
      asking.current = null
      setVersion((n) => n + 1)
      live.current.patch(open.msg, { makeAsk: undefined, aside: 'Answered in your words, read back below.' })
      await start(b.prompt, open.recording, { answered: true, quoteFirst: true, reading: b.reading, consent: 'tap' })
    },
    [dropBack, requote, start]
  )

  /** One shot made again for its confirmed quote, as a new version. */
  const reshoot = useCallback(async (key: string): Promise<void> => {
    const { docRef, push, patch, setDoc, applyAsVersion, during } = live.current
    const change = changes.current.get(key)
    const d = docRef.current
    if (!change || !d?.make) {
      push({
        role: 'assistant',
        text: 'That quote is from before Cutalong restarted, or a newer one replaced it. Ask again and I’ll quote it fresh.'
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
      progress: { stage: 'Starting', percent: null },
      actions: STOP
    })
    const off = api.onCutProgress((p) => patch(msg, { progress: p }))
    let r: Awaited<ReturnType<typeof api.makeShot>>
    try {
      r = await during(() => api.makeShot({ doc: d, change, confirmed: change.total, consent: 'tap' }))
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
      // Read from what was typed, so it is never made without its button, whatever Settings says.
      if (change.kind === 'draft') {
        await quote(msg, change.draft, change.reply)
        return
      }
      const key = newKey(`shot-${docRef.current?.id ?? ''}-${change.phrase}`)
      changes.current.set(key, change)
      showing(key, msg)
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
    },
    [quote, showing]
  )

  const handle = useCallback(
    async (text: string, command: { command: string; rest: string } | null, files: Attachment[]): Promise<boolean> => {
      sync()
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
        const mine = owner.current
        const r = await api.makeChange({
          doc: docRef.current,
          text: 'use my own recording',
          recording: audio[0].path,
          brand: live.current.brand()
        })
        // Another chat opened meanwhile: its quote is not this chat's to show.
        if (!still(mine)) return true
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
      const newAsk = !!asked || (!docRef.current && !video && wantsMake(text, { footage: video }))
      // Questions, a read-back or a quote waiting, live or left waiting in a chat opened again: nothing typed then
      // starts, changes or makes anything on its own.
      const waitingNow = !!asking.current || !!back.current || !!pending.current || restored.current
      if (newAsk) {
        if (asked && !command.rest.trim() && audio.length === 0) {
          push({
            role: 'assistant',
            text: 'Tell me what the video is about, like /make a 2 minute documentary about the 1950s oil boom, or paste your script.'
          })
          return true
        }
        // Nothing else waiting: the ask is the person's own go-ahead to write its script.
        if (!waitingNow) {
          await start(words, audio[0]?.path ?? null, { consent: 'command' })
          return true
        }
        // While questions wait, plain words answer them (below). Otherwise it is read back, and starts only on its tap.
        if (asked || !asking.current) {
          newAskBack(words, audio[0]?.path ?? null)
          return true
        }
      }
      // Questions waiting: what is typed is read here, never sent, and read back before anything is written.
      const open = asking.current
      if (open && text.trim()) {
        const waitingBack = back.current?.kind === 'ask' && back.current.id === open.id ? back.current : null
        const read = readAnswer(text, open.questions, { editOpen: !!docRef.current })
        // An edit's words, with an edit open: the questions go, and the edit takes them.
        if (read.kind === 'edit') {
          dropBack()
          asking.current = null
          setVersion((n) => n + 1)
          patch(open.msg, { makeAsk: undefined, aside: 'Left unanswered, so nothing was written.' })
          return false
        }
        // A file with words: nothing is read from it while the questions wait.
        if (files.length > 0) {
          push({ role: 'assistant', text: FILE_WITH_QUESTIONS })
          return true
        }
        if (read.kind === 'noEdit') {
          push({ role: 'assistant', text: NO_EDIT })
          return true
        }
        if (read.kind === 'read') {
          askBack(open, read)
          return true
        }
        if (read.kind === 'unread') {
          push({ role: 'assistant', text: UNREAD })
          return true
        }
        // A pause, a question back, or a go-ahead typed to a read-back, which only its button sends.
        if (read.kind === 'wait') {
          const goAhead = !!back.current && (isAcceptance(text) || isYes(text))
          push({ role: 'assistant', text: goAhead ? TAP_TO_GO : waitReply(open.questions, read.asked) })
          return true
        }
        // A no: to a read-back it is Not now, and the questions stay; to the questions, they go.
        if (waitingBack || back.current) {
          dropBack()
          push({ role: 'assistant', text: waitReply(open.questions, false) })
          return true
        }
        asking.current = null
        setVersion((n) => n + 1)
        patch(open.msg, { makeAsk: undefined, aside: 'Left unanswered, so nothing was written.' })
        push({ role: 'assistant', text: 'All right, I won’t make it. Nothing was written or spent.' })
        return true
      }
      // A quote waiting: a reply is decided by what it would change. A change of the quote is read back, and quoted
      // again only on its Yes; a change of the edit open goes to the edit; anything else stays here, pointed at the
      // button, however it is said.
      const waiting = pending.current
      if (waiting && text.trim()) {
        const draft = drafts.current.get(waiting.id)?.draft
        const editing = docRef.current
        // Another command typed in full: not a reply to the quote.
        if (command && !MAKE_COMMANDS.has(command.command)) return false
        const said = readAnswer(text, [])
        // Words only an edit takes ("cut the first 10 seconds"), never a change of the quote: the edit's, or answered here.
        if (said.kind === 'noEdit') {
          if (editing) return false
          push({ role: 'assistant', text: NO_EDIT_QUOTE })
          return true
        }
        // A no, or "not now": to what was read back of it, that goes and the quote stands; to the quote, it is set aside.
        if (said.kind === 'no' || NOT_NOW.test(text)) {
          if (back.current) {
            dropBack()
            push({ role: 'assistant', text: QUOTE_STANDS })
            return true
          }
          patch(waiting.msg, { actions: [] })
          pending.current = null
          push({ role: 'assistant', text: QUOTE_ASIDE })
          return true
        }
        const waitingBack = back.current?.kind === 'quote' && back.current.id === waiting.id ? back.current : null
        const words = quoteWords(text)
        const sofar = draft ? (waitingBack ? (reviseSteps(draft.brief, waitingBack.steps)?.brief ?? draft.brief) : draft.brief) : null
        if (draft && sofar && reviseBrief(sofar, words)) {
          const steps = [...(waitingBack?.steps ?? []), words]
          const r = reviseSteps(draft.brief, steps)
          dropBack()
          if (!r) {
            push({ role: 'assistant', text: 'That puts it back as it was quoted. Press the quote’s button to make it.' })
            return true
          }
          // A new length or format for a script Claude wrote means Claude writes it again, which is paid for.
          const again = rewritesScript(draft.brief, r.brief, !!draft.into)
          const key = newKey('back')
          const msg = push({
            role: 'assistant',
            text: `Change it to ${listOf(r.changed)}?`,
            aside: again
              ? `Yes asks Claude to write the script again, which may cost up to ${dollars(scriptCost(r.brief.seconds))}, and quotes it again. Nothing else is spent until you press the new quote’s button.`
              : 'Yes quotes it again. Nothing is spent until you press the new quote’s button.',
            actions: backActions(key)
          })
          back.current = { kind: 'quote', key, id: waiting.id, msg, steps }
          return true
        }
        if (editing) {
          // What an edit does, said first ("add a title"), with a file or not: the edit's.
          if (readAnswer(text, [], { editOpen: true }).kind === 'edit') return false
          // A change of the made video open (a shot made again, another voice): quoted on its own, never made unasked.
          if (editing.make && files.length === 0 && readMakeAsk(editing.make, text)) return false
          // A part only an edit has ("make the captions bigger", "at 1:20"): the edit's to change.
          if (files.length === 0 && namesEditPart(text)) return false
        }
        // Anything else, a file sent with it or not, stays here.
        push({ role: 'assistant', text: files.length > 0 ? FILE_WITH_QUOTE : back.current ? TAP_TO_GO : QUOTE_WAITS })
        return true
      }
      // A read-back waiting on its own, or what a chat opened again had left waiting: an edit's own words go to the
      // edit, a no settles it, and anything else stays here.
      if ((back.current || restored.current) && text.trim()) {
        const editing = docRef.current
        const said = readAnswer(text, [], { editOpen: !!editing })
        if (said.kind === 'edit' || (command && !MAKE_COMMANDS.has(command.command))) return false
        if (editing?.make && files.length === 0 && readMakeAsk(editing.make, text)) return false
        if (editing && files.length === 0 && namesEditPart(text)) return false
        if (said.kind === 'no' || NOT_NOW.test(text)) {
          dropBack()
          restored.current = false
          push({ role: 'assistant', text: 'All right. Nothing was written or spent.' })
          return true
        }
        push({ role: 'assistant', text: back.current ? TAP_TO_GO : EXPIRED_WAITS })
        return true
      }
      return false
    },
    [askBack, dropBack, newAskBack, offer, start, still, sync]
  )

  const asked = useCallback(
    async (text: string, onScreen: string | null = null): Promise<boolean> => {
      sync()
      const { docRef, push } = live.current
      const d = docRef.current
      if (!d?.make || !text.trim()) return false
      const mine = owner.current
      const r = await api.makeChange({ doc: d, text, onScreen, brand: live.current.brand() })
      // Another chat opened while it was priced: nothing of this chat's video lands there, and what was typed stays here.
      if (!still(mine)) return true
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
    [offer, still, sync]
  )

  /** The script under a quote opened or closed, and the button that does it renamed to match. */
  const toggleScript = useCallback(
    (id: string): void => {
      const draft = drafts.current.get(id)?.draft
      const msg = pending.current?.id === id ? pending.current.msg : null
      if (!draft || !msg) return
      const opening = openScript !== id
      setOpenScript(opening ? id : null)
      scriptMsg.current = opening ? msg : null
      live.current.patch(msg, {
        actions: quoteMsg(id, draft, { text: '', aside: null, chips: [], details: [] }, opening).actions
      })
    },
    [openScript, quoteMsg]
  )

  const onAction = useCallback(
    async (a: Action): Promise<void> => {
      if (a.kind !== 'make' || !a.payload) return
      sync()
      const p = JSON.parse(a.payload) as {
        do: 'go' | 'shot' | 'script' | 'stop' | 'back'
        id: string
        pick?: BackPick
        yes?: boolean
      }
      if (p.do === 'stop') {
        // What is in flight is cut short; what was made stays in the cache. The reply says what was spent and kept.
        await api.makeCancel()
        return
      }
      if (p.do === 'back') {
        await onBack(p.id, p.pick ?? (p.yes === true ? 'yes' : 'no'))
        return
      }
      if (p.do === 'go') {
        setOpenScript(null)
        await go(p.id)
      } else if (p.do === 'script') toggleScript(p.id)
      else await reshoot(p.id)
    },
    [go, onBack, reshoot, sync, toggleScript]
  )

  const editScript = useCallback(
    async (id: string, script: string): Promise<void> => {
      sync()
      const { push, patch } = live.current
      const draft = drafts.current.get(id)?.draft
      if (!draft) return
      const msg = push({
        role: 'assistant',
        text: '',
        progress: { stage: 'Reading your script again', percent: null }
      })
      const mine = owner.current
      const r = await api.makeScript({ draft, script })
      if (!still(mine)) return
      if (!r.ok) {
        patch(msg, { progress: null, text: r.message, error: true })
        return
      }
      setOpenScript(null)
      await quote(msg, r.draft, r.reply)
    },
    [quote, still, sync]
  )

  const draft = useCallback(
    (id: string): Draft | null => {
      sync(true)
      return drafts.current.get(id)?.draft ?? null
    },
    [sync]
  )
  const scriptOpen = useCallback((id: string): boolean => openScript === id, [openScript])
  const questions = useCallback(
    (id: string): MakeQuestion[] | null => {
      sync(true)
      return asking.current?.id === id ? asking.current.questions : null
    },
    [sync]
  )

  const restore = useCallback(
    (messages: Msg[]): Msg[] => {
      sync()
      let waiting = false
      const out = messages.map((m) => {
        const makes = (m.actions ?? []).filter((a) => a.kind === 'make')
        if (!m.makeAsk && makes.length === 0) return m
        const kinds = makes.map((a) => /"do":"(\w+)"/.exec(a.payload ?? '')?.[1] ?? '')
        const note = m.makeAsk ? EXPIRED.questions : kinds.some((k) => k === 'go' || k === 'shot') ? EXPIRED.quote : kinds.includes('back') ? EXPIRED.back : null
        if (note) waiting = true
        return {
          ...m,
          actions: (m.actions ?? []).filter((a) => a.kind !== 'make'),
          makeAsk: undefined,
          make: undefined,
          ...(note ? { aside: [note, m.aside].filter(Boolean).join(' ') } : {})
        }
      })
      restored.current = waiting
      return out
    },
    [sync]
  )

  return useMemo(
    () => ({ handle, asked, onAction, draft, editScript, scriptOpen, questions, answer, restore }),
    [handle, asked, onAction, draft, editScript, scriptOpen, questions, answer, restore]
  )
}
