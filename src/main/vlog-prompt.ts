import { z } from 'zod'
import { clock } from '../shared/presets'
import { timeOfDay, zoneAt } from '../shared/vlog/describe'
import type { EditDoc } from '../shared/edit'
import type { Moment, Story, Vlog } from '../shared/vlog/schema'
import { PACE } from '../shared/vlog/story'
import type { TalkUnit } from '../shared/vlog/talk'

/**
 * What Claude (or a model on this Mac) is sent to say what is in a vlog's
 * moments and to tell its story, and the shapes it answers in: kept apart
 * from the calls so they are tested without them.
 *
 * Only stills and measurements go out for describing, and only the shot list
 * (lines, words said, numbers) for the story; never the footage.
 */

export const DESCRIBE_SYSTEM = `You describe moments from a creator's vlog footage so an editor can find them. Each moment comes as a strip of stills, left to right in time, with its clip, its time in the clip and when it was recorded.

For each moment write one plain line of up to twelve words saying what happens and where, the way an editor would label a shot: "walking into the venue, a crowd at the door", "close on a plate of noodles, chopsticks lifting". Name the place when you can see it ("at the airport", "on the beach"). Say what you see, never what you guess about people's names, feelings or identity, and never read out faces' identities.

Also say what kind of shot it is:
- establishing: shows where we are, wide and calm
- action: something happening
- talk: someone talking to the camera
- reaction: faces reacting, laughing, cheering
- quiet: little happening, a pause

No exclamation marks, no emoji.`

export const DescribeAnswerSchema = z.object({
  moments: z.array(
    z.object({
      id: z.string().describe('The moment id as given: m12.'),
      line: z.string().describe('One plain line of up to twelve words.'),
      kind: z.enum(['establishing', 'action', 'talk', 'reaction', 'quiet'])
    })
  )
})
export type DescribeAnswer = z.infer<typeof DescribeAnswerSchema>

/** The label sent beside a moment's stills. */
export function momentLabel(m: Moment, vlog: Pick<Vlog, 'clips'>): string {
  const clip = vlog.clips.find((c) => c.id === m.clip)
  const when = timeOfDay(clip?.at ?? null, zoneAt(vlog.clips, clip?.at ?? null))
  return `${m.id}: ${clip?.name ?? m.clip}, ${m.inSec.toFixed(1)}-${m.outSec.toFixed(1)} s${when ? `, recorded ${when}` : ''}`
}

export const STORY_SYSTEM = `You are the story editor inside Cutalong, a video editor for YouTube creators. A creator shot a vlog: many short clips through a day. You receive the shot list (every usable clip, its scene, its moments with a line saying what is in them and measurements, and the words said in talking clips with their ids) and a request. You answer with the story as an ordered list of beats.

## The story
- Hook first, unless the request says otherwise: tease the strongest moment of the day in the first seconds, a few quick shots of about a second each from it and just before it, landing on the moment itself. It plays again in full later, in its place.
- Then the day in order. Each scene opens on an establishing shot (wide, calm, shows where we are), then its action, the talking that explains it, and a reaction.
- Build to the payoff: the strongest moment in full, longer than other shots.
- Close on a sign-off (the last thing said to camera) or a quiet moment.
- Pace: in the opening half minute after the hook, shots of about ${PACE.openShot} s; after that ${PACE.minShot} to ${PACE.maxShot} s; the payoff up to ${PACE.payoffMax} s. Talking runs as long as its sentences.
- Leave out weak moments before cutting a scene short; leave out a whole weak scene before showing every scene for one shot.

## Beats
- A shot: {"clip":"s4","role":"action","inSec":12.5,"outSec":15.5,"from":"","to":""}. inSec and outSec are seconds in that clip, inside one of its usable stretches.
- Talking: {"clip":"s7","role":"talk","inSec":0,"outSec":0,"from":"s7w12","to":"s7w30"}. from and to are word ids of that clip; the beat plays every word between them, so start and end on whole sentences. Talking is only ever cut on words.
- Roles: hook, establishing, action, talk, reaction, payoff, close.
- Use only clips and word ids in the shot list. Never invent one. Never use a clip it says is left out.
- Aim for the length asked for; Cutalong trims shots to meet it exactly and lands them on the music's beat.

## Writing
- scenes: a short name for each scene id, two to four words, for what it is ("The airport", "Dinner with the team").
- reply: one or two plain sentences telling the creator what the story is: what it opens on, where it goes, how it ends. First person, plain words, exact numbers, no exclamation marks, no emoji. Never write an id (s4, m12, s7w3, sc2) in the reply or summary.
- summary: one sentence for this version of the edit.`

export const StoryAnswerSchema = z.object({
  beats: z.array(
    z.object({
      clip: z.string(),
      role: z.enum(['hook', 'establishing', 'action', 'talk', 'reaction', 'payoff', 'close']),
      inSec: z.number(),
      outSec: z.number(),
      from: z.string(),
      to: z.string()
    })
  ),
  scenes: z.array(z.object({ id: z.string(), name: z.string() })),
  reply: z.string(),
  summary: z.string()
})
export type StoryAnswer = z.infer<typeof StoryAnswerSchema>

const r1 = (v: number): string => v.toFixed(1)

/**
 * The shot list: every scene in the order of the day, every usable clip in it
 * with its moments and the words said in it, with ids. What changes only with
 * the footage, so it is cached.
 */
export function renderShotList(doc: EditDoc, vlog: Vlog, units: TalkUnit[]): string {
  const lines: string[] = []
  const byClip = new Map<string, TalkUnit[]>()
  for (const u of units) byClip.set(u.clip, [...(byClip.get(u.clip) ?? []), u])
  const wordsOf = new Map<string, string[]>()
  for (const w of doc.words) wordsOf.set(w.source, [...(wordsOf.get(w.source) ?? []), `${w.id} ${w.text}`])
  vlog.scenes.forEach((scene, k) => {
    const from = timeOfDay(scene.startAt, zoneAt(vlog.clips, scene.startAt))
    const to = timeOfDay(scene.endAt, zoneAt(vlog.clips, scene.endAt))
    lines.push(
      `<scene id="${scene.id}" n="${k + 1}" name="${scene.name.replace(/"/g, '')}"${from ? ` from="${from}"` : ''}${to ? ` to="${to}"` : ''}>`
    )
    for (const id of scene.clips) {
      const clip = vlog.clips.find((c) => c.id === id)
      if (!clip) continue
      if (clip.left) {
        lines.push(
          `${clip.id} ${clip.name}: left out, ${clip.left}${clip.duplicateOf ? ` of ${clip.duplicateOf}` : ''}`
        )
        continue
      }
      const when = timeOfDay(clip.at, zoneAt(vlog.clips, clip.at))
      const shape = clip.height > clip.width ? ', upright' : ''
      lines.push(
        `${clip.id} ${clip.name}: ${clock(clip.durationSec)}${when ? `, recorded ${when}` : ''}${shape}, usable ${clip.usable.map(([a, b]) => `${r1(a)}-${r1(b)}`).join(' ')}`
      )
      for (const m of vlog.moments.filter((x) => x.clip === clip.id)) {
        const sounds = m.sounds.length ? ` | ${m.sounds.join(', ')}` : ''
        lines.push(
          `  ${m.id} ${r1(m.inSec)}-${r1(m.outSec)} peak ${r1(m.peakSec)} ${m.kind}: ${m.description} | motion ${m.motion.toFixed(2)}, steady ${m.steady.toFixed(2)}, light ${m.light.toFixed(2)}, interest ${m.interest.toFixed(2)}${sounds}`
        )
      }
      const said = wordsOf.get(clip.id)
      if (said?.length) {
        for (const u of byClip.get(clip.id) ?? []) {
          const ids = doc.words.filter((w) => w.source === clip.id)
          const a = ids.findIndex((w) => w.id === u.from)
          const z = ids.findIndex((w) => w.id === u.to)
          lines.push(
            `  talk ${r1(u.startSec)}-${r1(u.endSec)} (${r1(u.sec)} s): ${ids
              .slice(a, z + 1)
              .map((w) => `${w.id} ${w.text}`)
              .join(' | ')}`
          )
        }
      }
    }
    lines.push('</scene>')
  })
  return lines.join('\n')
}

/** The story as it stands, the length and the ask: the part that changes each time. */
export function renderStoryRequest(
  vlog: Vlog,
  request: string,
  targetSec: number,
  lengthAsked: boolean,
  hasMusic: boolean
): string {
  const parts: string[] = []
  const story: Story = vlog.story
  if (story.beats.length > 0) {
    parts.push('<story-now>')
    for (const b of story.beats) {
      parts.push(
        b.from
          ? `${b.role} ${b.clip} ${b.from}-${b.to}`
          : `${b.role} ${b.clip} ${r1(b.inSec ?? 0)}-${r1(b.outSec ?? 0)}${b.moment ? ` (${b.moment})` : ''}`
      )
    }
    parts.push('</story-now>')
  }
  parts.push(
    `Length: ${clock(targetSec)}${lengthAsked ? ', as the creator asked' : ', what the footage supports'}.${hasMusic ? ' There is a music bed; shots will land on its beats.' : ''}`
  )
  parts.push(request.trim() ? `<request>\n${request.trim()}\n</request>` : 'Cut the day into its story.')
  return parts.join('\n')
}
