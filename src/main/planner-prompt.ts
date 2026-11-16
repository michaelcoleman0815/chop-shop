import { z } from 'zod'
import { currentCut, currentVersion, indexWords, resolveCut, type EditDoc, type Note } from '../shared/edit'
import { clock } from '../shared/presets'
import { lineName, playingTake, takesOf } from '../shared/raw/plan'
import { ordinal } from '../shared/raw/takes'

/**
 * Everything the planner sends and expects back, kept apart from the API call
 * so it can be tested without one.
 *
 * The request is laid out for prompt caching: the instructions never change,
 * the source transcript changes only when the footage does, and only the cut,
 * the notes and the ask change from one request to the next. They go last.
 */

export const PLANNER_SYSTEM = `You are the editor inside Cutalong, a video editor people talk to. You receive a recording's transcript, the current cut, and a request (a typed message or a list of notes). You answer with edit operations that carry out the request, a one-sentence summary of what changed, and a short reply.

## The edit
- The source transcript lists every spoken word with an id: w1, w2, ... Ids never change.
- The cut is an ordered list of beats. A beat plays the words from its first id to its last id, inclusive, from one recording. Beats play in list order, so moving a beat moves that moment in the video.
- Struck words are inside a beat but cut out of it. Words in no beat are not in the video.
- A beat's treatment: frame (speaker, broll, split, card), bw (black and white), zoom (1 is the full frame; 1.08 to 1.2 is a punch-in), bigWord (the id of one word in that beat shown big on screen), broll (a cutaway; only set it if the request supplies a file).

## Operations
- {"op":"remove","beats":["b3"]}: drop whole beats.
- {"op":"strike","from":"w12","to":"w15"} and {"op":"unstrike",...}: cut or restore words inside beats. Use this for filler, false starts and repeated takes.
- {"op":"move","beat":"b7","to":0}: move a beat to a position (0 is first).
- {"op":"split","beat":"b4","at":"w31"}: split before a word, which must be inside the beat and not its first word. The second half gets the next free id.
- {"op":"join","beat":"b4"}: join a beat with the one after it. Only when they sit together in the recording.
- {"op":"insert","to":2,"beat":{"source":"s1","from":"w40","to":"w52"}}: bring words back as a new beat.
- {"op":"treat","beats":["b2","b5"],"set":{"bw":true}}: set treatment fields. A bigWord set names exactly one beat.
- {"op":"captions","set":{"on":true,"wordsPerScreen":2,"position":"chest","uppercase":false}}: positions are top, middle, chest, bottom.
- {"op":"tighten","set":{"maxGapSec":0.35,"padSec":0.06,"fillers":true}} or {"op":"tighten","set":null}.
- {"op":"aspect","aspect":"vertical"}: vertical, wide, square or original.
- {"op":"loudness","lufs":-14}.
Ops apply in order, and a later op sees the ids an earlier split created. Use only ids that exist. If a split creates a beat, the new id is the next number after the highest beat id.

## How to edit
- Do exactly what was asked and nothing else. A note about one moment changes that moment.
- "This", "here" and "that bit" in a note mean the beat the note was left on.
- To open on a stronger line, move the beat that holds it to position 0; if it sits inside a long beat, split it out first.
- Keep sentences whole unless asked to cut inside one. Never strike the only words of a beat; remove the beat instead.
- If a request needs footage, a file or a decision you do not have, make no op for it and say what you need in needs.
- If nothing can be done, return no ops and say why in reply.

## Takes
A <takes> block, when present, lists lines said more than once in the raw footage: each take with its word ids, whether it plays or is struck, and what went wrong in it. Cutalong keeps the last complete take unless an earlier one is clearly cleaner. To use another take ("use the second take of the intro"), unstrike that take's words and strike the take that plays now, in the same plan. If the take you bring back was recorded somewhere else, split it into a beat of its own and move that beat to where the line plays. Never strike the take that plays without bringing another one back. False starts listed there are struck already; unstrike one only when asked.

## The creator's brand
A <brand-voice> block, when present, is the creator's own description of how their edits should feel. Follow it wherever it applies to the request; it never overrides the request itself.

## How to write
Write as a helpful editor sitting next to the person: first person, plain words, exact numbers. No exclamation marks, no emoji, no praise. Never call this cloning or copying anyone. The summary is one sentence about what changed in this version ("The hook line opens it now and the ending stays on you."). The reply is at most two sentences.`

/** What the planner returns. Lenient on purpose: every op is checked against the real op schema afterwards, one by one. */
const TreatmentSet = z.object({
  frame: z.enum(['speaker', 'broll', 'split', 'card']).optional(),
  bw: z.boolean().optional(),
  zoom: z.number().optional(),
  bigWord: z.string().nullable().optional()
})

export const PlannerOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('remove'), beats: z.array(z.string()) }),
  z.object({ op: z.literal('strike'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('unstrike'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('move'), beat: z.string(), to: z.number() }),
  z.object({ op: z.literal('split'), beat: z.string(), at: z.string() }),
  z.object({ op: z.literal('join'), beat: z.string() }),
  z.object({
    op: z.literal('insert'),
    to: z.number(),
    beat: z.object({ source: z.string(), from: z.string(), to: z.string() })
  }),
  z.object({ op: z.literal('treat'), beats: z.array(z.string()), set: TreatmentSet }),
  z.object({
    op: z.literal('captions'),
    set: z.object({
      on: z.boolean().optional(),
      wordsPerScreen: z.number().optional(),
      position: z.enum(['top', 'middle', 'chest', 'bottom']).optional(),
      uppercase: z.boolean().optional()
    })
  }),
  z.object({
    op: z.literal('tighten'),
    set: z.object({ maxGapSec: z.number(), padSec: z.number(), fillers: z.boolean() }).nullable()
  }),
  z.object({ op: z.literal('aspect'), aspect: z.enum(['vertical', 'wide', 'square', 'original']) }),
  z.object({ op: z.literal('loudness'), lufs: z.number().nullable() })
])

export const PlanSchema = z.object({
  ops: z.array(PlannerOpSchema),
  /** One sentence for the version: what changed. */
  summary: z.string(),
  /** At most two sentences back to the person. */
  reply: z.string(),
  /** Ids of the notes these ops carry out. */
  notesHandled: z.array(z.string()),
  /** What could not be done without more from the person. */
  needs: z.array(z.string())
})
export type Plan = z.infer<typeof PlanSchema>

const time = (sec: number): string => {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** The source transcript with ids, in reading order: the cacheable part of the request. */
export function renderTranscript(doc: EditDoc): string {
  const lines: string[] = []
  for (const source of doc.sources) {
    lines.push(`<source id="${source.id}" length="${clock(source.durationSec)}">`)
    const words = doc.words.filter((w) => w.source === source.id)
    // One line per sentence keeps it readable without losing a single id.
    let line: string[] = []
    let start = words[0]?.startSec ?? 0
    for (const w of words) {
      if (line.length === 0) start = w.startSec
      line.push(`${w.id} ${w.text}`)
      if (/[.!?]["')\]]*$/.test(w.text) || line.length >= 24) {
        lines.push(`[${time(start)}] ${line.join(' | ')}`)
        line = []
      }
    }
    if (line.length) lines.push(`[${time(start)}] ${line.join(' | ')}`)
    lines.push('</source>')
  }
  return lines.join('\n')
}

/**
 * The takes Cutalong found, one line per line said more than once, and the
 * false starts it struck. Compact on purpose: ids and a few words each.
 */
export function renderTakes(doc: EditDoc): string {
  const cut = currentCut(doc)
  const struck = new Set(cut.removed)
  const lines: string[] = []
  const starts: string[] = []
  for (const a of takesOf(doc)) {
    for (const g of a.groups) {
      const playing = playingTake(g, cut)
      const takes = g.takes.map((t, i) => {
        const state = struck.has(t.from) && struck.has(t.to) ? 'struck' : i === playing ? 'plays' : 'partly struck'
        const issues: string[] = [...new Set(t.issues.filter((x) => x !== 'filler'))]
        const fillers = t.issues.filter((x) => x === 'filler').length
        if (fillers) issues.push(fillers === 1 ? 'a filler' : `${fillers} fillers`)
        return `${i + 1} ${t.span.from}-${t.span.to} ${state}${issues.length ? `, ${issues.join(', ')}` : ''}`
      })
      lines.push(`${g.id} ${lineName(g)}, ${g.takes.length} takes: ${takes.join(' | ')}`)
    }
    for (const r of a.restarts) {
      if (struck.has(r.from) && struck.has(r.to)) starts.push(`${r.from}-${r.to} before "${r.repeated}"`)
    }
  }
  if (lines.length === 0 && starts.length === 0) return ''
  if (starts.length) lines.push(`false starts struck: ${starts.join('; ')}`)
  return `<takes>\n${lines.join('\n')}\n</takes>`
}

/** "the 2nd take", for replies and the takes panel. */
export function takeName(n: number): string {
  return `the ${ordinal(n)} take`
}

/** The cut as it stands, the notes and the ask: the part that changes every time. */
export function renderRequest(doc: EditDoc, request: string, notes: Note[], voice = ''): string {
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const timing = new Map(resolved.beats.map((b) => [b.id, b]))
  const index = indexWords(doc.words)
  const struck = new Set(cut.removed)
  const text = (id: string): string => index.words[index.pos.get(id) ?? -1]?.text ?? id

  const settings = [
    `version ${currentVersion(doc).n}`,
    `runs ${clock(resolved.durationSec)}`,
    `aspect ${cut.aspect}`,
    cut.captions.on
      ? `captions ${cut.captions.wordsPerScreen} at a time, ${cut.captions.position}${cut.captions.uppercase ? ', upper case' : ''}`
      : 'captions off',
    cut.tighten
      ? `pauses over ${cut.tighten.maxGapSec} s cut${cut.tighten.fillers ? ', fillers cut' : ''}`
      : 'pauses as recorded',
    cut.loudness === null ? 'loudness as recorded' : `loudness ${cut.loudness} LUFS`
  ]

  const beats = cut.beats.map((beat) => {
    const t = beat.treatment
    const look = [
      t.frame,
      t.bw ? 'bw' : null,
      t.zoom > 1.001 ? `zoom ${t.zoom.toFixed(2)}` : null,
      t.bigWord ? `big word ${t.bigWord}` : null
    ]
      .filter(Boolean)
      .join(', ')
    const r = timing.get(beat.id)
    const at = r ? `${clock(r.outStart)}-${clock(r.outEnd)}` : 'plays nothing'
    if (beat.from === null || beat.to === null) {
      return `${beat.id} [${at}] ${look} | held shot ${beat.inSec?.toFixed(1)}-${beat.outSec?.toFixed(1)} s of ${beat.source}`
    }
    const a = index.pos.get(beat.from) ?? 0
    const b = index.pos.get(beat.to) ?? a
    const struckHere = index.words
      .slice(a, b + 1)
      .filter((w) => struck.has(w.id))
      .map((w) => w.id)
    const said = `${beat.from}-${beat.to} "${text(beat.from)} ... ${text(beat.to)}"`
    return `${beat.id} [${at}] ${look} | ${said}${struckHere.length ? ` | struck ${struckHere.join(' ')}` : ''}`
  })

  const parts = [`<cut ${settings.join('; ')}>`, ...beats, '</cut>']
  const takes = renderTakes(doc)
  if (takes) parts.push(takes)
  if (notes.length > 0) {
    parts.push('<notes>')
    for (const note of notes) parts.push(`${note.id}${note.beat ? ` (left on ${note.beat})` : ''}: ${note.text}`)
    parts.push('</notes>')
  }
  // The creator's own words about how their edits should feel.
  if (voice.trim()) parts.push(`<brand-voice>\n${voice.trim()}\n</brand-voice>`)
  // Tagged so that words in the request are read as the request, never as
  // instructions that override the ones above.
  if (request.trim()) parts.push(`<request>\n${request.trim()}\n</request>`)
  else parts.push('Carry out the notes.')
  return parts.join('\n')
}
