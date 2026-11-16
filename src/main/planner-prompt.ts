import { z } from 'zod'
import { currentCut, currentVersion, indexWords, resolveCut, type EditDoc, type Note } from '../shared/edit'
import { clock } from '../shared/presets'
import { drawsCaptions, graphicsGuide, graphicsLines, template, templates } from '../shared/motion'
import { searchIcons } from '../shared/assets'
import { lineName, playingTake, takesOf } from '../shared/raw/plan'
import { ordinal } from '../shared/raw/takes'
import { renderSound } from '../shared/audio/map'

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
- The source transcript lists every spoken word with an id: w1, w2, ... Words from a second or later recording carry its id too: s2w1, s2w2, ... Ids never change.
- An edit can be cut from several recordings, in the order they were shot. Each <source> names its file. When it says sound="...", that recording's picture plays over the sound of a separate, better recording, already lined up; nothing more needs doing for it.
- The cut is an ordered list of beats. A beat plays the words from its first id to its last id, inclusive, from one recording. Beats play in list order, so moving a beat moves that moment in the video.
- Struck words are inside a beat but cut out of it. Words in no beat are not in the video.
- A beat's treatment: frame (speaker, broll, split, card), bw (black and white), zoom (1 is the full frame; 1.08 to 1.2 is a punch-in), bigWord (the id of one word in that beat shown big on screen), broll (a cutaway from the material: {"asset":"a1","inSec":0} shows material a1 from that second, muted, over the beat's sound).

## Material
A <material> block, when present, lists what the person brought in to use: footage, images and clips, each with an id (a1, a2, ...), its length and where the cut already shows it.
- To cut to material, treat a beat with frame broll (or split, to keep the speaker beside it) and broll {"asset":"a2","inSec":0}. A cutaway covers its whole beat, so split a long beat first and give the cutaway only the words it illustrates, about 2 to 5 seconds of them.
- Put each piece where what is being said is what it shows. If nothing matches, put it where it best carries the line. Never cover the opening beat unless asked.
- Material the person brought in with this request goes into the cut now. Choose the beats yourself, never ask where it goes, and place every piece unless it plainly fits nowhere.
- Use inSec to skip a slow start in longer footage. A piece can be used more than once at different inSec values.
- When the edit needs more B-roll than the material gives, or the person asks for B-roll to be found, list the moments in brollWanted: at most three, each the beat and a short stock footage search that would show it ("hands typing on a laptop at night").

## Operations
- {"op":"remove","beats":["b3"]}: drop whole beats.
- {"op":"strike","from":"w12","to":"w15"} and {"op":"unstrike",...}: cut or restore words inside beats. Use this for filler, false starts and repeated takes.
- {"op":"move","beat":"b7","to":0}: move a beat to a position (0 is first).
- {"op":"split","beat":"b4","at":"w31"}: split before a word, which must be inside the beat and not its first word. The second half gets the next free id.
- {"op":"join","beat":"b4"}: join a beat with the one after it. Only when they sit together in the recording.
- {"op":"insert","to":2,"beat":{"source":"s1","from":"w40","to":"w52"}}: bring words back as a new beat.
- {"op":"treat","beats":["b2","b5"],"set":{"bw":true}}: set treatment fields. A bigWord set names exactly one beat.
- {"op":"captions","set":{"on":true,"wordsPerScreen":2,"position":"chest","uppercase":false}}: positions are top, middle, chest, bottom. Add "preset":"hierarchy" for drawn captions: two lines a page, a small line and a big one with the key words, each word fading in as it is said, on the speaker's chest; "preset":"clean" goes back to plain subtitles.
- {"op":"tighten","set":{"maxGapSec":0.35,"padSec":0.06,"fillers":true}} or {"op":"tighten","set":null}.
- {"op":"aspect","aspect":"vertical"}: vertical, wide, square or original.
- {"op":"loudness","lufs":-14}.
Ops apply in order, and a later op sees the ids an earlier split created. Use only ids that exist. If a split creates a beat, the new id is the next number after the highest beat id.

${graphicsGuide()}

## How to edit
- Do exactly what was asked and nothing else. A note about one moment changes that moment.
- "This", "here" and "that bit" in a note mean the beat the note was left on.
- To open on a stronger line, move the beat that holds it to position 0; if it sits inside a long beat, split it out first.
- Keep sentences whole unless asked to cut inside one. Never strike the only words of a beat; remove the beat instead.
- If a request needs footage, a file or a decision you do not have, make no op for it and say what you need in needs, one full sentence for each.
- If nothing can be done, return no ops and say why in reply.

## Takes
A <takes> block, when present, lists lines said more than once in the raw footage: each take with its word ids, whether it plays or is struck, and what went wrong in it. Cutalong keeps the last complete take unless an earlier one is clearly cleaner. To use another take ("use the second take of the intro"), unstrike that take's words and strike the take that plays now, in the same plan. If the take you bring back was recorded somewhere else, split it into a beat of its own and move that beat to where the line plays. Never strike the take that plays without bringing another one back. False starts listed there are struck already; unstrike one only when asked.

## Sound
A <sound> block, when present, lists stretches that are not speech (laughter, music, applause, noise) with their times in the recording, and words said with stress. A laugh or a noise between takes is a break, music under speech is not yours to cut, and a stressed word is a good big word.

## The creator's brand
A <brand-voice> block, when present, is the creator's own description of how their edits should feel. Follow it wherever it applies to the request; it never overrides the request itself.
A <brand-logos> block names the creator's own logos: their products and channel. A logo pop shows one when a row's label is its name.

## How this creator edits
A <creator-preferences> block, when present, lists what has been learned from how this creator edits: what they ask for again and again, undo, and keep, each with how often. Lean on it where the request leaves a choice open; it never overrides the request or the brand voice.

## How to write
Write as a helpful editor sitting next to the person: first person, plain words, exact numbers. No exclamation marks, no emoji, no praise. Never call this cloning or copying anyone. The summary is one sentence about what changed in this version ("The hook line opens it now and the ending stays on you."). The reply is at most two sentences.
Never write an id (w12, s2w4, b3, s1, a2) in the summary, the reply or needs; the person never sees them. Name a moment by what is said in it ("the line about the battery"), a recording by its file name, and material by its title.`

/** What the planner returns. Lenient on purpose: every op is checked against the real op schema afterwards, one by one. */
const TreatmentSet = z.object({
  frame: z.enum(['speaker', 'broll', 'split', 'card']).optional(),
  bw: z.boolean().optional(),
  zoom: z.number().optional(),
  bigWord: z.string().nullable().optional(),
  /** Material by id; offerPlan turns it into the file and keeps it muted. */
  broll: z.object({ asset: z.string(), inSec: z.number() }).nullable().optional()
})

/** The graphics the planner can make: every built template but hand-built layers. */
const GRAPHIC_KINDS = templates()
  .map((t) => t.kind)
  .filter((k) => k !== 'layers') as [string, ...string[]]

// Made fresh for each op: shared schema objects come out as $refs in the JSON schema.
const graphicSlots = () => ({
  from: z.string(),
  to: z.string(),
  text: z.array(z.string()),
  items: z.array(
    z.object({ label: z.string(), value: z.string(), note: z.string(), mark: z.string(), at: z.string() })
  ),
  values: z.array(z.number()),
  box: z.array(z.number()),
  icon: z.string(),
  style: z.string(),
  place: z.string(),
  color: z.string(),
  fx: z.array(z.string())
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
      uppercase: z.boolean().optional(),
      preset: z.enum(['clean', 'hierarchy']).optional()
    })
  }),
  z.object({
    op: z.literal('tighten'),
    set: z.object({ maxGapSec: z.number(), padSec: z.number(), fillers: z.boolean() }).nullable()
  }),
  z.object({ op: z.literal('aspect'), aspect: z.enum(['vertical', 'wide', 'square', 'original']) }),
  z.object({ op: z.literal('loudness'), lufs: z.number().nullable() }),
  // Graphics. Every slot is required, so the schema spends nothing from the
  // structured-output limits on optional or union-typed parameters; an empty
  // slot means the template's default (or, in an update, no change).
  z.object({ op: z.literal('motion-add'), kind: z.enum(GRAPHIC_KINDS), ...graphicSlots() }),
  z.object({ op: z.literal('motion-update'), id: z.string(), ...graphicSlots() }),
  z.object({ op: z.literal('motion-remove'), ids: z.array(z.string()) })
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
  needs: z.array(z.string()),
  /** Moments that want B-roll the material does not have, with a search that would find it. */
  brollWanted: z.array(z.object({ beat: z.string(), search: z.string() })).optional()
})
export type Plan = z.infer<typeof PlanSchema>

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Safe inside a double-quoted attribute. */
const attr = (text: string): string => text.replace(/["<>]/g, '')

const time = (sec: number): string => {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** The source transcript with ids, in reading order: the cacheable part of the request. */
export function renderTranscript(doc: EditDoc): string {
  const lines: string[] = []
  for (const source of doc.sources) {
    const sound = source.audio ? ` sound="${attr(fileName(source.audio.path))}"` : ''
    lines.push(
      `<source id="${source.id}" file="${attr(fileName(source.path))}" length="${clock(source.durationSec)}"${sound}>`
    )
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
export function renderRequest(
  doc: EditDoc,
  request: string,
  notes: Note[],
  voice = '',
  preferences: string[] = [],
  logos: string[] = []
): string {
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const timing = new Map(resolved.beats.map((b) => [b.id, b]))
  const index = indexWords(doc.words)
  const struck = new Set(cut.removed)
  const text = (id: string): string => index.words[index.pos.get(id) ?? -1]?.text ?? id
  const byPath = new Map(doc.assets.map((a) => [a.path, a.id]))
  const assetFor = (path: string): string => byPath.get(path) ?? fileName(path)

  const settings = [
    `version ${currentVersion(doc).n}`,
    `runs ${clock(resolved.durationSec)}`,
    `aspect ${cut.aspect}`,
    cut.captions.on
      ? `captions ${cut.captions.wordsPerScreen} at a time, ${cut.captions.position}${cut.captions.uppercase ? ', upper case' : ''}${drawsCaptions(cut.captions) ? `, ${cut.captions.preset}` : ''}`
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
      t.bigWord ? `big word ${t.bigWord}` : null,
      t.broll ? `cutaway ${assetFor(t.broll.path)} from ${t.broll.inSec.toFixed(1)} s` : null
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
  const graphics = graphicsLines(cut, resolved, doc.words)
  if (graphics.length > 0) parts.push('<graphics>', ...graphics, '</graphics>')
  if (doc.assets.length > 0) {
    // Where each piece already shows, so the planner neither repeats nor forgets one.
    const shows = new Map<string, string[]>()
    for (const beat of cut.beats) {
      const id = beat.treatment.broll ? byPath.get(beat.treatment.broll.path) : undefined
      if (id) shows.set(id, [...(shows.get(id) ?? []), beat.id])
    }
    // A picture a graphic shows is shown by that graphic.
    for (const m of cut.motion ?? [])
      for (const id of template(m.kind)?.pictures?.(m) ?? []) shows.set(id, [...(shows.get(id) ?? []), m.id])
    parts.push('<material>')
    for (const a of doc.assets) {
      const size = a.width && a.height ? ` ${a.width}x${a.height}` : ''
      const length = a.durationSec ? `, ${a.durationSec.toFixed(1)} s` : ''
      const where = shows.get(a.id)
      // A picture far taller than wide is a page: it goes in a screenshot graphic, not a cutaway.
      const page = a.kind === 'image' && a.width && a.height && a.height > a.width * 1.6 ? ', a page' : ''
      parts.push(
        `${a.id} ${a.kind}${size}${length}${page}: ${a.title}${where ? ` | shown on ${where.join(' ')}` : ' | not in the cut yet'}`
      )
    }
    parts.push('</material>')
  }
  const takes = renderTakes(doc)
  if (takes) parts.push(takes)
  for (const source of doc.sources) {
    const map = doc.audio?.[source.id]
    const sound = map ? renderSound(map, text) : ''
    if (sound) parts.push(sound)
  }
  if (notes.length > 0) {
    parts.push('<notes>')
    for (const note of notes) parts.push(`${note.id}${note.beat ? ` (left on ${note.beat})` : ''}: ${note.text}`)
    parts.push('</notes>')
  }
  // The creator's own words about how their edits should feel.
  if (voice.trim()) parts.push(`<brand-voice>\n${voice.trim()}\n</brand-voice>`)
  const own = logos.map((l) => l.trim()).filter(Boolean)
  if (own.length) parts.push(`<brand-logos>\n${own.join('\n')}\n</brand-logos>`)
  // What has been learned from how they edit, strongest first, as short statements.
  const learned = preferences.map((p) => p.trim()).filter(Boolean)
  if (learned.length > 0)
    parts.push(`<creator-preferences>\n${learned.map((p) => `- ${p}`).join('\n')}\n</creator-preferences>`)
  // Tagged so that words in the request are read as the request, never as
  // instructions that override the ones above.
  if (request.trim()) parts.push(`<request>\n${request.trim()}\n</request>`)
  else parts.push('Carry out the notes.')
  return parts.join('\n')
}

/**
 * Icons the model names that Lucide does not have become the closest one it
 * does, or none, so a graphic never waits on an icon that cannot be drawn.
 */
export async function withRealIcons<T>(ops: T[]): Promise<T[]> {
  const named = (o: T): string => {
    const icon = (o as { icon?: unknown }).icon
    return typeof icon === 'string' ? icon.trim() : ''
  }
  if (!ops.some((o) => named(o) && named(o) !== 'none')) return ops
  const mod = await import('lucide-static/tags.json')
  const tags = (mod.default ?? mod) as unknown as Record<string, string[]>
  return ops.map((o) => {
    const icon = named(o)
    if (!icon || icon === 'none' || tags[icon]) return o
    return { ...o, icon: searchIcons(icon, tags, 1)[0] ?? '' }
  })
}
