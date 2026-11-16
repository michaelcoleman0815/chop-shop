/**
 * Three long recordings with known contents, for testing /clipping: a
 * church service, a two-voice podcast and a livestream. Each is a list of
 * parts (speech, singing, music, laughter, game sound, quiet), some tagged
 * with what they are, so a test knows where the worship set and the sponsor
 * read are, and which stories a clip has to find whole.
 *
 * The same parts make the end-to-end media (espeak-ng and ffmpeg, in the
 * builder's scratch folder), where every word's time is measured from the
 * speech itself. Here, `plantedWords` lays the words out at a steady
 * speaking pace, which is close enough for the logic.
 *
 * Only tests and the media maker import this.
 */

export type Part =
  /** Spoken sentences; `after` is the quiet that follows, in seconds. */
  | { say: string; voice?: 'a' | 'b'; after?: number; tag?: string; loud?: boolean }
  /** Lines sung over music, each as many times as listed. */
  | { sing: [string, number][]; tag: string }
  /** Music with nobody talking; `frozen` holds the picture still; `heard` is what a recogniser writes over it. */
  | { music: number; tag: string; frozen?: boolean; heard?: { at: number; text: string }[] }
  | { laugh: number }
  /** A game's sound, with the odd word said over it. */
  | { game: number; tag: string; words?: { at: number; text: string }[] }
  | { quiet: number }

export interface Planted {
  name: string
  kind: 'church' | 'podcast' | 'livestream'
  parts: Part[]
  /** Moments a clip must find whole: from the sentence starting `starts` to the one ending `ends`. */
  moments: { tag: string; starts: string; ends: string }[]
  /** Tags of stretches no clip may reach into. */
  never: string[]
}

// ---------- Filler ----------

/** A small seeded generator, so the filler is the same on every machine. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]

/**
 * Ordinary talk that no clip should want: no story, no question, no point,
 * just people talking. Varied enough that it never reads as a song.
 */
export function filler(seed: number, sentences: number, style: 'sermon' | 'chat' | 'stream'): string[] {
  const r = random(seed)
  const lead = {
    sermon: [
      'In this passage',
      'Here in the text',
      'In the original language',
      'Across these chapters',
      'In the verses around it',
      'Throughout the book'
    ],
    chat: ['For the most part', 'Most weeks', 'Usually', 'Around the shop', 'On a normal day', 'Back at the office'],
    stream: ['Right now', 'For this run', 'On this map', 'Today', 'Over the weekend', 'For the next hour']
  }[style]
  const subject = {
    sermon: [
      'the writer',
      'the author',
      'the narrator',
      'the early church',
      'the crowd',
      'the disciples',
      'the older brother',
      'the Pharisees',
      'the listeners'
    ],
    chat: [
      'the crew',
      'our team',
      'the building manager',
      'the night shift',
      'the inspectors',
      'my partner',
      'the contractor',
      'the front desk'
    ],
    stream: [
      'the team',
      'my settings',
      'the matchmaking',
      'the loadout',
      'the patch',
      'the server',
      'my keyboard',
      'the overlay'
    ]
  }[style]
  const verb = {
    sermon: [
      'returns to',
      'points toward',
      'carefully describes',
      'repeats',
      'contrasts',
      'builds on',
      'slowly unfolds',
      'circles back to'
    ],
    chat: ['handles', 'schedules', 'reviews', 'double checks', 'signs off on', 'keeps track of', 'sorts out', 'logs'],
    stream: ['changes', 'resets', 'updates', 'tweaks', 'balances', 'adjusts', 'checks', 'loads']
  }[style]
  const object = {
    sermon: [
      'the theme of the chapter',
      'a familiar pattern',
      'the wider argument',
      'an older tradition',
      'the setting of the meal',
      'a common phrase',
      'the structure of the parable',
      'the cultural background'
    ],
    chat: [
      'the paperwork',
      'the maintenance logs',
      'the parts orders',
      'the weekly reports',
      'the service calendar',
      'the safety forms',
      'the inventory sheets',
      'the billing details'
    ],
    stream: [
      'the sensitivity',
      'the graphics options',
      'the inventory',
      'the minimap',
      'the crosshair',
      'the audio mix',
      'the spawn timers',
      'the camera angle'
    ]
  }[style]
  const tail = {
    sermon: [
      'in a quiet way',
      'without much comment',
      'several times over',
      'in the same sequence',
      'as the scene moves along',
      'in plain language',
      'with careful wording',
      'along the same lines'
    ],
    chat: [
      'every couple of weeks',
      'before the end of the month',
      'pretty much on schedule',
      'whenever it comes up',
      'in the usual order',
      'during the slow season',
      'most of the time',
      'as a matter of routine'
    ],
    stream: [
      'for a little while',
      'between matches',
      'after every round',
      'in the menu',
      'once in a while',
      'when it lags',
      'during the queue',
      'as usual'
    ]
  }[style]
  const asides = {
    sermon: [
      'Scholars have written a great deal about that detail.',
      'That structure shows up elsewhere as well.',
      'The wording there is fairly standard for the period.',
      'Several translations handle that phrase in slightly different ways.'
    ],
    chat: [
      'Yeah, that part is pretty standard.',
      'Right, it depends on the building.',
      'Sure, that makes sense.',
      'Mostly it is just routine work.',
      'Okay, got it.'
    ],
    stream: ['Okay, cool.', 'Yeah, that is fine.', 'Alright, moving on.', 'Sure, sure.', 'That works for now.']
  }[style]
  const out: string[] = []
  for (let i = 0; i < sentences; i++) {
    if (r() < 0.18) {
      out.push(pick(r, asides))
      continue
    }
    out.push(`${pick(r, lead)}, ${pick(r, subject)} ${pick(r, verb)} ${pick(r, object)} ${pick(r, tail)}.`)
  }
  return out
}

/** Speech parts from sentences, with a steady pause between them. */
function talk(sentences: string[], voice?: 'a' | 'b', tag?: string, after = 0.45): Part[] {
  return sentences.map((say) => ({ say, voice, tag, after }))
}

/** A conversation from alternating lines: host first. */
function chat(lines: string[], tag?: string): Part[] {
  return lines.map((say, i) => ({ say, voice: i % 2 === 0 ? ('a' as const) : ('b' as const), tag, after: 0.5 }))
}

/** Filler talk for a conversation, the two voices taking turns a few sentences at a time. */
function chatFiller(seed: number, sentences: number): Part[] {
  const lines = filler(seed, sentences, 'chat')
  const out: Part[] = []
  let voice: 'a' | 'b' = 'b'
  lines.forEach((say, i) => {
    if (i % 3 === 0) voice = voice === 'a' ? 'b' : 'a'
    out.push({ say, voice, after: 0.45 })
  })
  return out
}

// ---------- The service ----------

// Sung the way a worship set is: short lines, each said over and over. A
// real set measured 9 to 14 per cent unique words (shared/clipping/worship).
const SONG: [string, number][] = [
  ['You are the light in the dark', 4],
  ['You are the hope when I fall', 4],
  ['We lift our hands to you', 6],
  ['Holy holy you are holy', 6],
  ['You are the light in the dark', 4],
  ['We lift our hands to you', 6],
  ['You are holy you are holy', 8]
]

const SECOND_SONG: [string, number][] = [
  ['Great is your mercy on me', 6],
  ['Your love will not let me go', 6],
  ['Never let me go', 8],
  ['Great is your mercy on me', 6]
]

const CLOSING_SONG: [string, number][] = [
  ['Run to me run to me', 6],
  ['Father you run to me', 6],
  ['Run to me run to me', 6],
  ['When I was far away', 4],
  ['Father you run to me', 8]
]

export const SERVICE: Planted = {
  name: 'Sunday service',
  kind: 'church',
  parts: [
    { music: 40, tag: 'prelude' },
    { sing: SONG, tag: 'worship' },
    { sing: SECOND_SONG, tag: 'worship' },
    { quiet: 2 },
    ...talk(
      [
        'Good morning, church. It is so good to see you this morning.',
        'We have a few announcements before we open the word.',
        'The fall potluck is next Sunday right after the second service, so bring a dish to share.',
        'Small groups start again this week, and you can sign up at the welcome center in the lobby.',
        'Our kids ministry needs two more volunteers for the nursery on Wednesday nights.',
        'If you are new with us, fill out a connect card and drop it in the box by the doors.',
        'And the men’s breakfast is this Saturday at eight in the fellowship hall.'
      ],
      undefined,
      'announcements',
      0.6
    ),
    ...talk(
      [
        'As the ushers come forward, we want to give you a chance to worship through giving.',
        'You can give online at our website, or text the word give to the number on the screen.',
        'Thank you for your generosity. Your gifts keep the doors open for this whole city.'
      ],
      undefined,
      'giving',
      0.6
    ),
    { quiet: 2 },
    ...talk(
      [
        'Our reading this morning is from Luke chapter fifteen.',
        'There was a man who had two sons.',
        'The younger one said to his father, give me my share of the estate, and the father divided his property between them.',
        'Not long after that, the younger son gathered everything he had and set off for a distant country, and there he wasted it all in wild living.',
        'When he had spent everything, a severe famine came over that whole country, and he began to be in need.',
        'When he came to his senses, he said, I will get up and go to my father.',
        'But while he was still a long way off, his father saw him and was filled with compassion, and he ran to his son and threw his arms around him.',
        'This is the word of the Lord.'
      ],
      undefined,
      'scripture',
      0.7
    ),
    { quiet: 2 },
    ...talk(filler(11, 22, 'sermon'), undefined, 'teaching'),
    { quiet: 1.2 },
    { say: 'I want to tell you about my father.', tag: 'teaching', after: 0.6 },
    ...talk(
      [
        'In the winter of nineteen eighty seven, my father lost his job at the steel mill in Youngstown.',
        'He did not tell anyone for three weeks.',
        'Every morning he put on his work boots, packed his lunch, and drove to the public library, where he sat until five o’clock reading the want ads.',
        'My mother found out when the bank called about the mortgage.',
        'She did not yell. She drove to the library, sat down across the table from him, and slid half of her sandwich over to his side.',
        'She never said one word about the boots.',
        'That is what grace looks like.'
      ],
      undefined,
      'story-1',
      0.5
    ),
    { quiet: 1.6 },
    ...talk(filler(23, 24, 'sermon'), undefined, 'teaching'),
    { quiet: 1.2 },
    ...talk(
      [
        'When I was nineteen, I had forty dollars and a bus ticket to Chicago, and I was sure I was never coming home.',
        'I lasted eleven days.',
        'I slept in a laundromat on Clark Street because it stayed warm all night.',
        'On the eleventh night I called home collect from a pay phone, with a whole speech ready.',
        'My grandmother answered on the first ring. She said, your room is made up, and she hung up the phone.',
        'That is when I learned that home is not a place you earn your way back into.'
      ],
      undefined,
      'story-2',
      0.5
    ),
    { quiet: 1.6 },
    ...talk(
      [
        'Now, the older brother in the story has a hard time with all of this.',
        'He has kept every rule, and he cannot understand why there is a party.',
        'Some of us know exactly how he feels.',
        'We talk a lot about forgiveness in church, but most of us would rather keep score.'
      ],
      undefined,
      'teaching',
      0.5
    ),
    ...talk(filler(37, 18, 'sermon'), undefined, 'teaching'),
    { quiet: 1.2 },
    ...talk(
      [
        'Two years ago, a woman in our church named Ruth asked me to drive her to the state prison in Marion.',
        'Her son had been there for nine years, and she had never once gone to see him.',
        'We sat in the parking lot for forty minutes while she held her purse in both hands.',
        'Then she walked in, sat down across from him, and the first thing she said was, I am sorry I waited so long.',
        'He put his head down on the table and cried.',
        'Forgiveness is not a feeling you wait for, it is a door you walk through.'
      ],
      undefined,
      'story-3',
      0.5
    ),
    { quiet: 1.6 },
    ...talk(filler(41, 16, 'sermon'), undefined, 'teaching'),
    ...talk(
      [
        'So this week, find one table to sit down at.',
        'Find one person who is still a long way off, and go to them first.'
      ],
      undefined,
      'application',
      0.6
    ),
    { quiet: 2 },
    ...talk(
      [
        'Let us pray.',
        'Father, we thank you for running toward us.',
        'For every one of us still sitting in the parking lot, give us courage.',
        'For every one of us with a speech ready, let us hear your voice first.',
        'Teach us to slide half of what we have across the table.',
        'We pray this in Jesus’ name.',
        'Amen.'
      ],
      undefined,
      'prayer',
      1.35
    ),
    { quiet: 1 },
    { sing: CLOSING_SONG, tag: 'worship-2' },
    { quiet: 1.5 },
    ...talk(['Go in peace. Have a great week, and we will see you next Sunday.'], undefined, 'goodbye', 0.8),
    { music: 30, tag: 'postlude' }
  ],
  moments: [
    {
      tag: 'story-1',
      starts: 'In the winter of nineteen eighty seven',
      ends: 'That is what grace looks like.'
    },
    {
      tag: 'story-2',
      starts: 'When I was nineteen',
      ends: 'earn your way back into.'
    },
    {
      tag: 'story-3',
      starts: 'Two years ago, a woman in our church',
      ends: 'it is a door you walk through.'
    }
  ],
  never: ['worship', 'worship-2', 'announcements', 'giving', 'goodbye']
}

// ---------- The podcast ----------

export const PODCAST: Planted = {
  name: 'Long Table episode 41',
  kind: 'podcast',
  parts: [
    { quiet: 1.5 },
    ...chat(
      [
        'Are we recording? Is the red light on?',
        'I think so. Can you hear me okay?',
        'Yeah, you sound great. Let me just check my levels. Testing, testing.',
        'Do I need to sit closer to the mic?',
        'No, you are fine where you are. Okay, let’s do this.'
      ],
      'warmup'
    ),
    { quiet: 1.2 },
    {
      say: 'Welcome to the Long Table podcast, where we talk with people about the work they actually do.',
      voice: 'a',
      after: 0.4
    },
    {
      say: 'I am Sam, and today my guest is Jordan Reyes, who has spent twenty years fixing elevators in high rise buildings.',
      voice: 'a',
      after: 0.5
    },
    { say: 'Thanks for having me, Sam. I am happy to be here.', voice: 'b', after: 0.6 },
    ...chatFiller(5, 52),
    { quiet: 1.2 },
    { say: 'What was the worst day you ever had on the job?', voice: 'a', tag: 'qa-1', after: 0.7 },
    ...talk(
      [
        'It was the Fourth of July, two thousand nine, in a hotel in Phoenix.',
        'Forty people were stuck between the ninth and tenth floors, and it was a hundred and twelve degrees outside.',
        'The power had dropped out, the backup had failed, and the car was full of wedding guests in suits.',
        'I had to hand crank the car down a floor at a time, and every few minutes somebody would shout up to ask if I was still there.',
        'When I finally got the doors open, the first man off the car handed me a melting ice cream bar.'
      ],
      'b',
      'qa-1',
      0.45
    ),
    { laugh: 2.2 },
    { say: 'I ate it, too. Best tip I ever got.', voice: 'b', tag: 'qa-1', after: 1.4 },
    ...chatFiller(17, 60),
    { quiet: 1 },
    ...talk(
      [
        'Quick break.',
        'This episode is brought to you by Northwind Coffee.',
        'Northwind roasts small batches every Monday and ships them the same day.',
        'Use code TABLE for twenty percent off your first bag.',
        'Head to northwind dot com, and the link is in the description.'
      ],
      'a',
      'sponsor',
      0.5
    ),
    { say: 'Okay, back to Jordan.', voice: 'a', after: 0.8 },
    ...chatFiller(29, 40),
    { quiet: 1.2 },
    {
      say: 'Is it true that the close door button in an elevator does not actually do anything?',
      voice: 'a',
      tag: 'qa-2',
      after: 0.7
    },
    ...talk(
      [
        'In most buildings, yes, and I am sorry to be the one to tell you.',
        'Since nineteen ninety, the doors have to stay open long enough for someone in a wheelchair to get on, so the timer wins.',
        'The button is wired up, it lights up, and it does nothing at all.',
        'I have watched grown men press it eleven times in a row.'
      ],
      'b',
      'qa-2',
      0.45
    ),
    { laugh: 1.8 },
    {
      say: 'So the button is really there to give you something to do with your hands.',
      voice: 'b',
      tag: 'qa-2',
      after: 1.5
    },
    ...chatFiller(43, 58),
    { quiet: 1.2 },
    { say: 'What would you tell someone who is scared to ride an elevator?', voice: 'a', tag: 'qa-3', after: 0.7 },
    ...talk(
      [
        'I would tell them the truth, which is that the car is held by six to eight steel cables.',
        'Any one of those cables can hold the whole car by itself, with everyone in it.',
        'And if they all snapped at once, the brakes on the rails would stop the car inside of a few feet.',
        'But honestly, the thing that keeps you safe is not the cables.',
        'It is the person who checked them on Tuesday.',
        'That is why I have never once skipped a Tuesday.'
      ],
      'b',
      'qa-3',
      0.45
    ),
    { quiet: 1.5 },
    ...chatFiller(59, 52),
    { quiet: 1.2 },
    ...chat(
      [
        'Jordan, this was great. Thanks for coming on.',
        'Thanks for having me, Sam.',
        'That is all the time we have. Thanks for listening, and we will see you next week.',
        'Bye everyone.'
      ],
      'goodbye'
    ),
    { quiet: 2 }
  ],
  moments: [
    { tag: 'qa-1', starts: 'What was the worst day', ends: 'Best tip I ever got.' },
    { tag: 'qa-2', starts: 'Is it true that the close door button', ends: 'something to do with your hands.' },
    { tag: 'qa-3', starts: 'What would you tell someone', ends: 'never once skipped a Tuesday.' }
  ],
  never: ['warmup', 'sponsor', 'goodbye']
}

// ---------- The stream ----------

function streamTalk(seed: number, sentences: number): Part[] {
  return talk(filler(seed, sentences, 'stream'), 'a', undefined, 0.5)
}

export const STREAM: Planted = {
  name: 'Friday night stream',
  kind: 'livestream',
  parts: [
    {
      music: 300,
      tag: 'starting-soon',
      frozen: true,
      heard: [
        { at: 95, text: 'Thank you.' },
        { at: 211, text: 'Thanks for watching.' }
      ]
    },
    ...talk(
      [
        'Hey chat, welcome in, we are live.',
        'Give me one second to fix the overlay.',
        'Okay, there we go, I can see you all now.'
      ],
      'a',
      'opening',
      0.6
    ),
    ...streamTalk(3, 40),
    { quiet: 1.3 },
    ...talk(
      [
        'Last summer I drove eleven hours to a tournament in Denver with two friends and a cooler full of sandwiches.',
        'We got there at three in the morning, and the hotel had given our room away.',
        'So we slept in the car in the parking garage, all three of us, with our knees up by our ears.',
        'The next day I played the worst match of my life and we were out by ten o’clock.',
        'And honestly, it is still the best weekend I have ever had, because of who was in that car.'
      ],
      'a',
      'story-1',
      0.5
    ),
    { laugh: 1.5 },
    { quiet: 1.2 },
    ...streamTalk(7, 36),
    {
      game: 420,
      tag: 'game',
      words: [
        { at: 40, text: 'Okay.' },
        { at: 130, text: 'Nice.' },
        { at: 300, text: 'Come on.' }
      ]
    },
    ...streamTalk(13, 30),
    { quiet: 1.2 },
    {
      say: 'Someone in chat is asking, what is the hardest boss you have ever beaten?',
      voice: 'a',
      tag: 'chat-q',
      after: 0.7
    },
    ...talk(
      [
        'Honestly, it was the clockwork king in the first game, on the hard difficulty.',
        'It took me two hundred and forty tries over three weeks, and I kept a tally on a sticky note on my monitor.',
        'When I finally beat him, it was four in the morning, and I was so loud that my neighbour knocked on the wall.',
        'I still have that sticky note in a drawer.',
        'That is the difference between being good at a game and just refusing to quit.'
      ],
      'a',
      'chat-q',
      0.5
    ),
    { quiet: 1.5 },
    ...streamTalk(19, 34),
    {
      game: 480,
      tag: 'game',
      words: [
        { at: 60, text: 'Wait.' },
        { at: 250, text: 'Okay, okay.' }
      ]
    },
    { quiet: 1 },
    ...talk(['Alright chat, I need a quick break, I will be right back.'], 'a', 'brb-lead', 0.8),
    { music: 300, tag: 'brb', frozen: true, heard: [{ at: 150, text: 'Thank you.' }] },
    ...talk(['Okay, I am back, thank you for waiting.'], 'a', undefined, 0.6),
    ...streamTalk(23, 36),
    { game: 300, tag: 'game', words: [{ at: 20, text: 'Here we go.' }] },
    { quiet: 0.8 },
    {
      say: 'No way. No way! Did you see that? I hit the jump from the top of the tower and landed right on the flag!',
      voice: 'a',
      tag: 'hype',
      loud: true,
      after: 0.4
    },
    {
      say: 'Chat, clip that, somebody clip that right now, that is the best thing I have done all year!',
      voice: 'a',
      tag: 'hype',
      loud: true,
      after: 0.4
    },
    { laugh: 2 },
    {
      say: 'I have been trying that jump for two months and it finally worked on stream with everybody watching.',
      voice: 'a',
      tag: 'hype',
      after: 1.2
    },
    ...streamTalk(29, 34),
    { game: 360, tag: 'game', words: [{ at: 90, text: 'Nice.' }] },
    ...streamTalk(31, 30),
    { quiet: 1.3 },
    ...talk(
      [
        'Three years ago, I was streaming to four people, and two of them were my mom and my cousin.',
        'I almost quit every single week that first year.',
        'One night a viewer I had never met sent me a message that just said, you made my night shift easier.',
        'I printed that message out and taped it to the wall behind my desk, and it is still there.',
        'That is why I keep doing this, even on the nights when nothing goes right.'
      ],
      'a',
      'story-2',
      0.5
    ),
    { quiet: 1.5 },
    ...streamTalk(37, 30),
    { game: 420, tag: 'game', words: [{ at: 200, text: 'Got it.' }] },
    ...streamTalk(41, 26),
    ...talk(
      ['Okay chat, that is it for tonight.', 'Thanks for hanging out with me. Good night everyone.'],
      'a',
      'outro',
      0.7
    ),
    { music: 60, tag: 'ending', frozen: true }
  ],
  moments: [
    { tag: 'story-1', starts: 'Last summer I drove eleven hours', ends: 'because of who was in that car.' },
    { tag: 'chat-q', starts: 'Someone in chat is asking', ends: 'just refusing to quit.' },
    { tag: 'story-2', starts: 'Three years ago, I was streaming', ends: 'even on the nights when nothing goes right.' }
  ],
  never: ['starting-soon', 'brb', 'ending']
}

export const PLANTED: Planted[] = [SERVICE, PODCAST, STREAM]

// ---------- Laying the words out ----------

export interface PlantedWord {
  text: string
  startSec: number
  endSec: number
  tag: string | null
  voice: 'a' | 'b'
}

export interface PlantedTimeline {
  words: PlantedWord[]
  /** Every tagged stretch, start to end. */
  spans: { tag: string; startSec: number; endSec: number }[]
  laughter: { startSec: number; endSec: number }[]
  music: { startSec: number; endSec: number; frozen: boolean; sung: boolean }[]
  durationSec: number
}

/** How long a word takes at a steady speaking pace, close to espeak-ng's. */
export function wordSec(text: string): number {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length
  return 0.12 + letters * 0.052
}

/**
 * The words of a planted recording at a steady pace, with every tagged
 * stretch: what the unit tests run on. The media maker measures the real
 * times from the speech it makes.
 */
export function plantedTimeline(p: Planted): PlantedTimeline {
  const words: PlantedWord[] = []
  const spans: PlantedTimeline['spans'] = []
  const laughter: PlantedTimeline['laughter'] = []
  const music: PlantedTimeline['music'] = []
  let t = 0
  const mark = (tag: string | undefined, a: number, b: number): void => {
    if (!tag) return
    const last = spans[spans.length - 1]
    if (last && last.tag === tag && a - last.endSec < 3) last.endSec = b
    else spans.push({ tag, startSec: a, endSec: b })
  }
  const speak = (line: string, voice: 'a' | 'b', tag: string | null, gap = 0.07): number => {
    const start = t
    for (const token of line.split(/\s+/).filter(Boolean)) {
      const d = wordSec(token)
      words.push({ text: token, startSec: round(t), endSec: round(t + d), tag, voice })
      t += d + gap
    }
    return start
  }
  for (const part of p.parts) {
    if ('say' in part) {
      const a = speak(part.say, part.voice ?? 'a', part.tag ?? null)
      mark(part.tag, a, t)
      t += part.after ?? 0.45
    } else if ('sing' in part) {
      const a = t
      for (const [line, times] of part.sing) {
        for (let k = 0; k < times; k++) {
          // Sung slower than speech, with a breath between lines.
          speak(line, 'a', part.tag, 0.25)
          t += 0.9
        }
      }
      music.push({ startSec: a, endSec: t, frozen: false, sung: true })
      mark(part.tag, a, t)
    } else if ('music' in part) {
      const a = t
      for (const h of part.heard ?? []) {
        const before = t
        t = a + h.at
        speak(h.text, 'a', part.tag)
        t = before
      }
      t = a + part.music
      music.push({ startSec: a, endSec: t, frozen: !!part.frozen, sung: false })
      mark(part.tag, a, t)
    } else if ('laugh' in part) {
      laughter.push({ startSec: round(t), endSec: round(t + part.laugh) })
      t += part.laugh + 0.3
    } else if ('game' in part) {
      const a = t
      for (const w of part.words ?? []) {
        const before = t
        t = a + w.at
        speak(w.text, 'a', part.tag)
        t = before
      }
      t = a + part.game
      mark(part.tag, a, t)
    } else {
      t += part.quiet
    }
  }
  words.sort((x, y) => x.startSec - y.startSec)
  return { words, spans, laughter, music, durationSec: round(t) }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
