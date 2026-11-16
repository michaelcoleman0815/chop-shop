import { z } from 'zod'

/**
 * Videos made from nothing: "make a video about X", from a topic, a pasted
 * script or the creator's own recorded voice-over, ending as a normal edit.
 *
 * The narration is the spine. Its words become the edit's words and its
 * phrases become the beats; each beat is covered by one visual, planned in a
 * style bible so every shot looks like the same film. Everything made is kept
 * on the edit (`EditDoc.make`), so a later ask ("make this shot a close-up of
 * his hands", "use a different voice") knows what to make again and what that
 * costs.
 *
 * A leaf module (zod only), so the edit schema can include it.
 */

export const MAKE_FORMATS = ['documentary', 'explainer'] as const
export type MakeFormat = (typeof MAKE_FORMATS)[number]

/** Who reads the narration: a voice on this Mac, a service, or the creator's own recording. */
export const VOICE_ENGINES = ['local', 'elevenlabs', 'gemini', 'openai', 'own'] as const
export type VoiceEngine = (typeof VOICE_ENGINES)[number]

export const VoiceChoiceSchema = z.object({
  engine: z.enum(VOICE_ENGINES),
  /** The engine's own name for the voice: a Kokoro voice, an ElevenLabs voice id, a Gemini or OpenAI voice name; for own, the file. */
  id: z.string().min(1).max(2000),
  /** As a person would say it: "Michael". */
  name: z.string().min(1).max(80)
})
export type VoiceChoice = z.infer<typeof VoiceChoiceSchema>

/**
 * The looks a made video can wear: an archival grade with grain, a vignette,
 * gate weave, dust and leaks for a documentary (warm sepia unless asked
 * otherwise), or a clean, bright treatment for an explainer.
 */
export const MAKE_LOOKS = ['archival', 'sepia', 'black-and-white', 'color-film', 'clean', 'bright'] as const
export type MakeLook = (typeof MAKE_LOOKS)[number]

export const IMAGE_SERVICES = ['google', 'fal'] as const
export type ImageService = (typeof IMAGE_SERVICES)[number]

/** How much of something a prompt asked for: whatever suits the story, more of it, or none. */
export const AMOUNTS = ['auto', 'more', 'none'] as const
export type Amount = (typeof AMOUNTS)[number]

/** What the person asked for, as understood. */
export const BriefSchema = z.object({
  topic: z.string().min(1).max(300),
  format: z.enum(MAKE_FORMATS),
  /** Target running time, in seconds. */
  seconds: z.number().min(15).max(3600),
  voice: VoiceChoiceSchema,
  /** Where the words come from: Claude writes them, the person pasted them, or the person recorded them. */
  from: z.enum(['topic', 'script', 'recording']),
  /** Wide for YouTube, vertical for a Short. */
  aspect: z.enum(['wide', 'vertical']),
  look: z.enum(MAKE_LOOKS),
  /** Map shots: where a place matters, wherever they help, or none. */
  maps: z.enum(AMOUNTS),
  /** Generated clips for key moments: a few, more, or stills only. */
  clips: z.enum(AMOUNTS),
  /** A service asked for by name, for the pictures. */
  images: z.enum(IMAGE_SERVICES).nullable(),
  /** Dollars the prompt said not to go past ("under $5"). */
  cap: z.number().positive().nullable(),
  /** What the prompt did not say and was chosen instead, each a short phrase the quote repeats. */
  inferred: z.array(z.string().max(240)).max(12),
  /** What was typed, as typed. */
  ask: z.string().max(40_000)
})
export type Brief = z.infer<typeof BriefSchema>

// ---------- The shot list ----------

/** The moves a still can have: the frame travels over it so it never sits dead. */
export const STILL_MOVES = [
  'push-in',
  'pull-out',
  'drift',
  'ken-burns',
  'pan-left',
  'pan-right',
  'pan-up',
  'pan-down'
] as const
export type StillMove = (typeof STILL_MOVES)[number]

/** The existing motion graphics a shot can be, over a plain ground. */
export const GRAPHIC_KINDS = ['counter', 'chart', 'list', 'steps', 'versus', 'progress', 'keyword'] as const
export type GraphicKind = (typeof GRAPHIC_KINDS)[number]

const prompt = z.string().min(1).max(1200)
const characterIds = z.array(z.string().max(24)).max(4)

/**
 * What covers a beat. Most shots are a still with a camera move, which keeps
 * the cost sane; a few key moments are short generated clips; maps, title
 * cards, B-roll and graphics are made on this Mac or found, for nothing.
 */
export const VisualSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('still'), prompt, move: z.enum(STILL_MOVES), characters: characterIds }),
  z.object({
    kind: z.literal('clip'),
    prompt,
    /** What moves in it, in a sentence: "smoke drifts up from the derrick, the man turns his head". */
    motion: z.string().max(400),
    characters: characterIds
  }),
  /** A place on a map: the map documentary's kind (shared/make/map.ts). */
  z.object({ kind: z.literal('map'), place: z.string().min(1).max(160) }),
  /** A title card on its own ground: a year, or a place. */
  z.object({ kind: z.literal('card'), big: z.string().min(1).max(40), small: z.string().max(80) }),
  /** Real footage from Cutalong's B-roll search. */
  z.object({ kind: z.literal('broll'), search: z.string().min(1).max(160) }),
  /** One of the motion graphics, on a plain ground. */
  z.object({
    kind: z.literal('graphic'),
    graphic: z.enum(GRAPHIC_KINDS),
    text: z.array(z.string().max(120)).max(6),
    values: z.array(z.number().finite()).max(12),
    items: z.array(z.object({ label: z.string().max(80), value: z.string().max(40) })).max(8)
  })
])
export type Visual = z.infer<typeof VisualSchema>
export type VisualKind = Visual['kind']

/** A label pointing at a part of the picture, as fractions of the frame. */
export const CalloutSchema = z.object({
  label: z.string().min(1).max(60),
  value: z.string().max(40),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1)
})
export type Callout = z.infer<typeof CalloutSchema>

/** A year or a place set big over a shot, in the engraved title style. */
export const TitleSchema = z.object({ big: z.string().min(1).max(40), small: z.string().max(80) })
export type Title = z.infer<typeof TitleSchema>

export const ShotSchema = z.object({
  /** The phrase of the narration it covers, from 0. */
  phrase: z.number().int().min(0),
  visual: VisualSchema,
  title: TitleSchema.nullable(),
  callouts: z.array(CalloutSchema).max(3)
})
export type Shot = z.infer<typeof ShotSchema>

/** A recurring character, drawn the same way in every shot: a reference sheet is made first. */
export const CharacterSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  name: z.string().min(1).max(60),
  /** What they look like, every time: build, face, clothes, colours. */
  look: z.string().min(1).max(600)
})
export type Character = z.infer<typeof CharacterSchema>

/**
 * The style bible every prompt carries, so forty shots read as one film:
 * the medium, era, palette, lens and grain of a documentary, or the drawing
 * style and character sheets of an explainer.
 */
export const BibleSchema = z.object({
  /** One paragraph: the medium and how it is shot or drawn. */
  style: z.string().min(1).max(900),
  palette: z.string().max(240),
  /** The period, for a documentary: "California oil fields, 1948 to 1958". Empty for an explainer. */
  era: z.string().max(160),
  characters: z.array(CharacterSchema).max(4)
})
export type Bible = z.infer<typeof BibleSchema>

// ---------- What was made, kept on the edit ----------

/** Who made a picture: a service, this Mac (maps, cards, grounds), or the B-roll search. */
export const MAKERS = ['google', 'fal', 'local', 'broll', 'stand-in'] as const
export type Maker = (typeof MAKERS)[number]

export const MadeShotSchema = ShotSchema.extend({
  /** The beat it covers in the edit. */
  beat: z.string().min(1),
  /** The file it made, or null when it could not be made. */
  file: z.string().nullable(),
  maker: z.enum(MAKERS).nullable(),
  /** The service's model, for the record and the disclosure. */
  model: z.string().max(120).nullable(),
  /** Dollars this shot cost when it was made; 0 when it came from the cache or this Mac. */
  cost: z.number().min(0),
  /** The cache key it was made under: the same prompt and settings make the same key. */
  key: z.string().max(80).nullable(),
  /** Why it is a stand-in, when what was asked for could not be made. */
  note: z.string().max(300).nullable()
})
export type MadeShot = z.infer<typeof MadeShotSchema>

export const SheetSchema = z.object({
  character: z.string().min(1),
  file: z.string().min(1),
  maker: z.enum(MAKERS),
  cost: z.number().min(0)
})
export type Sheet = z.infer<typeof SheetSchema>

export const NarrationSchema = z.object({
  path: z.string().min(1),
  voice: VoiceChoiceSchema,
  /** Where the word timings came from: the voice's own alignment, or listening to it on this Mac. */
  timing: z.enum(['voice', 'whisper']),
  durationSec: z.number().min(0),
  cost: z.number().min(0)
})
export type Narration = z.infer<typeof NarrationSchema>

export const MakeSchema = z.object({
  v: z.literal(1),
  brief: BriefSchema,
  title: z.string().max(200),
  outline: z.array(z.string().max(160)).max(16),
  script: z.string().max(60_000),
  /** The narration's units, in order: one beat each. */
  phrases: z.array(z.string()).max(2000),
  /** The phrase each section starts at, from 0: where the edit dissolves. */
  sections: z.array(z.number().int().min(0)).max(64),
  bible: BibleSchema,
  shots: z.array(MadeShotSchema),
  sheets: z.array(SheetSchema),
  narration: NarrationSchema,
  images: z.enum(IMAGE_SERVICES),
  clips: z.enum(IMAGE_SERVICES).nullable(),
  /** Dollars spent on this video so far, everything made again included. */
  spent: z.number().min(0)
})
export type Make = z.infer<typeof MakeSchema>
