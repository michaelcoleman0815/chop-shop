import { CAPTION_POSITIONS } from '../edit/schema'
import { classify, type Signal } from './signals'

/**
 * From what someone did to plain statements about how they edit, each with
 * the evidence behind it: "You undo zoom punch-ins (3 of 4)", "You keep your
 * laughs (4 times)", "Captions at chest height (every edit)".
 *
 * Local rules only; nothing here calls anything. A statement needs more than
 * one sighting (or the person's own voice notes), and anything the person
 * later contradicts drops away: only the evidence since the last time they
 * went the other way counts.
 */

export type CaptionPosition = (typeof CAPTION_POSITIONS)[number]

export interface Preference {
  /** A topic and the way it goes: "zoom:less", "captions-position:chest". Stable, so it can be deleted or edited. */
  id: string
  topic: string
  value: string
  /** The statement with its evidence. */
  text: string
  n: number
  /** Out of how many chances, when that is known (undo counts). */
  of: number | null
  /** More and stronger evidence first. */
  weight: number
  /** A brand setting it maps to, if any. */
  setting: { captions: { position?: CaptionPosition; wordsPerScreen?: number } } | null
}

/** What undoing a version with each tag says. */
const UNDONE: Record<string, { topic: string; value: string; phrase: string }> = {
  'punch-in': { topic: 'zoom', value: 'less', phrase: 'zoom punch-ins' },
  bw: { topic: 'bw', value: 'less', phrase: 'black and white' },
  'big-word': { topic: 'big-words', value: 'less', phrase: 'big words on screen' },
  'captions-off': { topic: 'captions', value: 'on', phrase: 'turning captions off' },
  'tight-cuts': { topic: 'pauses', value: 'keep', phrase: 'very tight cuts' },
  'fillers-cut': { topic: 'fillers', value: 'keep', phrase: 'cutting the ums' },
  reorder: { topic: 'order', value: 'keep', phrase: 'moving lines around' },
  broll: { topic: 'broll', value: 'less', phrase: 'cutaways' }
}

const POSITION_WORDS: Record<string, string> = {
  top: 'at the top',
  middle: 'in the middle',
  chest: 'at chest height',
  bottom: 'low in frame'
}

/** What was said, in the app's words. */
function said(topic: string, value: string): string | null {
  switch (`${topic}:${value}`) {
    case 'pauses:keep':
      return 'You keep your pauses'
    case 'pauses:cut':
      return 'You like pauses cut tight'
    case 'pace:slower':
      return 'You like a slower pace'
    case 'pace:faster':
      return 'You like a faster pace'
    case 'caption-size:bigger':
      return 'Bigger captions'
    case 'caption-size:smaller':
      return 'Smaller captions'
    case 'laughs:keep':
      return 'You keep your laughs'
    case 'laughs:cut':
      return 'You cut the laughs'
    case 'zoom:less':
      return 'No zoom punch-ins'
    case 'zoom:more':
      return 'More zoom punch-ins'
    case 'bw:less':
      return 'You keep it in colour'
    case 'bw:more':
      return 'More black and white'
    case 'fillers:keep':
      return 'You keep the ums'
    case 'fillers:cut':
      return 'You cut the ums'
    case 'take:earlier':
      return 'You often pick an earlier take'
    case 'take:later':
      return 'You pick the later take'
    case 'captions:off':
      return 'No captions'
    case 'captions:on':
      return 'Captions on'
  }
  if (topic === 'captions-position' && POSITION_WORDS[value]) return `Captions ${POSITION_WORDS[value]}`
  // As the rest of the app says it: "2-word captions".
  if (topic === 'captions-words') return value === '1' ? 'One-word captions' : `${value}-word captions`
  return null
}

interface Evidence {
  value: string
  at: string
  kind: 'said' | 'voice' | 'undo' | 'chosen'
  doc?: string
}

/** A version someone made: by asking, by a slash command, or by carrying out notes. */
interface Made {
  doc: string
  at: string
  version: number
  tags: string[]
  /** Put on by the brand rather than chosen. */
  brand: boolean
}

type Of<K extends Signal['kind']> = Extract<Signal, { kind: K }>

const times = (n: number): string => (n === 1 ? 'once' : `${n} times`)

export function distill(signals: Signal[]): Preference[] {
  const sorted = [...signals].sort((a, b) => a.at.localeCompare(b.at))
  const evidence = new Map<string, Evidence[]>()
  const add = (topic: string, e: Evidence): void => {
    const list = evidence.get(topic)
    if (list) list.push(e)
    else evidence.set(topic, [e])
  }
  // Versions with each tag, and when: for "of how many" on undo counts.
  const applied = new Map<string, string[]>()

  // Undone: a version whose change was taken back.
  const undos = sorted.filter((s): s is Of<'undo'> => s.kind === 'undo')
  const undoOf = (v: { doc: string; at: string; version?: number | null }): Of<'undo'> | undefined => {
    const n = v.version
    return n === null || n === undefined
      ? undefined
      : undos.find((u) => u.doc === v.doc && u.at >= v.at && u.from >= n && u.to < n)
  }

  // Said: requests and the notes people write. A request whose result they
  // then undid no longer says they want it, nor does a note they took away
  // or whose version they undid. Voice notes are what they say now.
  const notes = sorted.filter((s): s is Of<'note'> => s.kind === 'note')
  const heard = (s: Of<'request'> | Of<'note'>): void => {
    for (const c of classify(s.text)) add(c.topic, { value: c.value, at: s.at, kind: 'said', doc: s.doc })
  }
  for (const s of sorted) {
    if (s.kind === 'request' && !undoOf(s)) heard(s)
    if (s.kind === 'note' && s.status === 'added') {
      const after = notes.filter((o) => o.doc === s.doc && o.text === s.text && o.at >= s.at && o.status !== 'added')
      const carried = after.find((o) => o.status === 'applied')
      if (!after.some((o) => o.status === 'dismissed') && !(carried && undoOf(carried))) heard(s)
    }
  }
  const voice = [...sorted].reverse().find((s): s is Of<'voice'> => s.kind === 'voice')
  if (voice) for (const c of classify(voice.text)) add(c.topic, { value: c.value, at: voice.at, kind: 'voice' })

  // Each version once, however many notes it carried out.
  const made = new Map<string, Made>()
  for (const s of sorted) {
    if (s.kind !== 'request' && s.kind !== 'command' && !(s.kind === 'note' && s.status === 'applied')) continue
    if (s.version === null || s.version === undefined || made.has(`${s.doc}:${s.version}`)) continue
    made.set(`${s.doc}:${s.version}`, {
      doc: s.doc,
      at: s.at,
      version: s.version,
      tags: s.tags ?? [],
      brand: s.kind === 'command' && s.command === 'brand'
    })
  }
  for (const v of made.values()) {
    const undo = undoOf(v)
    for (const tag of v.tags) {
      const meaning = UNDONE[tag]
      if (!meaning) continue
      const list = applied.get(meaning.topic) ?? []
      list.push(v.at)
      applied.set(meaning.topic, list)
      // Dated from the change itself, so "of how many" counts it among the changes.
      if (undo) add(meaning.topic, { value: meaning.value, at: v.at, kind: 'undo', doc: v.doc })
    }
    // Chosen: caption settings asked for by name (not put on by the brand), and kept.
    if (!undo && !v.brand) {
      for (const tag of v.tags) {
        const m = /^captions-(position|words):(.+)$/.exec(tag)
        if (m)
          add(m[1] === 'position' ? 'captions-position' : 'captions-words', {
            value: m[2],
            at: v.at,
            kind: 'chosen',
            doc: v.doc
          })
      }
    }
  }
  // The versions people left their edits on, to say "every edit" only when it is so.
  const keeps = sorted.filter((s): s is Of<'keep'> => s.kind === 'keep')

  const prefs: Preference[] = []
  for (const [topic, unordered] of evidence) {
    const list = [...unordered].sort((a, b) => a.at.localeCompare(b.at))
    // Only what has happened since the person last went the other way.
    const latest = list[list.length - 1].value
    let start = list.length - 1
    while (start > 0 && list[start - 1].value === latest) start--
    const window = list.slice(start)
    const since = window[0].at
    const saidN = window.filter((e) => e.kind === 'said').length
    const voiced = window.some((e) => e.kind === 'voice')
    const undoN = window.filter((e) => e.kind === 'undo').length
    const docs = [...new Set(window.filter((e) => e.kind === 'chosen').map((e) => e.doc))]
    const chances = (applied.get(topic) ?? []).filter((t) => t >= since).length
    const allDocs = new Set(list.filter((e) => e.kind === 'chosen').map((e) => e.doc)).size
    const id = `${topic}:${latest}`
    const words = said(topic, latest)
    const meaning = Object.values(UNDONE).find((u) => u.topic === topic && u.value === latest)

    let text: string | null = null
    let n = 0
    let of: number | null = null
    let weight = 0
    if (meaning && undoN >= 2 && undoN >= saidN && chances > 0 && undoN / chances >= 0.6) {
      text = `You undo ${meaning.phrase} (${undoN} of ${chances})`
      n = undoN
      of = chances
      weight = 1.5 * undoN + saidN
    } else if (words && docs.length >= 2) {
      // A setting chosen and kept across edits says more than how often it was asked for.
      const field = topic === 'captions-position' ? 'position' : 'wordsPerScreen'
      const keptOtherwise = keeps.some((k) => k.at >= since && k.captions.on && String(k.captions[field]) !== latest)
      const span =
        docs.length < allDocs ? `the last ${docs.length} edits` : keptOtherwise ? `${docs.length} edits` : 'every edit'
      text = `${words} (${span})`
      n = docs.length
      weight = 1.2 * docs.length + saidN
    } else if (words && (saidN >= 2 || voiced)) {
      text = saidN >= 2 ? `${words} (${times(saidN)})` : `${words} (in your voice notes)`
      n = saidN
      weight = saidN + (voiced ? 2 : 0) + undoN
    }
    if (!text) continue

    let setting: Preference['setting'] = null
    if (topic === 'captions-position' && (CAPTION_POSITIONS as readonly string[]).includes(latest)) {
      setting = { captions: { position: latest as CaptionPosition } }
    } else if (topic === 'captions-words' && /^[1-4]$/.test(latest)) {
      setting = { captions: { wordsPerScreen: Number(latest) } }
    }
    prefs.push({ id, topic, value: latest, text, n, of, weight, setting })
  }

  // Slash commands someone reaches for on most edits.
  const commandDocs = new Map<string, Set<string>>()
  const docsWithCommands = new Set<string>()
  for (const s of sorted) {
    if (s.kind !== 'command' || s.command === 'brand') continue
    docsWithCommands.add(s.doc)
    const set = commandDocs.get(s.command) ?? new Set<string>()
    set.add(s.doc)
    commandDocs.set(s.command, set)
  }
  for (const [command, docs] of commandDocs) {
    if (docs.size < 3 || docs.size / docsWithCommands.size < 0.6) continue
    prefs.push({
      id: `command:${command}`,
      topic: 'command',
      value: command,
      text: `You use /${command} on most edits (${docs.size} of ${docsWithCommands.size})`,
      n: docs.size,
      of: docsWithCommands.size,
      weight: 0.5 * docs.size,
      setting: null
    })
  }

  return prefs.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
}
