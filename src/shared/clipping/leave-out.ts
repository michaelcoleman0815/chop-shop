import { DEFAULT_MUSIC, detectMusic } from './worship'
import type { ClipProfileId } from './profile'
import type { LeaveOutKind, Region } from './schema'
import { plain, type Sentence, type TimedWord } from './sentences'

/**
 * The stretches of a long recording no clip comes from, because they never
 * travel (docs/research/raw-footage.md, section 5):
 *
 * - a worship set: a clip with a song under it is blocked, not merely weak
 *   (shared/clipping/worship);
 * - a stream's furniture: "starting soon" and BRB, minutes of music or quiet
 *   over a frozen picture;
 * - announcements and giving appeals, which are addressed to the room;
 * - sponsor reads;
 * - a podcast's warm-up ("are we recording?") and its long goodbye.
 *
 * Everything is measured or read from the words; nothing is guessed from
 * the clock alone. The sound of a stretch (speech, music, laughter) comes
 * from the audio map, and a frozen picture from ffmpeg's freezedetect.
 */

export interface SoundStretch {
  kind: 'speech' | 'music' | 'laughter' | 'applause' | 'noise' | 'silence'
  startSec: number
  endSec: number
}

export interface LeaveOutInput {
  words: TimedWord[]
  sentences: Sentence[]
  durationSec: number
  profile: ClipProfileId
  /** What the recording sounds like, stretch by stretch, when it was listened to. */
  sounds?: SoundStretch[]
  /** Where the picture holds still, when it has one. */
  frozen?: { startSec: number; endSec: number }[]
}

/** Stream furniture is offered for removal past this (docs/research/raw-footage.md, livestreams). */
const FURNITURE_SEC = 30

const ANNOUNCE_STRONG =
  /\b(announcements?|sign ?up|signup|registration|potluck|bulletin|connect card|small groups?|kids'? ministry|children'?s ministry|youth group|men'?s breakfast|women'?s (?:bible )?study|fellowship hall|membership class|baptism class|rsvp|info table|welcome center|guest services)\b/
const ANNOUNCE_WEAK =
  /\b(this (?:sunday|saturday|wednesday|friday|week|month)|next (?:sunday|week|month)|in the lobby|on the website|on our website|on the app|volunteers?|serve team|calendar|tickets?|deadline|reminder|don'?t forget|register|nursery|childcare)\b/
const GIVING_STRONG =
  /\b(tithes?|tithing|the offering|our offering|give online|online giving|text (?:the word )?give|giving envelopes?|offering plates?|ushers?|giving kiosk)\b/
const GIVING_WEAK =
  /\b(generosity|donate|donations?|financial(?:ly)?|support (?:the|this) ministry|partner with us|your gifts?|giving)\b/
const SPONSOR_STRONG =
  /\b(sponsored by|today'?s sponsor|brought to you by|thanks to [\w ]{1,30} for sponsoring|promo code|use (?:the )?code|discount code|coupon code|percent off|\d+ ?% off|first month free)\b/
const SPONSOR_WEAK =
  /\b(free trial|link (?:is )?in (?:the|my) description|affiliate|partnered with|in partnership with|head (?:over )?to \w+ (?:dot )?com|sign up today|subscription)\b/
const SPONSOR_RETURN =
  /^(?:(?:and|so|okay|ok|alright|all right|anyway|now)\s+)*(?:back to|anyway|where were we|so where was i|let'?s get back|now back)/
/** Talk about the recording itself: what only a warm-up says. */
const WARMUP =
  /\b(are we recording|is (?:it|this|that) recording|are we rolling|is it rolling|can you hear me|is my mic|is this (?:mic )?on|testing,? testing|mic check|check check|hit record|are we live|ready when you are|how'?s my (?:audio|sound|level)|is the (?:camera|mic) (?:on|working))\b/
/** How a warm-up hands over to the show, said just after it. */
const WARMUP_END =
  /\b(okay,? let'?s (?:do this|go|start|get started|begin)|we good|sound good|alright,? here we go|three,? two,? one)\b/
const SHOW_OPENS =
  /\b(welcome (?:back )?to (?:the |my |our |another )?(?:show|podcast|episode|stream|channel|program)|welcome to [\w' ]{1,40}(?:podcast|show|radio)|i'?m your host|this is episode)\b/
const GOODBYE =
  /\b(thanks? (?:so much |again )?for (?:listening|watching|having me|coming on|joining|tuning in|being here)|that'?s (?:all|it) (?:for|the time)|that'?s all (?:we have|the time)|see you (?:next|all next) (?:time|week|episode|sunday)|until next time|catch you (?:next|later)|signing off|goodbye|bye[- ]?bye|bye everyone|bye for now|rate and review|leave (?:us )?a review|have a (?:great|good|blessed) (?:week|day|night)|go in peace)\b|(?:^| )(?:take care|good ?night|bye)(?: everyone| guys| y'?all| all| now| folks| friends)?$/

/** A region named the way the reply says it. */
function region(kind: LeaveOutKind, startSec: number, endSec: number, label: string): Region {
  return { kind, startSec: Math.max(0, startSec), endSec: Math.max(startSec, endSec), label }
}

/** Speech's share of a stretch, from the audio map: how much of it is someone talking. */
function speechShare(sounds: SoundStretch[], a: number, b: number): number {
  let speech = 0
  for (const s of sounds) {
    if (s.kind !== 'speech') continue
    speech += Math.max(0, Math.min(b, s.endSec) - Math.max(a, s.startSec))
  }
  return b > a ? speech / (b - a) : 0
}

/** Words per second across a stretch. */
function wordRate(words: TimedWord[], a: number, b: number): number {
  let n = 0
  for (const w of words) if (w.startSec >= a && w.startSec < b) n++
  return b > a ? n / (b - a) : 0
}

/**
 * A stream's furniture: the picture frozen for at least 30 s while nobody
 * talks (music, or quiet). At the start it is "starting soon", at the end
 * an ending screen, anywhere else a break. Words a recogniser heard over
 * the music ("Thank you.") do not count as talk: the sound says whether
 * anyone spoke.
 */
function furniture(input: LeaveOutInput): Region[] {
  const out: Region[] = []
  const { durationSec } = input
  const edge = Math.max(60, durationSec * 0.05)
  for (const f of input.frozen ?? []) {
    const a = Math.max(0, f.startSec)
    const b = Math.min(durationSec, f.endSec)
    if (b - a < FURNITURE_SEC) continue
    const talk = input.sounds?.length ? speechShare(input.sounds, a, b) : Math.min(1, wordRate(input.words, a, b) / 2.5)
    if (talk > 0.25) continue
    const label = a <= edge ? 'starting soon' : b >= durationSec - edge ? 'the ending screen' : 'a break'
    out.push(region('furniture', a, b, label))
  }
  // Minutes of music with nobody talking and no picture to say so: an intro, or a break.
  for (const s of input.sounds ?? []) {
    if (s.kind !== 'music' || s.endSec - s.startSec < 45) continue
    if (out.some((r) => r.startSec <= s.startSec + 1 && r.endSec >= s.endSec - 1)) continue
    if (wordRate(input.words, s.startSec, s.endSec) > 0.5) continue
    out.push(region('music', s.startSec, s.endSec, 'music with nobody talking'))
  }
  return out
}

interface CueRun {
  from: number
  to: number
  strong: number
  weak: number
}

/**
 * Runs of sentences that cues mark, joined while each is within `reachSec`
 * of the last. A run needs two strong cues, a strong and a weak one, or
 * three weak ones, so a sermon that says "small group" or "generous" once
 * is not an announcement or an offering.
 */
function cueRuns(sentences: Sentence[], strong: RegExp, weak: RegExp, reachSec: number): CueRun[] {
  const runs: CueRun[] = []
  let run: CueRun | null = null
  for (let i = 0; i < sentences.length; i++) {
    const t = plain(sentences[i].text)
    const mark = strong.test(t) ? 2 : weak.test(t) ? 1 : 0
    if (mark === 0) continue
    if (run && sentences[i].startSec - sentences[run.to].endSec <= reachSec) {
      run.to = i
    } else {
      if (run) runs.push(run)
      run = { from: i, to: i, strong: 0, weak: 0 }
    }
    if (mark === 2) run.strong++
    else run.weak++
  }
  if (run) runs.push(run)
  return runs.filter((r) => 2 * r.strong + r.weak >= 3)
}

function announcements(input: LeaveOutInput): Region[] {
  const { sentences } = input
  const out: Region[] = []
  for (const run of cueRuns(sentences, ANNOUNCE_STRONG, ANNOUNCE_WEAK, 40)) {
    out.push(region('announcements', sentences[run.from].startSec, sentences[run.to].endSec, 'the announcements'))
  }
  for (const run of cueRuns(sentences, GIVING_STRONG, GIVING_WEAK, 40)) {
    // Words about generosity, with nothing about the offering itself, are a sermon's.
    if (run.strong === 0) continue
    out.push(region('giving', sentences[run.from].startSec, sentences[run.to].endSec, 'the giving appeal'))
  }
  return out
}

const LEAD_IN = /\b(?:quick|short) (?:break|word)|before we (?:go on|continue|get into)|a word from\b/

function sponsors(input: LeaveOutInput): Region[] {
  const { sentences } = input
  const out: Region[] = []
  for (const run of cueRuns(sentences, SPONSOR_STRONG, SPONSOR_WEAK, 45)) {
    let to = run.to
    // A read ends where the show comes back ("Anyway, back to ..."), within half a minute.
    for (let k = run.to + 1; k < sentences.length && sentences[k].startSec - sentences[run.to].endSec <= 30; k++) {
      if (SPONSOR_RETURN.test(plain(sentences[k].text))) {
        to = k - 1
        break
      }
    }
    // The sentence that leads into a read ("Quick break") belongs to it.
    let from = run.from
    const before = sentences[from - 1]
    if (before && sentences[from].startSec - before.endSec < 1.5 && LEAD_IN.test(plain(before.text))) from--
    out.push(region('sponsor', sentences[from].startSec, sentences[Math.max(from, to)].endSec, 'the sponsor read'))
  }
  return out
}

/**
 * A podcast's warm-up: when talk about the recording itself ("are we
 * recording?") comes in the first five minutes, everything up to the show's
 * opening line ("Welcome to the show"), or up to its hand-over ("Okay, let's
 * do this"). And its goodbye: from the first goodbye in the last five
 * minutes to the end.
 */
function edges(input: LeaveOutInput): Region[] {
  const { sentences, durationSec } = input
  const out: Region[] = []
  const head = Math.min(300, durationSec * 0.2)
  const early = sentences.filter((s) => s.startSec < head)
  const warm = early.filter((s) => WARMUP.test(plain(s.text)))
  if (warm.length > 0) {
    const last = warm[warm.length - 1]
    const opens = early.find((s) => SHOW_OPENS.test(plain(s.text)) && s.startSec >= warm[0].startSec)
    const handover = early.find(
      (s) => s.startSec >= last.startSec && s.startSec - last.endSec <= 60 && WARMUP_END.test(plain(s.text))
    )
    const end = opens ? opens.startSec : (handover ?? last).endSec
    if (end > 0) out.push(region('warmup', 0, end, 'the warm-up'))
  }
  const tail = Math.max(durationSec - 300, durationSec * 0.85)
  const bye = sentences.find((s) => s.startSec >= tail && GOODBYE.test(plain(s.text)))
  if (bye) out.push(region('goodbye', bye.startSec, durationSec, 'the goodbye'))
  return out
}

/**
 * Four words in a row said again inside two minutes. Twice is enough: a
 * transcript often keeps only two of a chorus's repeats, and speech that
 * repeats itself still brings new words between, which the share and the
 * run below catch.
 */
const LYRIC_GRAM = 4
const LYRIC_REACH_SEC = 60
const LYRIC_REPEATS = 2
/** Share of a stretch's words inside repeated lines, past which it is sung rather than said. */
const LYRIC_SHARE = 0.6
const LYRIC_WINDOW_SEC = 20
/** Shorter than this, a run of repeated lines is a refrain or a chant, not a song. */
const LYRIC_MIN_SEC = 45
/**
 * Whisper often writes a chorus down once or twice and leaves the rest of
 * its repeats out (a real run on the generated service did, for minutes),
 * so a song's written lines can sit half a minute apart.
 */
const LYRIC_GAP_SEC = 30
/**
 * Past this share of a run's words in repeated lines, with as few different
 * words across the run as a song's windows have, it is sung however few of
 * its repeats were written down. Speech built from stock phrases repeats
 * as much, but says many more different words.
 */
const LYRIC_WHOLE = 0.8

/**
 * Whether every half minute of a run says few words over and over, as
 * shared/clipping/worship asks of its windows, with the windows laid on the
 * run rather than on the clock. Even a preacher's "I have a dream that one
 * day" brings new words with every line.
 */
function fewWords(words: TimedWord[], a: number, b: number): boolean {
  const { windowSec, uniqueBelow } = DEFAULT_MUSIC
  const from = words[a].startSec
  const to = words[b].endSec
  for (let at = from; at + windowSec <= to + 5; at += 5) {
    const said: string[] = []
    for (let k = a; k <= b && words[k].startSec < at + windowSec; k++)
      if (words[k].startSec >= at) said.push(words[k].text.trim().toLowerCase())
    if (said.length >= 20 && new Set(said).size / said.length >= uniqueBelow) return false
  }
  return true
}

/**
 * Songs found line by line. The half-minute windows of shared/clipping/worship
 * miss a song shorter than about two minutes, such as the one a service ends
 * on, when its first or last window also holds speech. Here every run of four
 * words that comes back inside two minutes counts as sung, and a
 * stretch of at least 45 s where most words are sung, and few are new (or
 * nearly all of them are sung), is a song. A preacher's refrain comes back
 * too, but between sentences that do not.
 */
export function songsByLine(words: TimedWord[]): { startSec: number; endSec: number }[] {
  const n = words.length
  const texts = words.map((w) => plain(w.text))
  const at = new Map<string, number[]>()
  for (let k = 0; k + LYRIC_GRAM <= n; k++) {
    const key = texts.slice(k, k + LYRIC_GRAM).join(' ')
    if (!key.trim()) continue
    const list = at.get(key)
    if (list) list.push(k)
    else at.set(key, [k])
  }
  const repeated = new Uint8Array(n)
  for (const list of at.values()) {
    if (list.length < LYRIC_REPEATS) continue
    let lo = 0
    let hi = 0
    for (let j = 0; j < list.length; j++) {
      const t = words[list[j]].startSec
      while (words[list[lo]].startSec < t - LYRIC_REACH_SEC) lo++
      hi = Math.max(hi, j)
      while (hi + 1 < list.length && words[list[hi + 1]].startSec <= t + LYRIC_REACH_SEC) hi++
      if (hi - lo + 1 >= LYRIC_REPEATS) for (let g = 0; g < LYRIC_GRAM; g++) repeated[list[j] + g] = 1
    }
  }
  // The share of sung words around each word, then runs of words where most are sung.
  const out: { startSec: number; endSec: number }[] = []
  let lo = 0
  let hi = 0
  let inside = 0
  let run: { a: number; b: number } | null = null
  const flush = (): void => {
    if (run) {
      let { a, b } = run
      // At a song's edges the words around it are partly speech, so the share
      // falls; its repeated words there are still the song.
      while (a > 0 && repeated[a - 1] && words[a].startSec - words[a - 1].endSec < LYRIC_GAP_SEC) a--
      while (b + 1 < n && repeated[b + 1] && words[b + 1].startSec - words[b].endSec < LYRIC_GAP_SEC) b++
      let sung = 0
      for (let k = a; k <= b; k++) sung += repeated[k]
      const said = texts.slice(a, b + 1)
      const whole = sung / said.length >= LYRIC_WHOLE && new Set(said).size / said.length < DEFAULT_MUSIC.uniqueBelow
      if (words[b].endSec - words[a].startSec >= LYRIC_MIN_SEC && (whole || fewWords(words, a, b)))
        out.push({ startSec: words[a].startSec, endSec: words[b].endSec })
    }
    run = null
  }
  for (let k = 0; k < n; k++) {
    const t = words[k].startSec
    while (hi < n && words[hi].startSec <= t + LYRIC_WINDOW_SEC / 2) inside += repeated[hi++]
    while (words[lo].startSec < t - LYRIC_WINDOW_SEC / 2) inside -= repeated[lo++]
    const share = inside / (hi - lo)
    if (share >= LYRIC_SHARE && repeated[k]) {
      if (run && words[k].startSec - words[run.b].endSec < LYRIC_GAP_SEC) run.b = k
      else {
        flush()
        run = { a: k, b: k }
      }
    }
  }
  flush()
  return out
}

/**
 * Sung music, found by repetition (shared/clipping/worship, and line by line
 * above), with its edges moved onto the lines themselves. The finder judges
 * half-minute windows, so a song's first and last lines can sit just outside
 * what it found; a line the song already sang, or one made of its words, is
 * still the song.
 */
function sung(input: LeaveOutInput): { startSec: number; endSec: number }[] {
  const { sentences } = input
  const byLine = songsByLine(input.words)
  const found = [...detectMusic(input.words), ...byLine].sort((a, b) => a.startSec - b.startSec)
  const songs: { startSec: number; endSec: number }[] = []
  for (const m of found) {
    const last = songs[songs.length - 1]
    if (last && m.startSec <= last.endSec) last.endSec = Math.max(last.endSec, m.endSec)
    else songs.push({ startSec: m.startSec, endSec: m.endSec })
  }
  const out: { startSec: number; endSec: number }[] = []
  for (const m of songs) {
    const inside = sentences.filter((s) => s.endSec > m.startSec && s.startSec < m.endSec)
    // The song's lines are the ones it sings more than once.
    const counts = new Map<string, number>()
    for (const s of inside) counts.set(plain(s.text), (counts.get(plain(s.text)) ?? 0) + 1)
    const lines = new Set([...counts].filter(([, n]) => n >= 2).map(([t]) => t))
    if (lines.size === 0) {
      out.push({ startSec: m.startSec, endSec: m.endSec })
      continue
    }
    const vocab = new Set([...lines].flatMap((t) => t.split(' ')))
    const lyric = (s: Sentence): boolean => {
      const t = plain(s.text)
      if (lines.has(t)) return true
      const words = t.split(' ').filter(Boolean)
      return words.length > 0 && words.length <= 12 && words.filter((w) => vocab.has(w)).length / words.length >= 0.8
    }
    const sungInside = inside.filter(lyric)
    let a = sungInside[0].i
    let b = sungInside[sungInside.length - 1].i
    while (a > 0 && sentences[a].startSec - sentences[a - 1].endSec < 8 && lyric(sentences[a - 1])) a--
    while (b + 1 < sentences.length && sentences[b + 1].startSec - sentences[b].endSec < 8 && lyric(sentences[b + 1]))
      b++
    out.push({ startSec: sentences[a].startSec, endSec: sentences[b].endSec })
  }
  // What was found line by line is sung whatever its sentences look like:
  // "You are the light in the dark, you are the light in the dark" written
  // as one long sentence is still the song. leaveOut joins the two.
  return [...out, ...byLine]
}

/** Every stretch a clip never comes from, earliest first. */
export function leaveOut(input: LeaveOutInput): Region[] {
  const regions: Region[] = []
  for (const m of sung(input)) {
    const label = input.profile === 'church' ? 'the worship set' : 'the singing'
    regions.push(region('worship', m.startSec, Math.min(input.durationSec, m.endSec), label))
  }
  regions.push(...furniture(input))
  // Announcements and giving are a service's; a podcast or a stream that
  // names a sign-up is more often reading for a sponsor, found on its own.
  if (input.profile === 'church') regions.push(...announcements(input))
  regions.push(...sponsors(input))
  const ends = edges(input)
  // A service has no warm-up to speak of, but its "have a great week" goes too.
  regions.push(...(input.profile === 'church' ? ends.filter((r) => r.kind === 'goodbye') : ends))
  return merge(regions.sort((a, b) => a.startSec - b.startSec))
}

/** Regions of one kind that touch become one. */
function merge(regions: Region[]): Region[] {
  const out: Region[] = []
  for (const r of regions) {
    const last = [...out].reverse().find((o) => o.kind === r.kind)
    if (last && r.startSec <= last.endSec + 5) last.endSec = Math.max(last.endSec, r.endSec)
    else out.push({ ...r })
  }
  return out.sort((a, b) => a.startSec - b.startSec)
}

/** How much of [a, b] lies inside the regions, in seconds. */
export function overlapWith(regions: Region[], a: number, b: number): number {
  let n = 0
  for (const r of regions) n += Math.max(0, Math.min(b, r.endSec) - Math.max(a, r.startSec))
  return n
}

/** Seconds of the recording left once the regions are out. */
export function usableSec(regions: Region[], durationSec: number): number {
  const spans = regions.map((r) => [r.startSec, r.endSec]).sort((a, b) => a[0] - b[0])
  let covered = 0
  let at = 0
  for (const [a, b] of spans) {
    const from = Math.max(a, at)
    if (b > from) covered += b - from
    at = Math.max(at, b)
  }
  return Math.max(0, durationSec - covered)
}
