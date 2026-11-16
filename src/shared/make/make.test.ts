import { describe, expect, it } from 'vitest'
import {
  assembleDoc,
  checkShotList,
  countShots,
  estimateCounts,
  fitShots,
  localShotList,
  lookFor,
  phraseRanges,
  phrasesAndSections,
  promptFor,
  quoteFor,
  quoteReply,
  readAsk,
  readMakeAsk,
  readScript,
  reviseBrief,
  scriptText,
  sentencesOf,
  shotCost,
  shotMeant,
  wantsMake,
  type Availability,
  type Brief,
  type Make,
  type ShotListAnswer
} from './index'
import { EditDocSchema, currentCut, resolveCut, type Cut } from '../edit'

const ALL: Availability = { google: true, fal: true, elevenlabs: true, openai: true, claude: true, localVoice: true }
const NONE: Availability = { google: false, fal: false, elevenlabs: false, openai: false, claude: true, localVoice: false }

const SCRIPT = `# Black Gold

## The strike
In 1954, the derricks rose over San Bernardino like a forest of steel. Men in felt hats watched the sky turn black with oil. Nobody had seen money move this fast.

## The crowds
Whole towns came out to celebrate, and the bands played until dawn. By the end of the decade, the boom had changed California forever.`

describe('reading a script into phrases', () => {
  it('keeps sentences whole, abbreviations and decimals inside them', () => {
    expect(sentencesOf('Mr. Getty paid $3.5 million. It was 1954! Was it worth it?')).toEqual([
      'Mr. Getty paid $3.5 million.',
      'It was 1954!',
      'Was it worth it?'
    ])
  })

  it('takes headings as sections and the title as the title, never as words to say', () => {
    const read = readScript(SCRIPT)
    expect(read.title).toBe('Black Gold')
    expect(read.sections.map((s) => s.heading)).toEqual(['The strike', 'The crowds'])
    const { phrases, sections } = phrasesAndSections(SCRIPT)
    expect(sections).toEqual([0, 3])
    expect(phrases[0]).toBe('In 1954, the derricks rose over San Bernardino like a forest of steel.')
    expect(phrases.join(' ')).not.toMatch(/#|The strike/)
  })

  it('breaks a long sentence at a comma near its middle and leaves no flash-by fragments', () => {
    const long =
      'The wells on Signal Hill pumped day and night, and the money that came out of the ground built roads, schools and a whole new way of living in the West.'
    const { phrases } = phrasesAndSections(long)
    expect(phrases.length).toBe(2)
    expect(phrases.every((p) => p.split(' ').length >= 4)).toBe(true)
    expect(phrases.join(' ')).toBe(long)
  })

  it('drops stage directions and speaker labels from a pasted script', () => {
    const { phrases } = phrasesAndSections('[Music swells]\nNarrator: The oil came first.\n(pause)\nThen the people.')
    expect(phrases).toEqual(['The oil came first. Then the people.'])
  })

  it('lines heard words up with the phrases, through recognition mistakes', () => {
    const phrases = ['In 1954 the derricks rose.', 'Men in felt hats watched.', 'Nobody had seen it.']
    // "derricks" heard as "Derek's", an extra "uh", "felt" missed.
    const heard = ['In', '1954', 'the', "Derek's", 'rose.', 'uh', 'Men', 'in', 'hats', 'watched.', 'Nobody', 'had', 'seen', 'it.']
    expect(phraseRanges(phrases, heard)).toEqual([
      [0, 5],
      [6, 9],
      [10, 13]
    ])
  })

  it('gives every phrase a word when there are words to go round', () => {
    const ranges = phraseRanges(['One two three.', 'Four.'], ['one', 'two', 'three', 'four'])
    expect(ranges).toEqual([
      [0, 2],
      [3, 3]
    ])
  })
})

describe('one prompt carries the whole brief', () => {
  it("reads the owner's example: length, format, voice, look and maps, and infers nothing it was told", () => {
    const brief = readAsk(
      'make a 10 minute cinematic documentary about the 1950s oil boom, deep male narrator, sepia, with maps where it helps'
    ) as Brief
    expect(brief.topic).toBe('the 1950s oil boom')
    expect(brief.format).toBe('documentary')
    expect(brief.seconds).toBe(600)
    expect(brief.voice).toEqual({ engine: 'local', id: 'am_fenrir', name: 'Fenrir' })
    expect(brief.look).toBe('sepia')
    expect(brief.maps).toBe('more')
    expect(brief.inferred).toEqual([])
  })

  it('says what it chose for everything the prompt left out', () => {
    const brief = readAsk('make a video about the 1950s oil boom') as Brief
    expect(brief.format).toBe('documentary')
    expect(brief.seconds).toBe(120)
    expect(brief.inferred).toEqual([
      'a cinematic documentary, since it is a story from the past',
      '2:00 long',
      'read by Michael, a voice that runs on this Mac, free',
      'a warm sepia archival look with grain'
    ])
  })

  it('reads an explainer from how something works, and words in the topic stay in the topic', () => {
    const brief = readAsk('make a 90 second video about how the heart pumps blood') as Brief
    expect(brief.format).toBe('explainer')
    expect(brief.topic).toBe('how the heart pumps blood')
    const man = readAsk('make a documentary about the man who sold the world') as Brief
    expect(man.topic).toBe('the man who sold the world')
    expect(man.voice.id).toBe('am_michael')
    expect(man.inferred).toContain('read by Michael, a voice that runs on this Mac, free')
  })

  it('never reads a decade as a length, and reads lengths said in words', () => {
    expect(readAsk('make a documentary about the 90s')?.seconds).toBe(120)
    expect(readAsk('make a three minute documentary about the 1950s')?.seconds).toBe(180)
    expect(readAsk('make a documentary about Apollo, a minute and a half')?.seconds).toBe(90)
  })

  it('reads a voice service, a picture service, a budget, stills only and vertical', () => {
    const brief = readAsk(
      'make an animated explainer on how vaccines work, read by ElevenLabs, pictures with flux, stills only, under $3, vertical'
    ) as Brief
    expect(brief.voice.engine).toBe('elevenlabs')
    expect(brief.images).toBe('fal')
    expect(brief.clips).toBe('none')
    expect(brief.cap).toBe(3)
    expect(brief.aspect).toBe('vertical')
  })

  it('asks in plain words with no slash, and footage dropped with the words is an edit instead', () => {
    expect(wantsMake('make a video about the moon landing')).toBe(true)
    expect(wantsMake('A documentary about the Dust Bowl')).toBe(true)
    expect(wantsMake('explain how a transistor works in a short video')).toBe(true)
    expect(wantsMake('/make the gold rush')).toBe(true)
    expect(wantsMake('make it shorter')).toBe(false)
    expect(wantsMake('make a vlog')).toBe(false)
    expect(wantsMake('cut this for shorts')).toBe(false)
    expect(wantsMake('make a video about my trip', { footage: true })).toBe(false)
  })

  it('takes a pasted script as the narration, as long as it takes to read', () => {
    const pasted = Array.from(
      { length: 8 },
      (_, i) => `The oil men came to the valley in the year ${1950 + i} and they did not leave until the wells ran dry.`
    ).join(' ')
    const brief = readAsk(pasted) as Brief
    expect(brief.from).toBe('script')
    expect(brief.seconds).toBeGreaterThan(40)
  })

  it('takes changes to a brief not yet made, and stops calling them guesses', () => {
    const brief = readAsk('make a video about the 1950s oil boom') as Brief
    const next = reviseBrief(brief, 'make it 3 minutes, black and white, with a woman reading it')
    expect(next?.changed).toEqual(['3:00 long', 'read by Heart, a voice that runs on this Mac, free', 'the black and white look'])
    expect(next?.brief.seconds).toBe(180)
    expect(next?.brief.inferred).toEqual(['a cinematic documentary, since it is a story from the past'])
    expect(reviseBrief(brief, 'sounds good')).toBeNull()
  })
})

describe('the quote', () => {
  const brief = readAsk('make a 2 minute cinematic documentary about the 1950s oil boom') as Brief
  const { phrases } = phrasesAndSections(SCRIPT)

  it('prices every line from the price table and adds them up', () => {
    const counts = { ...estimateCounts(brief, phrases, SCRIPT), stills: 20, clips: 2, clipSeconds: 5, sheets: 0, references: 0 }
    const q = quoteFor(brief, counts, ALL, { today: '2026-11-16', scriptWritten: true })
    expect(q.images).toBe('google')
    expect(q.clips).toBe('google')
    const stills = q.lines.find((l) => l.what.startsWith('Up to 20 stills'))
    expect(stills?.cost).toBeCloseTo(20 * 0.0504, 6)
    const clips = q.lines.find((l) => l.what.startsWith('2 clips'))
    expect(clips?.cost).toBeCloseTo(2 * 5 * 0.0695, 6)
    expect(q.lines.find((l) => l.what.startsWith('The narration'))?.cost).toBe(0)
    expect(q.total).toBeCloseTo(
      q.lines.reduce((n, l) => n + l.cost, 0),
      6
    )
    expect(q.within).toBe(true)
    expect(q.auto).toBe(false)
  })

  it('says what goes where, and that the footage stays', () => {
    const q = quoteFor(brief, estimateCounts(brief, phrases, SCRIPT), ALL, { today: '2026-11-16' })
    expect(q.sends.join(' ')).toMatch(/Only the text prompts for the pictures go to Google, with the character sheet it made for each shot the character is in\./)
    expect(q.sends).toContain('Nothing of your own footage leaves this Mac.')
    expect(q.sends.join(' ')).toMatch(/Michael reads the script on this Mac/)
  })

  it('cannot be made without a key for the pictures, and says so', () => {
    const q = quoteFor(brief, estimateCounts(brief, phrases, SCRIPT), NONE, { today: '2026-11-16' })
    expect(q.images).toBeNull()
    expect(q.missing[0]).toMatch(/Google Gemini or fal\.ai key/)
  })

  it('takes clips off, then the size down, to stay under the cap', () => {
    const counts = { ...estimateCounts(brief, phrases, SCRIPT), stills: 30, clips: 6, clipSeconds: 10 }
    const capped = quoteFor({ ...brief, cap: 1.8 }, counts, ALL, { today: '2026-11-16', scriptWritten: true })
    expect(capped.counts.clips).toBe(0)
    expect(capped.total).toBeLessThanOrEqual(1.8)
    expect(capped.notes.join(' ')).toMatch(/every shot is a still/)
    const tight = quoteFor({ ...brief, cap: 1.2 }, counts, ALL, { today: '2026-11-16', scriptWritten: true })
    expect(tight.size).toBe('1K')
    const over = quoteFor({ ...brief, cap: 0.2 }, counts, ALL, { today: '2026-11-16', scriptWritten: true })
    expect(over.within).toBe(false)
    expect(over.missing.join(' ')).toMatch(/more than the \$0\.20/)
  })

  it('goes ahead without asking only when Settings allows it and the video costs less', () => {
    const counts = estimateCounts(brief, phrases, SCRIPT)
    const q = quoteFor(brief, counts, ALL, { today: '2026-11-16', autoUnder: 5 })
    expect(q.total).toBeLessThan(5)
    expect(q.auto).toBe(true)
    expect(quoteFor(brief, counts, ALL, { today: '2026-11-16', autoUnder: null }).auto).toBe(false)
    expect(quoteFor(brief, counts, ALL, { today: '2026-11-16', autoUnder: 0.01 }).auto).toBe(false)
  })

  it('prices a Gemini voice by its date: the rise on January 1, 2027', () => {
    const gemini = { ...brief, voice: { engine: 'gemini' as const, id: 'Charon', name: 'Charon' } }
    const counts = { ...estimateCounts(brief, phrases, SCRIPT), narrationSeconds: 100 }
    const before = quoteFor(gemini, counts, ALL, { today: '2026-12-31' }).lines.find((l) => l.what.startsWith('The narration'))
    const after = quoteFor(gemini, counts, ALL, { today: '2027-01-01' }).lines.find((l) => l.what.startsWith('The narration'))
    expect(before?.cost).toBeCloseTo(100 * 0.000225, 6)
    expect(after?.cost).toBeCloseTo(100 * 0.00045, 6)
  })

  it('reads the asked voice from this Mac when its service has no key', () => {
    const eleven = { ...brief, voice: { engine: 'elevenlabs' as const, id: 'x', name: 'George' } }
    const q = quoteFor(eleven, estimateCounts(brief, phrases, SCRIPT), { ...ALL, elevenlabs: false })
    expect(q.voice.engine).toBe('local')
    expect(q.notes[0]).toMatch(/no ElevenLabs key/)
  })

  it('replies in a sentence, three chips, and the numbers behind Details', () => {
    const q = quoteFor(brief, estimateCounts(brief, phrases, SCRIPT), ALL, { today: '2026-11-16' })
    const r = quoteReply(brief, q, { title: 'Black Gold', scenes: phrases.length })
    expect(r.text).toMatch(/^I'll make a 2:00 cinematic documentary about the 1950s oil boom, read by Michael/)
    expect(r.chips).toHaveLength(3)
    expect(r.details.map((d) => d.label)).toContain('What goes where')
    expect(r.text).not.toMatch(/!/)
  })
})

describe('the shot list', () => {
  const brief = readAsk('make a 2 minute cinematic documentary about the 1950s oil boom') as Brief
  const { phrases } = phrasesAndSections(SCRIPT)
  const answer: ShotListAnswer = {
    style: 'Photoreal archival photograph on 35 mm film.',
    palette: 'amber and cream',
    era: 'California, 1950s',
    characters: [{ id: 'Oil Man', name: 'The oilman', look: 'a tall man in a grey felt hat and a work shirt' }],
    shots: [
      ...phrases.map((_, i) => ({
        phrase: i,
        kind: (i === 1 ? 'clip' : i === 2 ? 'map' : 'still') as 'still',
        prompt: `shot ${i}`,
        move: 'push-in' as const,
        motion: 'smoke drifts',
        characters: ['Oil Man', 'nobody'],
        place: i === 2 ? 'Signal Hill, California' : '',
        titleBig: i === 0 ? '1954' : '',
        titleSmall: '',
        graphic: '' as const,
        text: [],
        values: [],
        items: [],
        callouts: []
      })),
      // A repeat and a phrase that does not exist.
      { ...({} as object), phrase: 0, kind: 'still', prompt: 'again', move: 'drift', motion: '', characters: [], place: '', titleBig: '', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] },
      { phrase: 99, kind: 'still', prompt: 'nowhere', move: 'drift', motion: '', characters: [], place: '', titleBig: '', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] }
    ] as ShotListAnswer['shots']
  }

  it('makes one shot for every phrase, characters only from the bible', () => {
    const checked = checkShotList(answer, phrases, { format: 'documentary', maxClips: 2, maps: true })
    expect(checked.shots.map((s) => s.phrase)).toEqual(phrases.map((_, i) => i))
    expect(checked.bible.characters[0].id).toBe('the-oilman')
    expect(checked.shots[0].visual).toMatchObject({ kind: 'still', characters: ['the-oilman'] })
    expect(checked.shots[0].title).toEqual({ big: '1954', small: '' })
    expect(checked.shots[1].visual.kind).toBe('clip')
    expect(checked.shots[2].visual).toEqual({ kind: 'map', place: 'Signal Hill, California' })
    expect(checked.mended).toContain('a second shot for phrase 0')
    expect(checked.mended).toContain('a shot for phrase 99, which does not exist')
  })

  it('holds clips to what was quoted and drops maps nobody wanted', () => {
    const checked = checkShotList(answer, phrases, { format: 'documentary', maxClips: 0, maps: false })
    expect(checked.shots.some((s) => s.visual.kind === 'clip' || s.visual.kind === 'map')).toBe(false)
  })

  it('fits the shots to the agreed total, clips becoming stills', () => {
    const checked = checkShotList(answer, phrases, { format: 'documentary', maxClips: 2, maps: true })
    const cost = (s: (typeof checked.shots)[number]): number => shotCost(s.visual, 'google', 'google', { clipSeconds: 5 })
    const full = checked.shots.reduce((n, s) => n + cost(s), 0)
    const fitted = fitShots(checked.shots, full - 0.1, cost)
    expect(fitted.downgraded).toBe(1)
    expect(fitted.total).toBeLessThanOrEqual(full - 0.1)
  })

  it('writes prompts from the style bible, with the characters as their sheets say, and never text', () => {
    const checked = checkShotList(answer, phrases, { format: 'documentary', maxClips: 2, maps: true })
    const p = promptFor(checked.shots[0].visual, checked.bible, 'documentary')
    expect(p).toMatch(/^shot 0\. Characters, drawn exactly as described: The oilman: a tall man in a grey felt hat/)
    expect(p).toMatch(/Setting: California, 1950s\. Style: Photoreal archival/)
    expect(p).toMatch(/No text, captions, logos/)
  })

  it('plans shots on this Mac when Claude cannot be asked', () => {
    const local = localShotList(brief, phrases)
    expect(local.shots).toHaveLength(phrases.length)
    expect(local.shots[0].visual.kind).toBe('card')
    expect(local.shots.find((s) => s.title?.big === '1954')).toBeUndefined()
    expect(countShots(local.shots, { sheets: 0, clipSeconds: [], narrationSeconds: 30, narrationChars: 300 }).stills).toBe(
      phrases.length - 1
    )
  })

  it('turns a script answer into the text the person edits', () => {
    expect(
      scriptText({ title: 'Black Gold', sections: [{ heading: 'The strike', paragraphs: ['One. Two.'] }, { heading: '', paragraphs: [' '] }] })
    ).toBe('# Black Gold\n\n## The strike\n\nOne. Two.')
  })
})

// ---------- Assembly ----------

const NARRATION_WORDS = (phrases: string[]): { text: string; startSec: number; endSec: number }[] => {
  const out: { text: string; startSec: number; endSec: number }[] = []
  let t = 0.2
  for (const p of phrases) {
    for (const w of p.split(' ')) {
      out.push({ text: w, startSec: t, endSec: t + 0.3 })
      t += 0.36
    }
    t += 0.5
  }
  return out
}

function made(format: 'documentary' | 'explainer'): Make {
  const brief = readAsk(
    format === 'documentary'
      ? 'make a 2 minute cinematic documentary about the 1950s oil boom'
      : 'make an animated explainer about how the heart works'
  ) as Brief
  const { phrases, sections, headings } = phrasesAndSections(SCRIPT)
  const local = localShotList(brief, phrases)
  const shots = local.shots.map((s, i) => ({
    ...s,
    callouts: format === 'explainer' && i === 1 ? [{ label: 'Coronary arteries', value: '', x: 0.4, y: 0.4 }] : [],
    beat: '',
    file: s.visual.kind === 'still' ? `/made/shot-${i}.png` : null,
    maker: s.visual.kind === 'still' ? ('stand-in' as const) : ('local' as const),
    model: null,
    cost: 0,
    key: null,
    note: null
  }))
  return {
    v: 1,
    brief,
    title: 'Black Gold',
    outline: headings,
    script: SCRIPT,
    phrases,
    sections,
    bible: local.bible,
    shots,
    sheets: [],
    narration: { path: '/made/narration.wav', voice: brief.voice, timing: 'voice', durationSec: 40, cost: 0 },
    images: 'google',
    clips: null,
    spent: 0
  }
}

describe('assembling the edit', () => {
  it('is a valid edit: the narration the only recording, one beat a phrase, every beat covered full frame', () => {
    const make = made('documentary')
    const { doc, unheard, rejected } = assembleDoc({
      id: 'made-1',
      make,
      words: NARRATION_WORDS(make.phrases),
      ground: '/made/ground.png',
      at: '2026-11-16T12:00:00.000Z'
    })
    expect(rejected).toEqual([])
    expect(unheard).toEqual([])
    expect(() => EditDocSchema.parse(doc)).not.toThrow()
    const cut = currentCut(doc)
    expect(doc.sources).toHaveLength(1)
    expect(doc.sources[0]).toMatchObject({ path: '/made/narration.wav', width: 0, height: 0, fps: 24 })
    expect(cut.beats).toHaveLength(make.phrases.length)
    expect(cut.beats.every((b) => b.treatment.frame === 'broll' && b.treatment.broll?.muted)).toBe(true)
    expect(cut.beats[1].treatment.broll?.camera?.kind).toBeTruthy()
    expect(cut.look?.name).toBe('archival')
    expect(cut.look?.dust).toBeGreaterThan(0)
    expect(cut.captions.on).toBe(false)
    expect(cut.aspect).toBe('wide')
    expect(cut.fade).toMatchObject({ inSec: 1, outSec: 1.5 })
    // The opening title card is an engraved title over the whole beat.
    expect(cut.motion.find((m) => m.kind === 'title')).toMatchObject({ style: 'engraved', from: 'b1', to: 'b1.end' })
    // The second section dissolves in.
    expect(cut.beats[make.sections[1]].transition?.kind).toBe('dissolve')
    expect(doc.make?.title).toBe('Black Gold')
  })

  it('keeps the narration whole: the pauses between phrases play, nothing is cut', () => {
    const make = made('documentary')
    const words = NARRATION_WORDS(make.phrases)
    const { doc } = assembleDoc({ id: 'made-2', make, words, ground: '/made/ground.png' })
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    const said = resolved.words.map((w) => w.text)
    expect(said).toEqual(words.map((w) => w.text))
    // The cut runs as long as the narration's words, the dissolve's overlap aside.
    expect(resolved.durationSec).toBeGreaterThan(words[words.length - 1].endSec - 1.2)
  })

  it('gives an explainer its clean look, labels that pop and the video frame rate', () => {
    const make = made('explainer')
    const { doc, rejected } = assembleDoc({ id: 'made-3', make, words: NARRATION_WORDS(make.phrases), ground: '/g.png' })
    expect(rejected).toEqual([])
    const cut: Cut = currentCut(doc)
    expect(doc.sources[0].fps).toBe(30)
    expect(cut.look?.name).toBe('explainer')
    expect(cut.motion.find((m) => m.kind === 'callout')).toMatchObject({ style: 'label', text: ['Coronary arteries'], box: [0.4, 0.4] })
    expect(cut.beats.find((b) => b.sfx?.length)?.sfx?.[0].kind).toBe('pop')
  })

  it('names the look each choice wears', () => {
    expect(lookFor('sepia').sepia).toBeGreaterThan(lookFor('archival').sepia as number)
    expect(lookFor('black-and-white').saturation).toBe(-1)
    expect(lookFor('clean').dust).toBeUndefined()
  })
})

describe('asks of a made video', () => {
  const make = made('documentary')
  make.shots = make.shots.map((s, i) => ({ ...s, beat: `b${i + 1}` }))
  make.shots[2] = { ...make.shots[2], visual: { kind: 'still', prompt: 'An oil derrick at dusk, a man in a felt hat beside it', move: 'push-in', characters: [] } }

  it('makes one shot again from "make this shot a close-up of his hands", on the shot on screen', () => {
    const ask = readMakeAsk(make, 'make this shot a close-up of his hands', 'b3')
    expect(ask).toEqual({ kind: 'reshoot', phrase: 2, want: 'close-up of his hands' })
  })

  it('finds a shot by number or by what it shows', () => {
    expect(shotMeant(make, 'shot 2', null)?.phrase).toBe(1)
    expect(shotMeant(make, 'the third shot', null)?.phrase).toBe(2)
    expect(shotMeant(make, 'the derrick shot', null)?.phrase).toBe(2)
  })

  it('reads a new voice, a new style, a new length and a swap for B-roll', () => {
    expect(readMakeAsk(make, 'use a different voice', null)).toMatchObject({ kind: 'voice', own: false })
    expect(readMakeAsk(make, 'use a british voice', null)).toEqual({
      kind: 'voice',
      voice: { engine: 'local', id: 'bm_george', name: 'George' },
      own: false
    })
    expect(readMakeAsk(make, 'make it an explainer instead', null)).toEqual({ kind: 'restyle', format: 'explainer' })
    expect(readMakeAsk(make, 'make it 8 minutes', null)).toEqual({ kind: 'length', seconds: 480 })
    expect(readMakeAsk(make, 'swap the derrick shot for b-roll', null)).toMatchObject({ kind: 'broll', phrase: 2 })
  })

  it('leaves ordinary edits to the planner', () => {
    expect(readMakeAsk(make, 'add a music bed', null)).toBeNull()
    expect(readMakeAsk(make, 'make the titles bigger', null)).toBeNull()
  })
})
