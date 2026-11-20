import { useCallback, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { addAsset, currentVersion, type EditDoc, type Op } from '../../../shared/edit'
import { asNewVersion } from '../../../shared/make/assemble'
import { cleanTopic, readAsk, reviseBrief, reviseSteps, rewritesScript, wantsMake } from '../../../shared/make/brief'
import {
  answered as answeredPrompt,
  isAcceptance,
  isDeferral,
  isYes,
  looksLikeChange,
  mergeReads,
  namesEditPart,
  NO_EDIT,
  quoteReplyParts,
  quoteWords,
  readAnswer,
  readBack,
  readCard,
  TAP_TO_GO,
  UNREAD,
  unplacedChange,
  waitReply,
  type MakeQuestion,
  type Read
} from '../../../shared/make/questions'
import { draftFingerprint } from '../../../shared/make/fingerprint'
import { readMakeAsk } from '../../../shared/make/edits'
import type { Change, Consent, Draft, Reply, ShotChange } from '../../../shared/make/draft'
import { dollars, listOf, scriptCost } from '../../../shared/make/quote'
import type { Brief } from '../../../shared/make/schema'
import type { ChatMessage } from '../../../shared/types'
import { api } from './api'
import type { Attachment } from './components/Composer'
import type { Action, Msg } from './components/Message'
import { isAudioFile, isVideoFile } from './format'
import { renumber, shotInto, shotKeptAt, type Kept } from '../../../shared/make/kept'

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
 *
 * What is paid for belongs to the chat that paid for it. Writing a script,
 * quoting one again, making a video or a shot keep the chat and its file they
 * were asked in; if another chat is open when the result comes back, it is
 * kept in that chat's own file (`keepFor`), never in the one open, and the
 * chat open says where it is. While it runs, any other chat shows a line with
 * its Stop. A tap that would spend while another chat is opening does nothing
 * (`switching`). A quote's script is kept with its reply, so it can be read
 * once the quote has gone, set aside, replaced or expired.
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
  /** The open chat's file, once it has one: a paid result is kept in the chat that paid for it. */
  project?: () => { path: string; name: string } | null
  /**
   * The open chat's file, made and saved now if it has none yet: done before anything is spent, so what comes back
   * always has a chat to go to.
   */
  ensureChat?: (name: string) => Promise<{ path: string; name: string } | null>
  /**
   * Keeps a paid result in its own chat's file while another chat is open (main, in that file's turn): with no file,
   * or a new video for a chat that has an edit, it goes in a new chat of its own. Where it was kept, or null.
   */
  keepFor?: (project: { path: string; name: string } | null, name: string, kept: Kept) => Promise<{ path: string; name: string } | null>
  /**
   * A chat of its own for a new video, as the chat it was asked in has an edit it never replaces: made with `first`
   * in it and saved, the chat being left given the line `leaving` says, then opened. Refused while other work runs
   * ('busy'), not made ('failed', or null), or given way to the chat open being asked for meanwhile ('overtaken', and
   * the chat it had made is taken away again).
   */
  newChat?: (
    name: string,
    first: Omit<ChatMessage, 'id'>[],
    leaving: (name: string) => Omit<ChatMessage, 'id'>
  ) => Promise<NewChat | null>
  /**
   * The chat's own edit, or one of its clips, by its id, while another of them is open in the editor: where a paid
   * result made for it goes all the same.
   */
  chatEdit?: (id: string) => EditDoc | null
  /** That edit, changed, put back where it is in the chat and saved, without opening it. */
  putChatEdit?: (doc: EditDoc) => void
  /** Whether Settings makes a new video straight away when it costs less than its amount. */
  goAhead?: () => Promise<boolean>
  /** What a brand never uses, by its id: kept with a shot made for a chat not open. */
  never?: (brand: string) => string[]
  /** Another chat is being opened: a tap that would write, change or make anything does nothing until it has. */
  switching?: () => boolean
  /** Resolves once no other chat is being opened: a result that comes back meanwhile goes where that leaves it. */
  settled?: () => Promise<void>
  /** A short notice outside the chat (a toast). */
  notify?: (text: string) => void
}

/** How making a new chat for a new video went: where it is, or why there is none. */
export type NewChat = { path: string; name: string } | { refused: 'busy' | 'failed' | 'overtaken' }

/** Where a paid piece of work was asked for: its chat, that chat's file once it has one, and its brand. */
interface Origin {
  key: string
  project: { path: string; name: string } | null
  brand: string
}

/**
 * Paid work under way, each its own (one ending never takes another's line or Stop): what it does, the chat it
 * was asked in, what it is, its stage, and where its progress and Stop show.
 */
interface Run {
  kind: 'script' | 'requote' | 'make' | 'shot'
  origin: Origin
  /** "your video about the oil boom". */
  what: string
  /** A chat of its own, should it need one: "The oil boom". */
  name: string
  stage: string | null
  /** Its progress, with Stop, and the chat that shows it. */
  msg: string
  msgKey: string
  /** A line with its Stop in another chat opened while it runs, and that chat. */
  mirror: string | null
  mirrorKey: string | null
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
  /** Paid work under way, for a line wherever the person is: what it is, and its stage. */
  running: () => { what: string; stage: string | null } | null
  /** Stops what is being made, from wherever the person is. */
  stop: () => Promise<void>
}

const OPEN: NonNullable<Msg['actions']> = [{ kind: 'open-editor', label: 'Open the editor', primary: true }]

/** While a video is made (and spends money), a way to stop it: shown on the progress, gone once it is done. */
const STOP: NonNullable<Msg['actions']> = [{ kind: 'make', label: 'Stop', payload: JSON.stringify({ do: 'stop', id: '' }), during: true }]

/** The same Stop, on the line another chat shows while the work runs in its own. */
const STOP_AWAY: NonNullable<Msg['actions']> = [{ kind: 'make', label: 'Stop', payload: JSON.stringify({ do: 'stop', id: '' }) }]

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const MAKE_COMMANDS = new Set(['make', 'documentary', 'explainer'])

/** What a reply that changes nothing about a quote, or a Not now to a change read back, is answered with. */
const QUOTE_STANDS = 'The quote stands as it was. Press its button to make it, or tell me what to change: its length, its voice, its look.'

/** What any other reply to a waiting quote is answered with: only its button makes it. */
const QUOTE_WAITS = 'Tap the button above to go ahead, or tell me what to change. Nothing is spent until you tap it; say “never mind” to set it aside.'

/** "Later", "not yet", "let me think": nothing is decided, so what waits stays as it is. */
const QUOTE_LATER = 'It’s here when you’re ready.'

/** A no ("no", "never mind", "cancel") to a waiting quote: its button goes, and its script, paid for, stays to read. */
const QUOTE_ASIDE = 'All right, I’ve set that quote aside. Its script stays above to read, and nothing more is spent.'

/** A tap that would spend, while another chat opens. */
const ONE_MOMENT = 'One moment… another chat is opening, so that tap did nothing and nothing was spent.'

/** A quote kept in a chat that was closed when it came back: no button there to make it from. */
const CAME_AWAY = 'It came back after you left this chat, so it has no button. Ask again here and I’ll quote it fresh.'

/** Questions that came back for a chat already closed. */
const ASK_AWAY = 'You left this chat before I could ask about this video. Ask again here and I’ll ask fresh.'

/** A new video's quote, in a chat with an edit: the edit is never replaced. */
const NEW_CHAT = 'It goes in a new chat, so your edit here stays as it is.'

/** A new chat for a new video could not be made: so nothing was. */
const NO_NEW_CHAT = 'I couldn’t make a new chat for it, so nothing was made or spent, and your edit here stays as it is. Press its button to try again.'

/** Why no new chat was made for a new video, said in the chat that asked: by its quote's button, or by its ask. */
const notMoved = (why: 'busy' | 'failed' | 'overtaken', by: 'tap' | 'ask'): string => {
  const again = by === 'tap' ? 'Press its button again' : 'Ask again'
  if (why === 'busy') return `Something else is still running here, so I didn’t start your video and nothing was spent. ${again} once it’s done.`
  if (why === 'overtaken')
    return `You stayed in this chat, so I didn’t start your video and nothing was spent. ${by === 'tap' ? 'Press its button' : 'Ask again'} to make it in a new chat.`
  return by === 'tap' ? NO_NEW_CHAT : 'I couldn’t make a new chat for it, so nothing was written or spent, and your edit here stays as it is. Ask again in a moment.'
}

/** Where a paid result made for an edit not open went: that edit, in this chat, beside the one open. */
const besideLine = (doc: EditDoc): string => `It went into “${doc.title}”, the edit it was made for, not the one open now. Go back to the chat to see it.`

/** A new chat for a new video was overtaken by another chat being opened: so nothing was made. */
const NO_NEW_CHAT_AWAY = 'Another chat opened before the new one for your video was ready, so nothing was started or spent.'

/** What is typed in a chat whose make questions, read-back or quote expired when it was opened again. */
const EXPIRED_WAITS = 'What was waiting above has expired, so nothing is written or made from it. Ask again for a fresh quote, or say “never mind”.'

/** Each make message left waiting in a chat opened again, and what it says once expired. */
const EXPIRED = {
  questions: 'These questions have expired. Ask again and I’ll ask them fresh.',
  quote: 'This quote has expired. Ask again and I’ll quote it fresh.',
  back: 'This has expired. Say it again and I’ll read it back fresh.'
}

/** A quote of a made video's change, pressed with another edit open. */
const OTHER_EDIT = 'That quote is for another edit than the one open now, so nothing was made or spent. Open that edit and ask again.'

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

/** A quote's script, kept with its reply so it can be read once the quote has gone. */
const scriptOf = (d: Draft): ChatMessage['script'] =>
  d.script.trim() ? { outline: d.outline, sections: d.sections, phrases: d.phrases } : undefined

/** "your video about the oil boom", for saying where a video is. */
const aboutOf = (brief: Brief | null): string => {
  const topic = brief?.from === 'topic' ? cleanTopic(brief.topic) : ''
  return topic && topic !== 'what you asked for' ? `your video about ${topic}` : 'your video'
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** A chat's name for a video of its own: its topic, as the chat would be named had it been asked for there. */
const nameOf = (brief: Brief | null): string => {
  const topic = brief?.from === 'topic' ? cleanTopic(brief.topic) : ''
  return topic && topic !== 'what you asked for' ? capital(topic).slice(0, 60) : 'New video'
}

/** Said instead of asking main for anything while a video or a shot is made. */
const stillMaking = (run: { what: string; origin: Origin }): string =>
  `I’m still making ${run.what} in “${run.origin.project?.name ?? 'this chat'}”. Stop it, or wait until it’s done.`

/** A quote kept in a chat that was closed when it came back: what it said, and its script to read, with no button. */
const keptQuote = (draft: Draft, reply: Reply, text?: string): Omit<ChatMessage, 'id'> => ({
  role: 'assistant',
  text: text ?? reply.text,
  aside: [reply.aside, CAME_AWAY].filter(Boolean).join(' '),
  chips: reply.chips,
  details: reply.details,
  script: scriptOf(draft)
})

/** A reply kept in a chat that was closed when it came back. */
const keptReply = (reply: Reply, actions?: NonNullable<Msg['actions']>): Omit<ChatMessage, 'id'> => ({
  role: 'assistant',
  text: reply.text,
  aside: reply.aside,
  chips: reply.chips,
  details: reply.details,
  ...(actions ? { actions } : {})
})

export function useMake(deps: MakeDeps): Makes {
  const live = useRef(deps)
  live.current = deps
  /** Every quote shown, by its own key: its draft, the price its button showed, and its fingerprint. */
  const drafts = useRef(new Map<string, { draft: Draft; total: number; fingerprint: string; reply: Reply }>())
  /** Shot changes quoted, each with the edit it was quoted on: it is made only while that edit is open. */
  const changes = useRef(new Map<string, { change: ShotChange; doc: string }>())
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

  /** A short notice: a toast where there is one, else a reply. */
  const say = useCallback((text: string): void => {
    const { notify, push } = live.current
    if (notify) notify(text)
    else push({ role: 'assistant', text })
  }, [])

  /** Paid work under way, each its own token: one ending takes away only its own line and Stop. */
  const runs = useRef(new Set<Run>())
  const [runLine, setRunLine] = useState<{ what: string; stage: string | null } | null>(null)

  /** The work whose line shows wherever the person is: a video or a shot being made first, else the newest. */
  const shownRun = useCallback((): Run | null => {
    const all = [...runs.current]
    return all.filter((r) => r.kind === 'make' || r.kind === 'shot').pop() ?? all.pop() ?? null
  }, [])
  const showLine = useCallback((): void => {
    const r = shownRun()
    setRunLine(r ? { what: r.what, stage: r.stage } : null)
  }, [shownRun])

  /** A video tapped and being got ready (its new chat made, its file saved): it counts as being made from the tap on. */
  const claimed = useRef<{ what: string; origin: Origin } | null>(null)

  /** A video or a shot being made now, or tapped and being got ready: while one is, no other make is asked of main. */
  const making = useCallback(
    (): { what: string; origin: Origin } | null =>
      [...runs.current].find((r) => r.kind === 'make' || r.kind === 'shot') ?? claimed.current,
    []
  )

  /** Paid work begins in the chat open, its progress in `msg`. */
  const begin = useCallback(
    (kind: Run['kind'], what: string, name: string, msg: string): Run => {
      const run: Run = {
        kind,
        origin: { key: owner.current, project: live.current.project?.() ?? null, brand: live.current.brand() },
        what,
        name,
        stage: null,
        msg,
        msgKey: owner.current,
        mirror: null,
        mirrorKey: null
      }
      runs.current.add(run)
      showLine()
      return run
    },
    [showLine]
  )

  /** The line another chat shows while paid work runs in its own. */
  const awayLine = (run: Run): string =>
    `I’m working on ${run.what} in its chat${run.origin.project ? `, “${run.origin.project.name}”` : ''}. Stop it here if you like.`

  /** Its progress, on its own reply and on the line another chat shows. */
  const progressed = useCallback(
    (run: Run, p: NonNullable<Msg['progress']>): void => {
      const { patch } = live.current
      run.stage = p.stage
      if (run.msgKey === owner.current) patch(run.msg, { progress: p })
      showLine()
    },
    [showLine]
  )

  /** This work is over: only its own line and Stop go. */
  const end = useCallback(
    (run: Run): void => {
      if (runs.current.delete(run)) showLine()
    },
    [showLine]
  )

  /**
   * Where the chat a paid piece of work was asked in is now: still open, closed and opened again, or not open. A chat
   * being opened as it comes back is waited for, so it goes where that leaves it.
   */
  const whereIs = useCallback(
    async (o: Origin): Promise<'here' | 'back' | 'away'> => {
      if (live.current.switching?.()) await live.current.settled?.()
      if (still(o.key)) return 'here'
      const now = live.current.project?.()
      return o.project && now && now.path === o.project.path ? 'back' : 'away'
    },
    [still]
  )

  /** The reply in the chat open to show a result in: its own progress if it is there, else a new one. */
  const replyFor = useCallback((run: Run): string => {
    if (run.msgKey === owner.current) return run.msg
    return live.current.push({ role: 'assistant', text: '' })
  }, [])

  /**
   * What paid work brought back for a chat that is not the one open: kept in that chat's own file, and never in the
   * one open, which says where it is.
   */
  const away = useCallback(async (run: Run, kept: Omit<Kept, 'brand' | 'never'>, news: 'ready' | 'quote' | 'news', target?: string): Promise<void> => {
    const { keepFor, never, patch, push } = live.current
    const full: Kept = { ...kept, brand: run.origin.brand, never: never?.(run.origin.brand) ?? [] }
    // Never dropped: with no file of its own chat, or a new video for a chat with an edit, it goes in a new chat.
    const where = keepFor ? await keepFor(run.origin.project, run.name, full).catch(() => null) : null
    const elsewhere = !!where && where.path !== run.origin.project?.path
    const chat = where ? `${elsewhere ? 'a new chat' : 'its chat'}, “${where.name}”` : 'its chat'
    const text = !where
      ? news === 'ready'
        ? `${capital(run.what)} is made, but its chat was closed and I couldn’t keep it there.`
        : news === 'quote'
          ? `The quote for ${run.what} came back after its chat was closed, and I couldn’t keep it there.`
          : `What happened with ${run.what} came back after its chat was closed, and I couldn’t keep it there.`
      : news === 'ready'
        ? `${capital(run.what)} is ready in ${chat}.`
        : news === 'quote'
          ? `The quote for ${run.what} is in ${chat}.`
          : `What happened with ${run.what} is in ${chat}.`
    if (target) patch(target, { progress: null, text, actions: [] })
    else if (run.mirror && run.mirrorKey === owner.current) patch(run.mirror, { text, actions: [] })
    else push({ role: 'assistant', text })
  }, [])

  /** A quote shown: kept under a key of its own, with the price its button shows and what it said. */
  const keep = useCallback((draft: Draft, reply: Reply): string => {
    const key = newKey('quote')
    drafts.current.set(key, { draft, total: draft.quote.total, fingerprint: draftFingerprint(draft), reply })
    setVersion((n) => n + 1)
    return key
  }, [])

  /** The newest quote is this one: the button of the one before it goes, so only one quote can be made at a time. */
  const showing = useCallback((key: string, msg: string): void => {
    const was = pending.current
    // The one before keeps its words and its script to read; only its button goes.
    if (was && was.msg !== msg) live.current.patch(was.msg, { actions: [], make: undefined })
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
    // A new video, asked for in a chat with an edit: it goes in a chat of its own, and the quote says so.
    const elsewhere = !draft.into && !!live.current.docRef.current
    return {
      ...shown(reply),
      ...(elsewhere ? { aside: [reply.aside, NEW_CHAT].filter(Boolean).join(' ') } : {}),
      actions,
      make: key,
      script: scriptOf(draft)
    }
  }, [])

  /**
   * A new video asked for in a chat that has an edit: a chat of its own, made, saved and opened before anything is
   * spent, with what was asked (and its quote) in it, and a line in the chat left saying where it went. How it went.
   */
  const moveToNewChat = useCallback(async (brief: Brief | null, ask: string, quoted: Omit<ChatMessage, 'id'> | null): Promise<NewChat> => {
    const { newChat } = live.current
    if (!newChat) return { refused: 'failed' }
    const what = aboutOf(brief)
    const first: Omit<ChatMessage, 'id'>[] = [{ role: 'user', text: ask }, ...(quoted ? [quoted] : [])]
    const where = await newChat(nameOf(brief), first, (name) => ({
      role: 'assistant',
      text: `${capital(what)} goes in a new chat, “${name}”, so your edit here stays as it is.`
    })).catch(() => null)
    return where ?? { refused: 'failed' }
  }, [])

  /**
   * A paid result for edit X, back while another of its chat's edits is open (one of its clips): X's next version all
   * the same, put back in the chat beside the one open. Null when X is not in this chat.
   */
  const intoBeside = (docId: string, next: (x: EditDoc) => EditDoc): EditDoc | null => {
    const { chatEdit, putChatEdit } = live.current
    const x = chatEdit?.(docId)
    if (!x || !putChatEdit) return null
    const done = next(x)
    putChatEdit(done)
    return done
  }

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
          // Another of this chat's edits is open (one of its clips): X's next version all the same, beside it.
          const into = r.into
          const beside = intoBeside(into.docId, (x) => asNewVersion(x, r.doc, into.summary, into.carry))
          if (beside) {
            patch(msg, {
              ...shown(r.reply),
              text: `${renumber(r.reply.text, currentVersion(beside).n)} ${besideLine(beside)}`,
              actions: []
            })
            return
          }
          // Not in this chat at all: a whole video of its own all the same (go keeps it in a new chat first).
          patch(msg, { progress: null, text: 'The edit it was made for isn’t in this chat any more.', error: true })
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

  /**
   * A new video come back into a chat that has an edit (Settings changed while it was written, say): it never takes
   * that edit's place, so it is kept in a chat of its own, and this one says where.
   */
  const intrudes = (r: { doc: EditDoc; into: Draft['into'] | null }): boolean => {
    const d = live.current.docRef.current
    return !r.into && !!d && d.id !== r.doc.id
  }

  /** Makes a confirmed draft: the one its button showed, for the price it showed. */
  const go = useCallback(
    async (key: string): Promise<void> => {
      const { push, patch, during } = live.current
      // One video or shot at a time: nothing more is asked of main while one is made.
      const busy = making()
      if (busy) {
        push({ role: 'assistant', text: stillMaking(busy) })
        return
      }
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
      // A change of a made video is made only into that video: with another edit open, nothing is spent on it.
      const into = entry.draft.into
      if (into && live.current.docRef.current?.id !== into.docId) {
        push({ role: 'assistant', text: OTHER_EDIT })
        return
      }
      // Anything else paid under way (a script being written): main does one at a time, so nothing is got ready for it.
      const other = [...runs.current][0]
      if (other) {
        push({ role: 'assistant', text: `I’m still working on ${other.what}. Wait for it, or stop it first.` })
        return
      }
      // What was read back and not confirmed goes: the quote is made as it was quoted.
      if (back.current) {
        patch(back.current.msg, { actions: [] })
        back.current = null
      }
      const quoteAt = pending.current.msg
      patch(quoteAt, { actions: [], make: undefined })
      pending.current = null
      const mine = owner.current
      // From the tap on it counts as being made: nothing else is asked of main while its chat is got ready.
      claimed.current = { what: aboutOf(entry.draft.brief), origin: { key: mine, project: live.current.project?.() ?? null, brand: live.current.brand() } }
      let begun: Run | null = null
      try {
        // A new video never takes the place of an edit: with one here, it is made in a chat of its own, made, saved
        // and opened now, before anything is spent, and what was asked and its quote go with it.
        if (!into && live.current.docRef.current) {
          const quoted = { ...keptReply(entry.reply), script: scriptOf(entry.draft) }
          const moved = await moveToNewChat(entry.draft.brief, entry.draft.brief.ask, quoted)
          if ('refused' in moved) {
            // Nothing was started or spent. Still here, its quote keeps its button to try again; somewhere else, it
            // says so where the person is.
            if (still(mine)) {
              showing(key, quoteAt)
              live.current.patch(quoteAt, quoteMsg(key, entry.draft, entry.reply))
              live.current.push({ role: 'assistant', text: notMoved(moved.refused, 'tap') })
            } else say(NO_NEW_CHAT_AWAY)
            return
          }
        }
        // Its chat has a file before anything is spent, so what comes back always has somewhere to go.
        await live.current.ensureChat?.(nameOf(entry.draft.brief))
        const msg = live.current.push({
          role: 'assistant',
          text: '',
          progress: { stage: 'Starting', percent: null },
          actions: STOP
        })
        begun = begin('make', aboutOf(entry.draft.brief), nameOf(entry.draft.brief), msg)
      } finally {
        claimed.current = null
      }
      if (!begun) return
      const run = begun
      const off = api.onCutProgress((p) => progressed(run, p))
      let r: Awaited<ReturnType<typeof api.makeGo>>
      try {
        r = await during(() => api.makeGo({ draft: entry.draft, confirmed: entry.total, fingerprint: entry.fingerprint, consent: 'tap' }))
      } catch (err) {
        r = { ok: false, message: errorText(err) }
      } finally {
        off()
        end(run)
      }
      drafts.current.delete(key)
      // Its chat is not the one open now: what it made is kept in that chat, never in this one.
      const where = await whereIs(run.origin)
      if (where === 'away') {
        if (r.ok) await away(run, { message: keptReply(r.reply, OPEN), doc: r.doc, into: r.into }, 'ready')
        else
          await away(
            run,
            { message: r.draft && r.reply ? keptQuote(r.draft, r.reply, r.message) : { role: 'assistant', text: r.message, error: true } },
            'news'
          )
        return
      }
      if (where === 'back') sync()
      const at = replyFor(run)
      if (!r.ok) {
        // A new price, another service, or the rest after a Stop: a new quote, with its own button.
        if (r.draft && r.reply) {
          const next = keep(r.draft, r.reply)
          showing(next, at)
          live.current.patch(at, { ...quoteMsg(next, r.draft, r.reply), text: r.message })
        } else live.current.patch(at, { progress: null, text: r.message, error: true })
        return
      }
      if (intrudes(r)) {
        await away(run, { message: keptReply(r.reply, OPEN), doc: r.doc, into: null }, 'ready', at)
        return
      }
      // A change of a made video whose edit is not the one open goes into that edit all the same, in this chat (land:
      // one of its clips is open). With that edit nowhere in this chat, it is a whole video of its own, in a new chat.
      const { chatEdit, putChatEdit } = live.current
      if (r.into && live.current.docRef.current?.id !== r.into.docId && !(putChatEdit && chatEdit?.(r.into.docId))) {
        await away(run, { message: keptReply(r.reply, OPEN), doc: r.doc, into: r.into }, 'ready', at)
        return
      }
      land(r, at)
    },
    [away, begin, end, keep, land, making, moveToNewChat, progressed, quoteMsg, replyFor, say, showing, still, sync, whereIs]
  )

  const quote = useCallback(
    async (msg: string, draft: Draft, reply: Reply): Promise<string> => {
      const key = keep(draft, reply)
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
      const { during } = live.current
      // One video or shot at a time: nothing more is asked of main while one is made.
      const busy = making()
      if (busy) {
        live.current.push({ role: 'assistant', text: stillMaking(busy) })
        return
      }
      if (consent === 'tap') restored.current = false
      const brief = readAsk(reading ?? text, { recording })
      // A new video never takes the place of an edit. Where Settings may make it straight away, it goes in a chat of
      // its own now, before anything is spent; otherwise its quote says it will, and its button moves it.
      if (!quoteFirst && live.current.docRef.current && (await live.current.goAhead?.())) {
        const mine = owner.current
        const moved = await moveToNewChat(brief, text, null)
        if ('refused' in moved) {
          if (still(mine)) live.current.push({ role: 'assistant', text: notMoved(moved.refused, 'ask') })
          else say(NO_NEW_CHAT_AWAY)
          return
        }
      }
      // Its chat has a file before Claude is asked anything, so what comes back always has somewhere to go.
      await live.current.ensureChat?.(nameOf(brief))
      // Writing the script spends, and Settings may make the video straight after: Stop stays in reach.
      const msg = live.current.push({
        role: 'assistant',
        text: '',
        progress: { stage: 'Reading what you asked for', percent: null },
        actions: STOP
      })
      const run = begin('script', aboutOf(brief), nameOf(brief), msg)
      const off = api.onCutProgress((p) => progressed(run, p))
      let r: Awaited<ReturnType<typeof api.makeStart>>
      try {
        r = await during(() =>
          api.makeStart({ text, recording, brand: live.current.brand(), answered, quoteFirst, consent, ...(reading ? { reading } : {}) })
        )
      } catch (err) {
        r = { ok: false, message: errorText(err) }
      } finally {
        off()
        end(run)
      }
      // Its chat is not the one open now: what came back is kept in that chat, never in this one.
      const where = await whereIs(run.origin)
      if (where === 'away') {
        if (!r.ok)
          await away(
            run,
            { message: r.draft && r.reply ? keptQuote(r.draft, r.reply, r.message) : { role: 'assistant', text: r.message, error: true } },
            'news'
          )
        else if (r.kind === 'ask') await away(run, { message: { role: 'assistant', text: ASK_AWAY } }, 'news')
        else if (r.kind === 'quote') await away(run, { message: keptQuote(r.draft, r.reply) }, 'quote')
        else await away(run, { message: keptReply(r.reply, OPEN), doc: r.doc, into: r.into }, 'ready')
        return
      }
      if (where === 'back') sync()
      const { patch } = live.current
      const at = replyFor(run)
      if (!r.ok) {
        // Made straight away and stopped: what was spent, and a quote for the rest, with its own button.
        if (r.draft && r.reply) {
          await quote(at, r.draft, r.reply)
          patch(at, { text: r.message })
        } else patch(at, { progress: null, text: r.message, error: true, actions: [] })
        return
      }
      if (r.kind === 'ask') {
        // Nothing is written yet: the questions wait under this reply, and so does what was asked.
        const id = `ask-${Date.now()}`
        asking.current = { id, msg: at, text, recording, questions: r.questions }
        setVersion((n) => n + 1)
        patch(at, {
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
        await quote(at, r.draft, r.reply)
        return
      }
      if (intrudes(r)) {
        await away(run, { message: keptReply(r.reply, OPEN), doc: r.doc, into: null }, 'ready', at)
        return
      }
      land(r, at)
    },
    [away, begin, end, land, making, moveToNewChat, progressed, quote, replyFor, sync, whereIs]
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
      // Another chat is opening: what the answers would write waits until it has.
      if (live.current.switching?.()) {
        say(ONE_MOMENT)
        return
      }
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
    [askBack, dropBack, say, start, sync]
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
      // One video or shot at a time: nothing more is asked of main while one is made.
      const busy = making()
      if (busy) {
        push({ role: 'assistant', text: stillMaking(busy) })
        return
      }
      const draft = drafts.current.get(b.id)?.draft
      if (!draft || pending.current?.id !== b.id) {
        push({ role: 'assistant', text: 'A newer quote replaced that one. Tell me the change again and I’ll read it back.' })
        return
      }
      requoting.current = b.id
      // A script written again is paid for: Stop stays in reach.
      const msg = push({ role: 'assistant', text: '', progress: { stage: 'Quoting it again', percent: null }, actions: STOP })
      const run = begin('requote', aboutOf(draft.brief), nameOf(draft.brief), msg)
      const off = api.onCutProgress((p) => progressed(run, p))
      let r: Awaited<ReturnType<typeof api.makeRevise>>
      try {
        r = await during(() => api.makeRevise({ draft, steps: b.steps, consent: 'tap' }))
      } catch (err) {
        r = { ok: false, message: errorText(err) }
      } finally {
        off()
        end(run)
        if (requoting.current === b.id) requoting.current = null
      }
      // Its chat is not the one open now: the new quote, and its script, are kept in that chat, never in this one.
      const where = await whereIs(run.origin)
      if (where === 'away') {
        if (r.draft && r.reply) await away(run, { message: keptQuote(r.draft, r.reply, r.ok ? undefined : r.message) }, 'quote')
        else await away(run, { message: { role: 'assistant', text: r.ok ? 'I could not quote that again.' : r.message, error: true } }, 'news')
        return
      }
      if (where === 'back') sync()
      const at = replyFor(run)
      if (!r.ok && r.draft && r.reply) {
        // Stopped or failed after Claude began: the same script, quoted with what that may have cost.
        await quote(at, r.draft, r.reply)
        patch(at, { text: r.message })
        return
      }
      if (!r.ok || !r.draft) {
        patch(at, { progress: null, text: r.ok ? 'I could not quote that again.' : r.message, error: true, actions: [] })
        return
      }
      await quote(at, r.draft, r.reply)
    },
    [away, begin, end, making, progressed, quote, replyFor, sync, whereIs]
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
          if (pending.current) patch(pending.current.msg, { actions: [], make: undefined })
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
    // One video or shot at a time: nothing more is asked of main while one is made.
    const busy = making()
    if (busy) {
      push({ role: 'assistant', text: stillMaking(busy) })
      return
    }
    const kept = changes.current.get(key)
    const d = docRef.current
    if (!kept || !d?.make) {
      push({
        role: 'assistant',
        text: 'That quote is from another chat, or from before Cutalong restarted, or a newer one replaced it. Ask again and I’ll quote it fresh.'
      })
      return
    }
    // Quoted on another edit than the one open: its shot is that edit's, so nothing is spent on it here.
    if (kept.doc !== d.id) {
      push({ role: 'assistant', text: OTHER_EDIT })
      return
    }
    const change = kept.change
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
    const run = begin('shot', `a shot of ${aboutOf(d.make.brief)}`, nameOf(d.make.brief), msg)
    const off = api.onCutProgress((p) => progressed(run, p))
    let r: Awaited<ReturnType<typeof api.makeShot>>
    try {
      r = await during(() => api.makeShot({ doc: d, change, confirmed: change.total, consent: 'tap' }))
    } catch (err) {
      r = { ok: false, message: errorText(err) }
    } finally {
      off()
      end(run)
    }
    changes.current.delete(key)
    // Its chat is not the one open now: the shot goes into that chat's edit, never into this one.
    const where = await whereIs(run.origin)
    if (where === 'away') {
      if (r.ok)
        await away(
          run,
          { message: keptReply(r.reply, OPEN), shot: { doc: d.id, asset: r.asset, ops: r.ops, make: r.make, summary: r.summary } },
          'ready'
        )
      else await away(run, { message: { role: 'assistant', text: r.message, error: true } }, 'news')
      return
    }
    if (where === 'back') sync()
    const at = replyFor(run)
    if (!r.ok) {
      patch(at, { progress: null, text: r.message, error: true })
      return
    }
    const latest = docRef.current
    if (!latest || latest.id !== d.id) {
      // Another of this chat's edits is open (one of its clips): the shot goes into X all the same, beside it; with X
      // in this chat no more, it is in no edit, and its picture is said where it is kept.
      const shot = { doc: d.id, asset: r.asset, ops: r.ops, make: r.make, summary: r.summary }
      let version: number | null = null
      const beside = intoBeside(d.id, (x) => {
        const made = shotInto(x, shot, live.current.never?.(run.origin.brand) ?? [])
        version = made.version
        return made.doc
      })
      patch(at, {
        ...shown(r.reply),
        text: beside
          ? `${version ? `v${version} is ready. ` : ''}${r.reply.text} ${besideLine(beside)}`
          : `${r.reply.text} ${shotKeptAt(r.asset.path)}`,
        actions: []
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
    patch(at, {
      ...shown(r.reply),
      text: done ? `v${done.n} is ready. ${r.reply.text}` : r.reply.text,
      actions: OPEN
    })
  }, [away, begin, end, making, progressed, replyFor, sync, whereIs])

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
      changes.current.set(key, { change, doc: docRef.current?.id ?? '' })
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
        const busy = making()
        if (busy) {
          push({ role: 'assistant', text: stillMaking(busy) })
          return true
        }
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
        // Words that only put things off ("hold on", "not yet") or only say no come out first, and what is left is read
        // for a change, so a change said with them ("hold on, make it 3 minutes") is never lost.
        const parts = quoteReplyParts(text)
        if (!parts.says) {
          // Not decided yet ("later", "no, not now"): the quote, and anything read back of it, stay as they are.
          if (parts.later) {
            push({ role: 'assistant', text: QUOTE_LATER })
            return true
          }
          // Only a no ("no", "never mind", "cancel"): to what was read back of it, that goes and the quote stands; to
          // the quote, its button goes, and its script, paid for, stays to read.
          if (parts.no) {
            if (back.current) {
              dropBack()
              push({ role: 'assistant', text: QUOTE_STANDS })
              return true
            }
            if (openScript === waiting.id) setOpenScript(null)
            patch(waiting.msg, { actions: [], make: undefined })
            pending.current = null
            push({ role: 'assistant', text: QUOTE_ASIDE })
            return true
          }
        }
        const waitingBack = back.current?.kind === 'quote' && back.current.id === waiting.id ? back.current : null
        const words = quoteWords(parts.says ? parts.rest : text)
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
        // Words that ask for a change it cannot place ("make it shorter"): never let go, and the quote stays as it was,
        // said so, so its button never makes what was just asked to be changed.
        if (files.length === 0 && parts.says && looksLikeChange(parts.rest)) {
          push({ role: 'assistant', text: unplacedChange(parts.rest) })
          return true
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
        // Not decided yet: a read-back waits as it is; what expired stays expired.
        if (isDeferral(text)) {
          push({ role: 'assistant', text: back.current ? QUOTE_LATER : EXPIRED_WAITS })
          return true
        }
        if (said.kind === 'no') {
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
    [askBack, dropBack, making, newAskBack, offer, openScript, start, still, sync]
  )

  const asked = useCallback(
    async (text: string, onScreen: string | null = null): Promise<boolean> => {
      sync()
      const { docRef, push } = live.current
      const d = docRef.current
      if (!d?.make || !text.trim()) return false
      // A change of the made video, asked while a video or a shot is made: nothing more is asked of main till it is.
      const busy = making()
      if (busy && readMakeAsk(d.make, text, onScreen)) {
        push({ role: 'assistant', text: stillMaking(busy) })
        return true
      }
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
    [making, offer, still, sync]
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
      // Another chat is opening: a tap that would write, change or make anything does nothing until it has.
      if (p.do !== 'script' && live.current.switching?.()) {
        say(ONE_MOMENT)
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
    [go, onBack, reshoot, say, sync, toggleScript]
  )

  const editScript = useCallback(
    async (id: string, script: string): Promise<void> => {
      sync()
      const { push, patch } = live.current
      const draft = drafts.current.get(id)?.draft
      if (!draft) return
      const busy = making()
      if (busy) {
        push({ role: 'assistant', text: stillMaking(busy) })
        return
      }
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
    [making, quote, still, sync]
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
        if (!m.makeAsk && makes.length === 0 && !m.make) return m
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
      // Paid work still under way: in its own chat opened again, its progress and Stop; in any other, a line with its
      // Stop. Either way it shows wherever the person is, and what it brings back goes to its own chat.
      const run = shownRun()
      if (run) {
        const id = newKey('run')
        const own = !!run.origin.project && live.current.project?.()?.path === run.origin.project.path
        if (own) {
          run.msg = id
          run.msgKey = owner.current
          out.push({ id, role: 'assistant', text: '', progress: { stage: run.stage ?? 'Working on it', percent: null }, actions: STOP })
        } else {
          run.mirror = id
          run.mirrorKey = owner.current
          out.push({ id, role: 'assistant', text: awayLine(run), actions: STOP_AWAY })
        }
      }
      return out
    },
    [shownRun, sync]
  )

  const stop = useCallback(async (): Promise<void> => {
    await api.makeCancel()
  }, [])
  // Read from the work itself, so a check made straight after it begins sees it; its line re-renders what shows it.
  const runningNow = useCallback((): { what: string; stage: string | null } | null => {
    const r = shownRun()
    return r ? { what: r.what, stage: r.stage } : null
  }, [runLine, shownRun])

  return useMemo(
    () => ({ handle, asked, onAction, draft, editScript, scriptOpen, questions, answer, restore, running: runningNow, stop }),
    [handle, asked, onAction, draft, editScript, scriptOpen, questions, answer, restore, runningNow, stop]
  )
}
