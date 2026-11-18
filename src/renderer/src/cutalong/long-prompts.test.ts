import { readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
    ipcMain: { handle: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('../../../main/apikey', () => ({ readApiKey: () => 'sk-ant-api03-stand-in', hasApiKey: () => true }))

import { amend, commit, currentVersion, resummarize, type EditDoc, type Op } from '../../../shared/edit'
import { motionCommandEntries } from '../../../shared/motion'
import { neverAfter } from '../../../shared/never'
import { PLAN_COMMAND_NAMES, type PlanQuestion } from '../../../shared/plan/commands'
import { planPovs } from '../../../shared/pov'
import { BUILT_IN_PRESETS, CAPTION_STYLE_PRESETS, planStyle, SKILL_PRESETS } from '../../../shared/presets'
import { switchedSentence } from '../../../shared/raw/ask'
import { docFor } from '../../../shared/raw/eval'
import { bringBack, planLength } from '../../../shared/raw/length'
import { switchTakeOps, takesOf } from '../../../shared/raw/plan'
import { carrySteps, composeReply, Gathered, runCommandStep, type CommandRunners } from './carry'
import { keepOffList, MODEL, planEdit, type PlanEditResult } from '../../../main/planner'

/**
 * Whole prompts, as people write them, each asking for many things at once.
 * Claude is stood in for at the network: the real SDK sends the real
 * request and gets back the plan a planner would make for that prompt, which
 * is read with the real schema, checked against the cut (offerPlan) and the
 * channel's never list (keepOffList), then carried out step by step with the
 * real executors (the length cutter, the takes, bring back, the presets) as
 * one version with one reply (renderer/src/cutalong/carry.ts). Nothing leaves
 * this computer.
 */

/** A phone review: an intro said twice, a camera section, a wedding story that goes nowhere, battery, screen, verdict, a call to action. */
const SCRIPT =
  "Hey everyone, welcome back. Today I'm reviewing the Pixel 9 Pro. |0.8| Let's start with the camera. The main camera is a big step up. Low light is where it shines. |1.5| Funny story, I took it to a wedding last weekend. The DJ played the same song four times. |1.5| The battery lasts about two days. Charging is fast, about thirty minutes to half. |1.5| The screen is bright enough to use outside at noon. |1.5| So should you buy it? If you shoot a lot of video, yes. |1.0| Hey everyone, welcome back. Today I'm reviewing the Pixel 9 Pro. |1.0| If this helped, subscribe and tell me what you want reviewed next."

/*
 * Its beats, as createDoc makes them:
 * b1 "Hey everyone, welcome back." b2 "Today I'm reviewing the Pixel 9 Pro."
 * b3 "Let's start with the camera." b4 "The main camera is a big step up." b5 "Low light is where it shines."
 * b6 "Funny story, I took it to a wedding last weekend." b7 "The DJ played the same song four times."
 * b8 "The battery lasts about two days." (w49-w54) b9 "Charging is fast, about thirty minutes to half."
 * b10 "The screen is bright enough to use outside at noon." (w63-w72) b11 "So should you buy it?"
 * b12 "If you shoot a lot of video, yes." (w78-w85) b13, b14 the intro again b15 "If this helped, subscribe..."
 * The intro said twice is the takes block's line g1.
 */
const review = (): EditDoc => docFor({ name: 'review', script: SCRIPT }).doc

/** The slash menu as the planner is sent it: presets, styles, the app's own commands and the motion commands. */
function menu(): { command: string; summary: string }[] {
  const app = readFileSync('src/renderer/src/cutalong/useCutalong.ts', 'utf8')
  const own = [
    ...app.matchAll(/command: '([a-z]+)',\n\s+title: '[^']+',\n\s+summary: '([^']+)'/g),
    ...app.matchAll(/\['([a-z]+)', '[^']+', '([^']+)'\]/g)
  ].map((m) => ({ command: m[1], summary: m[2] }))
  return [
    ...[...BUILT_IN_PRESETS, ...CAPTION_STYLE_PRESETS, ...SKILL_PRESETS].map((p) => ({ command: p.command, summary: p.summary })),
    ...own,
    ...motionCommandEntries().map((m) => ({ command: m.command, summary: m.summary }))
  ]
}
const MENU = menu()
const PRESETS = [...BUILT_IN_PRESETS, ...CAPTION_STYLE_PRESETS, ...SKILL_PRESETS]

const NO_QUESTION: PlanQuestion = { text: '', options: [] }

/** A plan as Claude writes it: every slot filled. */
interface Plan {
  ops: Record<string, unknown>[]
  summary: string
  reply: string
  notesHandled: string[]
  needs: string[]
  brollWanted?: { beat: string; search: string }[]
  question: PlanQuestion
}

const plan = (ops: Plan['ops'], reply: string, more: Partial<Plan> = {}): Plan => ({
  ops,
  summary: more.summary ?? reply,
  reply,
  notesHandled: [],
  needs: [],
  question: NO_QUESTION,
  ...more
})

// The steps, in the shapes the planner's instructions teach.
const run = (command: string, rest = ''): Record<string, unknown> => ({ op: 'run', command, rest, note: '' })
const length = (o: Partial<{ targetSec: number; minSec: number; maxSec: number; under: boolean; intro: boolean; keepAll: boolean }>) => ({
  op: 'length',
  targetSec: 0,
  minSec: 0,
  maxSec: 0,
  under: false,
  intro: false,
  keepAll: false,
  ...o
})
const take = (line: string, n: number) => ({ op: 'take', line, take: n })
const remove = (beats: string[], why = '') => ({ op: 'remove', beats, why })
const captions = (set: Record<string, unknown>) => ({ op: 'captions', set: { on: true, ...set } })
const zoom = (beats: string[], z: number) => ({ op: 'treat', beats, set: { zoom: z } })
const chapters = (set: { beat: string; title: string }[]) => ({ op: 'chapters', set })
const fade = (inSec: number, outSec: number) => ({ op: 'fade', inSec, outSec, color: 'black' })
const transition = (beats: string[], kind: string, sec: number) => ({ op: 'transition', beats, kind, sec })
const sfx = (beats: string[], kind: string, word = '') => ({ op: 'sfx', beats, kind, word, gainDb: 0 })
const look = (name: string) => ({ op: 'look', name, set: [], replace: true, off: false })
const never = (n: string[], allow: string[] = []) => ({ op: 'never', never: n, allow })

/** One prompt: what is said, the plan for it, and the executors it should reach, in order. */
interface Case {
  name: string
  prompt: string
  /** Sent with the footage: the plan shapes v1 itself. */
  first?: boolean
  /** The channel's never list when the prompt is sent. */
  list?: string[]
  offers?: string[]
  /** The edit as it stands before the prompt, from the recording. */
  before?: (doc: EditDoc) => EditDoc
  plan: Plan
  reached: string[]
  check?: (r: Result) => void
}

interface Result {
  offered: Extract<PlanEditResult, { ok: true }>
  before: EditDoc
  after: EditDoc
  reply: ReturnType<typeof composeReply>
  editor: StandIn
  sent: Record<string, unknown>
}

const CASES: Case[] = [
  {
    name: 'a Short for TikTok, from a paragraph',
    prompt:
      'Turn this into a punchy 30 second Short for TikTok. The wedding story goes nowhere, so lose it. Punch in when I talk about the battery, put big captions at the top, and put something upbeat from my music folder under it.',
    plan: plan(
      [
        remove(['b6', 'b7'], 'the wedding story'),
        run('shorts'),
        length({ targetSec: 30 }),
        captions({ position: 'top', wordsPerScreen: 2, uppercase: false }),
        zoom(['b8'], 1.15),
        { op: 'music-track', find: 'upbeat' }
      ],
      'I cut the wedding story, made it a 30 second Short with captions at the top, punched in on the battery and put an upbeat track under it.'
    ),
    reached: ['ops', 'run:shorts', 'length', 'ops', 'music-track']
  },
  {
    name: 'the words sent with the footage shape v1',
    first: true,
    prompt:
      "Here's my Pixel 9 review. I flubbed the intro less the second time, so use that take. Cut the dead air, keep it to about 35 seconds, and add chapters for the camera, the battery and the screen.",
    plan: plan(
      [
        take('g1', 2),
        run('tighten'),
        length({ targetSec: 35 }),
        chapters([
          { beat: 'b3', title: 'The camera' },
          { beat: 'b8', title: 'Battery' },
          { beat: 'b10', title: 'The screen' }
        ])
      ],
      'I used your second take of the intro, cut the dead air, brought it to about 35 seconds and added three chapters.',
      { summary: 'The second take of the intro, the pauses cut, about 35 seconds, and chapters.' }
    ),
    reached: ['take', 'run:tighten', 'length', 'ops'],
    check: ({ before, after, offered }) => {
      // One version: v1 itself, its summary Claude's.
      expect(after.versions).toHaveLength(before.versions.length)
      expect(currentVersion(after).n).toBe(1)
      expect(currentVersion(after).summary).toBe(offered.summary)
    }
  },
  {
    name: 'a rule for the never list, and what to do instead',
    prompt:
      'Never use whooshes on this channel, they feel cheap. Instead put a slow dissolve into the battery part, and fade the end out to black.',
    plan: plan([never(['sfx:whoosh']), transition(['b8'], 'dissolve', 0.5), fade(0, 1)], 'Whooshes are on the never list now. The battery part dissolves in and the end fades out.'),
    reached: ['never', 'ops'],
    check: ({ editor }) => expect(editor.list).toEqual(['sfx:whoosh'])
  },
  {
    name: 'something fine again, used at once',
    list: ['sfx:whoosh', 'bw'],
    prompt: "Whooshes are fine again, I changed my mind. Put one on the cut into the camera section, but keep black and white off this channel.",
    plan: plan([never([], ['sfx:whoosh']), sfx(['b3'], 'whoosh')], 'Whooshes are fine again, and one carries the cut into the camera section.'),
    reached: ['never', 'ops'],
    check: ({ offered, editor }) => {
      // The plan's own rule lifts the whoosh before the step that uses it.
      expect(offered.rejected).toEqual([])
      expect(editor.list).toEqual(['bw'])
    }
  },
  {
    name: 'a whoosh asked for on a channel that never uses them',
    list: ['sfx:whoosh'],
    prompt: 'Add a whoosh on every cut and give the whole thing a warm look, it feels cold right now. Also make the audio louder, like -14 LUFS.',
    plan: plan([sfx(['b3', 'b6', 'b8'], 'whoosh'), look('warm'), { op: 'loudness', lufs: -14 }], 'Whooshes on the cuts, a warm look and the sound at -14 LUFS.'),
    reached: ['ops'],
    check: ({ offered, reply }) => {
      expect(offered.steps).toEqual([{ ops: [expect.objectContaining({ op: 'look' }), { op: 'loudness', lufs: -14 }] }])
      expect(offered.rejected).toEqual(['I left out the whooshes, as Field Notes never uses them.'])
      expect(reply.aside ?? reply.text).toMatch(/I left out the whooshes, as Field Notes never uses them\./)
    }
  },
  {
    name: 'a part brought back by name, under a limit',
    before: (doc) => commit(doc, [remove(['b6', 'b7'], 'the wedding story') as Op], 'The wedding story is out.').doc,
    prompt:
      'Actually bring back the wedding story, a few people said it was the best bit. But keep the whole thing under 45 seconds, and if something has to go, take it from the intro.',
    plan: plan([{ op: 'bring-back', what: 'the wedding story' }, length({ maxSec: 45, under: true })], 'The wedding story is back, and it stays under 45 seconds.'),
    reached: ['bring-back', 'length']
  },
  {
    name: 'vertical, the hook first, captions in the middle',
    prompt:
      'Make it vertical for Reels. The battery line is the hook, so open on it, then the rest in order. Captions in the middle of the screen, uppercase, three words at a time.',
    plan: plan(
      [{ op: 'aspect', aspect: 'vertical' }, { op: 'move', beat: 'b8', to: 0 }, captions({ position: 'middle', uppercase: true, wordsPerScreen: 3 })],
      'It is vertical now and opens on the battery line, with uppercase captions in the middle.'
    ),
    reached: ['ops']
  },
  {
    name: 'finishing, then an export',
    prompt:
      'Tighten up the pauses, fade in from black and out at the end, bring the sound to -14 LUFS for YouTube, and export it when you are done so I can upload tonight.',
    plan: plan([run('tighten'), fade(0.5, 1), { op: 'loudness', lufs: -14 }, { op: 'export' }], 'Tighter, faded in and out, at -14 LUFS, and exported.'),
    reached: ['run:tighten', 'ops', 'export']
  },
  {
    name: 'clips from this recording',
    prompt:
      'Pull 3 of the funniest moments out of this as separate clips for Shorts, each under 30 seconds. Leave this edit as it is.',
    plan: plan([{ op: 'clipping', count: 3, minSec: 0, maxSec: 30, funny: true, topic: '' }], 'I am finding 3 funny clips under 30 seconds.'),
    reached: ['clipping'],
    check: ({ editor }) =>
      expect(editor.clipAsk).toMatchObject({ count: 3, funny: true, length: { maxSec: 30 }, topic: null })
  },
  {
    name: 'told as a vlog',
    prompt:
      'Tell this as a vlog instead of a review: about 8 minutes, open on the beach shots, and less of the hotel. Keep it chronological after the opening.',
    plan: plan([{ op: 'vlog', ask: 'about 8 minutes, open on the beach, less of the hotel' }], 'I am telling it as a vlog that opens on the beach.'),
    reached: ['vlog'],
    check: ({ editor }) => expect(editor.vlogAsk).toBe('about 8 minutes, open on the beach, less of the hotel')
  },
  {
    name: 'the kind of video, how the mouth is used, and a preset',
    prompt:
      "This is a podcast, not a talking head, so cut it like one. Don't time the cuts to my mouth, just keep the audio lined up with it. Then tighten it.",
    plan: plan(
      [{ op: 'profile', kind: 'podcast' }, { op: 'mouth', mode: 'sync' }, run('tighten')],
      'Cut as a podcast now: the sound stays lined up with your mouth, and the pauses are tighter.'
    ),
    reached: ['profile', 'mouth', 'run:tighten'],
    check: ({ editor }) => expect(editor.settings).toEqual({ profile: 'podcast', mouth: 'sync' })
  },
  {
    name: 'another brand, and its captions',
    prompt: 'This one belongs in my Field Notes brand, not the main channel. Switch it over and use that brand’s captions.',
    plan: plan([{ op: 'brand', name: 'Field Notes' }, run('captions')], 'It is in Field Notes now, with its captions.'),
    reached: ['brand', 'run:captions'],
    check: ({ editor }) => expect(editor.brand).toBe('Field Notes')
  },
  {
    name: 'an undo',
    before: (doc) => commit(doc, [{ op: 'aspect', aspect: 'vertical' }], 'Vertical.').doc,
    prompt: 'Undo that, the wide one was better. Sorry for the back and forth.',
    plan: plan([{ op: 'undo' }], 'Back to the wide version.'),
    reached: ['undo']
  },
  {
    name: 'a yes to the cuts offered, and chapters',
    offers: ['the second "Hey everyone, welcome back" and the line after it, at 0:38'],
    prompt: 'Yes, cut those repeats you offered. And while you are at it, add chapters for the camera, the battery and the verdict.',
    plan: plan(
      [{ op: 'accept-offers' }, chapters([{ beat: 'b3', title: 'The camera' }, { beat: 'b8', title: 'Battery' }, { beat: 'b11', title: 'Verdict' }])],
      'The repeats are out and the chapters are in.'
    ),
    reached: ['accept-offers', 'ops'],
    check: ({ sent }) => expect(JSON.stringify(sent)).toContain('<offers>')
  },
  {
    name: 'one question instead of a costly guess',
    prompt: 'Make it warmer.',
    plan: plan([], 'Warmer could mean the picture or the music.', {
      question: { text: 'Which should be warmer?', options: ['Make the picture warmer', 'Make the music warmer'] }
    }),
    reached: [],
    check: ({ reply, after, before }) => {
      expect(after.versions).toHaveLength(before.versions.length)
      expect(reply.text).toBe('Warmer could mean the picture or the music. Which should be warmer?')
      expect(reply.actions).toEqual([
        { kind: 'say', label: 'Make the picture warmer', payload: 'Make the picture warmer', primary: true },
        { kind: 'say', label: 'Make the music warmer', payload: 'Make the music warmer' }
      ])
    }
  },
  {
    name: 'every finishing touch, then Premiere',
    prompt: 'Do all the finishing touches you normally would, the whole lot, and then open it in Premiere so my editor can take it from there.',
    plan: plan([run('all'), run('premiere')], 'Every finishing touch is on, and it is open in Premiere.'),
    reached: ['run:all', 'run:premiere']
  },
  {
    name: 'B-roll wanted, and a dip to white',
    prompt:
      'When I talk about low light, show some city at night B-roll over me. And use a dip to white going into the verdict, it should feel like a reveal.',
    plan: plan([transition(['b11'], 'dip-to-white', 0.8)], 'The verdict comes in through white; I am looking for night city footage for the low light line.', {
      brollWanted: [{ beat: 'b5', search: 'city at night' }]
    }),
    reached: ['ops'],
    check: ({ offered }) => expect(offered.brollWanted).toEqual([{ beat: 'b5', search: 'city at night' }])
  },
  {
    name: 'speed and a freeze',
    prompt: 'Speed up the charging line to one and a half times, it drags. And freeze on the end of the screen line for a second before the verdict.',
    plan: plan(
      [
        { op: 'speed', beats: ['b9'], speed: 1.5, ramp: { inSec: 0, outSec: 0 }, of: '' },
        { op: 'freeze', beat: 'b10', word: 'w72', sec: 1 }
      ],
      'The charging line plays at 1.5x and the screen line holds for a second.'
    ),
    reached: ['ops']
  },
  {
    name: 'the first take, and the call to action out',
    prompt: 'Use the first take of the intro, it has more energy. And drop the subscribe line at the end, I put that in the description now.',
    plan: plan([take('g1', 1), remove(['b15'], 'the subscribe line')], 'The first take of the intro plays, and the subscribe line is out.'),
    reached: ['take', 'ops']
  },
  {
    name: 'a range and the intro out',
    prompt: 'Get it somewhere between 25 and 30 seconds and start right on the camera part, nobody needs the hello.',
    plan: plan([length({ minSec: 25, maxSec: 30, intro: true })], 'It starts on the camera and runs under 30 seconds.'),
    reached: ['length']
  },
  {
    name: 'every line kept, only tighter',
    prompt: 'Keep every line, I need all of it for the sponsor, but tighten it to around 38 seconds.',
    plan: plan([length({ targetSec: 38, keepAll: true })], 'Every line stays; only the pauses are shorter.'),
    reached: ['length']
  },
  {
    // What a sentence asks around its length is part of the same plan, so none of it is lost.
    name: 'a length with what is asked around it',
    prompt: 'Make it 60 seconds with captions.',
    plan: plan([length({ targetSec: 60 }), captions({})], 'It runs 60 seconds, with captions.'),
    reached: ['length', 'ops'],
    check: ({ offered }) =>
      expect(offered.steps.map((s) => ('command' in s ? s.command.op : s.ops.map((o) => o.op).join(',')))).toEqual(['length', 'captions'])
  },
  {
    name: 'a look with grain and a vignette',
    prompt: 'Give it a cinematic look with a bit of film grain and a soft vignette, like the last video.',
    plan: plan([look('cinematic'), run('grain', '0.4'), run('vignette', '0.5')], 'A cinematic look with grain and a soft vignette.'),
    reached: ['ops', 'run:grain', 'run:vignette']
  },
  {
    name: 'rules and a thing fine again, in one sentence',
    list: ['bw'],
    prompt: 'No zoom transitions and no B-roll from outside on this channel, ever. Black and white is fine again though, make the verdict black and white.',
    plan: plan(
      [never(['transition:zoom', 'broll'], ['bw']), { op: 'treat', beats: ['b12'], set: { bw: true } }],
      'Zoom transitions and outside B-roll are on the never list; the verdict is black and white.'
    ),
    reached: ['never', 'ops'],
    check: ({ editor, offered }) => {
      expect(editor.list).toEqual(['transition:zoom', 'broll'])
      expect(offered.rejected).toEqual([])
    }
  },
  {
    name: 'a J cut',
    prompt: 'Let my voice on the battery line start under the end of the camera section, so it flows.',
    plan: plan([{ op: 'jcut', beats: ['b8'], sec: 0.4 }], 'The battery line’s sound starts under the camera section.'),
    reached: ['ops']
  },
  {
    name: 'presets one after another, and music by name',
    prompt: 'Snappy pacing, then your hook treatment, then captions, and some lofi from my music folder under the whole thing.',
    plan: plan([run('snappy'), run('hook'), run('captions'), { op: 'music-track', find: 'lofi' }], 'Snappy, with the hook, captions and lofi under it.'),
    reached: ['run:snappy', 'run:hook', 'run:captions', 'music-track']
  },
  {
    name: 'a track, then its level',
    prompt: 'Put an upbeat track under it, but keep it quiet when I am talking so you can hear me.',
    plan: plan(
      [
        { op: 'music-track', find: 'upbeat' },
        { op: 'music', path: '', set: [{ key: 'levelDb', value: -20 }, { key: 'duckDb', value: 14 }], off: false }
      ],
      'An upbeat track plays under it and drops when you speak.'
    ),
    reached: ['music-track', 'ops']
  },
  {
    name: 'a part out and a word struck',
    prompt: "Cut the 'funny story' line but keep the DJ joke, and take out the 'about' in the battery line, it sounds unsure.",
    plan: plan([remove(['b6'], 'the funny story line'), { op: 'strike', from: 'w52', to: 'w52' }], 'The funny story line is out and the battery line is firmer.'),
    reached: ['ops']
  },
  {
    name: 'v1 shaped with chapters, a fade and an export',
    first: true,
    prompt: "Here's today's video. Chapters for each part, fade out at the end, and export it, I'm in a rush.",
    plan: plan(
      [chapters([{ beat: 'b1', title: 'Intro' }, { beat: 'b3', title: 'Camera' }, { beat: 'b8', title: 'Battery' }]), fade(0, 1), { op: 'export' }],
      'Chapters for each part, a fade at the end, and the export.'
    ),
    reached: ['ops', 'export'],
    check: ({ before, after }) => {
      expect(after.versions).toHaveLength(before.versions.length)
      expect(currentVersion(after).n).toBe(1)
    }
  },
  {
    name: 'clips about one subject',
    prompt: 'Make 5 clips about the camera from this, around a minute each, for LinkedIn. Nothing funny, just the useful parts.',
    plan: plan([{ op: 'clipping', count: 5, minSec: 50, maxSec: 70, funny: false, topic: 'the camera' }], 'I am finding 5 clips about the camera.'),
    reached: ['clipping'],
    check: ({ editor }) => expect(editor.clipAsk).toMatchObject({ count: 5, topic: 'the camera', length: { minSec: 50, maxSec: 70 } })
  },
  {
    name: 'a pop on a word, sped up, drawn captions',
    prompt: "Ramp the speed through the screen line, put a pop on the word 'yes' in the verdict, and use the drawn captions with the big words.",
    plan: plan(
      [
        { op: 'speed', beats: ['b10'], speed: 1.5, ramp: { inSec: 0.4, outSec: 0.4 }, of: '' },
        sfx(['b12'], 'pop', 'w85'),
        captions({ preset: 'hierarchy' })
      ],
      'The screen line ramps, a pop lands on yes, and the captions are drawn.'
    ),
    reached: ['ops']
  },
  {
    name: 'another brand, a rule there, and an export',
    prompt: 'Move this to my Tech brand. That brand never uses transitions at all. Then export.',
    plan: plan([{ op: 'brand', name: 'Tech' }, never(['transition']), { op: 'export' }], 'It is in Tech, which never uses transitions, and it is exported.'),
    reached: ['brand', 'never', 'export']
  },
  {
    name: 'players’ views of one session: follow whoever is talking, everyone when it goes off',
    prompt: 'Follow whoever’s talking, and show everyone at once when it goes off.',
    plan: plan(
      [{ op: 'povs', mode: 'talking', everyone: true, minSec: 0 }],
      'It follows whoever is talking, and everyone shows at once where you all react.'
    ),
    reached: ['povs'],
    // One recording, so there are no other views to cut to, and it says how to add them.
    check: ({ reply }) => expect(reply.aside ?? reply.text).toContain('This edit has one view. Drop the other players’ recordings')
  },
  {
    name: 'a command Cutalong does not have, left out in one sentence',
    prompt: 'Make me dance on the beat for the intro and tighten the rest.',
    plan: plan([run('dance'), run('tighten')], 'Tighter.'),
    reached: ['run:tighten'],
    check: ({ offered }) => expect(offered.rejected).toEqual(['One step asked for something Cutalong cannot do that way, so I left it out.'])
  },
  {
    name: 'a take there is not, left out',
    prompt: 'Use the third take of the intro, it was the best one, and add a fade in.',
    plan: plan([take('g1', 3), fade(0.5, 0)], 'A fade in.'),
    reached: ['ops'],
    check: ({ offered }) => expect(offered.rejected).toHaveLength(1)
  },
  {
    name: 'a length step that asks for nothing, left out',
    prompt: 'Cut it to whatever length you think is best and add captions.',
    plan: plan([length({}), captions({ position: 'chest' })], 'Captions on.'),
    reached: ['ops'],
    check: ({ offered }) => expect(offered.rejected).toHaveLength(1)
  }
]

/**
 * The editor, stood in: what useCutalong does with a plan, without React.
 * Its versions are made with commit and amend; its commands reach the real
 * executors where they live in shared/, and say what they did.
 */
class StandIn {
  doc: EditDoc
  readonly g: Gathered
  readonly reached: string[] = []
  list: string[]
  clipAsk: unknown = null
  vlogAsk: string | null = null
  brand: string | null = null
  settings: { profile?: string; mouth?: string } = {}
  private changes = 0
  private ids = 0

  constructor(doc: EditDoc, first: boolean, list: string[]) {
    this.doc = doc
    this.list = list
    this.g = new Gathered({ into: first ? currentVersion(doc).n : null, replaces: first })
  }

  say(text: string): void {
    this.g.push({ role: 'assistant', text }, `m${this.ids++}`)
  }

  /** One version for the whole plan: the first change makes it (or shapes v1), the rest add to it. */
  apply(ops: Op[], summary: string): void {
    if (ops.length === 0) return
    const into = this.g.into === currentVersion(this.doc).n
    const r = into ? amend(this.doc, ops, summary) : commit(this.doc, ops, summary)
    if (r.applied.length === 0) return
    this.doc = r.doc
    this.g.into = currentVersion(this.doc).n
    this.g.summaries.push(summary)
    this.changes++
  }

  version(): string {
    return String(this.changes)
  }

  runners(): CommandRunners {
    return {
      run: async (command, rest) => {
        this.reached.push(`run:${command}`)
        const preset = PRESETS.find((p) => p.command === command)
        if (preset) this.apply(planStyle(this.doc, preset.style).ops, preset.summary)
        else this.say(`/${command}${rest ? ` ${rest}` : ''} is done.`)
      },
      length: async (ask) => {
        this.reached.push('length')
        const p = planLength(this.doc, ask)
        if (p.ops.length) this.apply(p.ops, p.summary)
        else this.say(p.note ?? 'That is already how long it runs.')
      },
      take: (line, n) => {
        this.reached.push('take')
        const group = takesOf(this.doc)
          .flatMap((a) => a.groups)
          .find((g) => g.id === line)
        if (group) this.apply(switchTakeOps(this.doc, group, n - 1), switchedSentence(group, n - 1))
      },
      bringBack: (what) => {
        this.reached.push('bring-back')
        const p = bringBack(this.doc, what)
        if (p) this.apply(p.ops, p.summary)
        else this.say(`Nothing was cut as ${what}.`)
      },
      musicTrack: async (find) => {
        this.reached.push('music-track')
        this.apply([{ op: 'music', set: { path: `/Users/you/Music/${find || 'track'}.mp3` } } as Op], `A ${find} track plays under it.`)
      },
      clipping: async (ask) => {
        this.reached.push('clipping')
        this.clipAsk = ask
        this.say(`I am looking for ${ask.count ?? 'the best'} clips.`)
      },
      vlog: async (ask) => {
        this.reached.push('vlog')
        this.vlogAsk = ask
      },
      exportVideo: async () => {
        this.reached.push('export')
        this.say(`v${currentVersion(this.doc).n} is exported.`)
      },
      acceptOffers: () => {
        this.reached.push('accept-offers')
        this.apply([{ op: 'remove', beats: ['b13', 'b14'] }], 'The repeats are out.')
      },
      profile: (kind) => {
        this.reached.push('profile')
        this.settings.profile = kind
      },
      mouth: (mode) => {
        this.reached.push('mouth')
        this.settings.mouth = mode
      },
      never: async (n, allow) => {
        this.reached.push('never')
        this.list = neverAfter(this.list, { never: n, allow })
      },
      brand: (name) => {
        this.reached.push('brand')
        this.brand = name
      },
      povs: async (mode, everyone, minSec) => {
        this.reached.push('povs')
        const p = planPovs(this.doc, { mode, everyone, minSec })
        if ('ops' in p) this.apply(p.ops, p.summary)
        else this.say(p.say)
      },
      undo: () => {
        this.reached.push('undo')
      }
    }
  }
}

/** Anthropic as the SDK talks to it: every request is kept, and each is answered with the plan. */
function standInClaude(answer: Plan): { fetch: typeof fetch; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  const spy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({
        id: 'msg_stand_in',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  })
  return { fetch: spy as unknown as typeof fetch, sent }
}

async function carry(c: Case): Promise<Result> {
  const before = (c.before ?? ((d: EditDoc) => d))(review())
  const claude = standInClaude(c.plan)
  const r = await planEdit(
    {
      doc: before,
      request: c.prompt,
      notes: [],
      commands: MENU,
      offers: c.offers,
      brands: [
        { name: 'Main channel', current: true },
        { name: 'Field Notes', current: false },
        { name: 'Tech', current: false }
      ]
    },
    { fetch: claude.fetch }
  )
  if (!r.ok) throw new Error(r.message)
  const list = c.list ?? []
  const offered = keepOffList(r, before, list, 'Field Notes')
  if (!offered.ok) throw new Error('not ok')
  const editor = new StandIn(before, !!c.first, list)
  const outcomes = await carrySteps(offered.steps, {
    apply: (ops) => {
      editor.reached.push('ops')
      editor.apply(ops as Op[], offered.summary)
    },
    command: (command) => runCommandStep(command, editor.runners(), c.prompt),
    version: () => editor.version(),
    said: (from) => editor.g.since(from),
    mark: () => editor.g.mark(),
    still: () => true
  })
  const changed = editor.version() !== '0'
  const reply = composeReply({
    plan: offered,
    outcomes,
    version: changed ? { n: currentVersion(editor.doc).n, summary: currentVersion(editor.doc).summary } : null
  })
  // As the editor does: when every step did what it set out to, the version takes Claude's summary.
  const after = changed && reply.complete ? resummarize(editor.doc, offered.summary) : editor.doc
  expect(claude.sent).toHaveLength(1)
  return { offered, before, after, reply, editor, sent: claude.sent[0] }
}

describe('whole prompts, planned by Claude and carried out', () => {
  it('has at least thirty, and every command a plan can choose is reached by one', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30)
    const used = new Set(CASES.flatMap((c) => c.plan.ops.map((o) => String(o.op))))
    expect(PLAN_COMMAND_NAMES.filter((name) => !used.has(name))).toEqual([])
  })

  it.each(CASES)('$name', async (c) => {
    const result = await carry(c)
    const { offered, before, after, reply, editor, sent } = result

    // What Claude was sent: the commands it can choose, the prompt as written, and the plan's schema.
    expect(sent.model).toBe(MODEL)
    const content = (sent.messages as { content: { text: string }[] }[])[0].content.map((b) => b.text)
    expect(content[0]).toMatch(/^<commands>\n/)
    expect(content[0]).toContain('shorts: ')
    expect(content[content.length - 1]).toContain(`<request>\n${c.prompt}\n</request>`)
    const format = (sent.output_config as { format: { type: string; schema: unknown } }).format
    expect(format.type).toBe('json_schema')
    expect(JSON.stringify(format.schema)).toContain('bring-back')

    // Each step reached its executor, in the order Claude gave.
    expect(editor.reached).toEqual(c.reached)

    // One version at most for the whole prompt, and one reply that says it.
    const made = after.versions.length - before.versions.length
    expect(made).toBeLessThanOrEqual(1)
    if (made === 1 || (c.first && editor.version() !== '0')) expect(reply.text).toMatch(/v\d+ is ready\./)
    expect(reply.text.length).toBeGreaterThan(0)
    expect(reply.text).not.toMatch(/\b[wb]\d+\b/)
    if (!c.check) expect(offered.rejected).toEqual([])
    c.check?.(result)
  })
})
