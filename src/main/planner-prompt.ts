import { z } from 'zod'
import {
  CAMERA_KINDS,
  currentCut,
  currentVersion,
  describeLook,
  indexWords,
  NAMED_LOOKS,
  resolveCut,
  TRANSITION_KINDS,
  type EditDoc,
  type Note
} from '../shared/edit'
import { clock, describeCamera, describeSpeed, seconds } from '../shared/presets'
import { lineName, playingTake, takesOf } from '../shared/raw/plan'
import { ordinal } from '../shared/raw/takes'
import { renderSound } from '../shared/audio/map'
import { offCameraLine } from '../shared/vision/speakers'

/**
 * Everything the planner sends and expects back, kept apart from the API call
 * so it can be tested without one.
 *
 * The request is laid out for prompt caching: the instructions never change,
 * the source transcript changes only when the footage does, and only the cut,
 * the notes and the ask change from one request to the next. They go last.
 */

/** The named looks' settings, as the planner reads them. */
const NAMED_LIST = Object.values(NAMED_LOOKS)
  .map(({ look: { name, ...settings } }) => `${name} ${JSON.stringify(settings)}`)
  .join('; ')

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
- {"op":"captions","set":{"on":true,"wordsPerScreen":2,"position":"chest","uppercase":false}}: positions are top, middle, chest, bottom.
- {"op":"tighten","set":{"maxGapSec":0.35,"padSec":0.06,"fillers":true}} or {"op":"tighten","set":null}.
- {"op":"aspect","aspect":"vertical"}: vertical, wide, square or original.
- {"op":"loudness","lufs":-14}.
- {"op":"transition","beats":["b4"],"kind":"dissolve","sec":0.5}: how a beat comes in from the one before. Kinds: dissolve, dip-to-black, dip-to-white, flash, whip-left, whip-right, push-left, push-right, push-up, push-down, slide-left, slide-right, slide-up, slide-down, wipe-left, wipe-right, wipe-up, wipe-down, smooth-left, smooth-right, smooth-up, smooth-down, zoom, circle-open, circle-close, clock, doors-open, pixelate, blur, squeeze. sec is optional (0.04 to 3); leave it out for the usual length. The first beat has nothing before it, so it cannot have one.
- {"op":"transition","beats":["b4","b7"],"kind":"cut"}: back to a hard cut.
- {"op":"fade","inSec":0.5,"outSec":1,"color":"black"}: fade the whole video in from, and out to, black or white. 0 turns that end off.
- {"op":"jcut","beats":["b5"],"sec":0.3}: a J cut into b5. Its sound starts on time but the picture before stays 0.3 s longer, so the next line is heard before it is seen. Coming back from B-roll to the speaker, this reads naturally.
- {"op":"lcut","beats":["b5"],"sec":0.3}: an L cut into b5. Its picture comes in 0.3 s early, under the end of the sound before. Going into B-roll, the cutaway leads the words it shows.
- {"op":"lcut","beats":["b5"],"sec":0}: picture and sound cut together again (also for jcut). A beat has a transition or a J or L cut, not both; setting one replaces the other.
- {"op":"speed","beats":["b6"],"speed":2}: play a beat faster or slower, from 0.25 to 4; a voice keeps its pitch. On a beat that shows a cutaway this changes the cutaway, and the voice under it plays as recorded; add "of":"beat" to change the beat itself. Speed 1 plays it as recorded again.
- {"op":"speed","beats":["b6"],"speed":0.5,"ramp":{"inSec":0.4,"outSec":0.4}}: a speed ramp, easing from full speed into 0.5 over 0.4 s and back to full speed over the last 0.4 s.
- {"op":"freeze","beat":"b6","word":"w40","sec":1}: hold the picture where w40 ends for 1 s while the sound waits; everything after starts 1 s later. sec 0 removes it.
- {"op":"reverse","beats":["b6"],"on":true}: play a beat backwards, or the cutaway it shows. A beat played backwards has no captions. on false plays it forwards again.
- {"op":"camera","beats":["b4"],"move":{"kind":"push-in"}}: a camera move over a beat, or over the cutaway it shows (a card stays still). Kinds: push-in, pull-out, drift (a slow creep in over the whole beat), ken-burns (a slow zoom and drift across a still), pan-left, pan-right, pan-up, pan-down, punch-in, shake, focus. "zoom" sets how close it gets, from 1 to 3. "to" centres the move on a point, as fractions of the picture: {"x":0.5,"y":0.3}.
- {"op":"camera","beats":["b4"],"move":{"kind":"punch-in","word":"w31","zoom":1.2}}: a quick eased punch-in landing on a word in the beat; a shake can land on a word the same way.
- {"op":"camera","beats":["b4"],"move":{"kind":"focus","regions":[{"at":0,"x":0.1,"y":0.2,"w":0.3,"h":0.25}]}}: glide in on a region of a screen recording at "at" seconds into the beat; x, y, w and h are fractions of the recording.
- {"op":"camera","beats":["b4"],"move":null}: hold the frame still again.
- {"op":"voice","polish":0.6}: clean up the voice: rumble, hiss and harsh esses out, levels evened, presence lifted. 0 leaves it as recorded, 1 is the most.
- {"op":"music","set":{"levelDb":-15,"duckDb":12}}: change the music bed: levelDb is how far it sits under the voice (-40 to 0), duckDb how much further it dips while anyone speaks (0 to 30, 0 never dips), fadeInSec and fadeOutSec its fades, inSec where in the track it starts. Set "path" only to a file the request names. {"op":"music","set":null} takes it out.
- {"op":"look","set":{"name":"warm","temperature":0.4,"saturation":0.08,"contrast":0.05},"replace":true}: a look over the whole picture, under the captions. The named looks are clean (true colour, crisper), warm, cool, cinematic and vintage; their settings: ${NAMED_LIST}. Settings: exposure in stops (-2 to 2), contrast, saturation, temperature (warmer above 0) and tint (magenta above 0) from -1 to 1, lift (faded blacks), sharpen, vignette and grain from 0 to 1. Without "replace" the settings change the look already there; 0 takes one away. {"op":"look","set":null} takes the whole look off and a LUT with it; a LUT itself is chosen by the person with /lut.
Ops apply in order, and a later op sees the ids an earlier split created. Use only ids that exist. If a split creates a beat, the new id is the next number after the highest beat id.

## How to edit
- Do exactly what was asked and nothing else. A note about one moment changes that moment.
- "This", "here" and "that bit" in a note mean the beat the note was left on.
- To open on a stronger line, move the beat that holds it to position 0; if it sits inside a long beat, split it out first.
- Keep sentences whole unless asked to cut inside one. Never strike the only words of a beat; remove the beat instead.
- If a request needs footage, a file or a decision you do not have, make no op for it and say what you need in needs, one full sentence for each.
- If nothing can be done, return no ops and say why in reply.
- Hard cuts are the default. Add a transition only where it is asked for, or at a change of section when asked to "add transitions"; between a talking head and B-roll a dissolve or a short push reads cleanest. Never put one on every beat unless asked.
- Camera moves keep stills and long held shots alive: a ken-burns or drift on a product still, a drift on a long talking beat. Put a move on fewer than half the beats unless asked, and never two kinds in a row on the same picture.
- Leave the colour alone unless asked. For tech and product videos, "clean" keeps colour true; save warm, cool, cinematic and vintage for when someone asks for a mood.
- Leave speed alone unless asked. Someone talking sped past 1.25 is hard to follow; slow motion and speed ramps belong on footage without speech, such as a cutaway of a product turning or hands at work.

## Takes
A <takes> block, when present, lists lines said more than once in the raw footage: each take with its word ids, whether it plays or is struck, and what went wrong in it. Cutalong keeps the last complete take unless an earlier one is clearly cleaner. To use another take ("use the second take of the intro"), unstrike that take's words and strike the take that plays now, in the same plan. If the take you bring back was recorded somewhere else, split it into a beat of its own and move that beat to where the line plays. Never strike the take that plays without bringing another one back. False starts listed there are struck already; unstrike one only when asked.

## Sound
A <sound> block, when present, lists stretches that are not speech (laughter, music, applause, noise) with their times in the recording, and words said with stress. A laugh or a noise between takes is a break, music under speech is not yours to cut, and a stressed word is a good big word.

## The creator's brand
A <brand-voice> block, when present, is the creator's own description of how their edits should feel. Follow it wherever it applies to the request; it never overrides the request itself.

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
  z.object({ op: z.literal('loudness'), lufs: z.number().nullable() }),
  z.object({
    op: z.literal('transition'),
    beats: z.array(z.string()),
    kind: z.enum(['cut', ...TRANSITION_KINDS]),
    sec: z.number().optional()
  }),
  z.object({
    op: z.literal('fade'),
    inSec: z.number().optional(),
    outSec: z.number().optional(),
    color: z.enum(['black', 'white']).optional()
  }),
  z.object({ op: z.literal('jcut'), beats: z.array(z.string()), sec: z.number() }),
  z.object({ op: z.literal('lcut'), beats: z.array(z.string()), sec: z.number() }),
  z.object({
    op: z.literal('speed'),
    beats: z.array(z.string()),
    speed: z.number(),
    ramp: z.object({ inSec: z.number(), outSec: z.number() }).nullable().optional(),
    of: z.enum(['beat', 'cutaway']).optional()
  }),
  z.object({ op: z.literal('freeze'), beat: z.string(), word: z.string(), sec: z.number() }),
  z.object({
    op: z.literal('reverse'),
    beats: z.array(z.string()),
    on: z.boolean(),
    of: z.enum(['beat', 'cutaway']).optional()
  }),
  z.object({ op: z.literal('voice'), polish: z.number() }),
  z.object({
    op: z.literal('look'),
    set: z
      .object({
        name: z.string().optional(),
        exposure: z.number().optional(),
        contrast: z.number().optional(),
        saturation: z.number().optional(),
        temperature: z.number().optional(),
        tint: z.number().optional(),
        lift: z.number().optional(),
        sharpen: z.number().optional(),
        vignette: z.number().optional(),
        grain: z.number().optional()
      })
      .nullable(),
    replace: z.boolean().optional()
  }),
  z.object({
    op: z.literal('music'),
    set: z
      .object({
        path: z.string().optional(),
        levelDb: z.number().optional(),
        duckDb: z.number().optional(),
        inSec: z.number().optional(),
        fadeInSec: z.number().optional(),
        fadeOutSec: z.number().optional()
      })
      .nullable()
  }),
  z.object({
    op: z.literal('camera'),
    beats: z.array(z.string()),
    move: z
      .object({
        kind: z.enum(CAMERA_KINDS),
        zoom: z.number().optional(),
        from: z.object({ x: z.number(), y: z.number() }).optional(),
        to: z.object({ x: z.number(), y: z.number() }).optional(),
        word: z.string().optional(),
        sec: z.number().optional(),
        regions: z
          .array(z.object({ at: z.number(), x: z.number(), y: z.number(), w: z.number(), h: z.number() }))
          .optional()
      })
      .nullable(),
    of: z.enum(['beat', 'cutaway']).optional()
  })
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
  // Who spoke off camera is a fact about the footage, so it is cached with it.
  const offCamera = offCameraLine(doc)
  if (offCamera) lines.push(offCamera)
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
  preferences: string[] = []
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
      ? `captions ${cut.captions.wordsPerScreen} at a time, ${cut.captions.position}${cut.captions.uppercase ? ', upper case' : ''}`
      : 'captions off',
    cut.tighten
      ? `pauses over ${cut.tighten.maxGapSec} s cut${cut.tighten.fillers ? ', fillers cut' : ''}`
      : 'pauses as recorded',
    cut.loudness === null ? 'loudness as recorded' : `loudness ${cut.loudness} LUFS`
  ]
  if (cut.voice && cut.voice.polish > 0) settings.push(`voice polish ${cut.voice.polish}`)
  if (cut.look) settings.push(`look ${describeLook(cut.look)}`)
  if (cut.music) {
    const name = cut.music.path.split(/[\\/]/).pop()
    const bpm = cut.music.bpm ? `, ${Math.round(cut.music.bpm)} BPM` : ''
    settings.push(`music ${name}${bpm} at ${cut.music.levelDb} dB under the voice, dipping ${cut.music.duckDb} dB`)
  }
  if (cut.fade && (cut.fade.inSec > 0 || cut.fade.outSec > 0)) {
    const ends = [
      cut.fade.inSec > 0 ? `in over ${seconds(cut.fade.inSec)}` : null,
      cut.fade.outSec > 0 ? `out over ${seconds(cut.fade.outSec)}` : null
    ].filter(Boolean)
    settings.push(`fades ${ends.join(' and ')} through ${cut.fade.color}`)
  }

  const beats = cut.beats.map((beat) => {
    const t = beat.treatment
    const look = [
      t.frame,
      t.bw ? 'bw' : null,
      t.zoom > 1.001 ? `zoom ${t.zoom.toFixed(2)}` : null,
      t.bigWord ? `big word ${t.bigWord}` : null,
      beat.transition ? `comes in with ${beat.transition.kind} ${seconds(beat.transition.sec)}` : null,
      beat.splitEdit ? `${beat.splitEdit.kind.toUpperCase()} cut in, ${seconds(beat.splitEdit.sec)}` : null,
      t.speed !== undefined || t.ramp ? `speed ${describeSpeed(t.speed ?? 1, t.ramp)}` : null,
      t.broll && (t.broll.speed !== undefined || t.broll.ramp)
        ? `cutaway speed ${describeSpeed(t.broll.speed ?? 1, t.broll.ramp)}`
        : null,
      t.freeze ? `freezes on ${t.freeze.word} for ${seconds(t.freeze.sec)}` : null,
      t.reverse ? 'backwards' : null,
      t.broll?.reverse ? 'cutaway backwards' : null,
      t.camera ? `camera ${describeCamera(t.camera)}` : null,
      t.broll?.camera ? `cutaway camera ${describeCamera(t.broll.camera)}` : null,
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
  if (doc.assets.length > 0) {
    // Where each piece already shows, so the planner neither repeats nor forgets one.
    const shows = new Map<string, string[]>()
    for (const beat of cut.beats) {
      const id = beat.treatment.broll ? byPath.get(beat.treatment.broll.path) : undefined
      if (id) shows.set(id, [...(shows.get(id) ?? []), beat.id])
    }
    parts.push('<material>')
    for (const a of doc.assets) {
      const size = a.width && a.height ? ` ${a.width}x${a.height}` : ''
      const length = a.durationSec ? `, ${a.durationSec.toFixed(1)} s` : ''
      const where = shows.get(a.id)
      parts.push(
        `${a.id} ${a.kind}${size}${length}: ${a.title}${where ? ` | shown on ${where.join(' ')}` : ' | not in the cut yet'}`
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
