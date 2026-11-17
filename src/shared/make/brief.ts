import { countWords, sentencesOf } from './script'
import type { Amount, Brief, ImageService, MakeFormat, MakeLook, VoiceChoice } from './schema'
import { defaultVoice, voiceChosen, voiceFromWords } from './voices'
import { clock } from '../presets/preset'

/**
 * Reading "make a video about X" from one prompt.
 *
 * A single prompt on Start carries everything: "make a 10 minute cinematic
 * documentary about the 1950s oil boom, deep male narrator, sepia, with maps
 * where it helps". The topic is read first and set aside, so words in it
 * ("the man who sold the world") are never read as a voice or a look; the
 * rest is read for the format, length, voice, look, maps, clips, a service
 * and a budget. What the prompt does not say is chosen from the brand and
 * sensible defaults, and each choice is kept as a short phrase the quote
 * repeats, so nothing is decided silently.
 *
 * Plain words are enough; /make, /documentary and /explainer say the same.
 */

/** The command and the plain phrases that ask for a made video, for whatever reads intent from words. */
export const MAKE_COMMAND = {
  command: 'make',
  title: 'Make a video',
  summary: 'A documentary or an animated explainer made from nothing: /make a 2 minute documentary about the 1950s oil boom',
  aliases: ['documentary', 'explainer'],
  phrases: [
    'make a video about',
    'make a documentary about',
    'make a cinematic documentary about',
    'make an explainer about',
    'make an animated explainer about',
    'make a video explaining',
    'documentary about',
    'explainer about',
    'explain in a video'
  ]
} as const

const NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  ninety: 90
}

const NOUN = String.raw`(?:video|documentary|doc|docu(?:mentary)?|explainer|film|short|animation|cartoon|piece|story|feature)`
/** "make a 2 minute cinematic documentary about ..." and the many ways to say it. */
const ASK = new RegExp(
  String.raw`\b(?:make|create|produce|generate|build|do|write and make|put together|i want|i'd like|can you make|give me)\b[^.?!\n]{0,60}?\b${NOUN}s?\b[^.?!\n]{0,40}?\b(?:about|on|explaining|that explains|showing|of how|covering|telling|on how)\b`,
  'i'
)
/** Starting with the thing itself: "A documentary about ...", "Cinematic doc on ...". */
const LEADING = new RegExp(
  String.raw`^\s*(?:an?\s+)?(?:[\w-]+\s+){0,4}?(?:documentary|explainer|doc)\s+(?:about|on|explaining|of)\b`,
  'i'
)
/** "Explain how vaccines work in a video", "explain the blockchain as an animation". */
const EXPLAIN = /^\s*explain\b[^.?!\n]{3,200}\b(?:in|as|with)\s+(?:a|an)\s+(?:\w+\s+)?(?:video|animation|explainer|cartoon)\b/i
const SLASH = /^\s*\/(make|documentary|explainer)\b\s*/i

/** Whether these words ask for a video made from nothing. Footage dropped with them makes it an edit instead. */
export function wantsMake(text: string, opts: { footage?: boolean } = {}): boolean {
  const t = text.trim()
  if (!t) return false
  if (SLASH.test(t)) return true
  if (opts.footage) return false
  return ASK.test(t) || LEADING.test(t) || EXPLAIN.test(t) || looksLikeScript(t)
}

/** A pasted narration rather than an ask: long, in full sentences, with no "make a video" in front of it. */
export function looksLikeScript(text: string): boolean {
  const t = text.trim()
  if (/^(?:here(?:'s| is) (?:my|the) script|script|narration|voice ?over)\s*[:-]/i.test(t)) return true
  if (countWords(t) < 90) return false
  const sentences = sentencesOf(t.replace(/\n+/g, ' '))
  return sentences.length >= 5 && !ASK.test(t.slice(0, 200))
}

interface Span {
  start: number
  end: number
}

/** Where the topic is in the prompt: after "about", up to the first clause that says how to make it. */
function topicSpan(t: string): Span | null {
  const m =
    /\b(?:about|on how|of how|explaining|that explains|covering|telling the story of|on|showing)\s+/i.exec(t) ??
    (EXPLAIN.test(t) ? /^\s*explain\s+/i.exec(t) : null)
  if (!m) return null
  const start = m.index + m[0].length
  const rest = t.slice(start)
  // The topic ends where the prompt turns to how: a comma or full stop, or "with", "in the style", "narrated by"...
  const stop =
    /\s*(?:[,;.!?\n]|\s(?:with|narrated|read|voiced|in (?:a|an|the) (?:\w+ )?(?:style|voice|look)|in sepia|in black|in colou?r|using|for (?:my|youtube|a short)|under \$|as (?:a|an) (?:short|vertical|animation|explainer|documentary)|in a video|in an? \w+ video|in under|at most)\b)/i.exec(
      rest
    )
  const end = start + (stop ? stop.index : rest.length)
  return end > start ? { start, end } : null
}

/** A length in the words: "10 minute", "ninety seconds", "a minute and a half", "half an hour". */
export function lengthIn(text: string): number | null {
  const t = text.toLowerCase()
  if (/\bhalf an hour\b/.test(t)) return 1800
  if (/\b(?:a|one) minute and a half\b|\b90 ?sec/.test(t)) return 90
  const m = /\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\s*[- ]?\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/.exec(
    t
  )
  if (!m) return null
  const n = /^\d/.test(m[1]) ? Number(m[1]) : NUMBERS[m[1]]
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[2]
  const seconds = unit.startsWith('h') ? n * 3600 : unit.startsWith('m') ? n * 60 : n
  return Math.min(3600, Math.max(15, Math.round(seconds)))
}

function formatIn(t: string): MakeFormat | null {
  if (/\b(?:animated\s+)?explainer\b|\banimat(?:ed|ion)\b|\bcartoon\b|\bmotion graphics video\b/i.test(t)) return 'explainer'
  if (/\bdocumentary\b|\bdocu\b|\bdoc\b|\bcinematic\b|\barchival\b|\bhistory video\b/i.test(t)) return 'documentary'
  return null
}

/** The format a topic suits when the prompt does not say: how things work is explained, the past is told. */
function formatFor(topic: string, niche: string | null): { format: MakeFormat; why: string } {
  if (/^(?:how|why|what)\b|\bhow\b.*\bworks?\b|\bwhat (?:is|are|makes)\b|\bexplain/i.test(topic))
    return { format: 'explainer', why: 'since it asks how something works' }
  if (/\b(1[0-9]|20)\d0s\b|\b1[5-9]\d\d\b|\bhistory\b|\brise\b|\bfall\b|\bstory of\b|\bwar\b|\bera\b|\bcentury\b|\bancient\b|\bboom\b|\bempire\b/i.test(topic))
    return { format: 'documentary', why: 'since it is a story from the past' }
  if (niche === 'tech' || niche === 'education') return { format: 'explainer', why: 'since your brand is about tech' }
  return { format: 'documentary', why: 'the default' }
}

function lookIn(t: string, format: MakeFormat): MakeLook | null {
  if (/\b(black[- ]and[- ]white|b&w|b\/w|monochrome|greyscale|grayscale)\b/i.test(t)) return 'black-and-white'
  if (/\bsepia\b/i.test(t)) return 'sepia'
  if (/\b(technicolou?r|kodachrome|colou?r film|period colou?r|in colou?r)\b/i.test(t)) return 'color-film'
  if (/\b(clean|no grain|modern|crisp|sharp)\b/i.test(t)) return format === 'explainer' ? 'bright' : 'clean'
  if (/\b(bright|flat|colou?rful|pastel|vibrant)\b/i.test(t) && format === 'explainer') return 'bright'
  if (/\b(grain|grainy|film|archival|old footage|vintage|newsreel)\b/i.test(t)) return 'archival'
  return null
}

function mapsIn(t: string): Amount | null {
  if (/\b(no|without|skip the|don'?t (?:use|want)) maps?\b/i.test(t)) return 'none'
  if (/\bmaps?\b/i.test(t)) return 'more'
  return null
}

function clipsIn(t: string): Amount | null {
  if (/\b(no (?:video )?clips|stills only|only stills|no moving (?:shots|footage)|just (?:stills|images|pictures))\b/i.test(t))
    return 'none'
  if (/\b(more (?:video )?clips|lots of (?:motion|movement)|moving shots|more motion|real motion)\b/i.test(t)) return 'more'
  return null
}

function imagesIn(t: string): ImageService | null {
  if (/\b(fal(?:\.ai)?|flux)\b/i.test(t)) return 'fal'
  if (/\b(google|gemini|nano banana)\b/i.test(t)) return 'google'
  return null
}

function capIn(t: string): number | null {
  const m = /\b(?:under|below|less than|at most|no more than|up to|max(?:imum)?|budget(?: of| is)?|spend)\s*(?:of\s*)?\$\s?(\d+(?:\.\d{1,2})?)/i.exec(t)
  return m ? Number(m[1]) : null
}

function aspectIn(t: string): 'wide' | 'vertical' | null {
  if (/\b(vertical|9:16|portrait|youtube shorts?|tiktok|reels?|a short)\b/i.test(t)) return 'vertical'
  if (/\b(wide|16:9|landscape|horizontal)\b/i.test(t)) return 'wide'
  return null
}

const DEFAULT_SECONDS: Record<MakeFormat, number> = { documentary: 120, explainer: 90 }

export interface AskContext {
  /** The kind of videos the brand makes, if set. */
  niche?: string | null
  /** A voice-over the person dropped with the ask, if any. */
  recording?: string | null
  /** A voice chosen in Settings for made videos, if any. */
  voice?: VoiceChoice | null
}

/** What a chat that asks for a made video is called: its topic, capitalised ("The 1950s oil boom"); null for other asks. */
export function makeName(text: string): string | null {
  const brief = readAsk(text)
  if (!brief || brief.from === 'recording') return null
  const t = cleanTopic(brief.topic)
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}`.slice(0, 80) : null
}

/** The topic, named for a reply: "the 1950s oil boom". */
export function cleanTopic(topic: string): string {
  return topic
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/, '')
    .trim()
}

/**
 * The brief one prompt asks for: everything it says, and what was chosen for
 * everything it does not. Null when the words do not ask for a made video.
 */
export function readAsk(text: string, ctx: AskContext = {}): Brief | null {
  const ask = text.trim()
  if (!ask) return null
  const slash = SLASH.exec(ask)
  const body = slash ? ask.slice(slash[0].length) : ask
  const pasted = !slash && looksLikeScript(body) ? body : null
  if (!slash && !pasted && !wantsMake(body)) return null
  const fromSlash = slash?.[1].toLowerCase()
  const inferred: string[] = []

  // The topic first, and the rest of the prompt read without it.
  const span = pasted ? null : topicSpan(body)
  let topic = span ? cleanTopic(body.slice(span.start, span.end)) : ''
  if (!topic && slash) topic = cleanTopic(body.split(/[,;\n]/)[0] ?? '')
  const rest = span ? `${body.slice(0, span.start)} ${body.slice(span.end)}` : pasted ? '' : body
  if (pasted) {
    const first = sentencesOf(pasted.replace(/\n+/g, ' '))[0] ?? 'your script'
    topic = cleanTopic(first.split(/\s+/).slice(0, 8).join(' '))
  }
  if (!topic) topic = 'what you asked for'

  let format: MakeFormat =
    fromSlash === 'documentary' ? 'documentary' : fromSlash === 'explainer' ? 'explainer' : (formatIn(rest) as MakeFormat)
  if (!format) {
    const guess = formatFor(topic, ctx.niche ?? null)
    format = guess.format
    inferred.push(
      `${format === 'documentary' ? 'a cinematic documentary' : 'an animated explainer'}${guess.why === 'the default' ? '' : `, ${guess.why}`}`
    )
  }

  const asked = lengthIn(rest)
  let seconds = asked ?? DEFAULT_SECONDS[format]
  if (pasted) {
    // A pasted script runs as long as it takes to read.
    seconds = Math.max(15, Math.round((countWords(pasted) / (format === 'documentary' ? 140 : 158)) * 60))
  } else if (asked === null) inferred.push(`${clock(seconds)} long`)

  const recording = ctx.recording ?? null
  const ownVoice = !!recording || /\b(my (?:own )?voice|my voice-?over|my narration|i(?:'ll| will) (?:record|narrate|read))\b/i.test(rest)
  let voice: VoiceChoice
  if (ownVoice) voice = { engine: 'own', id: recording ?? 'pending', name: 'You' }
  else {
    const said = voiceFromWords(rest, format)
    if (said) voice = said
    else {
      voice = ctx.voice ?? defaultVoice(format)
      inferred.push(voiceChosen(voice))
    }
  }

  const aspect = aspectIn(rest) ?? 'wide'
  const look = lookIn(rest, format) ?? (format === 'documentary' ? 'archival' : 'bright')
  if (!lookIn(rest, format))
    inferred.push(format === 'documentary' ? 'a warm sepia archival look with grain' : 'a clean, bright look')
  const maps = mapsIn(rest) ?? 'auto'
  const clips = clipsIn(rest) ?? 'auto'
  return {
    topic,
    format,
    seconds,
    voice,
    from: recording ? 'recording' : pasted ? 'script' : 'topic',
    aspect,
    look,
    maps,
    clips,
    images: imagesIn(rest),
    cap: capIn(ask),
    inferred,
    ask
  }
}

/**
 * Changes to a brief not yet made, from what was said next: "make it 3
 * minutes", "use ElevenLabs", "black and white", "no maps", "make it an
 * explainer instead". Null when nothing said changes it.
 */
export function reviseBrief(brief: Brief, text: string): { brief: Brief; changed: string[] } | null {
  const t = text.trim()
  const changed: string[] = []
  let next: Brief = { ...brief }
  const format = /\b(?:as an?|make it an?|instead|an?)\s+(?:animated\s+)?explainer\b/i.test(t)
    ? 'explainer'
    : /\b(?:as an?|make it an?|instead|an?)\s+(?:cinematic\s+)?documentary\b/i.test(t)
      ? 'documentary'
      : null
  if (format && format !== brief.format) {
    next = { ...next, format, look: format === 'documentary' ? 'archival' : 'bright' }
    if (brief.voice.engine === 'local') next.voice = defaultVoice(format)
    changed.push(format === 'documentary' ? 'a cinematic documentary' : 'an animated explainer')
  }
  const seconds = lengthIn(t)
  if (seconds && seconds !== brief.seconds && brief.from !== 'script' && brief.from !== 'recording') {
    next.seconds = seconds
    changed.push(`${clock(seconds)} long`)
  }
  const voice = voiceFromWords(t, next.format, brief.voice)
  if (voice && (voice.id !== brief.voice.id || voice.engine !== brief.voice.engine)) {
    next.voice = voice
    changed.push(voiceChosen(voice))
  }
  const look = lookIn(t, next.format)
  if (look && look !== next.look) {
    next.look = look
    changed.push(`the ${look.replace(/-/g, ' ')} look`)
  }
  const maps = mapsIn(t)
  if (maps && maps !== brief.maps) {
    next.maps = maps
    changed.push(maps === 'none' ? 'no maps' : 'maps where they help')
  }
  const clips = clipsIn(t)
  if (clips && clips !== brief.clips) {
    next.clips = clips
    changed.push(clips === 'none' ? 'stills only' : 'more moving shots')
  }
  const images = imagesIn(t)
  if (images && images !== brief.images) {
    next.images = images
    changed.push(images === 'fal' ? 'pictures from fal.ai' : 'pictures from Google')
  }
  const cap = capIn(t)
  if (cap && cap !== brief.cap) {
    next.cap = cap
    changed.push(`no more than $${cap.toFixed(2)}`)
  }
  const aspect = aspectIn(t)
  if (aspect && aspect !== brief.aspect) {
    next.aspect = aspect
    changed.push(aspect === 'vertical' ? 'vertical, for Shorts' : 'wide')
  }
  if (changed.length === 0) return null
  // What is now said no longer needs saying as a guess.
  next.inferred = brief.inferred.filter(
    (i) =>
      !(seconds && /long$/.test(i)) &&
      !(voice && /voice| recording$/.test(i)) &&
      !(look && /look/.test(i)) &&
      !(format && /documentary|explainer/.test(i))
  )
  return { brief: next, changed }
}
